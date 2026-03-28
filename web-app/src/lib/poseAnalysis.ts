"use client";

import * as poseDetection from '@tensorflow-models/pose-detection';
import '@tensorflow/tfjs-backend-webgl';
import * as tf from '@tensorflow/tfjs-core';

import type { PoseSample } from './analysis';

const BODY_GROUPS: Record<string, number[]> = {
  upperBody: [5, 6],
  arms: [7, 8, 9, 10],
  core: [11, 12],
  legs: [13, 14, 15, 16],
};

type PoseDetector = poseDetection.PoseDetector;
type Keypoint = poseDetection.Keypoint;

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function ensureDetector(): Promise<PoseDetector> {
  await tf.setBackend('webgl');
  await tf.ready();

  return poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
    modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
  });
}

async function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    video.onloadedmetadata = () => resolve(video);
    video.onerror = () => reject(new Error('Failed to load video for local analysis.'));
  });
}

async function seekVideo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleSeeked = () => {
      cleanup();
      resolve();
    };

    const handleError = () => {
      cleanup();
      reject(new Error('Failed while seeking video for analysis.'));
    };

    const cleanup = () => {
      video.removeEventListener('seeked', handleSeeked);
      video.removeEventListener('error', handleError);
    };

    video.addEventListener('seeked', handleSeeked);
    video.addEventListener('error', handleError);
    video.currentTime = Math.min(timeSec, Math.max(video.duration - 0.05, 0));
  });
}

function getTorsoScale(keypoints: Keypoint[]) {
  const leftShoulder = keypoints[5];
  const rightShoulder = keypoints[6];
  const leftHip = keypoints[11];
  const rightHip = keypoints[12];

  const width = leftShoulder && rightShoulder ? Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y) : 0;
  const height = leftHip && rightHip ? Math.hypot(leftHip.x - rightHip.x, leftHip.y - rightHip.y) : 0;

  return Math.max(width, height, 1);
}

function normalizeKeypoints(keypoints: Keypoint[]) {
  const visible = keypoints.filter((point) => (point.score ?? 0) > 0.2);
  const centerX = average(visible.map((point) => point.x));
  const centerY = average(visible.map((point) => point.y));
  const scale = getTorsoScale(keypoints);

  return keypoints.map((point) => ({
    x: ((point.x ?? centerX) - centerX) / scale,
    y: ((point.y ?? centerY) - centerY) / scale,
    score: point.score ?? 0,
  }));
}

function summarizePose(
  current: Keypoint[],
  previous: Keypoint[] | null,
  timeSec: number,
): PoseSample {
  const normalized = normalizeKeypoints(current);
  const prevNormalized = previous ? normalizeKeypoints(previous) : null;

  const groupValues = Object.entries(BODY_GROUPS).reduce<Record<string, number>>((acc, [group, indices]) => {
    const movement = indices.map((index) => {
      const point = normalized[index];
      const prevPoint = prevNormalized?.[index];

      if (!point) return 0;
      if (!prevPoint) return Math.hypot(point.x, point.y);
      return Math.hypot(point.x - prevPoint.x, point.y - prevPoint.y);
    });

    acc[group] = average(movement);
    return acc;
  }, {});

  const quality = average(normalized.map((point) => point.score));
  const motion = average(Object.values(groupValues));
  const energy = average(Object.values(groupValues).map((value) => value * 1.4));
  const smoothness = average(
    normalized.map((point, index) => {
      const prevPoint = prevNormalized?.[index];
      if (!prevPoint) return 0;
      return Math.hypot(point.x - prevPoint.x, point.y - prevPoint.y);
    }),
  );

  return {
    timeSec,
    quality,
    motion,
    energy,
    smoothness,
    bodyAreas: groupValues,
  };
}

export async function analyzeVideoPoses(
  url: string,
  onProgress?: (progress: number, label: string) => void,
): Promise<{ durationSec: number; samples: PoseSample[] }> {
  const detector = await ensureDetector();
  const video = await loadVideo(url);
  const sampleCount = Math.max(12, Math.min(28, Math.round(video.duration * 2.5)));
  const interval = video.duration / sampleCount;
  const samples: PoseSample[] = [];
  let previousPose: Keypoint[] | null = null;

  try {
    for (let index = 0; index < sampleCount; index += 1) {
      const timeSec = index * interval;
      await seekVideo(video, timeSec);
      const poses = await detector.estimatePoses(video);
      const keypoints = poses[0]?.keypoints;

      if (!keypoints || keypoints.length === 0) {
        continue;
      }

      samples.push(summarizePose(keypoints, previousPose, timeSec));
      previousPose = keypoints;
      onProgress?.((index + 1) / sampleCount, `Sampling pose frames ${index + 1}/${sampleCount}`);
    }

    return {
      durationSec: video.duration,
      samples,
    };
  } finally {
    detector.dispose();
    video.removeAttribute('src');
    video.load();
  }
}
