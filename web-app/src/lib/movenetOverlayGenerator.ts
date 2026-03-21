"use client";

import type { Keypoint, PoseDetector } from "@tensorflow-models/pose-detection";

const GENERATION_FPS = 30;

function waitForEvent(target: EventTarget, eventName: string) {
  return new Promise<void>((resolve, reject) => {
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Failed while waiting for ${eventName}.`));
    };
    const cleanup = () => {
      target.removeEventListener(eventName, onSuccess);
      target.removeEventListener("error", onError);
    };
    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

async function seekVideo(video: HTMLVideoElement, timeSec: number) {
  const seekPromise = waitForEvent(video, "seeked");
  video.currentTime = timeSec;
  await seekPromise;
}

function withAlpha(hexColor: string, alpha: number) {
  const normalized = hexColor.replace("#", "");
  const safeHex =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized;

  if (!/^[0-9a-fA-F]{6}$/.test(safeHex)) {
    return `rgba(37, 99, 235, ${alpha})`;
  }

  const red = parseInt(safeHex.slice(0, 2), 16);
  const green = parseInt(safeHex.slice(2, 4), 16);
  const blue = parseInt(safeHex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function getVisiblePoint(keypoints: Keypoint[], index: number, threshold = 0.3) {
  const point = keypoints[index];
  if (!point || (point.score ?? 0) <= threshold) return null;
  return point;
}

function drawPoseFill(keypoints: Keypoint[], ctx: CanvasRenderingContext2D, fillColor: string) {
  const leftShoulder = getVisiblePoint(keypoints, 5);
  const rightShoulder = getVisiblePoint(keypoints, 6);
  const leftHip = getVisiblePoint(keypoints, 11);
  const rightHip = getVisiblePoint(keypoints, 12);

  const shoulderWidth =
    leftShoulder && rightShoulder
      ? Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y)
      : 60;
  const limbWidth = Math.max(shoulderWidth * 0.45, 16);

  const edgeFill = withAlpha(fillColor, 0.72);
  const coreFill = withAlpha(fillColor, 0.28);

  const drawLimb = (startIndex: number, endIndex: number, width: number) => {
    const start = getVisiblePoint(keypoints, startIndex);
    const end = getVisiblePoint(keypoints, endIndex);
    if (!start || !end) return;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.strokeStyle = edgeFill;
    ctx.stroke();
  };

  ctx.save();
  ctx.shadowColor = withAlpha(fillColor, 0.35);
  ctx.shadowBlur = 18;

  if (leftShoulder && rightShoulder && leftHip && rightHip) {
    ctx.beginPath();
    ctx.moveTo(leftShoulder.x, leftShoulder.y);
    ctx.lineTo(rightShoulder.x, rightShoulder.y);
    ctx.lineTo(rightHip.x, rightHip.y);
    ctx.lineTo(leftHip.x, leftHip.y);
    ctx.closePath();
    ctx.fillStyle = coreFill;
    ctx.fill();
  }

  drawLimb(5, 7, limbWidth);
  drawLimb(7, 9, limbWidth * 0.92);
  drawLimb(6, 8, limbWidth);
  drawLimb(8, 10, limbWidth * 0.92);
  drawLimb(11, 13, limbWidth * 1.05);
  drawLimb(13, 15, limbWidth);
  drawLimb(12, 14, limbWidth * 1.05);
  drawLimb(14, 16, limbWidth);

  ctx.restore();
}

let detectorPromise: Promise<PoseDetector> | null = null;

async function getDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const tf = await import("@tensorflow/tfjs-core");
      await import("@tensorflow/tfjs-backend-webgl");
      await tf.setBackend("webgl");
      await tf.ready();
      const poseDetection = await import("@tensorflow-models/pose-detection");
      return poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
        modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
      });
    })();
  }
  return detectorPromise;
}

export async function generateMoveNetOverlayFrames(params: {
  videoUrl: string;
  color: string;
  fps?: number;
  onProgress?: (completed: number, total: number) => void;
}): Promise<{ frames: string[]; fps: number; width: number; height: number }> {
  const { videoUrl, color, onProgress } = params;
  const fps = params.fps ?? GENERATION_FPS;

  const detector = await getDetector();

  const video = document.createElement("video");
  video.src = videoUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  await waitForEvent(video, "loadeddata");

  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Video duration is unavailable for MoveNet overlay generation.");
  }

  const width = video.videoWidth || 640;
  const height = video.videoHeight || 480;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to create overlay canvas.");

  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const frames: string[] = [];

  for (let index = 0; index < totalFrames; index += 1) {
    const timeSec = Math.min(duration - 0.001, index / fps);
    await seekVideo(video, Math.max(0, timeSec));

    ctx.clearRect(0, 0, width, height);

    const poses = await detector.estimatePoses(video, { maxPoses: 1, flipHorizontal: false });
    const keypoints = poses?.[0]?.keypoints ?? [];
    if (keypoints.length) {
      drawPoseFill(keypoints, ctx, color);
    }

    frames.push(canvas.toDataURL("image/webp", 0.82));
    onProgress?.(index + 1, totalFrames);
  }

  return { frames, fps, width, height };
}

