"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import type { EbsData } from "./ebs/types";
import {
  GeminiFeedbackPanel,
  type GeminiFeedbackPanelHandle,
} from "./ebs/GeminiFeedbackPanel";
import {
  BROWSER_YOLO_OVERLAY_FPS,
  BROWSER_YOLO_VARIANT,
  ensureBrowserYoloOverlays,
} from "../lib/ensureBrowserYoloOverlays";
import { getSessionEbs } from "../lib/ebsStorage";
import { buildEbsMeta } from "../lib/ebsSessionMeta";
import {
  buildFeedbackSegmentKey,
  getFeedbackSegment,
  hashEbsData,
} from "../lib/feedbackStorage";
import {
  buildOverlayKey,
  getSessionOverlay,
  type OverlayArtifact,
  type OverlaySegmentArtifact,
} from "../lib/overlayStorage";
import {
  buildOverlaySegmentPlans,
  getOverlaySegmentByIndex,
} from "../lib/overlaySegments";
import { getSessions, getSession, subscribeSessions, updateSession, type TempoFlowSession } from "../lib/sessionStorage";
import {
  getGeminiProcessableSegmentCount,
  isSessionPostProcessComplete,
  mergePostProcessMeta,
} from "../lib/sessionPostProcessing";
import { buildVisualFeedbackKey, getVisualFeedbackRun, storeVisualFeedbackRun } from "../lib/visualFeedbackStorage";
import { getSessionVideo } from "../lib/videoStorage";
import {
  buildVisualFeedbackFromYoloArtifacts,
  overlayArtifactHasYoloPoseFrames,
} from "../lib/yoloFeedback";

type ActiveSessionData = {
  session: TempoFlowSession;
  ebsData: EbsData;
  referenceUrl: string;
  practiceUrl: string;
};

function hasRenderableSegment(segment: OverlaySegmentArtifact | null) {
  return Boolean(segment?.video || (segment?.frames && segment.frames.length > 0));
}

function countReadyYoloSegments(params: {
  totalSegments: number;
  refYoloArtifact: OverlayArtifact | null;
  userYoloArtifact: OverlayArtifact | null;
  refYoloPoseArmsArtifact: OverlayArtifact | null;
  refYoloPoseLegsArtifact: OverlayArtifact | null;
  userYoloPoseArmsArtifact: OverlayArtifact | null;
  userYoloPoseLegsArtifact: OverlayArtifact | null;
}) {
  const {
    totalSegments,
    refYoloArtifact,
    userYoloArtifact,
    refYoloPoseArmsArtifact,
    refYoloPoseLegsArtifact,
    userYoloPoseArmsArtifact,
    userYoloPoseLegsArtifact,
  } = params;

  let ready = 0;
  for (let index = 0; index < totalSegments; index += 1) {
    const segmentReady =
      hasRenderableSegment(getOverlaySegmentByIndex(refYoloArtifact, index)) &&
      hasRenderableSegment(getOverlaySegmentByIndex(userYoloArtifact, index)) &&
      hasRenderableSegment(getOverlaySegmentByIndex(refYoloPoseArmsArtifact, index)) &&
      hasRenderableSegment(getOverlaySegmentByIndex(refYoloPoseLegsArtifact, index)) &&
      hasRenderableSegment(getOverlaySegmentByIndex(userYoloPoseArmsArtifact, index)) &&
      hasRenderableSegment(getOverlaySegmentByIndex(userYoloPoseLegsArtifact, index));
    if (segmentReady) ready += 1;
  }
  return ready;
}

function HiddenVideo(props: {
  videoRef: RefObject<HTMLVideoElement | null>;
  src: string | null;
  onReady: () => void;
}) {
  const { videoRef, src, onReady } = props;
  return (
    <video
      ref={videoRef}
      src={src ?? undefined}
      muted
      playsInline
      preload="metadata"
      onLoadedMetadata={onReady}
      style={{
        position: "fixed",
        width: 1,
        height: 1,
        opacity: 0,
        pointerEvents: "none",
        left: -1000,
        top: -1000,
      }}
    />
  );
}

export function BackgroundSessionPostProcessor() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeAnalysisSessionId = pathname === "/analysis" ? searchParams.get("session") : null;

  const [sessions, setSessions] = useState<TempoFlowSession[]>(() => getSessions());
  const [active, setActive] = useState<ActiveSessionData | null>(null);
  const [videosReady, setVideosReady] = useState({ reference: false, practice: false });
  const [overlayCacheReady, setOverlayCacheReady] = useState(false);
  const [refYoloArtifact, setRefYoloArtifact] = useState<OverlayArtifact | null>(null);
  const [userYoloArtifact, setUserYoloArtifact] = useState<OverlayArtifact | null>(null);
  const [refYoloPoseArmsArtifact, setRefYoloPoseArmsArtifact] = useState<OverlayArtifact | null>(null);
  const [refYoloPoseLegsArtifact, setRefYoloPoseLegsArtifact] = useState<OverlayArtifact | null>(null);
  const [userYoloPoseArmsArtifact, setUserYoloPoseArmsArtifact] = useState<OverlayArtifact | null>(null);
  const [userYoloPoseLegsArtifact, setUserYoloPoseLegsArtifact] = useState<OverlayArtifact | null>(null);
  const refVideo = useRef<HTMLVideoElement | null>(null);
  const userVideo = useRef<HTMLVideoElement | null>(null);
  const geminiFeedbackRef = useRef<GeminiFeedbackPanelHandle>(null);
  const autoGeminiQueuedRef = useRef<Set<number>>(new Set());
  const yoloStartedRef = useRef(false);

  useEffect(() => {
    const refresh = () => setSessions(getSessions());
    const unsubscribe = subscribeSessions(refresh);
    refresh();
    return unsubscribe;
  }, []);

  const activeSessionId = active?.session.id ?? null;
  const activeSessionState = useMemo(() => {
    if (!activeSessionId) return null;
    return sessions.find((session) => session.id === activeSessionId) ?? getSession(activeSessionId);
  }, [activeSessionId, sessions]);
  const activeSessionStatus = activeSessionState?.ebsStatus ?? null;
  const ebsFingerprint = useMemo(() => (active?.ebsData ? hashEbsData(active.ebsData) : ""), [active?.ebsData]);
  const totalSegments = active?.ebsData ? buildOverlaySegmentPlans(active.ebsData).length : 0;
  const geminiTotalSegments = active?.ebsData ? getGeminiProcessableSegmentCount(active.ebsData) : 0;

  const refreshProgress = useCallback(async () => {
    if (!active) return;
    const latestSession = getSession(active.session.id);
    if (!latestSession || latestSession.ebsStatus === "paused") {
      return;
    }

    const yoloReadySegments = countReadyYoloSegments({
      totalSegments,
      refYoloArtifact,
      userYoloArtifact,
      refYoloPoseArmsArtifact,
      refYoloPoseLegsArtifact,
      userYoloPoseArmsArtifact,
      userYoloPoseLegsArtifact,
    });

    let visualReadySegments = 0;
    if (ebsFingerprint) {
      const cachedVisual = await getVisualFeedbackRun(
        buildVisualFeedbackKey({ sessionId: active.session.id, ebsFingerprint }),
      );
      visualReadySegments = cachedVisual
        ? new Set(cachedVisual.refSamples.map((sample) => sample.segmentIndex)).size
        : 0;
    }

    let geminiReadySegments = 0;
    for (const segmentIndex of (active.ebsData.segments ?? []).map((_, index) => index)) {
      const segment = active.ebsData.segments[segmentIndex];
      const range = segment?.beat_idx_range;
      if (!range || range[1] <= range[0]) continue;
      const cached = await getFeedbackSegment(
        buildFeedbackSegmentKey({
          sessionId: active.session.id,
          segmentIndex,
          burnInLabels: true,
          includeAudio: false,
          ebsFingerprint,
        }),
      );
      if (cached) {
        geminiReadySegments += 1;
      }
    }

    const postProcessStatus =
      totalSegments > 0 &&
      yoloReadySegments >= totalSegments &&
      visualReadySegments >= totalSegments &&
      geminiReadySegments >= geminiTotalSegments
        ? "ready"
        : "processing";

    const nextMeta = mergePostProcessMeta(buildEbsMeta(active.ebsData, latestSession.ebsMeta), {
      postProcessStatus,
      yoloReadySegments,
      visualReadySegments,
      geminiReadySegments,
      geminiTotalSegments,
    });

    const latestSessionBeforeWrite = getSession(active.session.id);
    if (!latestSessionBeforeWrite || latestSessionBeforeWrite.ebsStatus === "paused") {
      return;
    }

    updateSession(active.session.id, {
      status: "analyzed",
      ebsStatus: postProcessStatus === "ready" ? "ready" : "processing",
      ebsMeta: nextMeta,
      ebsErrorMessage: undefined,
      errorMessage: undefined,
    });

    if (postProcessStatus === "ready") {
      setActive(null);
    }
  }, [
    active,
    ebsFingerprint,
    geminiTotalSegments,
    refYoloArtifact,
    refYoloPoseArmsArtifact,
    refYoloPoseLegsArtifact,
    totalSegments,
    userYoloArtifact,
    userYoloPoseArmsArtifact,
    userYoloPoseLegsArtifact,
  ]);

  useEffect(() => {
    if (!activeSessionState) return;
    if (activeSessionStatus === "paused" || activeSessionStatus === "error") {
      setActive(null);
    }
  }, [activeSessionState, activeSessionStatus]);

  useEffect(() => {
    let cancelled = false;

    const chooseNextSession = async () => {
      if (activeSessionId) {
        if (activeAnalysisSessionId === activeSessionId) {
          setActive(null);
          return;
        }
        const latest = getSession(activeSessionId);
        if (!latest || latest.ebsStatus === "paused" || latest.ebsStatus === "error") {
          setActive(null);
          return;
        }
        if (!isSessionPostProcessComplete(latest)) {
          return;
        }
      }

      for (const session of sessions) {
        const latestSession = getSession(session.id) ?? session;
        if (latestSession.id === activeAnalysisSessionId) continue;
        if (latestSession.ebsStatus === "paused" || latestSession.ebsStatus === "error") continue;
        const ebsData = await getSessionEbs(latestSession.id);
        if (!ebsData) continue;
        const recheckedSession = getSession(latestSession.id) ?? latestSession;
        if (recheckedSession.ebsStatus === "paused" || recheckedSession.ebsStatus === "error") continue;
        if (isSessionPostProcessComplete(recheckedSession)) continue;

        const [referenceFile, practiceFile] = await Promise.all([
          getSessionVideo(recheckedSession.id, "reference"),
          getSessionVideo(recheckedSession.id, "practice"),
        ]);
        if (!referenceFile || !practiceFile) continue;

        const referenceUrl = URL.createObjectURL(referenceFile);
        const practiceUrl = URL.createObjectURL(practiceFile);
        if (cancelled) {
          URL.revokeObjectURL(referenceUrl);
          URL.revokeObjectURL(practiceUrl);
          return;
        }

        updateSession(recheckedSession.id, {
          status: "analyzed",
          ebsStatus: "processing",
          ebsMeta: mergePostProcessMeta(buildEbsMeta(ebsData, recheckedSession.ebsMeta), {
            postProcessStatus: "processing",
            geminiTotalSegments: getGeminiProcessableSegmentCount(ebsData),
          }),
        });

        setActive({
          session: getSession(recheckedSession.id) ?? recheckedSession,
          ebsData,
          referenceUrl,
          practiceUrl,
        });
        return;
      }

      setActive(null);
    };

    void chooseNextSession();
    return () => {
      cancelled = true;
    };
  }, [activeAnalysisSessionId, activeSessionId, sessions]);

  useEffect(() => {
    if (!active) return;
    setVideosReady({ reference: false, practice: false });
    setOverlayCacheReady(false);
    setRefYoloArtifact(null);
    setUserYoloArtifact(null);
    setRefYoloPoseArmsArtifact(null);
    setRefYoloPoseLegsArtifact(null);
    setUserYoloPoseArmsArtifact(null);
    setUserYoloPoseLegsArtifact(null);
    autoGeminiQueuedRef.current = new Set();
    yoloStartedRef.current = false;

    return () => {
      URL.revokeObjectURL(active.referenceUrl);
      URL.revokeObjectURL(active.practiceUrl);
    };
  }, [active]);

  useEffect(() => {
    if (!activeSessionId) return;
    let cancelled = false;

    void (async () => {
      const [ryo, uyo, ryoArms, ryoLegs, uyoArms, uyoLegs] = await Promise.all([
        getSessionOverlay(
          buildOverlayKey({
            sessionId: activeSessionId,
            type: "yolo",
            side: "reference",
            fps: BROWSER_YOLO_OVERLAY_FPS,
            variant: BROWSER_YOLO_VARIANT,
          }),
        ),
        getSessionOverlay(
          buildOverlayKey({
            sessionId: activeSessionId,
            type: "yolo",
            side: "practice",
            fps: BROWSER_YOLO_OVERLAY_FPS,
            variant: BROWSER_YOLO_VARIANT,
          }),
        ),
        getSessionOverlay(
          buildOverlayKey({
            sessionId: activeSessionId,
            type: "yolo-pose-arms",
            side: "reference",
            fps: BROWSER_YOLO_OVERLAY_FPS,
            variant: BROWSER_YOLO_VARIANT,
          }),
        ),
        getSessionOverlay(
          buildOverlayKey({
            sessionId: activeSessionId,
            type: "yolo-pose-legs",
            side: "reference",
            fps: BROWSER_YOLO_OVERLAY_FPS,
            variant: BROWSER_YOLO_VARIANT,
          }),
        ),
        getSessionOverlay(
          buildOverlayKey({
            sessionId: activeSessionId,
            type: "yolo-pose-arms",
            side: "practice",
            fps: BROWSER_YOLO_OVERLAY_FPS,
            variant: BROWSER_YOLO_VARIANT,
          }),
        ),
        getSessionOverlay(
          buildOverlayKey({
            sessionId: activeSessionId,
            type: "yolo-pose-legs",
            side: "practice",
            fps: BROWSER_YOLO_OVERLAY_FPS,
            variant: BROWSER_YOLO_VARIANT,
          }),
        ),
      ]);
      if (cancelled) return;
      setRefYoloArtifact(ryo);
      setUserYoloArtifact(uyo);
      setRefYoloPoseArmsArtifact(ryoArms);
      setRefYoloPoseLegsArtifact(ryoLegs);
      setUserYoloPoseArmsArtifact(uyoArms);
      setUserYoloPoseLegsArtifact(uyoLegs);
      setOverlayCacheReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  useEffect(() => {
    if (!active || !overlayCacheReady || !videosReady.reference || !videosReady.practice) return;
    if (activeSessionStatus === "paused" || activeSessionStatus === "error") return;

    const allReady =
      totalSegments > 0 &&
      countReadyYoloSegments({
        totalSegments,
        refYoloArtifact,
        userYoloArtifact,
        refYoloPoseArmsArtifact,
        refYoloPoseLegsArtifact,
        userYoloPoseArmsArtifact,
        userYoloPoseLegsArtifact,
      }) >= totalSegments;
    if (allReady || yoloStartedRef.current) return;

    yoloStartedRef.current = true;
    const controller = new AbortController();

    void ensureBrowserYoloOverlays({
      sessionId: active.session.id,
      referenceVideoUrl: active.referenceUrl,
      userVideoUrl: active.practiceUrl,
      ebsData: active.ebsData,
      refVideo,
      userVideo,
      existingRef: refYoloArtifact,
      existingUser: userYoloArtifact,
      existingRefArms: refYoloPoseArmsArtifact,
      existingRefLegs: refYoloPoseLegsArtifact,
      existingUserArms: userYoloPoseArmsArtifact,
      existingUserLegs: userYoloPoseLegsArtifact,
      setRefArtifact: setRefYoloArtifact,
      setUserArtifact: setUserYoloArtifact,
      setRefArmsArtifact: setRefYoloPoseArmsArtifact,
      setRefLegsArtifact: setRefYoloPoseLegsArtifact,
      setUserArmsArtifact: setUserYoloPoseArmsArtifact,
      setUserLegsArtifact: setUserYoloPoseLegsArtifact,
      onStatus: () => {},
      onSegmentComplete: () => {
        void refreshProgress();
      },
      signal: controller.signal,
    })
      .catch(() => {
        yoloStartedRef.current = false;
      })
      .finally(() => {
        void refreshProgress();
      });

    return () => {
      controller.abort();
    };
  }, [
    active,
    overlayCacheReady,
    videosReady,
    totalSegments,
    refYoloArtifact,
    userYoloArtifact,
    refYoloPoseArmsArtifact,
    refYoloPoseLegsArtifact,
    userYoloPoseArmsArtifact,
    userYoloPoseLegsArtifact,
    refreshProgress,
    activeSessionStatus,
  ]);

  useEffect(() => {
    if (!active || !overlayCacheReady || !ebsFingerprint) return;
    if (activeSessionStatus === "paused" || activeSessionStatus === "error") return;
    if (!overlayArtifactHasYoloPoseFrames(refYoloArtifact) || !overlayArtifactHasYoloPoseFrames(userYoloArtifact)) {
      return;
    }
    let cancelled = false;

    void (async () => {
      const cacheKey = buildVisualFeedbackKey({
        sessionId: active.session.id,
        ebsFingerprint,
      });
      const cached = await getVisualFeedbackRun(cacheKey);
      const cachedCount = cached ? new Set(cached.refSamples.map((sample) => sample.segmentIndex)).size : 0;
      if (cachedCount >= totalSegments) {
        void refreshProgress();
        return;
      }

      const result = buildVisualFeedbackFromYoloArtifacts({
        referenceArtifact: refYoloArtifact,
        userArtifact: userYoloArtifact,
        segments: active.ebsData.segments,
      });
      if (cancelled) return;
      const resultCount = new Set(result.refSamples.map((sample) => sample.segmentIndex)).size;
      if (resultCount >= totalSegments) {
        await storeVisualFeedbackRun(cacheKey, result);
      }
      if (!cancelled) {
        void refreshProgress();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, activeSessionStatus, ebsFingerprint, refYoloArtifact, refreshProgress, totalSegments, userYoloArtifact, overlayCacheReady]);

  useEffect(() => {
    if (!active || !overlayCacheReady || !ebsFingerprint || !geminiFeedbackRef.current) return;
    if (activeSessionStatus === "paused" || activeSessionStatus === "error") return;
    for (let segmentIndex = 0; segmentIndex < active.ebsData.segments.length; segmentIndex += 1) {
      const segment = active.ebsData.segments[segmentIndex];
      const range = segment?.beat_idx_range;
      if (!range || range[1] <= range[0]) continue;
      if (autoGeminiQueuedRef.current.has(segmentIndex)) continue;
      if (
        !hasRenderableSegment(getOverlaySegmentByIndex(refYoloArtifact, segmentIndex)) ||
        !hasRenderableSegment(getOverlaySegmentByIndex(userYoloArtifact, segmentIndex))
      ) {
        continue;
      }

      autoGeminiQueuedRef.current.add(segmentIndex);
      void (async () => {
        const cached = await getFeedbackSegment(
          buildFeedbackSegmentKey({
            sessionId: active.session.id,
            segmentIndex,
            burnInLabels: true,
            includeAudio: false,
            ebsFingerprint,
          }),
        );
        if (!cached) {
          geminiFeedbackRef.current?.enqueueSegmentForFeedback(segmentIndex);
        } else {
          void refreshProgress();
        }
      })();
    }
  }, [active, activeSessionStatus, ebsFingerprint, overlayCacheReady, refYoloArtifact, refreshProgress, userYoloArtifact]);

  useEffect(() => {
    if (!active) return;
    const intervalId = window.setInterval(() => {
      void refreshProgress();
    }, 2000);
    void refreshProgress();
    return () => window.clearInterval(intervalId);
  }, [active, refreshProgress]);

  if (!active) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        width: 1,
        height: 1,
        overflow: "hidden",
        opacity: 0,
        pointerEvents: "none",
        left: -1000,
        top: -1000,
      }}
    >
      <HiddenVideo
        videoRef={refVideo}
        src={active.referenceUrl}
        onReady={() => setVideosReady((prev) => ({ ...prev, reference: true }))}
      />
      <HiddenVideo
        videoRef={userVideo}
        src={active.practiceUrl}
        onReady={() => setVideosReady((prev) => ({ ...prev, practice: true }))}
      />
      <GeminiFeedbackPanel
        ref={geminiFeedbackRef}
        sessionId={active.session.id}
        ebsData={active.ebsData}
        segments={active.ebsData.segments}
        sharedTime={0}
        renderUi={false}
        onSeek={() => {}}
        referenceVideoUrl={active.referenceUrl}
        userVideoUrl={active.practiceUrl}
        referenceYoloArtifact={refYoloArtifact}
        practiceYoloArtifact={userYoloArtifact}
        referenceYoloPoseArtifact={refYoloPoseArmsArtifact}
        practiceYoloPoseArtifact={userYoloPoseArmsArtifact}
        onFeedbackReady={() => {
          void refreshProgress();
        }}
        onPipelineProgress={() => {
          void refreshProgress();
        }}
      />
    </div>
  );
}
