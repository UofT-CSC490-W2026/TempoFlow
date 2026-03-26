"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useEbsViewer } from "./useEbsViewer";
import type { EbsData } from "./types";
import PoseOverlay from "../PoseOverlay";
import SegmentOverlay from "../SegmentOverlay";
import { BodyPixOverlay } from "../BodyPixOverlay";
import { ProgressiveOverlay } from "../ProgressiveOverlay";
import { generateMoveNetOverlayFrames } from "../../lib/movenetOverlayGenerator";
import { generateYoloOverlayFrames, type YoloExecutionProvider } from "../../lib/yoloOverlayGenerator";
import { generateFastSamOverlayFrames } from "../../lib/fastSamOverlayGenerator";
import { generateBodyPixOverlayFrames } from "../../lib/bodyPixOverlayGenerator";
import {
  buildOverlayKey,
  getSessionOverlay,
  storeSessionOverlay,
  type OverlayArtifact,
  type OverlaySegmentArtifact,
  type OverlayType,
} from "../../lib/overlayStorage";
import {
  buildOverlaySegmentPlans,
  createSegmentedOverlayArtifact,
  getOverlaySegmentByIndex,
  isOverlayArtifactComplete,
  overlayArtifactHasRenderableData,
  upsertOverlaySegment,
  type OverlaySegmentPlan,
} from "../../lib/overlaySegments";
import { getSessionVideo } from "../../lib/videoStorage";
import { FeedbackOverlay } from "./FeedbackOverlay";
import type { DanceFeedback } from "../../lib/bodyPixComparison";

type FileDropProps = {
  label: string;
  sublabel: string;
  icon: string;
  accept: string;
  onFile: (file: File) => void;
};

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

function FileDropZone({ label, sublabel, icon, accept, onFile }: FileDropProps) {
  const [loadedName, setLoadedName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleFile = (file: File) => {
    setLoadedName(file.name);
    onFile(file);
  };

  return (
    <div
      className={`ebs-drop-zone${loadedName ? " loaded" : ""}${dragOver ? " dragover" : ""}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) handleFile(file);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
      {loadedName ? (
        <div style={{ fontSize: 13, color: "var(--green)", padding: 4 }}>✓ {loadedName}</div>
      ) : (
        <>
          <div className="ebs-drop-icon">{icon}</div>
          <div className="ebs-drop-label">{label}</div>
          <div className="ebs-drop-sublabel">{sublabel}</div>
        </>
      )}
    </div>
  );
}

export function EbsViewer(props: EbsViewerProps) {
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
  } = useEbsViewer({ refVideo, userVideo });

  const viewerVisible = sessionMode || showViewer;
  const canLaunch = (sessionMode || refLoaded) && (sessionMode || userLoaded) && (sessionMode || jsonLoaded);
  const activeReferenceVideoUrl = sessionProps?.referenceVideoUrl ?? refVideoUrl;
  const activeUserVideoUrl = sessionProps?.userVideoUrl ?? userVideoUrl;
  const sessionEbsData = sessionProps?.ebsData ?? null;
  const sessionReferenceName = sessionProps?.referenceName ?? null;
  const sessionPracticeName = sessionProps?.practiceName ?? null;
  const sessionFooterSlot = sessionProps?.footerSlot ?? null;
  const sessionId = sessionProps?.sessionId ?? null;
  const [overlayMode, setOverlayMode] = useState<"precomputed" | "live">("precomputed");
  const [showMoveNet, setShowMoveNet] = useState(false);
  const [showYolo, setShowYolo] = useState(false);
  const [showYoloPose, setShowYoloPose] = useState(false);
  const [showBodyPix, setShowBodyPix] = useState(false);
  const [showFastSam, setShowFastSam] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [danceFeedback, setDanceFeedback] = useState<DanceFeedback[]>([]);
  const [overlayMethod, setOverlayMethod] = useState<"pose-fill" | "sam3-experimental" | "sam3-roboflow">("pose-fill");
  const [overlayBusy, setOverlayBusy] = useState(false);
  const [overlayStatus, setOverlayStatus] = useState<string | null>(null);
  const [segProvider, setSegProvider] = useState<YoloExecutionProvider>("wasm");
  const [segGenerator, setSegGenerator] = useState<"python" | "browser">("python");
  const [refPoseArtifact, setRefPoseArtifact] = useState<OverlayArtifact | null>(null);
  const [refYoloArtifact, setRefYoloArtifact] = useState<OverlayArtifact | null>(null);
  const [userPoseArtifact, setUserPoseArtifact] = useState<OverlayArtifact | null>(null);
  const [userYoloArtifact, setUserYoloArtifact] = useState<OverlayArtifact | null>(null);
  const [refYoloPoseArmsArtifact, setRefYoloPoseArmsArtifact] = useState<OverlayArtifact | null>(null);
  const [refYoloPoseLegsArtifact, setRefYoloPoseLegsArtifact] = useState<OverlayArtifact | null>(null);
  const [userYoloPoseArmsArtifact, setUserYoloPoseArmsArtifact] = useState<OverlayArtifact | null>(null);
  const [userYoloPoseLegsArtifact, setUserYoloPoseLegsArtifact] = useState<OverlayArtifact | null>(null);
  const [refFastSamArtifact, setRefFastSamArtifact] = useState<OverlayArtifact | null>(null);
  const [userFastSamArtifact, setUserFastSamArtifact] = useState<OverlayArtifact | null>(null);
  const [refBodyPixArtifact, setRefBodyPixArtifact] = useState<OverlayArtifact | null>(null);
  const [userBodyPixArtifact, setUserBodyPixArtifact] = useState<OverlayArtifact | null>(null);
  // Lower FPS dramatically reduces precompute time (model + WebP encode).
  const OVERLAY_FPS = 12;
  const yoloVariant = `${segGenerator}-${segProvider}`;
  const bodyPixVariant = segGenerator === "python" ? "python" : "bodypix24-browser";
  const overlaySegmentPlans = useMemo(() => buildOverlaySegmentPlans(state.ebs), [state.ebs]);
  const missingPrecomputed =
    overlayMode === "precomputed" &&
    ((showYolo &&
      (!overlayArtifactHasRenderableData(refYoloArtifact) ||
        !overlayArtifactHasRenderableData(userYoloArtifact))) ||
      (showYoloPose &&
        (!overlayArtifactHasRenderableData(refYoloPoseArmsArtifact) ||
          !overlayArtifactHasRenderableData(refYoloPoseLegsArtifact) ||
          !overlayArtifactHasRenderableData(userYoloPoseArmsArtifact) ||
          !overlayArtifactHasRenderableData(userYoloPoseLegsArtifact))) ||
      (showBodyPix &&
        (!overlayArtifactHasRenderableData(refBodyPixArtifact) ||
          !overlayArtifactHasRenderableData(userBodyPixArtifact))) ||
      (showMoveNet &&
        (!overlayArtifactHasRenderableData(refPoseArtifact) ||
          !overlayArtifactHasRenderableData(userPoseArtifact))) ||
      (showFastSam &&
        (!overlayArtifactHasRenderableData(refFastSamArtifact) ||
          !overlayArtifactHasRenderableData(userFastSamArtifact))));

  const loadCachedOverlays = useCallback(async () => {
    if (!sessionId) return;
    const variant = overlayMethod;
    const [rp, ry, rpa, rpl, rbp, up, uy, upa, upl, ubp, rf, uf] = await Promise.all([
      getSessionOverlay(buildOverlayKey({ sessionId, type: "movenet", side: "reference", fps: OVERLAY_FPS, variant })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo", side: "reference", fps: OVERLAY_FPS, variant: yoloVariant })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo-pose-arms", side: "reference", fps: OVERLAY_FPS, variant: "python" })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo-pose-legs", side: "reference", fps: OVERLAY_FPS, variant: "python" })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "bodypix", side: "reference", fps: OVERLAY_FPS, variant: bodyPixVariant })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "movenet", side: "practice", fps: OVERLAY_FPS, variant })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo", side: "practice", fps: OVERLAY_FPS, variant: yoloVariant })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo-pose-arms", side: "practice", fps: OVERLAY_FPS, variant: "python" })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo-pose-legs", side: "practice", fps: OVERLAY_FPS, variant: "python" })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "bodypix", side: "practice", fps: OVERLAY_FPS, variant: bodyPixVariant })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "fastsam", side: "reference", fps: OVERLAY_FPS, variant: "wasm" })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "fastsam", side: "practice", fps: OVERLAY_FPS, variant: "wasm" })),
    ]);
    setRefPoseArtifact(rp);
    setRefYoloArtifact(ry);
    setRefYoloPoseArmsArtifact(rpa);
    setRefYoloPoseLegsArtifact(rpl);
    setRefBodyPixArtifact(rbp);
    setUserPoseArtifact(up);
    setUserYoloArtifact(uy);
    setUserYoloPoseArmsArtifact(upa);
    setUserYoloPoseLegsArtifact(upl);
    setUserBodyPixArtifact(ubp);
    setRefFastSamArtifact(rf);
    setUserFastSamArtifact(uf);
  }, [bodyPixVariant, overlayMethod, sessionId, yoloVariant]);

  useEffect(() => {
    void loadCachedOverlays();
  }, [loadCachedOverlays]);

  const generateOverlays = useCallback(
    async (which: "movenet" | "yolo" | "yolo-pose" | "bodypix" | "fastsam") => {
      if (!sessionId || !activeReferenceVideoUrl || !activeUserVideoUrl) return;
      if (overlayBusy) return;
      setOverlayBusy(true);
      setOverlayStatus(null);

      try {
        const processorUrl =
          (process.env.NEXT_PUBLIC_EBS_PROCESSOR_URL as string | undefined) ?? "http://127.0.0.1:8787/api/process";
        const baseUrl = processorUrl.replace(/\/api\/process\s*$/, "");
        const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

        const getVideoSize = (side: "reference" | "practice") => {
          const video = side === "reference" ? refVideo.current : userVideo.current;
          return {
            width: video?.videoWidth || 640,
            height: video?.videoHeight || 480,
          };
        };

        const startBackgroundJob = async (endpoint: "yolo" | "bodypix", form: FormData) => {
          const res = await fetch(`${baseUrl}/api/overlay/${endpoint}/start`, {
            method: "POST",
            body: form,
          });
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(
              `${endpoint.toUpperCase()} overlay start error (${res.status}): ${txt || res.statusText}`,
            );
          }
          const json = (await res.json()) as { job_id?: string };
          if (!json.job_id) {
            throw new Error(`Missing job_id from ${endpoint.toUpperCase()} overlay start`);
          }
          return json.job_id;
        };

        const waitForBackgroundJob = async (
          endpoint: "yolo" | "bodypix",
          jobId: string,
          reportProgress: (progress: number) => void,
        ) => {
          while (true) {
            const stRes = await fetch(
              `${baseUrl}/api/overlay/${endpoint}/status?job_id=${encodeURIComponent(jobId)}`,
            );
            if (!stRes.ok) {
              const txt = await stRes.text().catch(() => "");
              throw new Error(
                `${endpoint.toUpperCase()} overlay status error (${stRes.status}): ${txt || stRes.statusText}`,
              );
            }

            const st = (await stRes.json()) as {
              status: string;
              progress?: number;
              error?: string;
            };
            reportProgress(typeof st.progress === "number" ? st.progress : 0);

            if (st.status === "done") {
              const outRes = await fetch(
                `${baseUrl}/api/overlay/${endpoint}/result?job_id=${encodeURIComponent(jobId)}`,
              );
              if (!outRes.ok) {
                const txt = await outRes.text().catch(() => "");
                throw new Error(
                  `${endpoint.toUpperCase()} overlay result error (${outRes.status}): ${txt || outRes.statusText}`,
                );
              }
              const blob = await outRes.blob();
              return {
                blob,
                mime: outRes.headers.get("content-type") || "video/webm",
              };
            }

            if (st.status === "error") {
              throw new Error(st.error || `${endpoint.toUpperCase()} overlay job failed`);
            }

            await sleep(400);
          }
        };

        const runSegmentedOverlayPipeline = async (params: {
          label: string;
          type: OverlayType;
          variant: string;
          existingReference: OverlayArtifact | null;
          existingPractice: OverlayArtifact | null;
          setReferenceArtifact: (artifact: OverlayArtifact) => void;
          setPracticeArtifact: (artifact: OverlayArtifact) => void;
          referenceMeta?: Record<string, unknown>;
          practiceMeta?: Record<string, unknown>;
          buildReferenceSegment: (
            plan: OverlaySegmentPlan,
            ctx: {
              ordinal: number;
              total: number;
              reportProgress: (progress: number) => void;
            },
          ) => Promise<OverlaySegmentArtifact>;
          buildPracticeSegment: (
            plan: OverlaySegmentPlan,
            ctx: {
              ordinal: number;
              total: number;
              reportProgress: (progress: number) => void;
            },
          ) => Promise<OverlaySegmentArtifact>;
        }) => {
          if (!overlaySegmentPlans.length) {
            return false;
          }

          if (
            isOverlayArtifactComplete(params.existingReference, overlaySegmentPlans.length) &&
            isOverlayArtifactComplete(params.existingPractice, overlaySegmentPlans.length)
          ) {
            setOverlayStatus(`${params.label} overlays already ready.`);
            return true;
          }

          let referenceArtifact = createSegmentedOverlayArtifact({
            existing: params.existingReference,
            type: params.type,
            side: "reference",
            fps: OVERLAY_FPS,
            ...getVideoSize("reference"),
            meta: params.referenceMeta,
          });
          let practiceArtifact = createSegmentedOverlayArtifact({
            existing: params.existingPractice,
            type: params.type,
            side: "practice",
            fps: OVERLAY_FPS,
            ...getVideoSize("practice"),
            meta: params.practiceMeta,
          });

          const referenceKey = buildOverlayKey({
            sessionId,
            type: params.type,
            side: "reference",
            fps: OVERLAY_FPS,
            variant: params.variant,
          });
          const practiceKey = buildOverlayKey({
            sessionId,
            type: params.type,
            side: "practice",
            fps: OVERLAY_FPS,
            variant: params.variant,
          });

          const countReadyPairs = () =>
            overlaySegmentPlans.filter(
              (plan) =>
                getOverlaySegmentByIndex(referenceArtifact, plan.index) &&
                getOverlaySegmentByIndex(practiceArtifact, plan.index),
            ).length;

          for (let idx = 0; idx < overlaySegmentPlans.length; idx += 1) {
            const plan = overlaySegmentPlans[idx];
            const ordinal = idx + 1;
            const existingReferenceSegment = getOverlaySegmentByIndex(referenceArtifact, plan.index);
            const existingPracticeSegment = getOverlaySegmentByIndex(practiceArtifact, plan.index);

            if (existingReferenceSegment && existingPracticeSegment) {
              continue;
            }

            let referenceProgress = existingReferenceSegment ? 1 : 0;
            let practiceProgress = existingPracticeSegment ? 1 : 0;

            const updateSegmentStatus = () => {
              const avgProgress = (referenceProgress + practiceProgress) / 2;
              const pct = Math.max(0, Math.min(100, Math.round(avgProgress * 100)));
              setOverlayStatus(
                `${params.label} segment ${ordinal}/${overlaySegmentPlans.length} processing… ${pct}%`,
              );
            };

            updateSegmentStatus();

            const [nextReferenceSegment, nextPracticeSegment] = await Promise.all([
              existingReferenceSegment
                ? Promise.resolve(existingReferenceSegment)
                : params.buildReferenceSegment(plan, {
                    ordinal,
                    total: overlaySegmentPlans.length,
                    reportProgress: (progress) => {
                      referenceProgress = progress;
                      updateSegmentStatus();
                    },
                  }),
              existingPracticeSegment
                ? Promise.resolve(existingPracticeSegment)
                : params.buildPracticeSegment(plan, {
                    ordinal,
                    total: overlaySegmentPlans.length,
                    reportProgress: (progress) => {
                      practiceProgress = progress;
                      updateSegmentStatus();
                    },
                  }),
            ]);

            referenceArtifact = upsertOverlaySegment(referenceArtifact, nextReferenceSegment);
            practiceArtifact = upsertOverlaySegment(practiceArtifact, nextPracticeSegment);

            await Promise.all([
              storeSessionOverlay(referenceKey, referenceArtifact),
              storeSessionOverlay(practiceKey, practiceArtifact),
            ]);

            params.setReferenceArtifact(referenceArtifact);
            params.setPracticeArtifact(practiceArtifact);

            const nextPendingIndex = overlaySegmentPlans.findIndex(
              (candidate) =>
                !getOverlaySegmentByIndex(referenceArtifact, candidate.index) ||
                !getOverlaySegmentByIndex(practiceArtifact, candidate.index),
            );

            if (nextPendingIndex >= 0) {
              setOverlayStatus(
                `${params.label} segment ${ordinal}/${overlaySegmentPlans.length} ready. ` +
                  `Segment ${nextPendingIndex + 1}/${overlaySegmentPlans.length} is processing in the background…`,
              );
            }
          }

          setOverlayStatus(
            `${params.label} overlays ready. ${countReadyPairs()}/${overlaySegmentPlans.length} segments processed.`,
          );
          return true;
        };

        if (which === "yolo") {
          setOverlayStatus("Generating YOLO overlays…");
          let refArtifact: OverlayArtifact;
          let userArtifact: OverlayArtifact;

          const usedSegmentPipeline = await runSegmentedOverlayPipeline({
            label: "YOLO",
            type: "yolo",
            variant: yoloVariant,
            existingReference: refYoloArtifact,
            existingPractice: userYoloArtifact,
            setReferenceArtifact: setRefYoloArtifact,
            setPracticeArtifact: setUserYoloArtifact,
            referenceMeta: { generator: segGenerator, provider: segProvider },
            practiceMeta: { generator: segGenerator, provider: segProvider },
            buildReferenceSegment: async (plan, ctx) => {
              if (segGenerator === "python") {
                const file = await getSessionVideo(sessionId, "reference");
                if (!file) throw new Error("Missing reference video for this session");

                const form = new FormData();
                form.append("video", file, file.name);
                form.append("color", "#38bdf8");
                form.append("fps", String(OVERLAY_FPS));
                form.append("session_id", sessionId);
                form.append("side", "reference");
                form.append("backend", segProvider);
                form.append("start_sec", String(plan.reference.startSec));
                form.append("end_sec", String(plan.reference.endSec));

                const jobId = await startBackgroundJob("yolo", form);
                const result = await waitForBackgroundJob("yolo", jobId, ctx.reportProgress);
                const size = getVideoSize("reference");
                return {
                  index: plan.index,
                  startSec: plan.reference.startSec,
                  endSec: plan.reference.endSec,
                  fps: OVERLAY_FPS,
                  width: size.width,
                  height: size.height,
                  frameCount: Math.max(
                    1,
                    Math.ceil((plan.reference.endSec - plan.reference.startSec) * OVERLAY_FPS),
                  ),
                  createdAt: new Date().toISOString(),
                  video: result.blob,
                  videoMime: result.mime,
                  meta: { generator: "python", provider: segProvider, segmentIndex: plan.index },
                };
              }

              const frames = await generateYoloOverlayFrames({
                videoUrl: activeReferenceVideoUrl,
                color: "#38bdf8",
                fps: OVERLAY_FPS,
                inferFps: Math.max(4, Math.round(OVERLAY_FPS / 2)),
                provider: segProvider,
                startSec: plan.reference.startSec,
                endSec: plan.reference.endSec,
                onProgress: (completed, total) =>
                  ctx.reportProgress(total > 0 ? completed / total : 0),
              });
              const size = getVideoSize("reference");
              return {
                index: plan.index,
                startSec: plan.reference.startSec,
                endSec: plan.reference.endSec,
                fps: OVERLAY_FPS,
                width: size.width,
                height: size.height,
                frameCount: frames.length,
                createdAt: new Date().toISOString(),
                frames,
                meta: { generator: "browser", provider: segProvider, segmentIndex: plan.index },
              };
            },
            buildPracticeSegment: async (plan, ctx) => {
              if (segGenerator === "python") {
                const file = await getSessionVideo(sessionId, "practice");
                if (!file) throw new Error("Missing practice video for this session");

                const form = new FormData();
                form.append("video", file, file.name);
                form.append("color", "#22c55e");
                form.append("fps", String(OVERLAY_FPS));
                form.append("session_id", sessionId);
                form.append("side", "practice");
                form.append("backend", segProvider);
                form.append("start_sec", String(plan.practice.startSec));
                form.append("end_sec", String(plan.practice.endSec));

                const jobId = await startBackgroundJob("yolo", form);
                const result = await waitForBackgroundJob("yolo", jobId, ctx.reportProgress);
                const size = getVideoSize("practice");
                return {
                  index: plan.index,
                  startSec: plan.practice.startSec,
                  endSec: plan.practice.endSec,
                  fps: OVERLAY_FPS,
                  width: size.width,
                  height: size.height,
                  frameCount: Math.max(
                    1,
                    Math.ceil((plan.practice.endSec - plan.practice.startSec) * OVERLAY_FPS),
                  ),
                  createdAt: new Date().toISOString(),
                  video: result.blob,
                  videoMime: result.mime,
                  meta: { generator: "python", provider: segProvider, segmentIndex: plan.index },
                };
              }

              const frames = await generateYoloOverlayFrames({
                videoUrl: activeUserVideoUrl,
                color: "#22c55e",
                fps: OVERLAY_FPS,
                inferFps: Math.max(4, Math.round(OVERLAY_FPS / 2)),
                provider: segProvider,
                startSec: plan.practice.startSec,
                endSec: plan.practice.endSec,
                onProgress: (completed, total) =>
                  ctx.reportProgress(total > 0 ? completed / total : 0),
              });
              const size = getVideoSize("practice");
              return {
                index: plan.index,
                startSec: plan.practice.startSec,
                endSec: plan.practice.endSec,
                fps: OVERLAY_FPS,
                width: size.width,
                height: size.height,
                frameCount: frames.length,
                createdAt: new Date().toISOString(),
                frames,
                meta: { generator: "browser", provider: segProvider, segmentIndex: plan.index },
              };
            },
          });

          if (usedSegmentPipeline) {
            return;
          }

          if (segGenerator === "python") {
            let referenceProgress = 0;
            let practiceProgress = 0;
            const updateStatus = () => {
              const avgProgress = (referenceProgress + practiceProgress) / 2;
              setOverlayStatus(`YOLO overlays generating… ${Math.round(avgProgress * 100)}%`);
            };

            const startJob = async (side: "reference" | "practice", color: string) => {
              const file = await getSessionVideo(sessionId, side);
              if (!file) throw new Error(`Missing ${side} video for this session`);

              const form = new FormData();
              form.append("video", file, file.name);
              form.append("color", color);
              form.append("fps", String(OVERLAY_FPS));
              form.append("session_id", sessionId);
              form.append("side", side);
              form.append("backend", segProvider);
              return startBackgroundJob("yolo", form);
            };

            const [referenceJobId, practiceJobId] = await Promise.all([
              startJob("reference", "#38bdf8"),
              startJob("practice", "#22c55e"),
            ]);

            const [referenceResult, practiceResult] = await Promise.all([
              waitForBackgroundJob("yolo", referenceJobId, (progress) => {
                referenceProgress = progress;
                updateStatus();
              }),
              waitForBackgroundJob("yolo", practiceJobId, (progress) => {
                practiceProgress = progress;
                updateStatus();
              }),
            ]);

            refArtifact = {
              version: 1,
              type: "yolo",
              side: "reference",
              fps: OVERLAY_FPS,
              ...getVideoSize("reference"),
              frameCount: 0,
              createdAt: new Date().toISOString(),
              video: referenceResult.blob,
              videoMime: referenceResult.mime,
              meta: { generator: "python", provider: segProvider },
            };
            userArtifact = {
              version: 1,
              type: "yolo",
              side: "practice",
              fps: OVERLAY_FPS,
              ...getVideoSize("practice"),
              frameCount: 0,
              createdAt: new Date().toISOString(),
              video: practiceResult.blob,
              videoMime: practiceResult.mime,
              meta: { generator: "python", provider: segProvider },
            };
          } else {
            const refFrames = await generateYoloOverlayFrames({
              videoUrl: activeReferenceVideoUrl,
              color: "#38bdf8",
              fps: OVERLAY_FPS,
              inferFps: Math.max(4, Math.round(OVERLAY_FPS / 2)),
              provider: segProvider,
              onProgress: (c, t) => setOverlayStatus(`YOLO (reference) ${c}/${t}`),
            });
            const userFrames = await generateYoloOverlayFrames({
              videoUrl: activeUserVideoUrl,
              color: "#22c55e",
              fps: OVERLAY_FPS,
              inferFps: Math.max(4, Math.round(OVERLAY_FPS / 2)),
              provider: segProvider,
              onProgress: (c, t) => setOverlayStatus(`YOLO (user) ${c}/${t}`),
            });

            refArtifact = {
              version: 1,
              type: "yolo",
              side: "reference",
              fps: OVERLAY_FPS,
              ...getVideoSize("reference"),
              frameCount: refFrames.length,
              createdAt: new Date().toISOString(),
              frames: refFrames,
              meta: { generator: "browser", provider: segProvider },
            };
            userArtifact = {
              version: 1,
              type: "yolo",
              side: "practice",
              fps: OVERLAY_FPS,
              ...getVideoSize("practice"),
              frameCount: userFrames.length,
              createdAt: new Date().toISOString(),
              frames: userFrames,
              meta: { generator: "browser", provider: segProvider },
            };
          }

          await Promise.all([
            storeSessionOverlay(
              buildOverlayKey({
                sessionId,
                type: "yolo",
                side: "reference",
                fps: OVERLAY_FPS,
                variant: yoloVariant,
              }),
              refArtifact,
            ),
            storeSessionOverlay(
              buildOverlayKey({
                sessionId,
                type: "yolo",
                side: "practice",
                fps: OVERLAY_FPS,
                variant: yoloVariant,
              }),
              userArtifact,
            ),
          ]);

          setRefYoloArtifact(refArtifact);
          setUserYoloArtifact(userArtifact);
          setOverlayStatus("YOLO overlays ready.");
        } else if (which === "yolo-pose") {
          setOverlayStatus("Generating YOLO Pose overlays…");
          const startedAt = Date.now();
          let refProgress = 0;
          let userProgress = 0;

          const updateStatus = () => {
            const avg = (refProgress + userProgress) / 2;
            const left = Math.max(0, Math.round((1 - avg) * 100));
            const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
            setOverlayStatus(`YOLO Pose overlays generating… ${left}% left (${s}s elapsed)`);
          };

          const startPoseJob = async (
            side: "reference" | "practice",
            armsColor: string,
            legsColor: string,
          ) => {
            const file = await getSessionVideo(sessionId, side);
            if (!file) throw new Error(`Missing ${side} video for this session`);

            const form = new FormData();
            form.append("video", file, file.name);
            form.append("arms_color", armsColor);
            form.append("legs_color", legsColor);
            form.append("fps", String(OVERLAY_FPS));
            form.append("session_id", sessionId);
            form.append("side", side);

            const res = await fetch(`${baseUrl}/api/overlay/yolo-pose/start`, {
              method: "POST",
              body: form,
            });
            if (!res.ok) {
              const txt = await res.text().catch(() => "");
              throw new Error(`YOLO Pose start error (${res.status}): ${txt || res.statusText}`);
            }
            const json = (await res.json()) as { job_id?: string };
            if (!json?.job_id) throw new Error("Missing job_id from YOLO Pose start");
            return json.job_id;
          };

          const waitPoseJob = async (jobId: string, side: "reference" | "practice") => {
            while (true) {
              const stRes = await fetch(
                `${baseUrl}/api/overlay/yolo-pose/status?job_id=${encodeURIComponent(jobId)}`,
              );
              if (!stRes.ok) {
                const txt = await stRes.text().catch(() => "");
                throw new Error(`YOLO Pose status error (${stRes.status}): ${txt || stRes.statusText}`);
              }
              const st = (await stRes.json()) as { status: string; progress?: number; error?: string };
              const p = typeof st.progress === "number" ? st.progress : 0;
              if (side === "reference") refProgress = p;
              else userProgress = p;
              updateStatus();

              if (st.status === "done") {
                const [armsRes, legsRes] = await Promise.all([
                  fetch(
                    `${baseUrl}/api/overlay/yolo-pose/result?job_id=${encodeURIComponent(jobId)}&layer=arms`,
                  ),
                  fetch(
                    `${baseUrl}/api/overlay/yolo-pose/result?job_id=${encodeURIComponent(jobId)}&layer=legs`,
                  ),
                ]);
                if (!armsRes.ok || !legsRes.ok) {
                  const [armsTxt, legsTxt] = await Promise.all([
                    armsRes.text().catch(() => ""),
                    legsRes.text().catch(() => ""),
                  ]);
                  throw new Error(
                    `YOLO Pose result error (${armsRes.status}/${legsRes.status}): ${armsTxt || legsTxt || "fetch failed"}`,
                  );
                }
                const [armsBlob, legsBlob] = await Promise.all([armsRes.blob(), legsRes.blob()]);
                return {
                  arms: { blob: armsBlob, mime: armsRes.headers.get("content-type") || "video/webm" },
                  legs: { blob: legsBlob, mime: legsRes.headers.get("content-type") || "video/webm" },
                };
              }
              if (st.status === "error") {
                throw new Error(st.error || "YOLO Pose job failed");
              }
              await sleep(500);
            }
          };

          updateStatus();
          const [refJobId, userJobId] = await Promise.all([
            startPoseJob("reference", "#38bdf8", "#6366f1"),
            startPoseJob("practice", "#22c55e", "#f59e0b"),
          ]);

          const [ref, user] = await Promise.all([
            waitPoseJob(refJobId, "reference"),
            waitPoseJob(userJobId, "practice"),
          ]);

          const refArmsArtifact: OverlayArtifact = {
            version: 1,
            type: "yolo-pose-arms",
            side: "reference",
            fps: OVERLAY_FPS,
            ...getVideoSize("reference"),
            frameCount: 0,
            createdAt: new Date().toISOString(),
            video: ref.arms.blob,
            videoMime: ref.arms.mime,
            meta: { generator: "python", part: "arms" },
          };
          const refLegsArtifact: OverlayArtifact = {
            version: 1,
            type: "yolo-pose-legs",
            side: "reference",
            fps: OVERLAY_FPS,
            ...getVideoSize("reference"),
            frameCount: 0,
            createdAt: new Date().toISOString(),
            video: ref.legs.blob,
            videoMime: ref.legs.mime,
            meta: { generator: "python", part: "legs" },
          };
          const userArmsArtifact: OverlayArtifact = {
            version: 1,
            type: "yolo-pose-arms",
            side: "practice",
            fps: OVERLAY_FPS,
            ...getVideoSize("practice"),
            frameCount: 0,
            createdAt: new Date().toISOString(),
            video: user.arms.blob,
            videoMime: user.arms.mime,
            meta: { generator: "python", part: "arms" },
          };
          const userLegsArtifact: OverlayArtifact = {
            version: 1,
            type: "yolo-pose-legs",
            side: "practice",
            fps: OVERLAY_FPS,
            ...getVideoSize("practice"),
            frameCount: 0,
            createdAt: new Date().toISOString(),
            video: user.legs.blob,
            videoMime: user.legs.mime,
            meta: { generator: "python", part: "legs" },
          };

          await Promise.all([
            storeSessionOverlay(
              buildOverlayKey({
                sessionId,
                type: "yolo-pose-arms",
                side: "reference",
                fps: OVERLAY_FPS,
                variant: "python",
              }),
              refArmsArtifact,
            ),
            storeSessionOverlay(
              buildOverlayKey({
                sessionId,
                type: "yolo-pose-legs",
                side: "reference",
                fps: OVERLAY_FPS,
                variant: "python",
              }),
              refLegsArtifact,
            ),
            storeSessionOverlay(
              buildOverlayKey({
                sessionId,
                type: "yolo-pose-arms",
                side: "practice",
                fps: OVERLAY_FPS,
                variant: "python",
              }),
              userArmsArtifact,
            ),
            storeSessionOverlay(
              buildOverlayKey({
                sessionId,
                type: "yolo-pose-legs",
                side: "practice",
                fps: OVERLAY_FPS,
                variant: "python",
              }),
              userLegsArtifact,
            ),
          ]);

          setRefYoloPoseArmsArtifact(refArmsArtifact);
          setRefYoloPoseLegsArtifact(refLegsArtifact);
          setUserYoloPoseArmsArtifact(userArmsArtifact);
          setUserYoloPoseLegsArtifact(userLegsArtifact);
          setOverlayStatus("YOLO Pose overlays ready.");
        } else if (which === "bodypix") {
          setOverlayStatus("Generating BodyPix overlays…");

          const usedSegmentPipeline = await runSegmentedOverlayPipeline({
            label: "BodyPix",
            type: "bodypix",
            variant: bodyPixVariant,
            existingReference: refBodyPixArtifact,
            existingPractice: userBodyPixArtifact,
            setReferenceArtifact: setRefBodyPixArtifact,
            setPracticeArtifact: setUserBodyPixArtifact,
            referenceMeta: { generator: segGenerator },
            practiceMeta: { generator: segGenerator },
            buildReferenceSegment: async (plan, ctx) => {
              if (segGenerator === "python") {
                const file = await getSessionVideo(sessionId, "reference");
                if (!file) throw new Error("Missing reference video for this session");
                const form = new FormData();
                form.append("video", file, file.name);
                form.append("fps", String(OVERLAY_FPS));
                form.append("session_id", sessionId);
                form.append("side", "reference");
                form.append("start_sec", String(plan.reference.startSec));
                form.append("end_sec", String(plan.reference.endSec));
                const jobId = await startBackgroundJob("bodypix", form);
                const result = await waitForBackgroundJob("bodypix", jobId, ctx.reportProgress);
                const size = getVideoSize("reference");
                return {
                  index: plan.index,
                  startSec: plan.reference.startSec,
                  endSec: plan.reference.endSec,
                  fps: OVERLAY_FPS,
                  width: size.width,
                  height: size.height,
                  frameCount: Math.max(
                    1,
                    Math.ceil((plan.reference.endSec - plan.reference.startSec) * OVERLAY_FPS),
                  ),
                  createdAt: new Date().toISOString(),
                  video: result.blob,
                  videoMime: result.mime,
                  meta: { generator: "python", segmentIndex: plan.index },
                };
              }
              const result = await generateBodyPixOverlayFrames({
                videoUrl: activeReferenceVideoUrl,
                fps: OVERLAY_FPS,
                opacity: 0.68,
                startSec: plan.reference.startSec,
                endSec: plan.reference.endSec,
                onProgress: (completed, total) =>
                  ctx.reportProgress(total > 0 ? completed / total : 0),
              });
              return {
                index: plan.index,
                startSec: plan.reference.startSec,
                endSec: plan.reference.endSec,
                fps: result.fps,
                width: result.width,
                height: result.height,
                frameCount: result.frames.length,
                createdAt: new Date().toISOString(),
                frames: result.frames,
                meta: { generator: "browser", segmentIndex: plan.index },
              };
            },
            buildPracticeSegment: async (plan, ctx) => {
              if (segGenerator === "python") {
                const file = await getSessionVideo(sessionId, "practice");
                if (!file) throw new Error("Missing practice video for this session");
                const form = new FormData();
                form.append("video", file, file.name);
                form.append("fps", String(OVERLAY_FPS));
                form.append("session_id", sessionId);
                form.append("side", "practice");
                form.append("start_sec", String(plan.practice.startSec));
                form.append("end_sec", String(plan.practice.endSec));
                const jobId = await startBackgroundJob("bodypix", form);
                const result = await waitForBackgroundJob("bodypix", jobId, ctx.reportProgress);
                const size = getVideoSize("practice");
                return {
                  index: plan.index,
                  startSec: plan.practice.startSec,
                  endSec: plan.practice.endSec,
                  fps: OVERLAY_FPS,
                  width: size.width,
                  height: size.height,
                  frameCount: Math.max(
                    1,
                    Math.ceil((plan.practice.endSec - plan.practice.startSec) * OVERLAY_FPS),
                  ),
                  createdAt: new Date().toISOString(),
                  video: result.blob,
                  videoMime: result.mime,
                  meta: { generator: "python", segmentIndex: plan.index },
                };
              }
              const result = await generateBodyPixOverlayFrames({
                videoUrl: activeUserVideoUrl,
                fps: OVERLAY_FPS,
                opacity: 0.68,
                startSec: plan.practice.startSec,
                endSec: plan.practice.endSec,
                onProgress: (completed, total) =>
                  ctx.reportProgress(total > 0 ? completed / total : 0),
              });
              return {
                index: plan.index,
                startSec: plan.practice.startSec,
                endSec: plan.practice.endSec,
                fps: result.fps,
                width: result.width,
                height: result.height,
                frameCount: result.frames.length,
                createdAt: new Date().toISOString(),
                frames: result.frames,
                meta: { generator: "browser", segmentIndex: plan.index },
              };
            },
          });

          if (usedSegmentPipeline) {
            return;
          }

          let refArtifact: OverlayArtifact;
          let userArtifact: OverlayArtifact;
          if (segGenerator === "python") {
            let referenceProgress = 0;
            let practiceProgress = 0;
            const updateStatus = () => {
              const avgProgress = (referenceProgress + practiceProgress) / 2;
              setOverlayStatus(`BodyPix overlays generating… ${Math.round(avgProgress * 100)}%`);
            };
            const startJob = async (side: "reference" | "practice") => {
              const file = await getSessionVideo(sessionId, side);
              if (!file) throw new Error(`Missing ${side} video for this session`);
              const form = new FormData();
              form.append("video", file, file.name);
              form.append("fps", String(OVERLAY_FPS));
              form.append("session_id", sessionId);
              form.append("side", side);
              return startBackgroundJob("bodypix", form);
            };
            const [referenceJobId, practiceJobId] = await Promise.all([
              startJob("reference"),
              startJob("practice"),
            ]);
            const [referenceResult, practiceResult] = await Promise.all([
              waitForBackgroundJob("bodypix", referenceJobId, (progress) => {
                referenceProgress = progress;
                updateStatus();
              }),
              waitForBackgroundJob("bodypix", practiceJobId, (progress) => {
                practiceProgress = progress;
                updateStatus();
              }),
            ]);
            refArtifact = {
              version: 1,
              type: "bodypix",
              side: "reference",
              fps: OVERLAY_FPS,
              ...getVideoSize("reference"),
              frameCount: 0,
              createdAt: new Date().toISOString(),
              video: referenceResult.blob,
              videoMime: referenceResult.mime,
              meta: { generator: "python" },
            };
            userArtifact = {
              version: 1,
              type: "bodypix",
              side: "practice",
              fps: OVERLAY_FPS,
              ...getVideoSize("practice"),
              frameCount: 0,
              createdAt: new Date().toISOString(),
              video: practiceResult.blob,
              videoMime: practiceResult.mime,
              meta: { generator: "python" },
            };
          } else {
            const ref = await generateBodyPixOverlayFrames({
              videoUrl: activeReferenceVideoUrl,
              fps: OVERLAY_FPS,
              opacity: 0.68,
              onProgress: (c, t) => setOverlayStatus(`BodyPix (reference) ${c}/${t}`),
            });
            const user = await generateBodyPixOverlayFrames({
              videoUrl: activeUserVideoUrl,
              fps: OVERLAY_FPS,
              opacity: 0.68,
              onProgress: (c, t) => setOverlayStatus(`BodyPix (user) ${c}/${t}`),
            });
            refArtifact = {
              version: 1,
              type: "bodypix",
              side: "reference",
              fps: ref.fps,
              width: ref.width,
              height: ref.height,
              frameCount: ref.frames.length,
              createdAt: new Date().toISOString(),
              frames: ref.frames,
              meta: { generator: "browser" },
            };
            userArtifact = {
              version: 1,
              type: "bodypix",
              side: "practice",
              fps: user.fps,
              width: user.width,
              height: user.height,
              frameCount: user.frames.length,
              createdAt: new Date().toISOString(),
              frames: user.frames,
              meta: { generator: "browser" },
            };
          }

          await Promise.all([
            storeSessionOverlay(
              buildOverlayKey({
                sessionId,
                type: "bodypix",
                side: "reference",
                fps: OVERLAY_FPS,
                variant: bodyPixVariant,
              }),
              refArtifact,
            ),
            storeSessionOverlay(
              buildOverlayKey({
                sessionId,
                type: "bodypix",
                side: "practice",
                fps: OVERLAY_FPS,
                variant: bodyPixVariant,
              }),
              userArtifact,
            ),
          ]);

          setRefBodyPixArtifact(refArtifact);
          setUserBodyPixArtifact(userArtifact);
          setOverlayStatus("BodyPix overlays ready.");
        } else if (which === "movenet") {
          setOverlayStatus("Generating MoveNet overlays…");
          const variant = overlayMethod;

          const usedSegmentPipeline = await runSegmentedOverlayPipeline({
            label: "MoveNet",
            type: "movenet",
            variant,
            existingReference: refPoseArtifact,
            existingPractice: userPoseArtifact,
            setReferenceArtifact: setRefPoseArtifact,
            setPracticeArtifact: setUserPoseArtifact,
            referenceMeta: { variant },
            practiceMeta: { variant },
            buildReferenceSegment: async (plan, ctx) => {
              const result = await generateMoveNetOverlayFrames({
                videoUrl: activeReferenceVideoUrl,
                color: "#2563eb",
                fps: OVERLAY_FPS,
                startSec: plan.reference.startSec,
                endSec: plan.reference.endSec,
                onProgress: (completed, total) =>
                  ctx.reportProgress(total > 0 ? completed / total : 0),
              });
              return {
                index: plan.index,
                startSec: plan.reference.startSec,
                endSec: plan.reference.endSec,
                fps: result.fps,
                width: result.width,
                height: result.height,
                frameCount: result.frames.length,
                createdAt: new Date().toISOString(),
                frames: result.frames,
                meta: { variant, segmentIndex: plan.index },
              };
            },
            buildPracticeSegment: async (plan, ctx) => {
              const result = await generateMoveNetOverlayFrames({
                videoUrl: activeUserVideoUrl,
                color: "#10b981",
                fps: OVERLAY_FPS,
                startSec: plan.practice.startSec,
                endSec: plan.practice.endSec,
                onProgress: (completed, total) =>
                  ctx.reportProgress(total > 0 ? completed / total : 0),
              });
              return {
                index: plan.index,
                startSec: plan.practice.startSec,
                endSec: plan.practice.endSec,
                fps: result.fps,
                width: result.width,
                height: result.height,
                frameCount: result.frames.length,
                createdAt: new Date().toISOString(),
                frames: result.frames,
                meta: { variant, segmentIndex: plan.index },
              };
            },
          });

          if (usedSegmentPipeline) {
            return;
          }

          const ref = await generateMoveNetOverlayFrames({
            videoUrl: activeReferenceVideoUrl,
            color: "#2563eb",
            fps: OVERLAY_FPS,
            onProgress: (c, t) => setOverlayStatus(`MoveNet (reference) ${c}/${t}`),
          });
          const user = await generateMoveNetOverlayFrames({
            videoUrl: activeUserVideoUrl,
            color: "#10b981",
            fps: OVERLAY_FPS,
            onProgress: (c, t) => setOverlayStatus(`MoveNet (user) ${c}/${t}`),
          });

          const refArtifact: OverlayArtifact = {
            version: 1,
            type: "movenet",
            side: "reference",
            fps: ref.fps,
            width: ref.width,
            height: ref.height,
            frameCount: ref.frames.length,
            createdAt: new Date().toISOString(),
            frames: ref.frames,
            meta: { variant },
          };
          const userArtifact: OverlayArtifact = {
            version: 1,
            type: "movenet",
            side: "practice",
            fps: user.fps,
            width: user.width,
            height: user.height,
            frameCount: user.frames.length,
            createdAt: new Date().toISOString(),
            frames: user.frames,
            meta: { variant },
          };

          await Promise.all([
            storeSessionOverlay(
              buildOverlayKey({ sessionId, type: "movenet", side: "reference", fps: OVERLAY_FPS, variant }),
              refArtifact,
            ),
            storeSessionOverlay(
              buildOverlayKey({ sessionId, type: "movenet", side: "practice", fps: OVERLAY_FPS, variant }),
              userArtifact,
            ),
          ]);

          setRefPoseArtifact(refArtifact);
          setUserPoseArtifact(userArtifact);
          setOverlayStatus("MoveNet overlays ready.");
        } else {
          setOverlayStatus("Generating FastSAM overlays…");
          const ref = await generateFastSamOverlayFrames({
            videoUrl: activeReferenceVideoUrl,
            color: "#f97316",
            onProgress: (c, t) => setOverlayStatus(`FastSAM (reference) ${c}/${t}`),
          });
          const user = await generateFastSamOverlayFrames({
            videoUrl: activeUserVideoUrl,
            color: "#fb923c",
            onProgress: (c, t) => setOverlayStatus(`FastSAM (user) ${c}/${t}`),
          });

          const refArtifact: OverlayArtifact = {
            version: 1,
            type: "fastsam",
            side: "reference",
            fps: ref.fps,
            width: ref.width,
            height: ref.height,
            frameCount: ref.frames.length,
            createdAt: new Date().toISOString(),
            frames: ref.frames,
          };
          const userArtifact: OverlayArtifact = {
            version: 1,
            type: "fastsam",
            side: "practice",
            fps: user.fps,
            width: user.width,
            height: user.height,
            frameCount: user.frames.length,
            createdAt: new Date().toISOString(),
            frames: user.frames,
          };

          await Promise.all([
            storeSessionOverlay(
              buildOverlayKey({
                sessionId,
                type: "fastsam",
                side: "reference",
                fps: OVERLAY_FPS,
                variant: "wasm",
              }),
              refArtifact,
            ),
            storeSessionOverlay(
              buildOverlayKey({
                sessionId,
                type: "fastsam",
                side: "practice",
                fps: OVERLAY_FPS,
                variant: "wasm",
              }),
              userArtifact,
            ),
          ]);

          setRefFastSamArtifact(refArtifact);
          setUserFastSamArtifact(userArtifact);
          setOverlayStatus("FastSAM overlays ready.");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Overlay generation failed.";
        setOverlayStatus(`Error: ${message}`);
      } finally {
        setOverlayBusy(false);
      }
    },
    [
      activeReferenceVideoUrl,
      activeUserVideoUrl,
      bodyPixVariant,
      overlayBusy,
      overlayMethod,
      overlaySegmentPlans,
      refBodyPixArtifact,
      refPoseArtifact,
      refVideo,
      refYoloArtifact,
      segGenerator,
      segProvider,
      sessionId,
      userBodyPixArtifact,
      userPoseArtifact,
      userVideo,
      userYoloArtifact,
      yoloVariant,
    ],
  );

  useEffect(() => {
    if (sessionMode) return;
    return () => {
      if (refVideoUrl) URL.revokeObjectURL(refVideoUrl);
      if (userVideoUrl) URL.revokeObjectURL(userVideoUrl);
    };
  }, [refVideoUrl, sessionMode, userVideoUrl]);

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
    const id = window.requestAnimationFrame(() => {
      if (state.segments.length) {
        seekToSegment(0);
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [seekToSegment, state.mainPlaybackRate, state.segments.length, viewerVisible]);

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

  const sessionNameTags = useMemo(() => {
    if (!sessionMode) return null;
    return (
      <>
        {sessionReferenceName ? <span className="ebs-tag">{sessionReferenceName}</span> : null}
        {sessionPracticeName ? <span className="ebs-tag">{sessionPracticeName}</span> : null}
      </>
    );
  }, [sessionMode, sessionPracticeName, sessionReferenceName]);

  return (
    <div className="ebs-viewer-root">
      <div className="ebs-header">
        <h1>{sessionMode ? <><span>TempoFlow</span> EBS Session</> : <><span>EBS</span> Segment Viewer</>}</h1>
        <div className="ebs-header-meta">
          {state.ebs && (
            <>
              {sessionNameTags}
              <span className="ebs-tag green">{bpm} BPM</span>
              <span className="ebs-tag">{nb} beats</span>
              <span className="ebs-tag">{state.segments.length} segments</span>
              <span className="ebs-tag orange">{mode}</span>
            </>
          )}
        </div>
      </div>

      {!sessionMode && !viewerVisible && (
        <div className="ebs-setup">
          <div className="ebs-setup-section">
            <h2 className="ebs-setup-title">Step 1 — Load Videos</h2>
            <div className="ebs-drop-row">
              <FileDropZone
                label="Reference Video"
                sublabel="Drop reference.mp4 or click"
                icon="1"
                accept="video/*"
                onFile={(file) => {
                  setVideoObjectUrl(file, refVideoUrl, setRefVideoUrl);
                  setRefLoaded(true);
                  setStatus(null);
                }}
              />
              <FileDropZone
                label="User Video"
                sublabel="Drop user.mp4 or click"
                icon="2"
                accept="video/*"
                onFile={(file) => {
                  setVideoObjectUrl(file, userVideoUrl, setUserVideoUrl);
                  setUserLoaded(true);
                  setStatus(null);
                }}
              />
            </div>
          </div>

          <div className="ebs-setup-section">
            <h2 className="ebs-setup-title">Step 2 — Load EBS JSON</h2>
            <FileDropZone
              label="Drop ebs_segments.json here or click to browse"
              sublabel="Load a previously generated result"
              icon="JSON"
              accept=".json,application/json"
              onFile={handleLoadJsonFile}
            />
          </div>

          {status && (
            <div className={`status-bar visible${status.type ? ` ${status.type}` : ""}`}>
              {status.message}
            </div>
          )}

          <button className="launch-btn visible" disabled={!canLaunch} onClick={handleLaunch}>
            Open Viewer
          </button>
        </div>
      )}
      {viewerVisible && (
        <div className="ebs-viewer visible">
          <div className="ebs-top-bar">
            {sessionMode ? (
            <div className="flex flex-col gap-3 items-end">
              <div className="flex flex-wrap items-center gap-2 justify-end">
                <select
                  value={overlayMode}
                  onChange={(e) => setOverlayMode(e.target.value as "precomputed" | "live")}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700"
                  aria-label="Overlay mode"
                >
                  <option value="precomputed">Precomputed</option>
                  <option value="live">Live</option>
                </select>
                <select
                  value={segGenerator}
                  onChange={(e) => setSegGenerator(e.target.value as "python" | "browser")}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700"
                  aria-label="Overlay generator"
                >
                  <option value="python">Python (fast)</option>
                  <option value="browser">Browser (slow)</option>
                </select>
                <select
                  value={segProvider}
                  onChange={(e) => setSegProvider(e.target.value as YoloExecutionProvider)}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700"
                  aria-label="Segmentation backend"
                >
                  <option value="wasm">CPU (WASM)</option>
                  <option value="webgpu">WebGPU (experimental)</option>
                </select>
                <button
                  onClick={() => setShowMoveNet((v) => !v)}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold border transition-all ${
                    showMoveNet ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-200"
                  }`}
                >
                  MoveNet
                </button>
                <button
                  onClick={() => setShowYolo((v) => !v)}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold border transition-all ${
                    showYolo ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-200"
                  }`}
                >
                  YOLO
                </button>
                <button
                  onClick={() => setShowYoloPose((v) => !v)}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold border transition-all ${
                    showYoloPose ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-200"
                  }`}
                >
                  YOLO Pose
                </button>
                <button
                  onClick={() => setShowBodyPix((v) => !v)}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold border transition-all ${
                    showBodyPix ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-200"
                  }`}
                >
                  BodyPix
                </button>
                <button
                  onClick={() => setShowFastSam((v) => !v)}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold border transition-all ${
                    showFastSam ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-200"
                  }`}
                >
                  FastSAM
                </button>                
                {/* moved to new tab 
                <button
                  onClick={() => setShowFeedback((v) => !v)}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold border transition-all ${
                    showFeedback ? "bg-violet-600 text-white border-violet-600" : "bg-white text-violet-700 border-violet-200 hover:bg-violet-50"
                  }`}
                >
                  Feedback
                </button>*/}
                {/*do we have options for this tho
                 <select
                  value={overlayMethod}
                  onChange={(e) =>
                    setOverlayMethod(e.target.value as "pose-fill" | "sam3-experimental" | "sam3-roboflow")
                  }
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700"
                  disabled={!showMoveNet || overlayMode !== "live"}
                  aria-label="Pose overlay style"
                >
                  <option value="pose-fill">Pose fill</option>
                  <option value="sam3-experimental">SAM3-style</option>
                  <option value="sam3-roboflow">Roboflow SAM3</option>
                </select> */}
                {/* Generation Buttons (Sky themed) */}
                <div className="flex gap-1 ml-2 pl-2 border-l border-slate-200">
                  <button
                    onClick={() => void generateOverlays("movenet")}
                    disabled={overlayBusy || !showMoveNet}
                    className="rounded-full bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 transition-all hover:bg-sky-100 disabled:opacity-50"
                  >
                    Gen MoveNet
                  </button>
                  <button
                    onClick={() => void generateOverlays("yolo")}
                    disabled={overlayBusy || !showYolo}
                    className="rounded-full bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 transition-all hover:bg-sky-100 disabled:opacity-50"
                  >
                    Gen YOLO
                  </button>
                  <button
                    onClick={() => void generateOverlays("bodypix")}
                    disabled={overlayBusy || !showBodyPix}
                    className="rounded-full bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 transition-all hover:bg-sky-100 disabled:opacity-50"
                  >
                    Gen BodyPix
                  </button>
                </div>
                </div>
              </div>
            ) : null}
            {hasSegments ? (
              <div className="ebs-toggle">
                <label htmlFor="chk-pause">Pause at segment end</label>
                <input
                  id="chk-pause"
                  type="checkbox"
                  className="ebs-toggle-switch"
                  checked={state.pauseAtSegmentEnd}
                  onChange={(e) => setPauseAtSegmentEnd(e.target.checked)}
                />
              </div>
            ) : (
              <div className="ebs-inline-note">Aligned videos loaded. No playable segments were detected.</div>
            )}
          </div>
          {overlayStatus ? (
            <div className="mb-3 rounded-2xl border border-sky-100 bg-sky-50 px-4 py-2 text-xs text-slate-700">
              {overlayStatus}
            </div>
          ) : null}
          {sessionMode && missingPrecomputed ? (
            <div className="mb-3 rounded-2xl border border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-900">
              Precomputed overlays are enabled, but frames haven’t been generated yet. Click <b>Gen MoveNet</b> /{" "}
              <b>Gen YOLO</b> / <b>Gen YOLO Pose</b> / <b>Gen BodyPix</b> once, then playback will be synced
              (no realtime lag).
            </div>
          ) : null}

          <div className="videos">
            <div className="video-panel">
              <div className="video-label">
                Reference (Clip 1)
                <span className="time-display">{fmtTimeFull(state.refTime)}</span>
              </div>
              <div className="relative">
                <video ref={refVideo} src={activeReferenceVideoUrl ?? undefined} playsInline />
                {sessionMode && showYolo ? (
                  overlayMode === "precomputed" ? (
                    <ProgressiveOverlay videoRef={refVideo} artifact={refYoloArtifact} />
                  ) : (
                    <SegmentOverlay videoRef={refVideo} color="#38bdf8" />
                  )
                ) : null}
                {sessionMode && showYoloPose ? (
                  overlayMode === "precomputed" ? (
                    <>
                      <ProgressiveOverlay videoRef={refVideo} artifact={refYoloPoseArmsArtifact} />
                      <ProgressiveOverlay videoRef={refVideo} artifact={refYoloPoseLegsArtifact} />
                    </>
                  ) : null
                ) : null}
                {sessionMode && showBodyPix ? (
                  overlayMode === "precomputed" ? (
                    <ProgressiveOverlay videoRef={refVideo} artifact={refBodyPixArtifact} />
                  ) : (
                    <BodyPixOverlay videoRef={refVideo} opacity={0.68} />
                  )
                ) : null}
                {sessionMode && showFastSam ? (
                  overlayMode === "precomputed" ? (
                    <ProgressiveOverlay videoRef={refVideo} artifact={refFastSamArtifact} />
                  ) : null
                ) : null}
                {sessionMode && showMoveNet ? (
                  overlayMode === "precomputed" ? (
                    <ProgressiveOverlay videoRef={refVideo} artifact={refPoseArtifact} />
                  ) : (
                    <PoseOverlay videoRef={refVideo} color="#2563eb" method={overlayMethod} />
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
                User (Clip 2)
                <span className="time-display">{fmtTimeFull(state.userTime)}</span>
              </div>
              <div className="relative">
                <video ref={userVideo} src={activeUserVideoUrl ?? undefined} playsInline />
                {sessionMode && showYolo ? (
                  overlayMode === "precomputed" ? (
                    <ProgressiveOverlay videoRef={userVideo} artifact={userYoloArtifact} />
                  ) : (
                    <SegmentOverlay videoRef={userVideo} color="#22c55e" />
                  )
                ) : null}
                {sessionMode && showYoloPose ? (
                  overlayMode === "precomputed" ? (
                    <>
                      <ProgressiveOverlay videoRef={userVideo} artifact={userYoloPoseArmsArtifact} />
                      <ProgressiveOverlay videoRef={userVideo} artifact={userYoloPoseLegsArtifact} />
                    </>
                  ) : null
                ) : null}
                {sessionMode && showBodyPix ? (
                  overlayMode === "precomputed" ? (
                    <ProgressiveOverlay videoRef={userVideo} artifact={userBodyPixArtifact} />
                  ) : (
                    <BodyPixOverlay videoRef={userVideo} opacity={0.68} />
                  )
                ) : null}
                {sessionMode && showFastSam ? (
                  overlayMode === "precomputed" ? (
                    <ProgressiveOverlay videoRef={userVideo} artifact={userFastSamArtifact} />
                  ) : null
                ) : null}
                {sessionMode && showMoveNet ? (
                  overlayMode === "precomputed" ? (
                    <ProgressiveOverlay videoRef={userVideo} artifact={userPoseArtifact} />
                  ) : (
                    <PoseOverlay videoRef={userVideo} color="#10b981" method={overlayMethod} />
                  )
                ) : null}
                {sessionMode && showFeedback && danceFeedback.length > 0 ? (
                  <FeedbackOverlay
                    refVideoRef={refVideo}
                    videoRef={userVideo}
                    feedback={danceFeedback}
                    sharedTime={state.sharedTime}
                  />
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
{/* moved to new tab
          {sessionMode && showFeedback && activeReferenceVideoUrl && activeUserVideoUrl && state.segments.length > 0 && (
            <div className="mt-4 mb-2">
              <FeedbackPanel
                referenceVideoUrl={activeReferenceVideoUrl}
                userVideoUrl={activeUserVideoUrl}
                segments={state.segments}
                sharedTime={state.sharedTime}
                onSeek={seekToShared}
                onFeedbackReady={setDanceFeedback}
              />
            </div>
          )} */}

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
                  <button className="transport-btn" onClick={toggleMainSpeed} title="Toggle 0.5x speed">
                    {state.mainPlaybackRate === 1 ? "1x" : "0.5x"}
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

              <div className="timeline">
                <div className="timeline-track" ref={timelineTrackRef} onClick={handleTimelineClick}>
                  {state.segments.map((segment, index) => (
                    <div
                      key={`seg-track-${index}`}
                      className={[
                        "timeline-segment",
                        index === state.currentSegmentIndex ? "active" : "",
                        segmentDoneSet.has(index) ? "done" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{
                        left: `${(segment.shared_start_sec / sharedLen) * 100}%`,
                        width: `${((segment.shared_end_sec - segment.shared_start_sec) / sharedLen) * 100}%`,
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        seekToSegment(index);
                      }}
                    >
                      {index}
                    </div>
                  ))}
                  <div
                    className="timeline-playhead"
                    style={{ left: `${sharedLen > 0 ? (state.sharedTime / sharedLen) * 100 : 0}%` }}
                  />
                </div>
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
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            seekToMove(index);
                          }}
                        >
                          <div className="mv-n">Move {move.num}</div>
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
                {state.practice.moves.map((move, index) => (
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
                    onClick={() => seekToMove(index)}
                  >
                    <div className="mv-cn">Move {move.num}</div>
                    <div className="mv-ct">
                      {fmtTime(move.startSec)} - {fmtTime(move.endSec)}
                    </div>
                    {move.isTransition && <div className="mv-cl">Transition</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
