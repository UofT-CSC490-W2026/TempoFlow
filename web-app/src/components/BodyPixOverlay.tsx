"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

type BodyPixModule = typeof import("@tensorflow-models/body-pix");
type BodyPixNet = Awaited<ReturnType<BodyPixModule["load"]>>;

const BODYPIX_PART_COLORS: Array<[number, number, number]> = [
  [110, 64, 170],
  [106, 72, 183],
  [100, 81, 196],
  [92, 91, 206],
  [84, 101, 214],
  [75, 113, 221],
  [66, 125, 224],
  [56, 138, 226],
  [48, 150, 224],
  [40, 163, 220],
  [33, 176, 214],
  [29, 188, 205],
  [26, 199, 194],
  [26, 210, 182],
  [28, 219, 169],
  [33, 227, 155],
  [41, 234, 141],
  [51, 240, 128],
  [64, 243, 116],
  [79, 246, 105],
  [96, 247, 97],
  [115, 246, 91],
  [134, 245, 88],
  [155, 243, 88],
];

export function BodyPixOverlay(props: {
  videoRef: RefObject<HTMLVideoElement | null>;
  opacity?: number;
}) {
  const { videoRef, opacity = 0.68 } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const netRef = useRef<BodyPixNet | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      } catch (e) {
        if (!mounted) return;
        setError(e instanceof Error ? e.message : "BodyPix load failed.");
      }
    };
    void setup();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const net = netRef.current;
    if (!video || !canvas || !net || error) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let running = true;
    let lastInferAt = 0;
    const inferEveryMs = 80; // ~12.5Hz, keeps browser responsive

    const loop = async () => {
      if (!running) return;
      raf = window.requestAnimationFrame(loop);
      if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return;

      const now = performance.now();
      if (now - lastInferAt < inferEveryMs) return;
      lastInferAt = now;

      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round((video.clientWidth || video.videoWidth) * dpr));
      const h = Math.max(1, Math.round((video.clientHeight || video.videoHeight) * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      const seg = (await net.segmentPersonParts(video, {
        flipHorizontal: false,
        internalResolution: "medium",
        segmentationThreshold: 0.5,
        maxDetections: 1,
        scoreThreshold: 0.2,
        nmsRadius: 20,
      })) as { data: Int32Array; width: number; height: number };

      const image = ctx.createImageData(seg.width, seg.height);
      const data = image.data;
      const parts = seg.data;

      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        if (part < 0) continue;
        const px = i * 4;

        const c = BODYPIX_PART_COLORS[part] ?? [56, 189, 248];
        data[px] = c[0];
        data[px + 1] = c[1];
        data[px + 2] = c[2];
        data[px + 3] = Math.round(255 * opacity);
      }

      const offscreen = document.createElement("canvas");
      offscreen.width = seg.width;
      offscreen.height = seg.height;
      const off = offscreen.getContext("2d");
      if (!off) return;
      off.putImageData(image, 0, 0);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
    };

    raf = window.requestAnimationFrame(loop);
    return () => {
      running = false;
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [videoRef, error, opacity, ready]);

  if (error) return null;
  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none absolute inset-0 h-full w-full ${ready ? "opacity-100" : "opacity-80"}`}
      style={{ mixBlendMode: "screen" }}
    />
  );
}

