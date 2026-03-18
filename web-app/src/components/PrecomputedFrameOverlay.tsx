"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export function PrecomputedFrameOverlay(props: {
  videoRef: RefObject<HTMLVideoElement | null>;
  frames: string[];
  fps: number;
}) {
  const { videoRef, frames, fps } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);

  const frameCount = frames.length;
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;

  const cacheRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const lastIdxRef = useRef<number>(-1);

  useEffect(() => {
    const cache = cacheRef.current;
    cache.clear();
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
      img.src = frames[i];
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

    let raf = 0;
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

    const draw = () => {
      syncCanvasSize();
      const t = video.currentTime || 0;
      const dur = video.duration || 0;
      // Prefer duration-proportional indexing (matches exp/mock-up behavior).
      const idx =
        dur > 0
          ? Math.min(frameCount - 1, Math.max(0, Math.round((t / dur) * (frameCount - 1))))
          : Math.min(frameCount - 1, Math.max(0, Math.floor(t * safeFps)));
      const src = frames[idx];
      if (src) {
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
            img.src = src;
            cache.set(idx, img);
          }
        }
      }
      raf = window.requestAnimationFrame(draw);
    };

    raf = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(raf);
  }, [frameCount, frames, safeFps, videoRef]);

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none absolute inset-0 h-full w-full ${ready ? "opacity-100" : "opacity-70"}`}
      style={{ mixBlendMode: "screen" }}
    />
  );
}

