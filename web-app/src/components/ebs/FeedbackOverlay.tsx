"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { BodyRegion, DanceFeedback, FeedbackSeverity } from "../../lib/bodyPixComparison";

type BodyPixModule = typeof import("@tensorflow-models/body-pix");
type BodyPixNet = Awaited<ReturnType<BodyPixModule["load"]>>;

type FeedbackOverlayProps = {
  refVideoRef: RefObject<HTMLVideoElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  feedback: DanceFeedback[];
  sharedTime: number;
};

type Kp = { x: number; y: number; score: number };

const SEVERITY_COLORS: Record<FeedbackSeverity, [number, number, number, number]> = {
  good:     [52, 211, 153, 0.12],
  minor:    [251, 191, 36, 0.40],
  moderate: [251, 146, 60, 0.50],
  major:    [248, 113, 113, 0.60],
};

const PART_TO_REGION: Record<number, BodyRegion> = {
  0: "head", 1: "head",
  2: "arms", 3: "arms", 4: "arms", 5: "arms",
  6: "arms", 7: "arms", 8: "arms", 9: "arms",
  10: "arms", 11: "arms",
  12: "torso", 13: "torso",
  14: "legs", 15: "legs", 16: "legs", 17: "legs",
  18: "legs", 19: "legs", 20: "legs", 21: "legs",
  22: "legs", 23: "legs",
};

const SEVERITY_ORDER: FeedbackSeverity[] = ["good", "minor", "moderate", "major"];

const SKELETON_CONNECTIONS: [number, number][] = [
  [5, 6],   // shoulders
  [5, 7],   [7, 9],   // left arm
  [6, 8],   [8, 10],  // right arm
  [5, 11],  [6, 12],  // torso sides
  [11, 12], // hips
  [11, 13], [13, 15], // left leg
  [12, 14], [14, 16], // right leg
  [0, 1],   [0, 2],   // nose-eyes
  [1, 3],   [2, 4],   // eyes-ears
];

const KP_NAMES = [
  "nose", "leftEye", "rightEye", "leftEar", "rightEar",
  "leftShoulder", "rightShoulder", "leftElbow", "rightElbow",
  "leftWrist", "rightWrist", "leftHip", "rightHip",
  "leftKnee", "rightKnee", "leftAnkle", "rightAnkle",
];

function findRegionSeverities(
  feedback: DanceFeedback[],
  sharedTime: number,
  windowSec: number = 1.5,
): Record<BodyRegion, FeedbackSeverity> {
  const result: Record<BodyRegion, FeedbackSeverity> = {
    head: "good", arms: "good", torso: "good", legs: "good", full_body: "good",
  };
  for (const fb of feedback) {
    if (Math.abs(fb.timestamp - sharedTime) > windowSec) continue;
    const sev = fb.severity;
    if (fb.bodyRegion === "full_body") {
      for (const r of ["head", "arms", "torso", "legs"] as BodyRegion[]) {
        if (SEVERITY_ORDER.indexOf(sev) > SEVERITY_ORDER.indexOf(result[r])) {
          result[r] = sev;
        }
      }
      if (SEVERITY_ORDER.indexOf(sev) > SEVERITY_ORDER.indexOf(result.full_body)) {
        result.full_body = sev;
      }
    } else if (SEVERITY_ORDER.indexOf(sev) > SEVERITY_ORDER.indexOf(result[fb.bodyRegion])) {
      result[fb.bodyRegion] = sev;
    }
  }
  return result;
}

function extractKeypoints(
  allPoses: Array<{ keypoints: Array<{ position: { x: number; y: number }; score: number; part: string }> }> | undefined,
): Kp[] {
  return KP_NAMES.map((name) => {
    const kp = allPoses?.[0]?.keypoints?.find((k) => k.part === name);
    return kp
      ? { x: kp.position.x, y: kp.position.y, score: kp.score }
      : { x: 0, y: 0, score: 0 };
  });
}

const MIN_KP_SCORE = 0.3;

/**
 * Ordinary Procrustes Analysis: finds the similarity transform
 * (rotation + uniform scale + translation) that best maps the reference
 * skeleton onto the user skeleton. This handles camera angle differences
 * up to moderate rotations and mirrored setups.
 */
function remapRefToUser(refKps: Kp[], userKps: Kp[]): Kp[] {
  const pairs: Array<{ rx: number; ry: number; ux: number; uy: number }> = [];
  for (let i = 0; i < Math.min(refKps.length, userKps.length); i++) {
    if (refKps[i].score >= MIN_KP_SCORE && userKps[i].score >= MIN_KP_SCORE) {
      pairs.push({ rx: refKps[i].x, ry: refKps[i].y, ux: userKps[i].x, uy: userKps[i].y });
    }
  }
  if (pairs.length < 4) return [];

  const n = pairs.length;
  const refCx = pairs.reduce((s, p) => s + p.rx, 0) / n;
  const refCy = pairs.reduce((s, p) => s + p.ry, 0) / n;
  const userCx = pairs.reduce((s, p) => s + p.ux, 0) / n;
  const userCy = pairs.reduce((s, p) => s + p.uy, 0) / n;

  let sumRefSq = 0;
  let dotSum = 0;   // Σ(rx'·ux' + ry'·uy')
  let crossSum = 0; // Σ(rx'·uy' - ry'·ux')

  for (const p of pairs) {
    const rx = p.rx - refCx;
    const ry = p.ry - refCy;
    const ux = p.ux - userCx;
    const uy = p.uy - userCy;
    sumRefSq += rx * rx + ry * ry;
    dotSum += rx * ux + ry * uy;
    crossSum += rx * uy - ry * ux;
  }

  if (sumRefSq < 1) return [];

  const theta = Math.atan2(crossSum, dotSum);
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);

  // Optimal scale: s = (cosθ·dotSum + sinθ·crossSum) / sumRefSq
  // which simplifies to sqrt(dotSum² + crossSum²) / sumRefSq
  const scale = Math.sqrt(dotSum * dotSum + crossSum * crossSum) / sumRefSq;

  return refKps.map((kp) => {
    if (kp.score < 0.25) return { x: 0, y: 0, score: 0 };
    const cx = kp.x - refCx;
    const cy = kp.y - refCy;
    const rotX = cx * cosT - cy * sinT;
    const rotY = cx * sinT + cy * cosT;
    return {
      x: rotX * scale + userCx,
      y: rotY * scale + userCy,
      score: kp.score,
    };
  });
}

function drawGhostSkeleton(
  ctx: CanvasRenderingContext2D,
  kps: Kp[],
  segW: number,
  segH: number,
  canvasW: number,
  canvasH: number,
) {
  const sx = canvasW / segW;
  const sy = canvasH / segH;

  ctx.save();
  ctx.strokeStyle = "rgba(56, 189, 248, 0.7)";
  ctx.lineWidth = 2.5 * (window.devicePixelRatio || 1);
  ctx.setLineDash([6, 4]);
  ctx.lineCap = "round";

  for (const [a, b] of SKELETON_CONNECTIONS) {
    const ka = kps[a], kb = kps[b];
    if (!ka || !kb || ka.score < 0.25 || kb.score < 0.25) continue;
    ctx.beginPath();
    ctx.moveTo(ka.x * sx, ka.y * sy);
    ctx.lineTo(kb.x * sx, kb.y * sy);
    ctx.stroke();
  }

  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(56, 189, 248, 0.85)";
  const r = 4 * (window.devicePixelRatio || 1);
  for (const kp of kps) {
    if (kp.score < 0.25) continue;
    ctx.beginPath();
    ctx.arc(kp.x * sx, kp.y * sy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

export function FeedbackOverlay({ refVideoRef, videoRef, feedback, sharedTime }: FeedbackOverlayProps) {
  const segCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const skelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const netRef = useRef<BodyPixNet | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  const regionSeverities = useMemo(
    () => findRegionSeverities(feedback, sharedTime),
    [feedback, sharedTime],
  );

  const worstRegion = useMemo(() => {
    let worst: { region: BodyRegion; severity: FeedbackSeverity } | null = null;
    for (const region of ["head", "arms", "torso", "legs"] as BodyRegion[]) {
      const sev = regionSeverities[region];
      if (sev === "good") continue;
      if (!worst || SEVERITY_ORDER.indexOf(sev) > SEVERITY_ORDER.indexOf(worst.severity)) {
        worst = { region, severity: sev };
      }
    }
    return worst;
  }, [regionSeverities]);

  useEffect(() => {
    let mounted = true;
    const setup = async () => {
      try {
        const tf = await import("@tensorflow/tfjs-core");
        await import("@tensorflow/tfjs-backend-webgl");
        await tf.setBackend("webgl");
        await tf.ready();
        const bodyPix = await import("@tensorflow-models/body-pix");
        const net = await bodyPix.load({
          architecture: "MobileNetV1",
          outputStride: 16,
          multiplier: 0.75,
          quantBytes: 2,
        });
        if (!mounted) return;
        netRef.current = net;
        setReady(true);
      } catch {
        if (mounted) setError(true);
      }
    };
    void setup();
    return () => { mounted = false; };
  }, []);

  const regionSeveritiesRef = useRef(regionSeverities);
  regionSeveritiesRef.current = regionSeverities;

  useEffect(() => {
    const userVid = videoRef.current;
    const refVid = refVideoRef.current;
    const segCanvas = segCanvasRef.current;
    const skelCanvas = skelCanvasRef.current;
    const net = netRef.current;
    if (!userVid || !refVid || !segCanvas || !skelCanvas || !net || error) return;

    const segCtx = segCanvas.getContext("2d");
    const skelCtx = skelCanvas.getContext("2d");
    if (!segCtx || !skelCtx) return;

    let raf = 0;
    let running = true;
    let lastInferAt = 0;
    const inferEveryMs = 90;

    const syncCanvasSize = (canvas: HTMLCanvasElement, video: HTMLVideoElement) => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round((video.clientWidth || video.videoWidth) * dpr));
      const h = Math.max(1, Math.round((video.clientHeight || video.videoHeight) * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      return { w, h };
    };

    type SegResult = {
      data: Int32Array;
      width: number;
      height: number;
      allPoses?: Array<{ keypoints: Array<{ position: { x: number; y: number }; score: number; part: string }> }>;
    };

    const inferOpts = {
      flipHorizontal: false,
      internalResolution: "medium" as const,
      segmentationThreshold: 0.5,
      maxDetections: 1,
      scoreThreshold: 0.2,
      nmsRadius: 20,
    };

    const loop = async () => {
      if (!running) return;
      raf = window.requestAnimationFrame(loop);
      if (userVid.readyState < 2 || userVid.videoWidth <= 0) return;
      if (refVid.readyState < 2 || refVid.videoWidth <= 0) return;

      const now = performance.now();
      if (now - lastInferAt < inferEveryMs) return;
      lastInferAt = now;

      const { w, h } = syncCanvasSize(segCanvas, userVid);
      syncCanvasSize(skelCanvas, userVid);

      const [userSeg, refSeg] = await Promise.all([
        net.segmentPersonParts(userVid, inferOpts) as Promise<SegResult>,
        net.segmentPersonParts(refVid, inferOpts) as Promise<SegResult>,
      ]);

      // --- severity-colored body parts ---
      const sevs = regionSeveritiesRef.current;
      const image = segCtx.createImageData(userSeg.width, userSeg.height);
      const data = image.data;

      for (let i = 0; i < userSeg.data.length; i++) {
        const partId = userSeg.data[i];
        if (partId < 0) continue;
        const region = PART_TO_REGION[partId];
        if (!region) continue;
        const sev = sevs[region];
        const [r, g, b, a] = SEVERITY_COLORS[sev];
        const px = i * 4;
        data[px] = r;
        data[px + 1] = g;
        data[px + 2] = b;
        data[px + 3] = Math.round(255 * a);
      }

      const tmp = document.createElement("canvas");
      tmp.width = userSeg.width;
      tmp.height = userSeg.height;
      const tmpCtx = tmp.getContext("2d")!;
      tmpCtx.putImageData(image, 0, 0);

      segCtx.clearRect(0, 0, w, h);
      segCtx.imageSmoothingEnabled = true;
      segCtx.imageSmoothingQuality = "high";
      segCtx.drawImage(tmp, 0, 0, w, h);

      // --- ghost reference skeleton ---
      const refKps = extractKeypoints(refSeg.allPoses);
      const userKps = extractKeypoints(userSeg.allPoses);
      const remapped = remapRefToUser(refKps, userKps);

      skelCtx.clearRect(0, 0, w, h);
      if (remapped.length > 0) {
        drawGhostSkeleton(skelCtx, remapped, userSeg.width, userSeg.height, w, h);
      }
    };

    raf = window.requestAnimationFrame(loop);
    return () => {
      running = false;
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [videoRef, refVideoRef, error, ready]);

  if (error) return null;

  const worstLabelColor =
    worstRegion?.severity === "major" ? "bg-red-500" :
    worstRegion?.severity === "moderate" ? "bg-orange-400" :
    worstRegion?.severity === "minor" ? "bg-amber-400" : "";

  const regionLabels: Record<BodyRegion, string> = {
    head: "Head", arms: "Arms", torso: "Torso", legs: "Legs", full_body: "Body",
  };

  return (
    <>
      <canvas
        ref={segCanvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ mixBlendMode: "multiply", opacity: ready ? 1 : 0 }}
      />
      <canvas
        ref={skelCanvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ opacity: ready ? 1 : 0 }}
      />
      {ready && worstRegion && (
        <div
          className={`pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-white text-[11px] font-semibold shadow-lg transition-all duration-300 ${worstLabelColor}`}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {regionLabels[worstRegion.region]}
        </div>
      )}
      {ready && (
        <div className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-2 rounded-full bg-black/40 px-2.5 py-1 text-[10px] text-white/80 backdrop-blur-sm">
          <span className="inline-block w-3 border-t-2 border-dashed border-sky-400" />
          Reference pose
        </div>
      )}
    </>
  );
}
