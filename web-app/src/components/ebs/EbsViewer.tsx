"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useEbsViewer } from "./useEbsViewer";
import type { EbsData } from "./types";
import PoseOverlay from "../PoseOverlay";
import SegmentOverlay from "../SegmentOverlay";
import { PrecomputedFrameOverlay } from "../PrecomputedFrameOverlay";
import { PrecomputedVideoOverlay } from "../PrecomputedVideoOverlay";
import { generateMoveNetOverlayFrames } from "../../lib/movenetOverlayGenerator";
import { generateYoloOverlayFrames, type YoloExecutionProvider } from "../../lib/yoloOverlayGenerator";
import { generateFastSamOverlayFrames } from "../../lib/fastSamOverlayGenerator";
import { buildOverlayKey, getSessionOverlay, storeSessionOverlay, type OverlayArtifact } from "../../lib/overlayStorage";
import { getSessionVideo } from "../../lib/videoStorage";

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
  backLabel?: string;
  onBack?: () => void;
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
  const sessionBackLabel = sessionProps?.backLabel ?? "Back";
  const sessionFooterSlot = sessionProps?.footerSlot ?? null;
  const sessionId = sessionProps?.sessionId ?? null;
  const [overlayMode, setOverlayMode] = useState<"precomputed" | "live">("precomputed");
  const [showMoveNet, setShowMoveNet] = useState(false);
  const [showYolo, setShowYolo] = useState(false);
  const [showYoloPose, setShowYoloPose] = useState(false);
  const [showFastSam, setShowFastSam] = useState(false);
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
  // Lower FPS dramatically reduces precompute time (model + WebP encode).
  const OVERLAY_FPS = 12;
  const missingPrecomputed =
    overlayMode === "precomputed" &&
    ((showYolo && (!refYoloArtifact || !userYoloArtifact)) ||
      (showYoloPose &&
        (!refYoloPoseArmsArtifact ||
          !refYoloPoseLegsArtifact ||
          !userYoloPoseArmsArtifact ||
          !userYoloPoseLegsArtifact)) ||
      (showMoveNet && (!refPoseArtifact || !userPoseArtifact)) ||
      (showFastSam && (!refFastSamArtifact || !userFastSamArtifact)));

  const loadCachedOverlays = useCallback(async () => {
    if (!sessionId) return;
    const variant = overlayMethod;
    const [rp, ry, rpa, rpl, up, uy, upa, upl, rf, uf] = await Promise.all([
      getSessionOverlay(buildOverlayKey({ sessionId, type: "movenet", side: "reference", fps: OVERLAY_FPS, variant })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo", side: "reference", fps: OVERLAY_FPS, variant: segProvider })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo-pose-arms", side: "reference", fps: OVERLAY_FPS, variant: "python" })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo-pose-legs", side: "reference", fps: OVERLAY_FPS, variant: "python" })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "movenet", side: "practice", fps: OVERLAY_FPS, variant })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo", side: "practice", fps: OVERLAY_FPS, variant: segProvider })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo-pose-arms", side: "practice", fps: OVERLAY_FPS, variant: "python" })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo-pose-legs", side: "practice", fps: OVERLAY_FPS, variant: "python" })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "fastsam", side: "reference", fps: OVERLAY_FPS, variant: "wasm" })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "fastsam", side: "practice", fps: OVERLAY_FPS, variant: "wasm" })),
    ]);
    setRefPoseArtifact(rp);
    setRefYoloArtifact(ry);
    setRefYoloPoseArmsArtifact(rpa);
    setRefYoloPoseLegsArtifact(rpl);
    setUserPoseArtifact(up);
    setUserYoloArtifact(uy);
    setUserYoloPoseArmsArtifact(upa);
    setUserYoloPoseLegsArtifact(upl);
    setRefFastSamArtifact(rf);
    setUserFastSamArtifact(uf);
  }, [overlayMethod, segProvider, sessionId]);

  useEffect(() => {
    void loadCachedOverlays();
  }, [loadCachedOverlays]);

  const generateOverlays = useCallback(
    async (which: "movenet" | "yolo" | "yolo-pose" | "fastsam") => {
      if (!sessionId || !activeReferenceVideoUrl || !activeUserVideoUrl) return;
      if (overlayBusy) return;
      setOverlayBusy(true);
      setOverlayStatus(null);

      try {
        if (which === "yolo") {
          setOverlayStatus("Generating YOLO overlays…");
          const processorUrl =
            (process.env.NEXT_PUBLIC_EBS_PROCESSOR_URL as string | undefined) ?? "http://127.0.0.1:8787/api/process";
          const baseUrl = processorUrl.replace(/\/api\/process\s*$/, "");

          const generateViaPython = async (side: "reference" | "practice", color: string) => {
            const file = await getSessionVideo(sessionId, side);
            if (!file) throw new Error(`Missing ${side} video for this session`);

            const form = new FormData();
            form.append("video", file, file.name);
            form.append("color", color);
            form.append("fps", String(OVERLAY_FPS));
            form.append("session_id", sessionId);
            form.append("side", side);
            form.append("backend", segProvider);

            const res = await fetch(`${baseUrl}/api/overlay/yolo`, { method: "POST", body: form });
            if (!res.ok) {
              const txt = await res.text().catch(() => "");
              throw new Error(`YOLO overlay service error (${res.status}): ${txt || res.statusText}`);
            }
            const blob = await res.blob();
            return { blob, mime: res.headers.get("content-type") || "video/webm" };
          };

          let refArtifact: OverlayArtifact;
          let userArtifact: OverlayArtifact;

          if (segGenerator === "python") {
            const startedAt = Date.now();
            let refProgress = 0;
            let userProgress = 0;

            const updateStatus = () => {
              const avg = (refProgress + userProgress) / 2;
              const left = Math.max(0, Math.round((1 - avg) * 100));
              const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
              setOverlayStatus(`YOLO overlays generating… ${left}% left (${s}s elapsed)`);
            };

            const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

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

              const res = await fetch(`${baseUrl}/api/overlay/yolo/start`, { method: "POST", body: form });
              if (!res.ok) {
                const txt = await res.text().catch(() => "");
                throw new Error(`YOLO overlay start error (${res.status}): ${txt || res.statusText}`);
              }
              const json = (await res.json()) as { job_id: string };
              if (!json?.job_id) throw new Error("Missing job_id from YOLO overlay start");
              return json.job_id;
            };

            const waitJob = async (jobId: string, side: "reference" | "practice") => {
              // Poll until done.
              // eslint-disable-next-line no-constant-condition
              while (true) {
                const stRes = await fetch(`${baseUrl}/api/overlay/yolo/status?job_id=${encodeURIComponent(jobId)}`);
                if (!stRes.ok) {
                  const txt = await stRes.text().catch(() => "");
                  throw new Error(`YOLO overlay status error (${stRes.status}): ${txt || stRes.statusText}`);
                }
                const st = (await stRes.json()) as { status: string; progress?: number; error?: string };
                const p = typeof st.progress === "number" ? st.progress : 0;
                if (side === "reference") refProgress = p;
                else userProgress = p;
                updateStatus();

                if (st.status === "done") {
                  const outRes = await fetch(
                    `${baseUrl}/api/overlay/yolo/result?job_id=${encodeURIComponent(jobId)}`
                  );
                  if (!outRes.ok) {
                    const txt = await outRes.text().catch(() => "");
                    throw new Error(
                      `YOLO overlay result error (${outRes.status}): ${txt || outRes.statusText}`
                    );
                  }
                  const blob = await outRes.blob();
                  return { blob, mime: outRes.headers.get("content-type") || "video/webm" };
                }
                if (st.status === "error") {
                  throw new Error(st.error || "YOLO overlay job failed");
                }
                await sleep(500);
              }
            };

            updateStatus();
            const [refJobId, userJobId] = await Promise.all([
              startJob("reference", "#38bdf8"),
              startJob("practice", "#22c55e"),
            ]);

            const [ref, user] = await Promise.all([
              waitJob(refJobId, "reference"),
              waitJob(userJobId, "practice"),
            ]);

            refArtifact = {
              version: 1,
              type: "yolo",
              side: "reference",
              fps: OVERLAY_FPS,
              width: refVideo.current?.videoWidth || 640,
              height: refVideo.current?.videoHeight || 480,
              frameCount: 0,
              createdAt: new Date().toISOString(),
              video: ref.blob,
              videoMime: ref.mime,
              meta: { generator: "python", provider: segProvider },
            };
            userArtifact = {
              version: 1,
              type: "yolo",
              side: "practice",
              fps: OVERLAY_FPS,
              width: userVideo.current?.videoWidth || 640,
              height: userVideo.current?.videoHeight || 480,
              frameCount: 0,
              createdAt: new Date().toISOString(),
              video: user.blob,
              videoMime: user.mime,
              meta: { generator: "python", provider: segProvider },
            };
          } else {
            // Browser fallback (slow).
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
              width: refVideo.current?.videoWidth || 640,
              height: refVideo.current?.videoHeight || 480,
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
              width: userVideo.current?.videoWidth || 640,
              height: userVideo.current?.videoHeight || 480,
              frameCount: userFrames.length,
              createdAt: new Date().toISOString(),
              frames: userFrames,
              meta: { generator: "browser", provider: segProvider },
            };
          }

          await Promise.all([
            storeSessionOverlay(
              buildOverlayKey({ sessionId, type: "yolo", side: "reference", fps: OVERLAY_FPS, variant: segProvider }),
              refArtifact,
            ),
            storeSessionOverlay(
              buildOverlayKey({ sessionId, type: "yolo", side: "practice", fps: OVERLAY_FPS, variant: segProvider }),
              userArtifact,
            ),
          ]);

          setRefYoloArtifact(refArtifact);
          setUserYoloArtifact(userArtifact);
          setOverlayStatus("YOLO overlays ready.");
        } else if (which === "yolo-pose") {
          setOverlayStatus("Generating YOLO Pose overlays…");
          const processorUrl =
            (process.env.NEXT_PUBLIC_EBS_PROCESSOR_URL as string | undefined) ?? "http://127.0.0.1:8787/api/process";
          const baseUrl = processorUrl.replace(/\/api\/process\s*$/, "");
          const startedAt = Date.now();
          let refProgress = 0;
          let userProgress = 0;

          const updateStatus = () => {
            const avg = (refProgress + userProgress) / 2;
            const left = Math.max(0, Math.round((1 - avg) * 100));
            const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
            setOverlayStatus(`YOLO Pose overlays generating… ${left}% left (${s}s elapsed)`);
          };

          const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

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

            const res = await fetch(`${baseUrl}/api/overlay/yolo-pose/start`, { method: "POST", body: form });
            if (!res.ok) {
              const txt = await res.text().catch(() => "");
              throw new Error(`YOLO Pose start error (${res.status}): ${txt || res.statusText}`);
            }
            const json = (await res.json()) as { job_id: string };
            if (!json?.job_id) throw new Error("Missing job_id from YOLO Pose start");
            return json.job_id;
          };

          const waitPoseJob = async (jobId: string, side: "reference" | "practice") => {
            while (true) {
              const stRes = await fetch(
                `${baseUrl}/api/overlay/yolo-pose/status?job_id=${encodeURIComponent(jobId)}`
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
                    `${baseUrl}/api/overlay/yolo-pose/result?job_id=${encodeURIComponent(jobId)}&layer=arms`
                  ),
                  fetch(
                    `${baseUrl}/api/overlay/yolo-pose/result?job_id=${encodeURIComponent(jobId)}&layer=legs`
                  ),
                ]);
                if (!armsRes.ok || !legsRes.ok) {
                  const [armsTxt, legsTxt] = await Promise.all([
                    armsRes.text().catch(() => ""),
                    legsRes.text().catch(() => ""),
                  ]);
                  throw new Error(
                    `YOLO Pose result error (${armsRes.status}/${legsRes.status}): ${armsTxt || legsTxt || "fetch failed"}`
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
            width: refVideo.current?.videoWidth || 640,
            height: refVideo.current?.videoHeight || 480,
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
            width: refVideo.current?.videoWidth || 640,
            height: refVideo.current?.videoHeight || 480,
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
            width: userVideo.current?.videoWidth || 640,
            height: userVideo.current?.videoHeight || 480,
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
            width: userVideo.current?.videoWidth || 640,
            height: userVideo.current?.videoHeight || 480,
            frameCount: 0,
            createdAt: new Date().toISOString(),
            video: user.legs.blob,
            videoMime: user.legs.mime,
            meta: { generator: "python", part: "legs" },
          };

          await Promise.all([
            storeSessionOverlay(
              buildOverlayKey({ sessionId, type: "yolo-pose-arms", side: "reference", fps: OVERLAY_FPS, variant: "python" }),
              refArmsArtifact,
            ),
            storeSessionOverlay(
              buildOverlayKey({ sessionId, type: "yolo-pose-legs", side: "reference", fps: OVERLAY_FPS, variant: "python" }),
              refLegsArtifact,
            ),
            storeSessionOverlay(
              buildOverlayKey({ sessionId, type: "yolo-pose-arms", side: "practice", fps: OVERLAY_FPS, variant: "python" }),
              userArmsArtifact,
            ),
            storeSessionOverlay(
              buildOverlayKey({ sessionId, type: "yolo-pose-legs", side: "practice", fps: OVERLAY_FPS, variant: "python" }),
              userLegsArtifact,
            ),
          ]);

          setRefYoloPoseArmsArtifact(refArmsArtifact);
          setRefYoloPoseLegsArtifact(refLegsArtifact);
          setUserYoloPoseArmsArtifact(userArmsArtifact);
          setUserYoloPoseLegsArtifact(userLegsArtifact);
          setOverlayStatus("YOLO Pose overlays ready.");
        } else if (which === "movenet") {
          setOverlayStatus("Generating MoveNet overlays…");
          const variant = overlayMethod;
          // Generate sequentially to avoid contention and keep UI progress readable.
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
              buildOverlayKey({ sessionId, type: "fastsam", side: "reference", fps: OVERLAY_FPS, variant: "wasm" }),
              refArtifact,
            ),
            storeSessionOverlay(
              buildOverlayKey({ sessionId, type: "fastsam", side: "practice", fps: OVERLAY_FPS, variant: "wasm" }),
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
    [activeReferenceVideoUrl, activeUserVideoUrl, overlayBusy, overlayMethod, segProvider, sessionId, refVideo, userVideo],
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

  const handleBack = () => {
    if (sessionMode) {
      sessionProps?.onBack?.();
      return;
    }
    pausePlayback();
    resetViewer();
    setShowViewer(false);
  };

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
            <button className="ebs-back-btn" onClick={handleBack}>
              {sessionMode ? sessionBackLabel : "Load New Videos"}
            </button>
            {sessionMode ? (
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
                  onClick={() => setShowFastSam((v) => !v)}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold border transition-all ${
                    showFastSam ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-200"
                  }`}
                >
                  FastSAM
                </button>
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
                </select>
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
                  onClick={() => void generateOverlays("yolo-pose")}
                  disabled={overlayBusy || !showYoloPose}
                  className="rounded-full bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 transition-all hover:bg-sky-100 disabled:opacity-50"
                >
                  Gen YOLO Pose
                </button>
                <button
                  onClick={() => void generateOverlays("fastsam")}
                  disabled={overlayBusy || !showFastSam}
                  className="rounded-full bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 transition-all hover:bg-sky-100 disabled:opacity-50"
                >
                  Gen FastSAM
                </button>
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
              <b>Gen YOLO</b> / <b>Gen YOLO Pose</b> once, then playback will be synced (no realtime lag).
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
                    refYoloArtifact ? (
                      refYoloArtifact.video ? (
                        <PrecomputedVideoOverlay
                          videoRef={refVideo}
                          overlayBlob={refYoloArtifact.video}
                          mimeType={refYoloArtifact.videoMime}
                        />
                      ) : refYoloArtifact.frames ? (
                        <PrecomputedFrameOverlay videoRef={refVideo} frames={refYoloArtifact.frames} fps={refYoloArtifact.fps} />
                      ) : null
                    ) : null
                  ) : (
                    <SegmentOverlay videoRef={refVideo} color="#38bdf8" />
                  )
                ) : null}
                {sessionMode && showYoloPose ? (
                  overlayMode === "precomputed" ? (
                    <>
                      {refYoloPoseArmsArtifact?.video ? (
                        <PrecomputedVideoOverlay
                          videoRef={refVideo}
                          overlayBlob={refYoloPoseArmsArtifact.video}
                          mimeType={refYoloPoseArmsArtifact.videoMime}
                        />
                      ) : null}
                      {refYoloPoseLegsArtifact?.video ? (
                        <PrecomputedVideoOverlay
                          videoRef={refVideo}
                          overlayBlob={refYoloPoseLegsArtifact.video}
                          mimeType={refYoloPoseLegsArtifact.videoMime}
                        />
                      ) : null}
                    </>
                  ) : null
                ) : null}
                {sessionMode && showFastSam ? (
                  overlayMode === "precomputed" ? (
                    refFastSamArtifact ? (
                      <PrecomputedFrameOverlay
                        videoRef={refVideo}
                        frames={refFastSamArtifact.frames}
                        fps={refFastSamArtifact.fps}
                      />
                    ) : null
                  ) : null
                ) : null}
                {sessionMode && showMoveNet ? (
                  overlayMode === "precomputed" ? (
                    refPoseArtifact ? (
                      <PrecomputedFrameOverlay
                        videoRef={refVideo}
                        frames={refPoseArtifact.frames}
                        fps={refPoseArtifact.fps}
                      />
                    ) : null
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
                    userYoloArtifact ? (
                      userYoloArtifact.video ? (
                        <PrecomputedVideoOverlay
                          videoRef={userVideo}
                          overlayBlob={userYoloArtifact.video}
                          mimeType={userYoloArtifact.videoMime}
                        />
                      ) : userYoloArtifact.frames ? (
                        <PrecomputedFrameOverlay videoRef={userVideo} frames={userYoloArtifact.frames} fps={userYoloArtifact.fps} />
                      ) : null
                    ) : null
                  ) : (
                    <SegmentOverlay videoRef={userVideo} color="#22c55e" />
                  )
                ) : null}
                {sessionMode && showYoloPose ? (
                  overlayMode === "precomputed" ? (
                    <>
                      {userYoloPoseArmsArtifact?.video ? (
                        <PrecomputedVideoOverlay
                          videoRef={userVideo}
                          overlayBlob={userYoloPoseArmsArtifact.video}
                          mimeType={userYoloPoseArmsArtifact.videoMime}
                        />
                      ) : null}
                      {userYoloPoseLegsArtifact?.video ? (
                        <PrecomputedVideoOverlay
                          videoRef={userVideo}
                          overlayBlob={userYoloPoseLegsArtifact.video}
                          mimeType={userYoloPoseLegsArtifact.videoMime}
                        />
                      ) : null}
                    </>
                  ) : null
                ) : null}
                {sessionMode && showFastSam ? (
                  overlayMode === "precomputed" ? (
                    userFastSamArtifact ? (
                      <PrecomputedFrameOverlay
                        videoRef={userVideo}
                        frames={userFastSamArtifact.frames}
                        fps={userFastSamArtifact.fps}
                      />
                    ) : null
                  ) : null
                ) : null}
                {sessionMode && showMoveNet ? (
                  overlayMode === "precomputed" ? (
                    userPoseArtifact ? (
                      <PrecomputedFrameOverlay
                        videoRef={userVideo}
                        frames={userPoseArtifact.frames}
                        fps={userPoseArtifact.fps}
                      />
                    ) : null
                  ) : (
                    <PoseOverlay videoRef={userVideo} color="#10b981" method={overlayMethod} />
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

