"use client";

import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { InferenceSession } from 'onnxruntime-web';

// ─── Constants ───────────────────────────────────────────────────────────────
const MODEL_PATH = '/models/yolo26n-seg.onnx';
const INPUT_SIZE = 640;
const MASK_SIZE = 160;       // output1 spatial dim (160×160 prototypes)
const MASK_RATIO = INPUT_SIZE / MASK_SIZE; // 4
const CONF_THRESH = 0.4;
const IOU_THRESH = 0.45;
const PERSON_CLASS = 0;      // COCO class 0 = "person"
const NUM_CLASSES = 80;
const NUM_MASK_COEFFS = 32;
const NUM_ANCHORS = 8400;
const MAX_DETECTIONS = 4;    // draw at most 4 people per frame

// ─── Types ───────────────────────────────────────────────────────────────────
interface Detection {
  box: [number, number, number, number]; // vx1 vy1 vx2 vy2 in video coords
  score: number;
  maskCoeffs: number[];
}

interface SegmentOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  color?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * Letterbox-resize video frame into a 640×640 Float32Array in CHW order [0,1].
 * Returns scaling/padding info needed to map detections back to video space.
 */
function letterboxFrame(video: HTMLVideoElement): {
  tensor: Float32Array;
  scaleX: number;
  scaleY: number;
  padLeft: number;
  padTop: number;
} {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(INPUT_SIZE / vw, INPUT_SIZE / vh);
  const sw = Math.round(vw * scale);
  const sh = Math.round(vh * scale);
  const padLeft = Math.round((INPUT_SIZE - sw) / 2);
  const padTop = Math.round((INPUT_SIZE - sh) / 2);

  const offscreen = document.createElement('canvas');
  offscreen.width = INPUT_SIZE;
  offscreen.height = INPUT_SIZE;
  const ctx = offscreen.getContext('2d')!;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(video, padLeft, padTop, sw, sh);

  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const tensor = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < plane; i++) {
    tensor[i]           = data[i * 4]     / 255; // R
    tensor[i + plane]   = data[i * 4 + 1] / 255; // G
    tensor[i + plane*2] = data[i * 4 + 2] / 255; // B
  }
  return { tensor, scaleX: scale, scaleY: scale, padLeft, padTop };
}

/** IoU of two [x1 y1 x2 y2] boxes */
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

/** Greedy NMS — returns kept indices sorted by score desc */
function nms(dets: Detection[]): Detection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const keep: Detection[] = [];
  for (const d of sorted) {
    if (keep.every(k => iou(d.box, k.box) < IOU_THRESH)) keep.push(d);
  }
  return keep;
}

/**
 * Decode output0 [1,116,8400] into per-person detections in video coords.
 * output0 layout: feature axis = 116 (cx cy w h + 80 cls scores + 32 mask coeffs),
 *                 anchor axis = 8400.
 * To read feature f of anchor i: data[f * NUM_ANCHORS + i]
 */
function decodeDetections(
  preds: Float32Array,
  scaleX: number,
  scaleY: number,
  padLeft: number,
  padTop: number,
  videoWidth: number,
  videoHeight: number,
): Detection[] {
  const detections: Detection[] = [];

  for (let i = 0; i < NUM_ANCHORS; i++) {
    const personScore = preds[(4 + PERSON_CLASS) * NUM_ANCHORS + i];
    if (personScore < CONF_THRESH) continue;

    // Box in input-image coords (centre format)
    const cx = preds[0 * NUM_ANCHORS + i];
    const cy = preds[1 * NUM_ANCHORS + i];
    const bw = preds[2 * NUM_ANCHORS + i];
    const bh = preds[3 * NUM_ANCHORS + i];

    // Convert to video-pixel coords (removing letterbox padding & scale)
    const vx1 = Math.max(0, ((cx - bw / 2) - padLeft) / scaleX);
    const vy1 = Math.max(0, ((cy - bh / 2) - padTop)  / scaleY);
    const vx2 = Math.min(videoWidth,  ((cx + bw / 2) - padLeft) / scaleX);
    const vy2 = Math.min(videoHeight, ((cy + bh / 2) - padTop)  / scaleY);

    if (vx2 - vx1 < 4 || vy2 - vy1 < 4) continue;

    const maskCoeffs: number[] = [];
    const coeffStart = (4 + NUM_CLASSES) * NUM_ANCHORS;
    for (let m = 0; m < NUM_MASK_COEFFS; m++) {
      maskCoeffs.push(preds[coeffStart + m * NUM_ANCHORS + i]);
    }

    detections.push({ box: [vx1, vy1, vx2, vy2], score: personScore, maskCoeffs });
  }

  return nms(detections).slice(0, MAX_DETECTIONS);
}

/**
 * Compute a 160×160 binary mask for one detection.
 * mask[j] = sigmoid(dot(maskCoeffs, protos[:, j]))
 */
function computeMask(
  coeffs: number[],
  protos: Float32Array, // [32 * 160 * 160]
): Uint8Array {
  const n = MASK_SIZE * MASK_SIZE;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let j = 0; j < NUM_MASK_COEFFS; j++) {
      v += coeffs[j] * protos[j * n + i];
    }
    // sigmoid > 0.5  ⟺  v > 0
    mask[i] = v > 0 ? 1 : 0;
  }
  return mask;
}

// ─── Component ───────────────────────────────────────────────────────────────
const SegmentOverlay: React.FC<SegmentOverlayProps> = ({
  videoRef,
  color = '#00FF00',
}) => {
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const sessionRef    = useRef<InferenceSession | null>(null);
  const ortRef        = useRef<typeof import('onnxruntime-web') | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null); // reusable 160×160 canvas
  const animFrameRef  = useRef<number>(0);
  const lastInferRef  = useRef<number>(0);
  const inFlightRef   = useRef<boolean>(false);
  const cancelledRef  = useRef<boolean>(false);

  const [status, setStatus] = useState('Loading YOLO model…');
  const [error,  setError]  = useState<string | null>(null);

  const [r, g, b] = hexToRgb(color);

  // ── Load ONNX model once ──────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    cancelledRef.current = false;

    const load = async () => {
      try {
        const ort = await import('onnxruntime-web');
        ortRef.current = ort;

        // Point WASM runtime at CDN to avoid Next.js WASM-serving issues
        ort.env.wasm.wasmPaths =
          'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';
        // Single-threaded WASM avoids SharedArrayBuffer / COEP requirement
        ort.env.wasm.numThreads = 1;

        setStatus('Creating inference session…');
        const session = await ort.InferenceSession.create(MODEL_PATH, {
          // WASM-only is far more stable; WebGPU frequently crashes with OOB in some setups.
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });

        if (!mounted) return;
        sessionRef.current = session;
        // Allocate a reusable 160×160 mask canvas
        const mc = document.createElement('canvas');
        mc.width  = MASK_SIZE;
        mc.height = MASK_SIZE;
        maskCanvasRef.current = mc;
        setStatus('Ready');
      } catch (err) {
        if (!mounted) return;
        const msg = err instanceof Error ? err.message : 'Failed to load YOLO model.';
        setError(msg);
        setStatus('Error');
      }
    };

    load();
    return () => {
      mounted = false;
      cancelledRef.current = true;
      cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  // ── Draw detected masks on canvas ────────────────────────────────────────
  const drawMasks = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      detections: Detection[],
      protos: Float32Array,
      scaleX: number,
      scaleY: number,
      padLeft: number,
      padTop: number,
    ) => {
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      if (detections.length === 0 || !maskCanvasRef.current) return;

      const mc    = maskCanvasRef.current;
      const mCtx  = mc.getContext('2d')!;
      const cw    = ctx.canvas.width;
      const ch    = ctx.canvas.height;

      // Where (0,0)→(MASK_SIZE,MASK_SIZE) of the mask maps in canvas-pixel space:
      // mask pixel mx → input px (mx * MASK_RATIO) → video px (mx*MASK_RATIO - padLeft)/scaleX
      const dstX = -padLeft / scaleX;
      const dstY = -padTop  / scaleY;
      const dstW =  INPUT_SIZE / scaleX;
      const dstH =  INPUT_SIZE / scaleY;

      for (const det of detections) {
        const mask  = computeMask(det.maskCoeffs, protos);
        const imgData = mCtx.createImageData(MASK_SIZE, MASK_SIZE);
        const buf     = imgData.data;

        for (let i = 0; i < MASK_SIZE * MASK_SIZE; i++) {
          if (!mask[i]) continue;
          buf[i * 4]     = r;
          buf[i * 4 + 1] = g;
          buf[i * 4 + 2] = b;
          buf[i * 4 + 3] = 140; // ~55 % opacity
        }
        mCtx.putImageData(imgData, 0, 0);

        // Clip drawing to the bounding box so neighbouring regions stay clean
        const [bx1, by1, bx2, by2] = det.box;
        ctx.save();
        ctx.beginPath();
        ctx.rect(
          Math.max(0, bx1 - 2), Math.max(0, by1 - 2),
          Math.min(cw, bx2 + 2) - Math.max(0, bx1 - 2),
          Math.min(ch, by2 + 2) - Math.max(0, by1 - 2),
        );
        ctx.clip();
        ctx.drawImage(mc, dstX, dstY, dstW, dstH);
        ctx.restore();
      }
    },
    [r, g, b],
  );

  // ── Inference loop ────────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== 'Ready') return;

    const loop = async () => {
      const video   = videoRef.current;
      const canvas  = canvasRef.current;
      const session = sessionRef.current;
      const ort     = ortRef.current;

      if (
        video && canvas && session && ort &&
        video.readyState >= 2 &&
        !video.paused &&
        video.videoWidth > 0
      ) {
        const now = performance.now();
        // ~10 fps inference rate — keeps frame budget reasonable
        if (!inFlightRef.current && now - lastInferRef.current >= 100) {
          lastInferRef.current = now;
          inFlightRef.current = true;

          // Sync canvas dimensions to video
          if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
            canvas.width  = video.videoWidth;
            canvas.height = video.videoHeight;
          }

          const ctx = canvas.getContext('2d');
          if (ctx) {
            try {
              if (cancelledRef.current) return;
              const { tensor, scaleX, scaleY, padLeft, padTop } = letterboxFrame(video);
              const inputTensor = new ort.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]);

              const results = await session.run({ images: inputTensor });
              const output0 = results['output0'];
              const output1 = results['output1'];
              if (!output0 || !output1) {
                return;
              }

              const preds  = output0.data as Float32Array;
              const protos = output1.data as Float32Array;

              const detections = decodeDetections(
                preds, scaleX, scaleY, padLeft, padTop,
                video.videoWidth, video.videoHeight,
              );

              drawMasks(ctx, detections, protos, scaleX, scaleY, padLeft, padTop);
            } catch (err) {
              console.error('YOLO inference error:', err);
            } finally {
              inFlightRef.current = false;
            }
          }
        }
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [status, videoRef, drawMasks]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (status !== 'Ready') {
    return (
      <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1 text-xs font-medium text-white">
        {status === 'Error' ? (
          <span title={error ?? ''}>⚠ YOLO unavailable</span>
        ) : (
          <>
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-yellow-400" />
            {status}
          </>
        )}
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className="absolute top-0 left-0 h-full w-full pointer-events-none"
      style={{ objectFit: 'cover' }}
    />
  );
};

export default SegmentOverlay;
