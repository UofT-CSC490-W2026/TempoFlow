"use client";

import type { InferenceSession } from "onnxruntime-web";

const MODEL_PATH = "/models/fastsam-s.onnx";
const INPUT_SIZE = 512; // adjust if your FastSAM export expects a different size
const GENERATION_FPS = 30;

type DetectionMask = Float32Array; // flattened H×W soft mask

let ortModulePromise: Promise<typeof import("onnxruntime-web")> | null = null;
let sessionPromise: Promise<InferenceSession> | null = null;

function getOrt() {
  if (!ortModulePromise) {
    ortModulePromise = import("onnxruntime-web").then((ort) => {
      ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/";
      ort.env.wasm.numThreads = 1;
      return ort;
    });
  }
  return ortModulePromise;
}

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = getOrt().then((ort) =>
      ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      }),
    );
  }
  return sessionPromise;
}

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
  if (Math.abs(video.currentTime - timeSec) < 0.001) return;
  const seekPromise = waitForEvent(video, "seeked");
  video.currentTime = timeSec;
  await seekPromise;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function preprocessFrame(video: HTMLVideoElement) {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const scale = Math.min(INPUT_SIZE / vw, INPUT_SIZE / vh);
  const sw = Math.round(vw * scale);
  const sh = Math.round(vh * scale);
  const padLeft = Math.round((INPUT_SIZE - sw) / 2);
  const padTop = Math.round((INPUT_SIZE - sh) / 2);

  const offscreen = document.createElement("canvas");
  offscreen.width = INPUT_SIZE;
  offscreen.height = INPUT_SIZE;
  const ctx = offscreen.getContext("2d");
  if (!ctx) throw new Error("Failed to create preprocessing canvas.");

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(video, padLeft, padTop, sw, sh);

  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const tensor = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < plane; i++) {
    tensor[i] = data[i * 4] / 255;
    tensor[i + plane] = data[i * 4 + 1] / 255;
    tensor[i + plane * 2] = data[i * 4 + 2] / 255;
  }

  return { tensor, padLeft, padTop, scale, width: vw, height: vh };
}

function decodeFastSamMask(output: Float32Array): DetectionMask {
  // Assume output is [1,1,H,W] flattened; adjust indexing if your model differs.
  return output;
}

function drawFastSamMask(
  ctx: CanvasRenderingContext2D,
  mask: DetectionMask,
  maskSize: number,
  videoWidth: number,
  videoHeight: number,
  padLeft: number,
  padTop: number,
  scale: number,
  color: string,
) {
  const [r, g, b] = hexToRgb(color);

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = maskSize;
  maskCanvas.height = maskSize;
  const maskCtx = maskCanvas.getContext("2d");
  if (!maskCtx) return;

  const imageData = maskCtx.createImageData(maskSize, maskSize);
  const buf = imageData.data;

  for (let i = 0; i < maskSize * maskSize; i++) {
    const alpha = mask[i];
    if (alpha <= 0.05) continue;
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = Math.min(200, Math.round(alpha * 255));
  }

  maskCtx.putImageData(imageData, 0, 0);

  const dstX = -padLeft / scale;
  const dstY = -padTop / scale;
  const dstW = INPUT_SIZE / scale;
  const dstH = INPUT_SIZE / scale;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, videoWidth, videoHeight);
  ctx.clip();
  ctx.drawImage(maskCanvas, dstX, dstY, dstW, dstH);
  ctx.restore();
}

export async function generateFastSamOverlayFrames(params: {
  videoUrl: string;
  color: string;
  onProgress?: (completed: number, total: number) => void;
}): Promise<{ frames: string[]; fps: number; width: number; height: number }> {
  const { videoUrl, color, onProgress } = params;
  const [ort, session] = await Promise.all([getOrt(), getSession()]);
  const inputName = session.inputNames?.[0] ?? "image";

  const video = document.createElement("video");
  video.src = videoUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  await waitForEvent(video, "loadeddata");

  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Video duration is unavailable for FastSAM overlay generation.");
  }

  const width = video.videoWidth || 640;
  const height = video.videoHeight || 480;

  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = width;
  outputCanvas.height = height;
  const outputCtx = outputCanvas.getContext("2d");
  if (!outputCtx) throw new Error("Failed to create FastSAM output canvas.");

  const totalFrames = Math.max(1, Math.ceil(duration * GENERATION_FPS));
  const frames: string[] = [];

  for (let index = 0; index < totalFrames; index += 1) {
    const timeSec = Math.min(duration - 0.001, index / GENERATION_FPS);
    await seekVideo(video, Math.max(0, timeSec));

    const { tensor, padLeft, padTop, scale } = preprocessFrame(video);
    const inputTensor = new ort.Tensor("float32", tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]);

    const results = await session.run({ [inputName]: inputTensor });
    const firstKey = Object.keys(results)[0];
    const maskTensor = results[firstKey];
    if (!maskTensor) continue;
    const maskData = maskTensor.data as Float32Array;

    const maskSize = Math.sqrt(maskData.length);
    if (!Number.isFinite(maskSize)) continue;

    outputCtx.clearRect(0, 0, width, height);
    drawFastSamMask(outputCtx, decodeFastSamMask(maskData), maskSize | 0, width, height, padLeft, padTop, scale, color);
    frames.push(outputCanvas.toDataURL("image/webp", 0.9));
    onProgress?.(index + 1, totalFrames);
  }

  return { frames, fps: GENERATION_FPS, width, height };
}

