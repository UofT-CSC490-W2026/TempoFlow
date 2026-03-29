"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { calculateAlignmentTransform, type Keypoint } from "../lib/normalization";

type BodyPixModule = typeof import("@tensorflow-models/body-pix");
type BodyPixNet = Awaited<ReturnType<BodyPixModule["load"]>>;

interface BodyPixOverlayProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  sourceKeypoints?: Keypoint[] | null;
  opacity?: number;
  color?: { r: number; g: number; b: number };
}

export function BodyPixOverlay({
  videoRef,
  sourceKeypoints,
  opacity = 0.6,
  color = { r: 56, g: 189, b: 248 }, // default cyan
}: BodyPixOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const netRef = useRef<BodyPixNet | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- EFFECT 1: Initialize TensorFlow and BodyPix ---
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
        setError(e instanceof Error ? e.message : "Failed to load BodyPix");
      }
    };
    void setup();
    return () => { mounted = false; };
  }, []);

  // --- EFFECT 2: The Inference and Alignment Loop ---
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
    const inferEveryMs = 60; // ~16 FPS for smooth dance tracking

    const loop = async () => {
      if (!running) return;
      raf = window.requestAnimationFrame(loop);
      
      // Ensure video is playing and has data
      if (video.readyState < 2 || video.videoWidth <= 0) return;

      const now = performance.now();
      if (now - lastInferAt < inferEveryMs) return;
      lastInferAt = now;

      // Match canvas to video display size
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round((video.clientWidth || video.videoWidth) * dpr);
      const h = Math.round((video.clientHeight || video.videoHeight) * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      // 1. Perform Inference (Outputs Mask + Wiremesh Keypoints)
      const result = await net.segmentPersonParts(video, {
        internalResolution: "medium",
        segmentationThreshold: 0.5,
      });

      const targetPose = result.allPoses[0];
      if (!targetPose) return;

      // 2. Create the Mask Image Buffer (Offscreen)
      const offscreen = document.createElement("canvas");
      offscreen.width = result.width;
      offscreen.height = result.height;
      const offCtx = offscreen.getContext("2d");
      if (!offCtx) return;

      const imgData = offCtx.createImageData(result.width, result.height);
      for (let i = 0; i < result.data.length; i++) {
        if (result.data[i] >= 0) { // If pixel belongs to a body part
          const px = i * 4;
          imgData.data[px] = color.r;
          imgData.data[px + 1] = color.g;
          imgData.data[px + 2] = color.b;
          imgData.data[px + 3] = Math.round(255 * opacity);
        }
      }
      offCtx.putImageData(imgData, 0, 0);

      // 3. Clear and Transform Main Canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();

      if (sourceKeypoints) {
        // Use the wiremesh (allPoses) to calculate the linear transformation
        const matrix = calculateAlignmentTransform(sourceKeypoints, targetPose.keypoints);
        
        if (matrix) {
          // A: Scale to the current display canvas size
          ctx.scale(canvas.width / result.width, canvas.height / result.height);
          // B: Apply the matrix (Rotation, Scale, Translation to match Source)
          ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
        }
      } else {
        // Default: Just scale to fill the canvas
        ctx.scale(canvas.width / result.width, canvas.height / result.height);
      }

      // 4. Draw the Transformed Mask
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(offscreen, 0, 0);

      ctx.restore();
    };

    raf = window.requestAnimationFrame(loop);
    return () => {
      running = false;
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [videoRef, sourceKeypoints, opacity, ready, error]);

  if (error) return null;

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 h-full w-full pointer-events-none transition-opacity duration-300 ${
        ready ? "opacity-100" : "opacity-0"
      }`}
      style={{ mixBlendMode: "screen" }}
    />
  );
}