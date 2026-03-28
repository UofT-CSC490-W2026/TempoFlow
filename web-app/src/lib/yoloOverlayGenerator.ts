"use client";

import type { InferenceSession } from 'onnxruntime-web';

const MODEL_PATH = '/models/yolo26n-seg.onnx';
// Must match the YOLO ONNX model's expected input size.
// (Model is exported for 640x640; keep that to avoid dimension errors.)
const INPUT_SIZE = 640;
const CONF_THRESH = 0.4;
const IOU_THRESH = 0.45;
const PERSON_CLASS = 0;
const NUM_CLASSES = 80;
const MAX_DETECTIONS = 4;
const DEFAULT_GENERATION_FPS = 15;

export type YoloExecutionProvider = "wasm" | "webgpu";

type Detection = {
  box: [number, number, number, number];
  score: number;
  maskCoeffs: number[];
};

let ortModulePromise: Promise<typeof import('onnxruntime-web')> | null = null;
const sessionPromises = new Map<YoloExecutionProvider, Promise<InferenceSession>>();

function getOrt() {
  if (!ortModulePromise) {
    ortModulePromise = import('onnxruntime-web').then((ort) => {
      ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';
      const hc = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4;
      ort.env.wasm.numThreads = Math.max(1, Math.min(8, (hc || 4) - 1));
      return ort;
    });
  }
  return ortModulePromise;
}

async function getSession() {
  throw new Error("Use getSessionForProvider(provider) instead.");
}

async function getSessionForProvider(provider: YoloExecutionProvider) {
  const existing = sessionPromises.get(provider);
  if (existing) return existing;
  const promise = getOrt().then((ort) =>
    ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: provider === "webgpu" ? ["webgpu", "wasm"] : ["wasm"],
      graphOptimizationLevel: "all",
    }),
  );
  sessionPromises.set(provider, promise);
  return promise;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function iou(a: number[], b: number[]): number {
  const ix1 = Math.max(a[0], b[0]);
  const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]);
  const iy2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter + 1e-6);
}

function nms(dets: Detection[]): Detection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const keep: Detection[] = [];
  for (const d of sorted) {
    if (keep.every((k) => iou(d.box, k.box) < IOU_THRESH)) keep.push(d);
  }
  return keep;
}

function preprocessFrame(sourceCanvas: HTMLCanvasElement) {
  const vw = sourceCanvas.width;
  const vh = sourceCanvas.height;
  const scale = Math.min(INPUT_SIZE / vw, INPUT_SIZE / vh);
  const sw = Math.round(vw * scale);
  const sh = Math.round(vh * scale);
  const padLeft = Math.round((INPUT_SIZE - sw) / 2);
  const padTop = Math.round((INPUT_SIZE - sh) / 2);

  const offscreen = document.createElement('canvas');
  offscreen.width = INPUT_SIZE;
  offscreen.height = INPUT_SIZE;
  const ctx = offscreen.getContext('2d');
  if (!ctx) throw new Error('Failed to create preprocessing canvas.');

  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(sourceCanvas, padLeft, padTop, sw, sh);

  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const tensor = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < plane; i++) {
    tensor[i] = data[i * 4] / 255;
    tensor[i + plane] = data[i * 4 + 1] / 255;
    tensor[i + plane * 2] = data[i * 4 + 2] / 255;
  }

  return { tensor, scaleX: scale, scaleY: scale, padLeft, padTop };
}

function decodeDetections(params: {
  preds: Float32Array;
  numAnchors: number;
  numMaskCoeffs: number;
  scaleX: number;
  scaleY: number;
  padLeft: number;
  padTop: number;
  videoWidth: number;
  videoHeight: number;
}): Detection[] {
  const { preds, numAnchors, numMaskCoeffs, scaleX, scaleY, padLeft, padTop, videoWidth, videoHeight } = params;
  const detections: Detection[] = [];

  for (let i = 0; i < numAnchors; i++) {
    const personScore = preds[(4 + PERSON_CLASS) * numAnchors + i];
    if (personScore < CONF_THRESH) continue;

    const cx = preds[i];
    const cy = preds[numAnchors + i];
    const bw = preds[2 * numAnchors + i];
    const bh = preds[3 * numAnchors + i];

    const vx1 = Math.max(0, ((cx - bw / 2) - padLeft) / scaleX);
    const vy1 = Math.max(0, ((cy - bh / 2) - padTop) / scaleY);
    const vx2 = Math.min(videoWidth, ((cx + bw / 2) - padLeft) / scaleX);
    const vy2 = Math.min(videoHeight, ((cy + bh / 2) - padTop) / scaleY);

    if (vx2 - vx1 < 4 || vy2 - vy1 < 4) continue;

    const maskCoeffs: number[] = [];
    const coeffStart = (4 + NUM_CLASSES) * numAnchors;
    for (let m = 0; m < numMaskCoeffs; m++) {
      maskCoeffs.push(preds[coeffStart + m * numAnchors + i]);
    }

    detections.push({ box: [vx1, vy1, vx2, vy2], score: personScore, maskCoeffs });
  }

  return nms(detections).slice(0, MAX_DETECTIONS);
}

function computeMask(coeffs: number[], protos: Float32Array, maskSize: number, numMaskCoeffs: number): Float32Array {
  const n = maskSize * maskSize;
  const mask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let j = 0; j < numMaskCoeffs; j++) {
      v += coeffs[j] * protos[j * n + i];
    }
    // soft mask: sigmoid(v) instead of hard 0/1
    const alpha = 1 / (1 + Math.exp(-v));
    mask[i] = alpha;
  }
  return mask;
}

function drawMasks(
  ctx: CanvasRenderingContext2D,
  detections: Detection[],
  protos: Float32Array,
  maskSize: number,
  numMaskCoeffs: number,
  scaleX: number,
  scaleY: number,
  padLeft: number,
  padTop: number,
  color: string,
) {
  const [r, g, b] = hexToRgb(color);
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = maskSize;
  maskCanvas.height = maskSize;
  const maskCtx = maskCanvas.getContext("2d");
  if (!maskCtx) return;

  const dstX = -padLeft / scaleX;
  const dstY = -padTop / scaleY;
  const dstW = INPUT_SIZE / scaleX;
  const dstH = INPUT_SIZE / scaleY;

  // Smooth scaling from 160x160 → full res
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  for (const det of detections) {
    const mask = computeMask(det.maskCoeffs, protos, maskSize, numMaskCoeffs);
    const imageData = maskCtx.createImageData(maskSize, maskSize);
    const buf = imageData.data;

    for (let i = 0; i < maskSize * maskSize; i++) {
      const alpha = mask[i];
      if (alpha <= 0.05) continue;
      buf[i * 4] = r;
      buf[i * 4 + 1] = g;
      buf[i * 4 + 2] = b;
      // scale soft alpha into 0–255, with a max around 180 for a glow-like feel
      buf[i * 4 + 3] = Math.min(200, Math.round(alpha * 255));
    }

    maskCtx.putImageData(imageData, 0, 0);

    const [bx1, by1, bx2, by2] = det.box;
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      Math.max(0, bx1 - 2),
      Math.max(0, by1 - 2),
      Math.min(ctx.canvas.width, bx2 + 2) - Math.max(0, bx1 - 2),
      Math.min(ctx.canvas.height, by2 + 2) - Math.max(0, by1 - 2),
    );
    ctx.clip();
    ctx.drawImage(maskCanvas, dstX, dstY, dstW, dstH);
    ctx.restore();
  }
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
      target.removeEventListener('error', onError);
    };
    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

export async function generateYoloOverlayFrames(params: {
  videoUrl: string;
  color: string;
  fps?: number; // output fps (frame count)
  inferFps?: number; // how often to actually run the model
  provider?: YoloExecutionProvider;
  startSec?: number;
  endSec?: number;
  onProgress?: (completed: number, total: number) => void;
}): Promise<Array<string | Blob>> {
  const { videoUrl, color, onProgress } = params;
  const fps = params.fps ?? DEFAULT_GENERATION_FPS;
  const inferFps = Math.max(0.5, Math.min(fps, params.inferFps ?? Math.min(6, fps)));
  const provider: YoloExecutionProvider = params.provider ?? "wasm";
  const [ort, session] = await Promise.all([getOrt(), getSessionForProvider(provider)]);
  const inputName = session.inputNames?.[0] ?? "images";

  const video = document.createElement('video');
  video.src = videoUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  await waitForEvent(video, 'loadeddata');

  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Video duration is unavailable for YOLO overlay generation.');
  }

  const segmentStartSec = Math.max(0, Math.min(duration, params.startSec ?? 0));
  const rawSegmentEndSec = params.endSec ?? duration;
  const segmentEndSec = Math.max(segmentStartSec, Math.min(duration, rawSegmentEndSec));
  const segmentDurationSec = segmentEndSec - segmentStartSec;
  if (segmentDurationSec <= 0) {
    throw new Error("YOLO overlay segment duration must be greater than 0.");
  }

  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = video.videoWidth || 640;
  sourceCanvas.height = video.videoHeight || 480;
  const sourceCtx = sourceCanvas.getContext('2d');
  if (!sourceCtx) throw new Error('Failed to create source canvas.');

  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = sourceCanvas.width;
  outputCanvas.height = sourceCanvas.height;
  const outputCtx = outputCanvas.getContext('2d');
  if (!outputCtx) throw new Error('Failed to create output canvas.');
  outputCtx.imageSmoothingEnabled = true;
  outputCtx.imageSmoothingQuality = "high";

  const totalFrames = Math.max(1, Math.ceil(segmentDurationSec * fps));
  const frames: Array<string | Blob> = [];

  // Sequential decode: play forward and sample frames via RVFC (no seeking).
  const rvfc = (video as HTMLVideoElement & {
    requestVideoFrameCallback?: (
      callback: (now: number, metadata: { mediaTime?: number }) => void,
    ) => number;
  }).requestVideoFrameCallback;

  let cancelled = false;
  let inFlight = false;
  let lastSampleTime = -1;

  const processFrameAt = async (t: number) => {
    if (cancelled) return;
    inFlight = true;
    try {
      sourceCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
      sourceCtx.drawImage(video, 0, 0, sourceCanvas.width, sourceCanvas.height);

      const { tensor, scaleX, scaleY, padLeft, padTop } = preprocessFrame(sourceCanvas);
      const inputTensor = new ort.Tensor("float32", tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]);
      const results = await session.run({ [inputName]: inputTensor });

      const tensors = Object.values(results) as unknown as Array<{
        data: unknown;
        dims?: readonly number[];
      }>;
      const predsTensor = tensors.find((tt) => Array.isArray(tt.dims) && tt.dims.length === 3) as
        | { data: Float32Array; dims: number[] }
        | undefined;
      const protoTensor = tensors.find((tt) => Array.isArray(tt.dims) && (tt.dims.length === 4 || tt.dims.length === 3)) as
        | { data: Float32Array; dims: number[] }
        | undefined;
      if (!predsTensor || !protoTensor) return;

      const preds = predsTensor.data as Float32Array;
      const protos = protoTensor.data as Float32Array;
      const numAnchors = predsTensor.dims[2] ?? 8400;
      const featLen = predsTensor.dims[1] ?? (4 + NUM_CLASSES + 32);
      const numMaskCoeffs = Math.max(0, featLen - 4 - NUM_CLASSES);
      const maskSize =
        protoTensor.dims.length >= 4
          ? protoTensor.dims[2]
          : Math.round(Math.sqrt(protos.length / Math.max(1, numMaskCoeffs)));

      const detections = decodeDetections({
        preds,
        numAnchors,
        numMaskCoeffs,
        scaleX,
        scaleY,
        padLeft,
        padTop,
        videoWidth: sourceCanvas.width,
        videoHeight: sourceCanvas.height,
      });

      outputCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
      drawMasks(outputCtx, detections, protos, maskSize, numMaskCoeffs, scaleX, scaleY, padLeft, padTop, color);
      const blob = await new Promise<Blob>((resolve, reject) => {
        outputCanvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Failed to encode overlay frame."))),
          "image/webp",
          0.8,
        );
      });
      frames.push(blob);
      onProgress?.(Math.min(frames.length, totalFrames), totalFrames);
    } finally {
      inFlight = false;
    }
  };

  let lastOverlay: Blob | null = null;
  const pushOverlay = (overlay: Blob | null) => {
    // If we haven’t inferred yet, store an empty transparent frame.
    if (!overlay) {
      // 1x1 transparent WebP blob is annoying to generate; reuse a tiny blank PNG instead.
      const blank = new Blob(
        [
          Uint8Array.from([
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8,
            6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0,
            1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
          ]),
        ],
        { type: "image/png" },
      );
      frames.push(blank);
    } else {
      frames.push(overlay);
    }
    onProgress?.(Math.min(frames.length, totalFrames), totalFrames);
  };

  if (!rvfc) {
    // Fallback: old seek-based path if RVFC unsupported.
    const inferEvery = Math.max(1, Math.round(fps / inferFps));
    for (let index = 0; index < totalFrames; index += 1) {
      const timeSec = Math.min(segmentEndSec - 0.001, segmentStartSec + index / fps);
      const seekPromise = waitForEvent(video, "seeked");
      video.currentTime = Math.max(0, timeSec);
      await seekPromise;
      if (index % inferEvery === 0) {
        const before = frames.length;
        await processFrameAt(timeSec);
        const produced = frames.length > before ? (frames[frames.length - 1] as Blob) : null;
        lastOverlay = produced;
      } else {
        pushOverlay(lastOverlay);
      }
    }
    return frames;
  }

  const onVideoFrame = async (_now: number, metadata: { mediaTime?: number }) => {
    if (cancelled) return;
    const t = metadata.mediaTime ?? video.currentTime ?? 0;
    const step = 1 / fps;
    const inferEvery = Math.max(1, Math.round(fps / inferFps));
    const nextIndex = frames.length;
    if (t < segmentStartSec - 1e-3) {
      video.requestVideoFrameCallback?.(onVideoFrame);
      return;
    }
    if (!inFlight && (lastSampleTime < 0 || t - lastSampleTime >= step - 1e-3)) {
      lastSampleTime = t;
      if (nextIndex % inferEvery === 0) {
        const before = frames.length;
        await processFrameAt(t);
        const produced = frames.length > before ? (frames[frames.length - 1] as Blob) : null;
        lastOverlay = produced;
      } else {
        pushOverlay(lastOverlay);
      }
      if (frames.length >= totalFrames || t >= segmentEndSec - 0.02) {
        cancelled = true;
        video.pause();
        return;
      }
    }
    video.requestVideoFrameCallback?.(onVideoFrame);
  };

  // Start decode
  video.currentTime = segmentStartSec;
  await waitForEvent(video, "seeked").catch(() => undefined);
  await video.play().catch(() => undefined);
  video.requestVideoFrameCallback(onVideoFrame);

  // Wait until done
  while (!cancelled) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 50));
  }
  while (frames.length < totalFrames) {
    pushOverlay(lastOverlay);
  }
  return frames;
}
