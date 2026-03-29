"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { useEbsViewer } from "./useEbsViewer";
import type { EbsData } from "./types";
import { buildMovesForSegment } from "./ebsViewerLogic";
import { BodyPixOverlay } from "../BodyPixOverlay";
import { ProgressiveOverlay } from "../ProgressiveOverlay";
import { OverlayMaskLayer } from "./OverlayMaskLayer";
import {
  BROWSER_BODYPIX_OVERLAY_FPS,
  BROWSER_BODYPIX_VARIANT,
  ensureBrowserBodyPixOverlays,
} from "../../lib/ensureBrowserBodyPixOverlays";
import {
  BROWSER_YOLO_OVERLAY_FPS,
  BROWSER_YOLO_VARIANT,
  ensureBrowserYoloOverlays,
} from "../../lib/ensureBrowserYoloOverlays";
import {
  buildOverlayKey,
  getSessionOverlay,
  type OverlayArtifact,
  type OverlaySegmentArtifact,
} from "../../lib/overlayStorage";
import {
  buildOverlaySegmentPlans,
  isOverlayArtifactComplete,
  overlayArtifactHasRenderableData,
} from "../../lib/overlaySegments";
import {
  GeminiFeedbackPanel,
  TIMING_LABEL_COLORS,
  type GeminiFeedbackPanelHandle,
  type GeminiFlatMove,
} from "./GeminiFeedbackPanel";
import {
  buildFeedbackSegmentKey,
  getFeedbackSegment,
  hashEbsData,
} from "../../lib/feedbackStorage";

type ManualViewerProps = {
  mode?: "manual";
  title?: string;
};

type SessionViewerProps = {
  mode: "session";
  sessionId?: string;
  referenceVideoUrl: string;
  userVideoUrl: string;
  ebsData: EbsData;
  referenceName?: string;
  practiceName?: string;
  title?: string;
  footerSlot?: ReactNode;
};

type EbsViewerProps = ManualViewerProps | SessionViewerProps;

function YoloHybridOverlayStack(props: {
  videoRef: RefObject<HTMLVideoElement | null>;
  layers: Array<{
    key: string;
    artifact: OverlayArtifact | null;
    opacity: number;
    className?: string;
    getSegmentStyle?: (segment: OverlaySegmentArtifact | null) => CSSProperties | undefined;
  }>;
}) {
  const { videoRef, layers } = props;

  return (
    <>
      {layers.map((layer) => {
        if (!overlayArtifactHasRenderableData(layer.artifact)) return null;
        return (
          <ProgressiveOverlay
            key={layer.key}
            videoRef={videoRef}
            artifact={layer.artifact}
            className={layer.className}
            style={{ opacity: layer.opacity }}
            getSegmentStyle={layer.getSegmentStyle}
          />
        );
      })}
    </>
  );
}

export function FeedbackViewer(props: EbsViewerProps) {
  const sessionMode = props.mode === "session";
  const sessionProps = sessionMode ? props : null;
  const refVideo = useRef<HTMLVideoElement | null>(null);
  const userVideo = useRef<HTMLVideoElement | null>(null);
  const timelineTrackRef = useRef<HTMLDivElement | null>(null);
  const moveTimelineTrackRef = useRef<HTMLDivElement | null>(null);

  const [refLoaded, setRefLoaded] = useState(false);
  const [userLoaded, setUserLoaded] = useState(false);
  const [jsonLoaded, setJsonLoaded] = useState(false);
  const [showViewer, setShowViewer] = useState(false);
  const [refVideoUrl, setRefVideoUrl] = useState<string | null>(null);
  const [userVideoUrl, setUserVideoUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<{ message: string; type?: "error" | "success" } | null>(null);
  const [viewMode, setViewMode] = useState<"side" | "overlay">("side");
  const [overlayViewSource, setOverlayViewSource] = useState<"reference" | "user" | "both">("both");
  const [overlayDetector, setOverlayDetector] = useState<"bodypix" | "yolo">("yolo");
  const overlayVideoRef = useRef<HTMLVideoElement>(null);
  const [overlayCurrentTime, setOverlayCurrentTime] = useState(0);
  
  const {
    state,
    loadFromJson,
    resetViewer,
    hidePauseOverlay,
    seekToShared,
    seekToSegment,
    seekToPrevSegment,
    seekToNextSegment,
    togglePlay,
    pausePlayback,
    playSegment,
    setPauseAtSegmentEnd,
    toggleMainSpeed,
    openPracticeMode,
    closePracticeMode,
    seekToMove,
    seekToPrevMove,
    seekToNextMove,
    setPracticeLoop,
    setPauseAtMoveEnd,
    togglePracticeSpeed,
  } = useEbsViewer({ refVideo, userVideo, overlayVideo: viewMode === "overlay" ? overlayVideoRef : undefined });

  const viewerVisible = sessionMode || showViewer;
  const canLaunch = (sessionMode || refLoaded) && (sessionMode || userLoaded) && (sessionMode || jsonLoaded);
  const activeReferenceVideoUrl = sessionProps?.referenceVideoUrl ?? refVideoUrl;
  const activeUserVideoUrl = sessionProps?.userVideoUrl ?? userVideoUrl;
  const sessionEbsData = sessionProps?.ebsData ?? null;
  const sessionReferenceName = sessionProps?.referenceName ?? null;
  const sessionPracticeName = sessionProps?.practiceName ?? null;
  const sessionFooterSlot = sessionProps?.footerSlot ?? null;
  const sessionId = sessionProps?.sessionId ?? null;
  /** Fixed defaults: precomputed BodyPix in browser (see ensureBrowserBodyPixOverlays). */
  const overlayMode: "precomputed" | "live" = "precomputed";
  const showBodyPix = true;
  const showFeedback = true;
  const [geminiFeedback, setGeminiFeedback] = useState<GeminiFlatMove[]>([]);
  const [overlayBusy, setOverlayBusy] = useState(false);
  const [overlayStatus, setOverlayStatus] = useState<string | null>(null);
  const [bodyPixSegmentProgress, setBodyPixSegmentProgress] = useState<{ segmentIndex: number; progress: number } | null>(null);
  const [yoloSegmentProgress, setYoloSegmentProgress] = useState<{ segmentIndex: number; progress: number } | null>(null);
  const [overlayCacheReady, setOverlayCacheReady] = useState(false);
  const [refBodyPixArtifact, setRefBodyPixArtifact] = useState<OverlayArtifact | null>(null);
  const [userBodyPixArtifact, setUserBodyPixArtifact] = useState<OverlayArtifact | null>(null);
  const [refYoloArtifact, setRefYoloArtifact] = useState<OverlayArtifact | null>(null);
  const [userYoloArtifact, setUserYoloArtifact] = useState<OverlayArtifact | null>(null);
  const [refYoloPoseArmsArtifact, setRefYoloPoseArmsArtifact] = useState<OverlayArtifact | null>(null);
  const [refYoloPoseLegsArtifact, setRefYoloPoseLegsArtifact] = useState<OverlayArtifact | null>(null);
  const [userYoloPoseArmsArtifact, setUserYoloPoseArmsArtifact] = useState<OverlayArtifact | null>(null);
  const [userYoloPoseLegsArtifact, setUserYoloPoseLegsArtifact] = useState<OverlayArtifact | null>(null);
  const autoBodyPixStartedRef = useRef(false);
  const autoYoloStartedRef = useRef(false);
  const geminiFeedbackRef = useRef<GeminiFeedbackPanelHandle>(null);
  const autoGeminiQueuedRef = useRef<Set<number>>(new Set());
  const ebsFingerprint = useMemo(() => (sessionEbsData ? hashEbsData(sessionEbsData) : ""), [sessionEbsData]);

  const loadCachedOverlays = useCallback(async () => {
    if (!sessionId) return;
    const [rbp, ubp, ryo, uyo, ryoArms, ryoLegs, uyoArms, uyoLegs] = await Promise.all([
      getSessionOverlay(
        buildOverlayKey({
          sessionId,
          type: "bodypix",
          side: "reference",
          fps: BROWSER_BODYPIX_OVERLAY_FPS,
          variant: BROWSER_BODYPIX_VARIANT,
        }),
      ),
      getSessionOverlay(
        buildOverlayKey({
          sessionId,
          type: "bodypix",
          side: "practice",
          fps: BROWSER_BODYPIX_OVERLAY_FPS,
          variant: BROWSER_BODYPIX_VARIANT,
        }),
      ),
      getSessionOverlay(
        buildOverlayKey({
          sessionId,
          type: "yolo",
          side: "reference",
          fps: BROWSER_YOLO_OVERLAY_FPS,
          variant: BROWSER_YOLO_VARIANT,
        }),
      ),
      getSessionOverlay(
        buildOverlayKey({
          sessionId,
          type: "yolo",
          side: "practice",
          fps: BROWSER_YOLO_OVERLAY_FPS,
          variant: BROWSER_YOLO_VARIANT,
        }),
      ),
      getSessionOverlay(
        buildOverlayKey({
          sessionId,
          type: "yolo-pose-arms",
          side: "reference",
          fps: BROWSER_YOLO_OVERLAY_FPS,
          variant: BROWSER_YOLO_VARIANT,
        }),
      ),
      getSessionOverlay(
        buildOverlayKey({
          sessionId,
          type: "yolo-pose-legs",
          side: "reference",
          fps: BROWSER_YOLO_OVERLAY_FPS,
          variant: BROWSER_YOLO_VARIANT,
        }),
      ),
      getSessionOverlay(
        buildOverlayKey({
          sessionId,
          type: "yolo-pose-arms",
          side: "practice",
          fps: BROWSER_YOLO_OVERLAY_FPS,
          variant: BROWSER_YOLO_VARIANT,
        }),
      ),
      getSessionOverlay(
        buildOverlayKey({
          sessionId,
          type: "yolo-pose-legs",
          side: "practice",
          fps: BROWSER_YOLO_OVERLAY_FPS,
          variant: BROWSER_YOLO_VARIANT,
        }),
      ),
    ]);
    setRefBodyPixArtifact(rbp);
    setUserBodyPixArtifact(ubp);
    setRefYoloArtifact(ryo);
    setUserYoloArtifact(uyo);
    setRefYoloPoseArmsArtifact(ryoArms);
    setRefYoloPoseLegsArtifact(ryoLegs);
    setUserYoloPoseArmsArtifact(uyoArms);
    setUserYoloPoseLegsArtifact(uyoLegs);
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadCachedOverlays();
      if (!cancelled) setOverlayCacheReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadCachedOverlays]);

  useEffect(() => {
    if (overlayDetector !== "bodypix") {
      return;
    }
    if (
      !sessionMode ||
      !overlayCacheReady ||
      !sessionId ||
      !activeReferenceVideoUrl ||
      !activeUserVideoUrl ||
      !sessionEbsData
    ) {
      return;
    }
    const plans = buildOverlaySegmentPlans(sessionEbsData);
    const n = plans.length;
    const refOk =
      n > 0
        ? isOverlayArtifactComplete(refBodyPixArtifact, n)
        : overlayArtifactHasRenderableData(refBodyPixArtifact);
    const userOk =
      n > 0
        ? isOverlayArtifactComplete(userBodyPixArtifact, n)
        : overlayArtifactHasRenderableData(userBodyPixArtifact);
    if (refOk && userOk) return;
    if (autoBodyPixStartedRef.current) return;

    autoBodyPixStartedRef.current = true;
    setOverlayBusy(true);
    setOverlayStatus("Generating BodyPix overlays…");

    void ensureBrowserBodyPixOverlays({
      sessionId,
      referenceVideoUrl: activeReferenceVideoUrl,
      userVideoUrl: activeUserVideoUrl,
      ebsData: sessionEbsData,
      refVideo,
      userVideo,
      existingRef: refBodyPixArtifact,
      existingUser: userBodyPixArtifact,
      setRefArtifact: setRefBodyPixArtifact,
      setUserArtifact: setUserBodyPixArtifact,
      onStatus: setOverlayStatus,
      onSegmentProgress: (segmentIndex, progress) => {
        setBodyPixSegmentProgress({ segmentIndex, progress });
      },
    })
      .catch((err) => {
        setOverlayStatus(err instanceof Error ? err.message : "BodyPix overlay generation failed.");
      })
      .finally(() => {
        setOverlayBusy(false);
      });
  }, [
    overlayDetector,
    sessionMode,
    overlayCacheReady,
    sessionId,
    activeReferenceVideoUrl,
    activeUserVideoUrl,
    sessionEbsData,
    refBodyPixArtifact,
    userBodyPixArtifact,
  ]);

  useEffect(() => {
    if (
      !sessionMode ||
      !overlayCacheReady ||
      !sessionId ||
      !activeReferenceVideoUrl ||
      !activeUserVideoUrl ||
      !sessionEbsData
    ) {
      return;
    }

    const totalSegments = buildOverlaySegmentPlans(sessionEbsData).length;
    const refOk =
      totalSegments > 0
        ? isOverlayArtifactComplete(refYoloArtifact, totalSegments)
        : overlayArtifactHasRenderableData(refYoloArtifact);
    const userOk =
      totalSegments > 0
        ? isOverlayArtifactComplete(userYoloArtifact, totalSegments)
        : overlayArtifactHasRenderableData(userYoloArtifact);
    const refArmsOk =
      totalSegments > 0
        ? isOverlayArtifactComplete(refYoloPoseArmsArtifact, totalSegments)
        : overlayArtifactHasRenderableData(refYoloPoseArmsArtifact);
    const refLegsOk =
      totalSegments > 0
        ? isOverlayArtifactComplete(refYoloPoseLegsArtifact, totalSegments)
        : overlayArtifactHasRenderableData(refYoloPoseLegsArtifact);
    const userArmsOk =
      totalSegments > 0
        ? isOverlayArtifactComplete(userYoloPoseArmsArtifact, totalSegments)
        : overlayArtifactHasRenderableData(userYoloPoseArmsArtifact);
    const userLegsOk =
      totalSegments > 0
        ? isOverlayArtifactComplete(userYoloPoseLegsArtifact, totalSegments)
        : overlayArtifactHasRenderableData(userYoloPoseLegsArtifact);
    if (refOk && userOk && refArmsOk && refLegsOk && userArmsOk && userLegsOk) {
      setOverlayStatus("YOLO hybrid overlays ready.");
      return;
    }
    if (autoYoloStartedRef.current) return;

    autoYoloStartedRef.current = true;
    setOverlayBusy(true);
    setOverlayStatus("Generating YOLO hybrid overlays…");
    const controller = new AbortController();

    void ensureBrowserYoloOverlays({
      sessionId,
      referenceVideoUrl: activeReferenceVideoUrl,
      userVideoUrl: activeUserVideoUrl,
      ebsData: sessionEbsData,
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
      onStatus: setOverlayStatus,
      onSegmentProgress: (segmentIndex, progress) => {
        setYoloSegmentProgress({ segmentIndex, progress });
      },
      onSegmentComplete: (segmentIndex) => {
        setYoloSegmentProgress({ segmentIndex, progress: 1 });
        autoGeminiQueuedRef.current.add(segmentIndex);
        queueMicrotask(() => {
          geminiFeedbackRef.current?.enqueueSegmentForFeedback(segmentIndex);
        });
      },
      signal: controller.signal,
    })
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        autoYoloStartedRef.current = false;
        setOverlayStatus(err instanceof Error ? err.message : "YOLO hybrid overlay generation failed.");
      })
      .finally(() => {
        setOverlayBusy(false);
      });

    return () => {
      controller.abort();
    };
    // Keep this tied to the session/input lifecycle only.
    // Depending on overlay artifact state makes React clean up the in-flight run
    // after each completed segment update, which aborts the remaining segments.
  }, [
    sessionMode,
    overlayCacheReady,
    sessionId,
    activeReferenceVideoUrl,
    activeUserVideoUrl,
    sessionEbsData,
  ]);

  // Auto-resume: when YOLO segment data is already cached but Gemini is missing, auto-enqueue those segments.
  useEffect(() => {
    if (
      !sessionMode ||
      !overlayCacheReady ||
      !sessionId ||
      !sessionEbsData ||
      !refYoloArtifact ||
      !userYoloArtifact
    ) {
      return;
    }

    const plans = buildOverlaySegmentPlans(sessionEbsData);
    const n = plans.length;
    if (n === 0) return;
    void (async () => {
      for (let i = 0; i < n; i++) {
        if (autoGeminiQueuedRef.current.has(i)) continue;

        const refSegment =
          refYoloArtifact?.segments?.find(
            (segment) => segment.index === i && Boolean(segment.video || (segment.frames && segment.frames.length > 0)),
          ) ?? null;
        const userSegment =
          userYoloArtifact?.segments?.find(
            (segment) => segment.index === i && Boolean(segment.video || (segment.frames && segment.frames.length > 0)),
          ) ?? null;
        const hasYoloContext =
          Boolean(refSegment && userSegment) &&
          Boolean(refSegment?.meta?.segSummary || refSegment?.meta?.poseSummary) &&
          Boolean(userSegment?.meta?.segSummary || userSegment?.meta?.poseSummary);
        if (!hasYoloContext) continue;

        const key = buildFeedbackSegmentKey({
          sessionId,
          segmentIndex: i,
          burnInLabels: true,
          includeAudio: false,
          ebsFingerprint,
        });
        const cached = await getFeedbackSegment(key);
        if (!cached) {
          // Also check with audio=true variant
          const keyAudio = buildFeedbackSegmentKey({
            sessionId,
            segmentIndex: i,
            burnInLabels: true,
            includeAudio: true,
            ebsFingerprint,
          });
          const cachedAudio = await getFeedbackSegment(keyAudio);
          if (!cachedAudio) {
            autoGeminiQueuedRef.current.add(i);
            queueMicrotask(() => {
              geminiFeedbackRef.current?.enqueueSegmentForFeedback(i);
            });
          }
        }
      }
    })();
  }, [
    sessionMode,
    overlayCacheReady,
    sessionId,
    sessionEbsData,
    refYoloArtifact,
    userYoloArtifact,
    ebsFingerprint,
  ]);

  useEffect(() => {
    if (sessionMode) return;
    return () => {
      if (refVideoUrl) URL.revokeObjectURL(refVideoUrl);
      if (userVideoUrl) URL.revokeObjectURL(userVideoUrl);
    };
  }, [refVideoUrl, sessionMode, userVideoUrl]);

  useEffect(() => {
    autoBodyPixStartedRef.current = false;
    autoYoloStartedRef.current = false;
    setOverlayCacheReady(false);
    setBodyPixSegmentProgress(null);
    setYoloSegmentProgress(null);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionEbsData) return;
    loadFromJson(sessionEbsData);
  }, [loadFromJson, sessionEbsData]);

  useEffect(() => {
    if (!viewerVisible) return;
    if (userVideo.current) {
      userVideo.current.muted = true;
    }
    if (refVideo.current) {
      refVideo.current.playbackRate = state.mainPlaybackRate;
    }
    if (userVideo.current) {
      userVideo.current.playbackRate = state.mainPlaybackRate;
    }
    // Only seek to segment 0 on initial load if we haven't started yet
    if (state.sharedTime === 0 && state.segments.length) {
      const id = window.requestAnimationFrame(() => {
        seekToSegment(0);
      });
      return () => window.cancelAnimationFrame(id);
    }
  }, [seekToSegment, state.mainPlaybackRate, state.segments.length, state.sharedTime, viewerVisible]);

  useEffect(() => {
    if (!viewerVisible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT") return;

      if (event.code === "Space") {
        event.preventDefault();
        togglePlay();
        return;
      }

      if (event.code === "Escape" && state.practice.enabled) {
        event.preventDefault();
        closePracticeMode();
        return;
      }

      if (state.practice.enabled) {
        if (event.code === "ArrowLeft") {
          event.preventDefault();
          seekToPrevMove();
        }
        if (event.code === "ArrowRight") {
          event.preventDefault();
          seekToNextMove();
        }
      } else {
        if (event.code === "ArrowLeft") {
          event.preventDefault();
          seekToPrevSegment();
        }
        if (event.code === "ArrowRight") {
          event.preventDefault();
          seekToNextSegment();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    closePracticeMode,
    seekToNextMove,
    seekToNextSegment,
    seekToPrevMove,
    seekToPrevSegment,
    state.practice.enabled,
    togglePlay,
    viewerVisible,
    viewMode,
  ]);

  const fmtTime = (sec: number) => {
    const safe = Math.max(0, sec);
    const min = Math.floor(safe / 60);
    return `${min}:${(safe % 60).toFixed(1).padStart(4, "0")}`;
  };

  const fmtTimeFull = (sec: number) => {
    const safe = Math.max(0, sec);
    const min = Math.floor(safe / 60);
    return `${min}:${(safe % 60).toFixed(3).padStart(6, "0")}`;
  };

  const setVideoObjectUrl = (
    file: File,
    currentUrl: string | null,
    setter: (value: string) => void,
  ) => {
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    setter(URL.createObjectURL(file));
  };

  const handleLoadJsonFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as EbsData;
        loadFromJson(parsed);
        setJsonLoaded(true);
        setStatus({
          message: `Loaded ${file.name} with ${parsed.segments.length} segments.`,
          type: "success",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown JSON error";
        setStatus({ message: `Invalid JSON: ${message}`, type: "error" });
      }
    };
    reader.readAsText(file);
  };

  const handleLaunch = () => {
    if (!canLaunch) return;
    setShowViewer(true);
    setStatus(null);
  };

  const bpm = state.ebs?.beat_tracking?.estimated_bpm ?? "?";
  const nb = state.ebs?.beat_tracking?.num_beats ?? state.beats.length;
  const mode = state.ebs?.segmentation_mode ?? "?";
  const sharedLen = state.sharedLen;
  const currentSegment = state.currentSegmentIndex >= 0 ? state.segments[state.currentSegmentIndex] : null;
  const currentPracticeSegment =
    state.practice.segmentIndex >= 0 ? state.segments[state.practice.segmentIndex] : null;
  const practiceSpeedText = `${state.practice.playbackRate.toFixed(2).replace(/\.00$/, "")}x`;
  const segmentDoneSet = new Set(state.doneSegmentIndexes);
  const moveDoneSet = new Set(state.practice.doneMoveIndexes);
  const hasSegments = state.segments.length > 0;

  const handleTimelineClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineTrackRef.current || sharedLen <= 0) return;
    const rect = timelineTrackRef.current.getBoundingClientRect();
    const pct = (event.clientX - rect.left) / rect.width;
    seekToShared(pct * sharedLen);
  };

  const handleMoveTimelineClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!moveTimelineTrackRef.current || !currentPracticeSegment) return;
    const rect = moveTimelineTrackRef.current.getBoundingClientRect();
    const segmentDuration = currentPracticeSegment.shared_end_sec - currentPracticeSegment.shared_start_sec;
    if (segmentDuration <= 0) return;
    const pct = (event.clientX - rect.left) / rect.width;
    seekToShared(currentPracticeSegment.shared_start_sec + pct * segmentDuration);
  };

  const downloadJson = () => {
    if (!state.ebs) return;
    const blob = new Blob([JSON.stringify(state.ebs, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "ebs_segments.json";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const bpmInfo = state.ebs?.alignment
    ? `${bpm} BPM · 8 beats/seg · offset ${state.ebs.alignment.clip_2_start_sec.toFixed(3)}s · shared ${sharedLen.toFixed(3)}s`
    : "";

  const practiceInfo =
    currentPracticeSegment && state.practice.moves.length
      ? `${state.practice.moves.length} moves · ${(currentPracticeSegment.shared_end_sec - currentPracticeSegment.shared_start_sec).toFixed(1)}s segment · plays ${((currentPracticeSegment.shared_end_sec - currentPracticeSegment.shared_start_sec) / state.practice.playbackRate).toFixed(1)}s at ${practiceSpeedText}`
      : "";
  const activeSideOverlayDetector = overlayDetector === "yolo" ? "YOLO Hybrid" : "BodyPix";
  const activeReferenceArtifact = overlayDetector === "yolo" ? refYoloArtifact : refBodyPixArtifact;
  const activeUserArtifact = overlayDetector === "yolo" ? userYoloArtifact : userBodyPixArtifact;
  const overlaySegmentPlans = useMemo(
    () => buildOverlaySegmentPlans(sessionEbsData),
    [sessionEbsData],
  );
  const segmentMoves = useMemo(
    () => state.segments.map((_, index) => buildMovesForSegment(state.beats, state.segments, index)),
    [state.beats, state.segments],
  );
  const referenceYoloLayers = useMemo(
    () => [
      { key: "ref-yolo-seg", artifact: refYoloArtifact, opacity: 0.5, className: "z-10" },
      { key: "ref-yolo-legs", artifact: refYoloPoseLegsArtifact, opacity: 0.5, className: "z-20" },
      { key: "ref-yolo-arms", artifact: refYoloPoseArmsArtifact, opacity: 0.54, className: "z-30" },
    ],
    [refYoloArtifact, refYoloPoseArmsArtifact, refYoloPoseLegsArtifact],
  );
  const userYoloLayers = useMemo(
    () => [
      { key: "user-yolo-seg", artifact: userYoloArtifact, opacity: 0.52, className: "z-10" },
      { key: "user-yolo-legs", artifact: userYoloPoseLegsArtifact, opacity: 0.52, className: "z-20" },
      { key: "user-yolo-arms", artifact: userYoloPoseArmsArtifact, opacity: 0.56, className: "z-30" },
    ],
    [userYoloArtifact, userYoloPoseArmsArtifact, userYoloPoseLegsArtifact],
  );
  const getNormalizedReferenceOverlayStyle = useCallback(
    (segment: OverlaySegmentArtifact | null) => {
      const normalization = segment?.meta?.normalization as
        | { scaleX?: number; scaleY?: number; translateX?: number; translateY?: number; pivotX?: number; pivotY?: number }
        | undefined;
      if (!normalization) return undefined;
      const scaleX = Number(normalization.scaleX);
      const scaleY = Number(normalization.scaleY);
      const translateX = Number(normalization.translateX);
      const translateY = Number(normalization.translateY);
      const pivotX = Number(normalization.pivotX);
      const pivotY = Number(normalization.pivotY);
      if (
        !Number.isFinite(scaleX) ||
        !Number.isFinite(scaleY) ||
        !Number.isFinite(translateX) ||
        !Number.isFinite(translateY) ||
        !Number.isFinite(pivotX) ||
        !Number.isFinite(pivotY)
      ) {
        return undefined;
      }
      return {
        transformOrigin: `${(pivotX * 100).toFixed(3)}% ${(pivotY * 100).toFixed(3)}%`,
        transform: `translate(${(translateX * 100).toFixed(3)}%, ${(translateY * 100).toFixed(3)}%) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`,
      };
    },
    [],
  );
  const getRenderableSegment = useCallback((artifact: OverlayArtifact | null, index: number) => {
    return (
      artifact?.segments?.find(
        (segment) => segment.index === index && Boolean(segment.video || (segment.frames && segment.frames.length > 0)),
      ) ?? null
    );
  }, []);
  const activeMoveReadiness = useMemo(() => {
    const inFlight = overlayDetector === "yolo" ? yoloSegmentProgress : bodyPixSegmentProgress;
    const readySharedCutoffBySegment = new Map<number, number>();
    const segmentReadyByIndex = state.segments.map((segment, index) => {
      if (overlayDetector === "yolo") {
        return Boolean(
          getRenderableSegment(refYoloArtifact, index) &&
            getRenderableSegment(userYoloArtifact, index) &&
            getRenderableSegment(refYoloPoseArmsArtifact, index) &&
            getRenderableSegment(refYoloPoseLegsArtifact, index) &&
            getRenderableSegment(userYoloPoseArmsArtifact, index) &&
            getRenderableSegment(userYoloPoseLegsArtifact, index),
        );
      }

      return Boolean(getRenderableSegment(refBodyPixArtifact, index) && getRenderableSegment(userBodyPixArtifact, index));
    });

    state.segments.forEach((segment, index) => {
      if (segmentReadyByIndex[index]) {
        readySharedCutoffBySegment.set(index, segment.shared_end_sec);
        return;
      }

      if (overlayDetector === "bodypix" && inFlight?.segmentIndex === index) {
        const duration = Math.max(0, segment.shared_end_sec - segment.shared_start_sec);
        readySharedCutoffBySegment.set(
          index,
          segment.shared_start_sec + duration * Math.max(0, Math.min(1, inFlight.progress)),
        );
      }
    });

    const moveReadyBySegment = segmentMoves.map((moves, segmentIndex) => {
      if (overlayDetector === "yolo") {
        return moves.map(() => segmentReadyByIndex[segmentIndex] ?? false);
      }
      const cutoff = readySharedCutoffBySegment.get(segmentIndex);
      return moves.map((move) => cutoff != null && move.endSec <= cutoff + 0.04);
    });

    const readyMoves = moveReadyBySegment.reduce(
      (total, moves) => total + moves.filter(Boolean).length,
      0,
    );
    const totalMoves = segmentMoves.reduce((total, moves) => total + moves.length, 0);
    const readySegments = segmentReadyByIndex.filter(Boolean).length;

    return {
      readySharedCutoffBySegment,
      segmentReadyByIndex,
      moveReadyBySegment,
      readyMoves,
      readySegments,
      totalMoves,
    };
  }, [
    overlayDetector,
    yoloSegmentProgress,
    bodyPixSegmentProgress,
    state.segments,
    segmentMoves,
    getRenderableSegment,
    refYoloArtifact,
    userYoloArtifact,
    refYoloPoseArmsArtifact,
    refYoloPoseLegsArtifact,
    userYoloPoseArmsArtifact,
    userYoloPoseLegsArtifact,
    refBodyPixArtifact,
    userBodyPixArtifact,
  ]);
  const moveReadySummary =
    overlayDetector === "yolo"
      ? state.segments.length > 0
        ? `${activeMoveReadiness.readySegments}/${state.segments.length} segments ready`
        : null
      : activeMoveReadiness.totalMoves > 0
        ? `${activeMoveReadiness.readyMoves}/${activeMoveReadiness.totalMoves} moves ready`
        : null;

  const feedbackBySegment = useMemo(() => {
    const bySegment = new Map<number, GeminiFlatMove[]>();
    geminiFeedback.forEach((move) => {
      const segmentIndex = Number(move.segmentIndex);
      if (!Number.isFinite(segmentIndex)) return;
      const existing = bySegment.get(segmentIndex) ?? [];
      existing.push(move);
      bySegment.set(segmentIndex, existing);
    });
    return bySegment;
  }, [geminiFeedback]);

  const segmentFeedbackStyles = useMemo(() => {
    const severityByLabel: Record<string, number> = {
      "on-time": 0,
      uncertain: 0.45,
      early: 0.74,
      late: 0.74,
      rushed: 0.88,
      dragged: 0.88,
      mixed: 1,
    };

    return state.segments.map((_, index) => {
      const moves = feedbackBySegment.get(index) ?? [];
      if (!moves.length) {
        return {
          fill: "rgba(191, 219, 254, 0.72)",
          border: "rgba(191, 219, 254, 0.95)",
          glow: "rgba(148, 163, 184, 0.12)",
          accent: "#94a3b8",
        };
      }

      const severities = moves.map((move) => severityByLabel[move.micro_timing_label] ?? 0.55);
      const avgSeverity = severities.reduce((sum, value) => sum + value, 0) / severities.length;

      if (avgSeverity <= 0.18) {
        return {
          fill: "linear-gradient(180deg, rgba(187, 247, 208, 0.94) 0%, rgba(134, 239, 172, 0.86) 100%)",
          border: "rgba(74, 222, 128, 0.95)",
          glow: "rgba(74, 222, 128, 0.18)",
          accent: "#16a34a",
        };
      }

      if (avgSeverity <= 0.52) {
        return {
          fill: "linear-gradient(180deg, rgba(254, 240, 138, 0.92) 0%, rgba(253, 224, 71, 0.82) 100%)",
          border: "rgba(234, 179, 8, 0.95)",
          glow: "rgba(234, 179, 8, 0.16)",
          accent: "#ca8a04",
        };
      }

      return {
        fill: "linear-gradient(180deg, rgba(254, 202, 202, 0.94) 0%, rgba(252, 165, 165, 0.84) 100%)",
        border: "rgba(248, 113, 113, 0.98)",
        glow: "rgba(239, 68, 68, 0.18)",
        accent: "#dc2626",
      };
    });
  }, [feedbackBySegment, state.segments]);

  const mapArtifactToOverlayTimeline = useCallback(
    (
      artifact: OverlayArtifact | null,
      side: "reference" | "practice",
    ): OverlayArtifact | null => {
      if (!artifact?.segments?.length || !overlaySegmentPlans.length) return artifact;

      const plansByIndex = new Map(overlaySegmentPlans.map((plan) => [plan.index, plan]));
      return {
        ...artifact,
        segments: artifact.segments.map((segment) => {
          const parentIndex =
            typeof segment.meta?.segmentIndex === "number"
              ? segment.meta.segmentIndex
              : Number(segment.meta?.segmentIndex ?? segment.index);
          const plan = plansByIndex.get(parentIndex);
          if (!plan) return segment;
          const sharedStartSec = Number(segment.meta?.sharedStartSec);
          const sharedEndSec = Number(segment.meta?.sharedEndSec);
          const hasSharedMeta =
            Number.isFinite(sharedStartSec) &&
            Number.isFinite(sharedEndSec) &&
            sharedEndSec > sharedStartSec;
          const nextRange = hasSharedMeta
            ? {
                startSec: plan.practice.startSec + (sharedStartSec - plan.sharedStartSec),
                endSec: plan.practice.startSec + (sharedEndSec - plan.sharedStartSec),
              }
            : plan.practice;
          return {
            ...segment,
            startSec: nextRange.startSec,
            endSec: nextRange.endSec,
          };
        }),
      };
    },
    [overlaySegmentPlans],
  );

  const overlayReferenceArtifact = useMemo(
    () => mapArtifactToOverlayTimeline(activeReferenceArtifact, "reference"),
    [activeReferenceArtifact, mapArtifactToOverlayTimeline],
  );
  const overlayUserArtifact = useMemo(
    () => mapArtifactToOverlayTimeline(activeUserArtifact, "practice"),
    [activeUserArtifact, mapArtifactToOverlayTimeline],
  );
  const overlayReferenceYoloLayers = useMemo(
    () =>
      referenceYoloLayers.map((layer) => ({
        ...layer,
        artifact: mapArtifactToOverlayTimeline(layer.artifact, "reference"),
        getSegmentStyle: getNormalizedReferenceOverlayStyle,
      })),
    [getNormalizedReferenceOverlayStyle, mapArtifactToOverlayTimeline, referenceYoloLayers],
  );
  const overlayUserYoloLayers = useMemo(
    () =>
      userYoloLayers.map((layer) => ({
        ...layer,
        artifact: mapArtifactToOverlayTimeline(layer.artifact, "practice"),
      })),
    [mapArtifactToOverlayTimeline, userYoloLayers],
  );
  // Overlay diff: get frame from per-segment BodyPix artifacts for current time
  const getOverlayDiffFrame = useCallback((
    artifact: OverlayArtifact | null,
    currentTimeSec: number
  ): string | Blob | null => {
    if (!artifact?.segments?.length) return null;
    
    // Find which segment contains this time
    for (const seg of artifact.segments) {
      if (currentTimeSec >= seg.startSec && currentTimeSec < seg.endSec) {
        if (!seg.frames?.length) return null;
        const segTime = currentTimeSec - seg.startSec;
        const frameIdx = Math.floor(segTime * seg.fps);
        const clampedIdx = Math.max(0, Math.min(frameIdx, seg.frames.length - 1));
        return seg.frames[clampedIdx] ?? null;
      }
    }
    return null;
  }, []);

  const getOverlayDiffFrameKey = useCallback((
    artifact: OverlayArtifact | null,
    currentTimeSec: number,
  ): string | null => {
    if (!artifact?.segments?.length) return null;

    for (const seg of artifact.segments) {
      if (currentTimeSec >= seg.startSec && currentTimeSec < seg.endSec) {
        const frameCount = seg.frames?.length ?? 0;
        if (!frameCount) return `${seg.index}:video`;
        const segTime = currentTimeSec - seg.startSec;
        const frameIdx = Math.max(0, Math.min(Math.floor(segTime * seg.fps), frameCount - 1));
        return `${seg.index}:${frameIdx}`;
      }
    }

    return null;
  }, []);

  const useFrameStyledOverlay = viewMode === "overlay" && overlayDetector === "bodypix";

  const refOverlayFrame = useFrameStyledOverlay
    ? getOverlayDiffFrame(overlayReferenceArtifact, overlayCurrentTime)
    : null;
  const userOverlayFrame = useFrameStyledOverlay
    ? getOverlayDiffFrame(overlayUserArtifact, overlayCurrentTime)
    : null;

  // Sync overlay video time to local state only when the rendered BodyPix frame should change.
  useEffect(() => {
    if (!useFrameStyledOverlay || !overlayVideoRef.current) return;
    const video = overlayVideoRef.current;

    let cancelled = false;
    let raf = 0;
    let rvfcHandle = 0;
    const rvfc = (video as HTMLVideoElement & {
      requestVideoFrameCallback?: (
        callback: (now: number, metadata: { mediaTime?: number }) => void,
      ) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    }).requestVideoFrameCallback;
    const cancelRvfc = (video as HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void })
      .cancelVideoFrameCallback;
    let lastFrameKey = "";

    const maybeUpdateTime = (timeSec: number) => {
      const nextKey = [
        getOverlayDiffFrameKey(overlayReferenceArtifact, timeSec),
        getOverlayDiffFrameKey(overlayUserArtifact, timeSec),
      ].join("|");
      if (nextKey === lastFrameKey) return;
      lastFrameKey = nextKey;
      setOverlayCurrentTime(timeSec);
    };

    const onVideoFrame = (_now: number, metadata: { mediaTime?: number }) => {
      if (cancelled) return;
      maybeUpdateTime(metadata.mediaTime ?? video.currentTime ?? 0);
      rvfcHandle = rvfc ? rvfc.call(video, onVideoFrame) : 0;
    };

    const onRaf = () => {
      if (cancelled) return;
      maybeUpdateTime(video.currentTime || 0);
      raf = window.requestAnimationFrame(onRaf);
    };

    maybeUpdateTime(video.currentTime || 0);
    if (rvfc) {
      rvfcHandle = rvfc.call(video, onVideoFrame);
    } else {
      raf = window.requestAnimationFrame(onRaf);
    }

    return () => {
      cancelled = true;
      if (cancelRvfc && rvfcHandle) cancelRvfc.call(video, rvfcHandle);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [getOverlayDiffFrameKey, overlayReferenceArtifact, overlayUserArtifact, useFrameStyledOverlay]);

  // Initial sync when switching to overlay mode
  useEffect(() => {
    if (viewMode === "overlay" && overlayVideoRef.current && state.ebs?.alignment) {
      const overlayTargetTime = state.ebs.alignment.clip_2_start_sec + Math.max(0, state.sharedTime);
      const timeDiff = Math.abs(overlayVideoRef.current.currentTime - overlayTargetTime);
      if (timeDiff > 0.1) {
        overlayVideoRef.current.currentTime = overlayTargetTime;
      }
      setOverlayCurrentTime(overlayTargetTime);
    }
  }, [state.ebs, state.sharedTime, viewMode]);

  return (
    <div className="ebs-viewer-root">
      {viewerVisible && (
        <div className="ebs-viewer visible">
          <div className="ebs-top-bar">
          {hasSegments ? (
            <div className="ebs-toggle flex items-center w-full">
              <label htmlFor="chk-pause">Pause at segment end</label>
              <input
                id="chk-pause"
                type="checkbox"
                className="ebs-toggle-switch"
                checked={state.pauseAtSegmentEnd}
                onChange={(e) => setPauseAtSegmentEnd(e.target.checked)}
              />
              <div className="flex-1" />
              {/* View mode toggle */}
              <div className="flex items-center gap-2 mr-4">
                <span className="text-xs text-slate-500">View:</span>
                <button
                  onClick={() => setViewMode("side")}
                  className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors ${
                    viewMode === "side"
                      ? "bg-slate-800 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                  title="Side-by-side view"
                >
                  Side
                </button>
                <button
                  onClick={() => setViewMode("overlay")}
                  className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors ${
                    viewMode === "overlay"
                      ? "bg-slate-800 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                  title={`Overlay diff view (uses ${activeSideOverlayDetector})`}
                >
                  Overlay
                </button>
                {sessionMode && (
                  <>
                    <span className="text-xs text-slate-400">|</span>
                    <span className="text-xs text-slate-500">Dev:</span>
                    <button
                      onClick={() => setOverlayDetector("bodypix")}
                      className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                        overlayDetector === "bodypix"
                          ? "bg-slate-800 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                      title="Use BodyPix overlays"
                    >
                      BodyPix
                    </button>
                    <button
                      onClick={() => setOverlayDetector("yolo")}
                      className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                        overlayDetector === "yolo"
                          ? "bg-slate-800 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                      title="Use YOLO hybrid overlays"
                    >
                      YOLO
                    </button>
                  </>
                )}
                {viewMode === "overlay" && (
                  <>
                    <span className="text-xs text-slate-400">|</span>
                    <button
                      onClick={() => setOverlayViewSource("reference")}
                      className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                        overlayViewSource === "reference"
                          ? "bg-blue-500 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                      title="Show reference overlay on user video"
                    >
                      Ref
                    </button>
                    <button
                      onClick={() => setOverlayViewSource("user")}
                      className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                        overlayViewSource === "user"
                          ? "bg-blue-500 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                      title="Show user overlay on user video"
                    >
                      User
                    </button>
                    <button
                      onClick={() => setOverlayViewSource("both")}
                      className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                        overlayViewSource === "both"
                          ? "bg-blue-500 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                      title="Show both overlays"
                    >
                      Both
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="ebs-inline-note">Aligned videos loaded...</div>
          )}
        </div>
          {(overlayStatus || overlayBusy) && sessionMode ? (
            <div className="mb-3 rounded-2xl border border-sky-100 bg-sky-50 px-4 py-2 text-xs text-slate-700">
              <div>{overlayBusy ? `${overlayStatus ?? "Working…"}` : overlayStatus}</div>
              {moveReadySummary ? (
                <div className="mt-1 text-[11px] text-slate-500">{moveReadySummary}</div>
              ) : null}
            </div>
          ) : null}
          {viewMode === "side" ? (
            <div className="videos">
              <div className="video-panel">
                <div className="video-label">
                  Reference ({sessionReferenceName || "Clip 1"})
                  {sessionMode ? <span className="ml-2 text-[10px] text-slate-400">{activeSideOverlayDetector}</span> : null}
                  <span className="time-display">{fmtTimeFull(state.refTime)}</span>
                </div>
                <div className="relative">
                  <video ref={refVideo} src={activeReferenceVideoUrl ?? undefined} playsInline />
                  {sessionMode && showBodyPix ? (
                    overlayMode === "precomputed" ? (
                      overlayDetector === "yolo" ? (
                        <YoloHybridOverlayStack videoRef={refVideo} layers={referenceYoloLayers} />
                      ) : (
                        <ProgressiveOverlay videoRef={refVideo} artifact={activeReferenceArtifact} />
                      )
                    ) : (
                      <BodyPixOverlay videoRef={refVideo} opacity={0.68} color={{ r: 50, g: 200, b: 100 }} />
                    )
                  ) : null}
                </div>
                <div className={`beat-flash${state.beatFlashOn ? " on" : ""}`} />
                <div className={`seg-pause-overlay${state.pauseOverlay.visible ? " visible" : ""}`}>
                  <div className="seg-pause-card">
                    <div className="seg-done-num">{state.pauseOverlay.label}</div>
                    <div className="seg-done-label">{state.pauseOverlay.completionLabel}</div>
                    <div className="seg-done-hint">Space to continue · → next section</div>
                  </div>
                </div>
              </div>
              <div className="video-panel">
                <div className="video-label">
                  User ({sessionPracticeName || "Clip 2"})
                  {sessionMode ? <span className="ml-2 text-[10px] text-slate-400">{activeSideOverlayDetector}</span> : null}
                  <span className="time-display">{fmtTimeFull(state.userTime)}</span>
                </div>
                <div className="relative">
                  <video ref={userVideo} src={activeUserVideoUrl ?? undefined} playsInline />
                  {sessionMode && showBodyPix ? (
                    overlayMode === "precomputed" ? (
                      overlayDetector === "yolo" ? (
                        <YoloHybridOverlayStack videoRef={userVideo} layers={userYoloLayers} />
                      ) : (
                        <ProgressiveOverlay videoRef={userVideo} artifact={activeUserArtifact} />
                      )
                    ) : (
                      <BodyPixOverlay videoRef={userVideo} opacity={0.68} color={{ r: 255, g: 100, b: 50 }} />
                    )
                  ) : null}
                </div>
                <div className={`beat-flash${state.beatFlashOn ? " on" : ""}`} />
                <div className={`seg-pause-overlay${state.pauseOverlay.visible ? " visible" : ""}`}>
                  <div className="seg-pause-card">
                    <div className="seg-done-num">{state.pauseOverlay.label}</div>
                    <div className="seg-done-label">{state.pauseOverlay.completionLabel}</div>
                    <div className="seg-done-hint">Space to continue · → next section</div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* Overlay diff view - reuses the selected per-segment detector data */
            <div className="videos single-view">
              <div className="video-panel" style={{ maxWidth: "100%", width: "100%" }}>
                <div className="video-label">
                  <span>User ({sessionPracticeName || "Practice"})</span>
                  <span className="ml-2 text-[10px] text-slate-400">{activeSideOverlayDetector}</span>
                </div>
                <div className="relative" style={{ aspectRatio: "16/9", background: "#000" }}>
                  {/* Base: User video (synced with timeline) */}
                  <video
                    ref={overlayVideoRef}
                    src={activeUserVideoUrl ?? undefined}
                    className="absolute inset-0 w-full h-full object-contain z-0"
                    playsInline
                  />
                  {overlayDetector === "yolo" ? (
                    <>
                      {(overlayViewSource === "reference" || overlayViewSource === "both") && (
                        <YoloHybridOverlayStack videoRef={overlayVideoRef} layers={overlayReferenceYoloLayers} />
                      )}
                      {(overlayViewSource === "user" || overlayViewSource === "both") && (
                        <YoloHybridOverlayStack videoRef={overlayVideoRef} layers={overlayUserYoloLayers} />
                      )}
                    </>
                  ) : (
                    <>
                      {/* Layer 1: Reference ghost (BodyPix overlay) */}
                      {(overlayViewSource === "reference" || overlayViewSource === "both") && refOverlayFrame && (
                        <OverlayMaskLayer
                          frame={refOverlayFrame}
                          color={{ r: 14, g: 165, b: 233 }}
                          fillOpacity={0.08}
                          contourOpacity={0.88}
                          contourRadius={2}
                          seamOpacity={0.42}
                          seamRadius={1}
                          glowOpacity={0.16}
                          glowRadius={4}
                          className="z-10"
                        />
                      )}
                      {/* Layer 2: User BodyPix overlay */}
                      {(overlayViewSource === "user" || overlayViewSource === "both") && userOverlayFrame && (
                        <OverlayMaskLayer
                          frame={userOverlayFrame}
                          color={{ r: 249, g: 115, b: 22 }}
                          fillOpacity={0.12}
                          contourOpacity={0.92}
                          contourRadius={2}
                          seamOpacity={0.5}
                          seamRadius={1}
                          glowOpacity={0.18}
                          glowRadius={4}
                          className="z-20"
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
          {sessionMode && showFeedback && sessionId && sessionEbsData && state.segments.length > 0 && (
            <div className="mt-4 mb-2">
              <GeminiFeedbackPanel
                ref={geminiFeedbackRef}
                sessionId={sessionId}
                ebsData={sessionEbsData}
                segments={state.segments}
                sharedTime={state.sharedTime}
                onSeek={seekToShared}
                onFeedbackReady={setGeminiFeedback}
                referenceVideoUrl={activeReferenceVideoUrl}
                userVideoUrl={activeUserVideoUrl}
                referenceYoloArtifact={refYoloArtifact}
                practiceYoloArtifact={userYoloArtifact}
                referenceYoloPoseArtifact={refYoloPoseArmsArtifact}
                practiceYoloPoseArtifact={userYoloPoseArmsArtifact}
              />
            </div>
          )}
          {!state.practice.enabled && hasSegments && (
            <>
              <div className="transport">
                <div className="transport-row">
                  <button className="transport-btn" onClick={seekToPrevSegment} title="Previous segment">
                    ◀◀
                  </button>
                  <button className="transport-btn play-btn" onClick={togglePlay} title="Play / Pause">
                    {state.isPlaying ? "▮▮" : "▶"}
                  </button>
                  <button className="transport-btn" onClick={seekToNextSegment} title="Next segment">
                    ▶▶
                  </button>
                  <button className="transport-btn" onClick={toggleMainSpeed} title="Toggle playback speed">
                    {state.mainPlaybackRate === 1 ? "1x" : state.mainPlaybackRate === 0.5 ? "0.5x" : "0.25x"}
                  </button>
                  <button
                    className="transport-btn practice-btn"
                    onClick={() => {
                      if (state.currentSegmentIndex >= 0) {
                        openPracticeMode(state.currentSegmentIndex);
                      } else if (state.segments.length) {
                        openPracticeMode(0);
                      }
                    }}
                    title="Practice current segment"
                  >
                    Practice
                  </button>
                  <div className="transport-info">
                    <div className="current-segment">
                      {currentSegment ? (
                        <>
                          Segment <span>{state.currentSegmentIndex}</span> / {state.segments.length - 1}
                        </>
                      ) : (
                        "Between segments"
                      )}
                    </div>
                    <div className="bpm-info">{bpmInfo}</div>
                  </div>
                  <div className="time-code">{fmtTime(state.sharedTime)}</div>
                </div>
              </div>

              <div className="timeline" style={{ position: "relative", zIndex: 10 }}>
                <div className="timeline-track relative" ref={timelineTrackRef} onClick={handleTimelineClick}>
                    {/* 1. SEGMENTS LAYER */}
                    {state.segments.map((segment, index) => {
                      const isActive = index === state.currentSegmentIndex;
                      const feedbackStyle = segmentFeedbackStyles[index];

                      return (
                        <div
                          key={`seg-track-${index}`}
                          className={[
                            "timeline-segment transition-colors duration-500",
                            isActive ? "active" : "",
                            segmentDoneSet.has(index) ? "done" : "",
                          ].filter(Boolean).join(" ")}
                          style={{
                            left: `${(segment.shared_start_sec / sharedLen) * 100}%`,
                            width: `${((segment.shared_end_sec - segment.shared_start_sec) / sharedLen) * 100}%`,
                            background: feedbackStyle?.fill,
                            borderColor: feedbackStyle?.border,
                            boxShadow: feedbackStyle ? `inset 0 0 0 1px ${feedbackStyle.border}, 0 8px 20px ${feedbackStyle.glow}` : undefined,
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            seekToSegment(index);
                          }}
                        >
                          {index}
                        </div>
                      );
                    })}

                    {/* 3. PLAYHEAD (Top Layer) */}
                    <div
                      className="timeline-playhead z-[10] shadow-md"
                      style={{ left: `${sharedLen > 0 ? (state.sharedTime / sharedLen) * 100 : 0}%` }}
                    />
                </div>
                    {showFeedback && sharedLen > 0 && (
                  <div className="pointer-events-none absolute left-0 right-0 top-0 z-[9] h-[52px] overflow-visible">
                    {geminiFeedback.map((move, index) => {
                      const start = move.shared_start_sec ?? 0;
                      const end = move.shared_end_sec ?? start;
                      const mid = start + Math.max(end - start, 0.04) / 2;
                      const color = TIMING_LABEL_COLORS[move.micro_timing_label] ?? "#94a3b8";
                      return (
                        <button
                          key={`gflag-${index}`}
                          type="button"
                          className="pointer-events-auto absolute z-[8] -translate-x-1/2 cursor-pointer bg-transparent p-0 border-0"
                          title={`Move ${move.move_index}: ${move.micro_timing_label}`}
                          style={{
                            left: `${(mid / sharedLen) * 100}%`,
                            top: "0px",
                            height: "52px",
                            width: "16px",
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            seekToShared(start);
                          }}
                        >
                          <span
                            className="absolute left-1/2 top-[4px] -translate-x-1/2 rounded-full"
                            style={{
                              width: "3px",
                              height: "42px",
                              backgroundColor: color,
                              boxShadow: `0 0 0 1px rgba(255,255,255,0.95), 0 0 12px ${color}`,
                            }}
                          />
                          <span
                            className="absolute left-1/2 top-0 -translate-x-1/2 rounded-full"
                            style={{
                              width: "10px",
                              height: "10px",
                              backgroundColor: color,
                              boxShadow: `0 0 0 2px rgba(255,255,255,0.96), 0 2px 8px ${color}`,
                            }}
                          />
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="beat-markers">
                  {state.beats.map((beat, index) => (
                    <div
                      key={`beat-${index}`}
                      className={`beat-dot${index % 8 === 0 ? " downbeat" : ""}`}
                      style={{ left: `${sharedLen > 0 ? (beat / sharedLen) * 100 : 0}%` }}
                    />
                  ))}
                </div>
              </div>

              <div className="segment-list">
                {state.segments.map((segment, index) => (
                  <div
                    key={`seg-chip-${index}`}
                    className={[
                      "seg-chip",
                      index === state.currentSegmentIndex ? "active" : "",
                      segmentDoneSet.has(index) ? "done" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => {
                      hidePauseOverlay();
                      seekToSegment(index);
                    }}
                  >
                    <div className="seg-num">Seg {index}</div>
                    <div className="seg-time">
                      {fmtTime(segment.shared_start_sec)} - {fmtTime(segment.shared_end_sec)}
                    </div>
                    {segmentMoves[index]?.length ? (
                      overlayDetector === "yolo" ? (
                        <div
                          className={`text-[10px] ${
                            activeMoveReadiness.segmentReadyByIndex[index] ? "text-emerald-600" : "text-slate-400"
                          }`}
                        >
                          {activeMoveReadiness.segmentReadyByIndex[index] ? "Segment ready" : "Segment processing"}
                        </div>
                      ) : (
                        <div
                          className={`text-[10px] ${
                            activeMoveReadiness.moveReadyBySegment[index]?.every(Boolean)
                              ? "text-emerald-600"
                              : activeMoveReadiness.moveReadyBySegment[index]?.some(Boolean)
                                ? "text-amber-600"
                                : "text-slate-400"
                          }`}
                        >
                          {activeMoveReadiness.moveReadyBySegment[index]?.filter(Boolean).length ?? 0}/
                          {segmentMoves[index].length} moves ready
                        </div>
                      )
                    ) : null}
                    <button
                      className="seg-practice-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        openPracticeMode(index);
                      }}
                    >
                      ▶ Practice
                    </button>
                  </div>
                ))}
              </div>

              <div className="download-row">
                <button className="dl-btn" onClick={downloadJson}>
                  Download EBS JSON
                </button>
                <button
                  className="dl-btn"
                  onClick={() => {
                    if (state.currentSegmentIndex >= 0) {
                      playSegment(state.currentSegmentIndex);
                    }
                  }}
                >
                  Replay Current Segment
                </button>
                {sessionMode ? sessionFooterSlot : null}
              </div>
            </>
          )}

          {!state.practice.enabled && !hasSegments && (
            <>
              <div className="ebs-empty-state">
                <div className="ebs-empty-state-title">No beat-synced segments were detected</div>
                <p className="ebs-empty-state-copy">
                  TempoFlow successfully aligned the videos and loaded the EBS result, but this clip did not produce
                  any playable sections. This usually happens when the shared audio is too short or the beat tracker
                  cannot find a stable pulse.
                </p>
                <div className="ebs-empty-state-meta">
                  <span className="ebs-tag">{sharedLen.toFixed(3)}s shared audio</span>
                  <span className="ebs-tag">{nb} beats detected</span>
                  <span className="ebs-tag orange">{mode}</span>
                </div>
              </div>

              <div className="download-row">
                <button className="dl-btn" onClick={downloadJson}>
                  Download EBS JSON
                </button>
                {sessionMode ? sessionFooterSlot : null}
              </div>
            </>
          )}

          {state.practice.enabled && (
            <div className="practice-panel visible">
              <div className="practice-header">
                <div>
                  <span className="practice-title">
                    Practice: Segment <span className="pnum">{state.practice.segmentIndex}</span>
                    <span className="speed-badge">{practiceSpeedText}</span>
                  </span>
                  <div className="practice-note">Last move = transition to next segment</div>
                </div>
                <div className="practice-header-actions">
                  <div className="ebs-toggle">
                    <label htmlFor="chk-pause-move">Pause at move end</label>
                    <input
                      id="chk-pause-move"
                      type="checkbox"
                      className="ebs-toggle-switch"
                      checked={state.practice.pauseAtMoveEnd}
                      onChange={(event) => setPauseAtMoveEnd(event.target.checked)}
                    />
                  </div>
                  <button className="ebs-back-btn" onClick={closePracticeMode}>
                    ← Back to Overview
                  </button>
                </div>
              </div>

              <div className="transport">
                <div className="transport-row">
                  <button className="transport-btn" onClick={seekToPrevMove}>
                    ◀◀
                  </button>
                  <button className="transport-btn play-btn" onClick={togglePlay}>
                    {state.isPlaying ? "▮▮" : "▶"}
                  </button>
                  <button className="transport-btn" onClick={seekToNextMove}>
                    ▶▶
                  </button>
                  <button className="transport-btn practice-active" onClick={togglePracticeSpeed}>
                    {practiceSpeedText}
                  </button>
                  <button
                    className={`transport-btn${state.practice.loopSegment ? " practice-active" : ""}`}
                    onClick={() => setPracticeLoop(!state.practice.loopSegment)}
                  >
                    Loop
                  </button>
                  <div className="transport-info">
                    <div className="current-segment">
                      {state.practice.currentMoveIndex >= 0 ? (
                        <>
                          Move <span>{state.practice.moves[state.practice.currentMoveIndex]?.num}</span> /{" "}
                          {state.practice.moves.length}
                          {state.practice.moves[state.practice.currentMoveIndex]?.isTransition
                            ? " (Transition)"
                            : ""}
                        </>
                      ) : (
                        <>
                          Move <span>—</span>
                        </>
                      )}
                    </div>
                    <div className="bpm-info">{practiceInfo}</div>
                  </div>
                  <div className="time-code">{fmtTime(state.sharedTime)}</div>
                </div>
              </div>

              <div className="move-timeline">
                <div className="move-tl-label">Move Breakdown</div>
                <div
                  className="move-tl-track"
                  ref={moveTimelineTrackRef}
                  onClick={handleMoveTimelineClick}
                >
                  {currentPracticeSegment &&
                    state.practice.moves.map((move, index) => {
                      const segDuration =
                        currentPracticeSegment.shared_end_sec - currentPracticeSegment.shared_start_sec;
                      const moveReady =
                        activeMoveReadiness.moveReadyBySegment[state.practice.segmentIndex]?.[index] ?? false;
                      return (
                        <div
                          key={`move-track-${index}`}
                          className={[
                            "move-block",
                            move.isTransition ? "transition-move" : "",
                            index === state.practice.currentMoveIndex ? "active" : "",
                            moveDoneSet.has(index) ? "done" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          style={{
                            left: `${((move.startSec - currentPracticeSegment.shared_start_sec) / segDuration) * 100}%`,
                            width: `${((move.endSec - move.startSec) / segDuration) * 100}%`,
                            opacity: moveReady ? 1 : 0.45,
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            seekToMove(index);
                          }}
                        >
                          <div className="mv-n">Move {move.num}</div>
                          <div className="mv-s">{moveReady ? "Ready" : "Processing"}</div>
                          {move.isTransition && <div className="mv-s">Transition</div>}
                        </div>
                      );
                    })}
                  <div
                    className="move-playhead"
                    style={{
                      left:
                        currentPracticeSegment
                          ? `${((state.sharedTime - currentPracticeSegment.shared_start_sec) /
                              (currentPracticeSegment.shared_end_sec -
                                currentPracticeSegment.shared_start_sec)) *
                              100}%`
                          : "0%",
                    }}
                  />
                </div>
              </div>

              <div className="move-list">
                {state.practice.moves.map((move, index) => {
                  const moveReady =
                    activeMoveReadiness.moveReadyBySegment[state.practice.segmentIndex]?.[index] ?? false;
                  return (
                  <div
                    key={`move-chip-${index}`}
                    className={[
                      "move-chip",
                      move.isTransition ? "transition-move" : "",
                      index === state.practice.currentMoveIndex ? "active" : "",
                      moveDoneSet.has(index) ? "done" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{ opacity: moveReady ? 1 : 0.6 }}
                    onClick={() => seekToMove(index)}
                  >
                    <div className="mv-cn">Move {move.num}</div>
                    <div className="mv-ct">
                      {fmtTime(move.startSec)} - {fmtTime(move.endSec)}
                    </div>
                    <div className={`text-[10px] ${moveReady ? "text-emerald-600" : "text-slate-400"}`}>
                      {moveReady ? "Ready" : "Processing"}
                    </div>
                    {move.isTransition && <div className="mv-cl">Transition</div>}
                  </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
