"use client";

import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { Keypoint, PoseDetector } from '@tensorflow-models/pose-detection';

interface PoseOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  color?: string;
  method?: 'pose-fill' | 'sam3-experimental' | 'sam3-roboflow';
}

function getVisiblePoint(keypoints: Keypoint[], index: number, threshold = 0.3) {
  const point = keypoints[index];
  if (!point || (point.score ?? 0) <= threshold) {
    return null;
  }
  return point;
}

function withAlpha(hexColor: string, alpha: number) {
  const normalized = hexColor.replace('#', '');
  const safeHex = normalized.length === 3
    ? normalized.split('').map((char) => char + char).join('')
    : normalized;

  if (!/^[0-9a-fA-F]{6}$/.test(safeHex)) {
    return `rgba(168, 85, 247, ${alpha})`;
  }

  const red = parseInt(safeHex.slice(0, 2), 16);
  const green = parseInt(safeHex.slice(2, 4), 16);
  const blue = parseInt(safeHex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function drawBodyOverlay(keypoints: Keypoint[], ctx: CanvasRenderingContext2D, fillColor: string) {
  const leftShoulder = getVisiblePoint(keypoints, 5);
  const rightShoulder = getVisiblePoint(keypoints, 6);
  const leftHip = getVisiblePoint(keypoints, 11);
  const rightHip = getVisiblePoint(keypoints, 12);
  const nose = getVisiblePoint(keypoints, 0, 0.2);

  const shoulderWidth =
    leftShoulder && rightShoulder
      ? Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y)
      : 60;

  const torsoWidth = Math.max(shoulderWidth * 0.75, 24);
  const limbWidth = Math.max(shoulderWidth * 0.45, 16);
  const coreFill = withAlpha(fillColor, 0.28);
  const edgeFill = withAlpha(fillColor, 0.52);
  const glowFill = withAlpha(fillColor, 0.18);

  const drawJointCircle = (point: Keypoint | null, radius: number, colorValue: string) => {
    if (!point) return;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = colorValue;
    ctx.fill();
  };

  const drawLimb = (startIndex: number, endIndex: number, width: number) => {
    const start = getVisiblePoint(keypoints, startIndex);
    const end = getVisiblePoint(keypoints, endIndex);
    if (!start || !end) return;

    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.strokeStyle = edgeFill;
    ctx.stroke();

    drawJointCircle(start, width * 0.42, edgeFill);
    drawJointCircle(end, width * 0.42, edgeFill);
  };

  ctx.save();
  ctx.shadowColor = withAlpha(fillColor, 0.45);
  ctx.shadowBlur = 20;

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

  if (leftShoulder && leftHip) {
    drawLimb(5, 11, torsoWidth * 0.65);
  }
  if (rightShoulder && rightHip) {
    drawLimb(6, 12, torsoWidth * 0.65);
  }

  if (nose && leftShoulder && rightShoulder) {
    const headRadius = Math.max(shoulderWidth * 0.28, 18);
    drawJointCircle(nose, headRadius * 1.15, glowFill);
    drawJointCircle(nose, headRadius, edgeFill);
  }

  drawJointCircle(leftShoulder, torsoWidth * 0.28, edgeFill);
  drawJointCircle(rightShoulder, torsoWidth * 0.28, edgeFill);
  drawJointCircle(leftHip, torsoWidth * 0.25, edgeFill);
  drawJointCircle(rightHip, torsoWidth * 0.25, edgeFill);

  ctx.restore();
}

function drawSam3StyleOverlay(keypoints: Keypoint[], ctx: CanvasRenderingContext2D, fillColor: string) {
  const leftShoulder = getVisiblePoint(keypoints, 5);
  const rightShoulder = getVisiblePoint(keypoints, 6);
  const leftHip = getVisiblePoint(keypoints, 11);
  const rightHip = getVisiblePoint(keypoints, 12);
  const nose = getVisiblePoint(keypoints, 0, 0.2);

  const shoulderWidth =
    leftShoulder && rightShoulder
      ? Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y)
      : 60;

  const solidFill = withAlpha(fillColor, 0.46);
  const edgeFill = withAlpha(fillColor, 0.78);
  const glowFill = withAlpha(fillColor, 0.24);
  const torsoExpand = Math.max(shoulderWidth * 0.18, 10);
  const limbWidth = Math.max(shoulderWidth * 0.7, 26);

  const drawCircle = (point: Keypoint | null, radius: number, fill: string) => {
    if (!point) return;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = fill;
    ctx.fill();
  };

  const drawLimb = (startIndex: number, endIndex: number, width: number) => {
    const start = getVisiblePoint(keypoints, startIndex);
    const end = getVisiblePoint(keypoints, endIndex);
    if (!start || !end) return;

    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.strokeStyle = solidFill;
    ctx.stroke();
  };

  ctx.save();
  ctx.shadowColor = withAlpha(fillColor, 0.55);
  ctx.shadowBlur = 24;

  if (leftShoulder && rightShoulder && leftHip && rightHip) {
    ctx.beginPath();
    ctx.moveTo(leftShoulder.x - torsoExpand, leftShoulder.y);
    ctx.lineTo(rightShoulder.x + torsoExpand, rightShoulder.y);
    ctx.lineTo(rightHip.x + torsoExpand * 0.8, rightHip.y);
    ctx.lineTo(leftHip.x - torsoExpand * 0.8, leftHip.y);
    ctx.closePath();
    ctx.fillStyle = solidFill;
    ctx.fill();
  }

  drawLimb(5, 7, limbWidth);
  drawLimb(7, 9, limbWidth * 0.86);
  drawLimb(6, 8, limbWidth);
  drawLimb(8, 10, limbWidth * 0.86);
  drawLimb(11, 13, limbWidth * 1.05);
  drawLimb(13, 15, limbWidth * 0.9);
  drawLimb(12, 14, limbWidth * 1.05);
  drawLimb(14, 16, limbWidth * 0.9);
  drawLimb(5, 11, limbWidth * 0.72);
  drawLimb(6, 12, limbWidth * 0.72);

  if (nose) {
    const headRadius = Math.max(shoulderWidth * 0.35, 22);
    drawCircle(nose, headRadius * 1.15, glowFill);
    drawCircle(nose, headRadius, edgeFill);
  }

  drawCircle(leftShoulder, Math.max(limbWidth * 0.28, 12), edgeFill);
  drawCircle(rightShoulder, Math.max(limbWidth * 0.28, 12), edgeFill);
  drawCircle(leftHip, Math.max(limbWidth * 0.24, 10), edgeFill);
  drawCircle(rightHip, Math.max(limbWidth * 0.24, 10), edgeFill);

  ctx.restore();
}

const PoseOverlay: React.FC<PoseOverlayProps> = ({
  videoRef,
  color = '#00FF00',
  method = 'pose-fill',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [detector, setDetector] = useState<PoseDetector | null>(null);
  const [status, setStatus] = useState<string>('Loading TensorFlow...');
  const [error, setError] = useState<string | null>(null);
  const [roboflowPolygons, setRoboflowPolygons] = useState<number[][][] | null>(null);
  const lastRoboflowFetchRef = useRef<number>(0);
  const roboflowAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let mounted = true;

    const setup = async () => {
      try {
        setStatus('Loading TensorFlow.js...');

        const tf = await import('@tensorflow/tfjs-core');
        await import('@tensorflow/tfjs-backend-webgl');

        setStatus('Setting up WebGL backend...');
        await tf.setBackend('webgl');
        await tf.ready();
        setStatus('Loading MoveNet model...');
        const poseDetection = await import('@tensorflow-models/pose-detection');

        const model = poseDetection.SupportedModels.MoveNet;
        const detectorConfig = {
          modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
        };

        const newDetector = await poseDetection.createDetector(model, detectorConfig);

        if (mounted) {
          setDetector(newDetector);
          setStatus('Ready');
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to initialize pose detector.';
        console.error('Failed to load pose detector:', message);
        if (mounted) {
          setError(message);
          setStatus('Error');
        }
      }
    };

    setup();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      roboflowAbortRef.current?.abort();
    };
  }, []);

  const fetchRoboflowMask = async (video: HTMLVideoElement) => {
    const now = performance.now();
    if (now - lastRoboflowFetchRef.current < 650) return;
    lastRoboflowFetchRef.current = now;

    const w = Math.max(2, Math.round((video.videoWidth || 640) * 0.4));
    const h = Math.max(2, Math.round((video.videoHeight || 480) * 0.4));

    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;
    const offCtx = offscreen.getContext('2d');
    if (!offCtx) return;

    offCtx.drawImage(video, 0, 0, w, h);
    const dataUrl = offscreen.toDataURL('image/jpeg', 0.75);
    const base64 = dataUrl.split(',')[1] || '';
    if (!base64) return;

    roboflowAbortRef.current?.abort();
    roboflowAbortRef.current = new AbortController();

    const response = await fetch('/api/sam3/frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: base64,
        prompt: 'person',
        outputProbThresh: 0.5,
      }),
      signal: roboflowAbortRef.current.signal,
    });

    if (!response.ok) return;
    const json = (await response.json()) as { polygons?: number[][][] };
    if (Array.isArray(json.polygons)) {
      setRoboflowPolygons(json.polygons);
    }
  };

  const drawRoboflowPolygons = useCallback((
    ctx: CanvasRenderingContext2D,
    polygons: number[][][],
    scaleX: number,
    scaleY: number,
  ) => {
    if (polygons.length === 0) return;

    ctx.save();
    ctx.scale(scaleX, scaleY);
    ctx.fillStyle = withAlpha(color, 0.35);
    ctx.strokeStyle = withAlpha(color, 0.75);
    ctx.lineWidth = 2;

    for (const poly of polygons.slice(0, 4)) {
      if (!Array.isArray(poly) || poly.length < 3) continue;
      const [x0, y0] = poly[0] ?? [];
      if (typeof x0 !== 'number' || typeof y0 !== 'number') continue;

      ctx.beginPath();
      ctx.moveTo(x0, y0);
      for (const [x, y] of poly.slice(1)) {
        if (typeof x !== 'number' || typeof y !== 'number') continue;
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
  }, [color]);

  useEffect(() => {
    let animationFrameId: number;

    const detectPose = async () => {
      if (detector && videoRef.current && canvasRef.current) {
        const video = videoRef.current;
        const canvas = canvasRef.current;

        if (video.readyState < 2 || video.paused) {
          animationFrameId = requestAnimationFrame(detectPose);
          return;
        }

        const ctx = canvas.getContext('2d');

        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth || 640;
          canvas.height = video.videoHeight || 480;
        }

        if (ctx && video.videoWidth > 0) {
          try {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            if (method === 'sam3-roboflow') {
              await fetchRoboflowMask(video);
              if (roboflowPolygons) {
                const baseW = Math.max(2, Math.round((video.videoWidth || 640) * 0.4));
                const baseH = Math.max(2, Math.round((video.videoHeight || 480) * 0.4));
                drawRoboflowPolygons(ctx, roboflowPolygons, canvas.width / baseW, canvas.height / baseH);
              }
            } else {
              const poses = await detector.estimatePoses(video);
              if (poses.length > 0 && poses[0].keypoints) {
                if (method === 'sam3-experimental') {
                  drawSam3StyleOverlay(poses[0].keypoints, ctx, color);
                } else {
                  drawBodyOverlay(poses[0].keypoints, ctx, color);
                }
              }
            }
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown pose estimation error';
            console.error('Pose estimation error:', message);
          }
        }
      }
      animationFrameId = requestAnimationFrame(detectPose);
    };

    if (detector) {
      detectPose();
    }

    return () => cancelAnimationFrame(animationFrameId);
  }, [color, detector, drawRoboflowPolygons, method, roboflowPolygons, videoRef]);

  if (status !== 'Ready') {
    return (
      <div className="absolute top-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded z-10">
        {error ? `Pose overlay unavailable: ${error}` : status}
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className="absolute top-0 left-0 w-full h-full pointer-events-none"
      style={{ objectFit: 'cover' }}
    />
  );
};

export default PoseOverlay;
