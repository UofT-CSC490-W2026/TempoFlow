"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export function PrecomputedFrameOverlay(props: {
  videoRef: RefObject<HTMLVideoElement | null>;
  frames: Array<string | Blob>;
  fps: number;
}) {
  const { videoRef, frames, fps } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);

  const frameCount = frames.length;
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;

  const cacheRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const urlCacheRef = useRef<Map<number, string>>(new Map());
  const lastIdxRef = useRef<number>(-1);

  useEffect(() => {
    const cache = cacheRef.current;
    const urlCache = urlCacheRef.current;
    cache.clear();
    for (const u of urlCache.values()) URL.revokeObjectURL(u);
    urlCache.clear();
    if (!frameCount) return;

    // Warm a small window (first few frames) for quick first render.
    const warmCount = Math.min(12, frameCount);
    let cancelled = false;
    let loaded = 0;

    for (let i = 0; i < warmCount; i += 1) {
      const img = new Image();
      img.onload = () => {
        loaded += 1;
        if (loaded === 1 && !cancelled) {
          setReady(true);
        }
        if (!cancelled && loaded >= Math.min(3, warmCount)) {
          setReady(true);
        }
      };
      const f = frames[i];
      if (typeof f === "string") {
        img.src = f;
      } else {
        const url = URL.createObjectURL(f);
        urlCache.set(i, url);
        img.src = url;
      }
      cache.set(i, img);
    }

    return () => {
      cancelled = true;
    };
  }, [frameCount, frames]);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cache = cacheRef.current;

    const syncCanvasSize = () => {
      const cssW = video.clientWidth || 0;
      const cssH = video.clientHeight || 0;
      if (cssW <= 0 || cssH <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(cssW * dpr));
      const h = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    const computeIndex = (t: number) => {
      // Prefer FPS-based indexing because frames were generated at index/fps.
      if (frameCount > 0) {
        return Math.min(frameCount - 1, Math.max(0, Math.round(t * safeFps)));
      }
      return 0;
    };

    const drawAtTime = (t: number) => {
      syncCanvasSize();
      const idx = computeIndex(t);
      const src = frames[idx];
      if (src != null) {
        if (idx !== lastIdxRef.current) {
          lastIdxRef.current = idx;
          const cached = cache.get(idx);
          if (cached) {
            if (cached.complete && cached.naturalWidth > 0) {
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              ctx.drawImage(cached, 0, 0, canvas.width, canvas.height);
            }
          } else {
            const img = new Image();
            img.onload = () => {
              // Only draw if we’re still on the same frame index
              if (lastIdxRef.current !== idx) return;
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            };
            if (typeof src === "string") {
              img.src = src;
            } else {
              const existing = urlCacheRef.current.get(idx);
              if (existing) {
                img.src = existing;
              } else {
                const url = URL.createObjectURL(src);
                urlCacheRef.current.set(idx, url);
                img.src = url;
              }
            }
            cache.set(idx, img);
          }
        }
      }
    };

    let raf = 0;
    let cancelled = false;
    // Use requestVideoFrameCallback for tight sync when available.
    const rvfc = (video as HTMLVideoElement & {
      requestVideoFrameCallback?: (
        callback: (now: number, metadata: { mediaTime?: number }) => void,
      ) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    }).requestVideoFrameCallback;
    const cancelRvfc = (video as HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void })
      .cancelVideoFrameCallback;

    let rvfcHandle = 0;
    const onVideoFrame = (_now: number, metadata: { mediaTime?: number }) => {
      if (cancelled) return;
      const t = metadata.mediaTime ?? video.currentTime ?? 0;
      drawAtTime(t);
      rvfcHandle = rvfc ? rvfc.call(video, onVideoFrame) : 0;
    };

    const onRaf = () => {
      if (cancelled) return;
      drawAtTime(video.currentTime || 0);
      raf = window.requestAnimationFrame(onRaf);
    };

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
  }, [frameCount, frames, safeFps, videoRef]);

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none absolute inset-0 h-full w-full ${ready ? "opacity-100" : "opacity-70"}`}
      style={{ mixBlendMode: "screen" }}
    />
  );
}

