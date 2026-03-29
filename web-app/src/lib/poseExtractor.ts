"use client";

/**
 * Real-time pose extraction using TensorFlow.js MoveNet.
 *
 * Keypoint indices and confidence thresholds mirror the YOLO pose pipeline
 * in A5/src/overlay_api.py (_visible_pose_point, _render_pose_layers)
 * so the skeletal JSON sent to Gemini uses the same COCO-17 layout.
 */

import type { PoseDetector, Keypoint } from "@tensorflow-models/pose-detection";

const COCO_JOINTS = [
  "nose",           // 0
  "left_eye",       // 1
  "right_eye",      // 2
  "left_ear",       // 3
  "right_ear",      // 4
  "left_shoulder",  // 5
  "right_shoulder", // 6
  "left_elbow",     // 7
  "right_elbow",    // 8
  "left_wrist",     // 9
  "right_wrist",    // 10
  "left_hip",       // 11
  "right_hip",      // 12
  "left_knee",      // 13
  "right_knee",     // 14
  "left_ankle",     // 15
  "right_ankle",    // 16
] as const;

// Major joints for dance coaching — eyes and ears are excluded
// (matches the joints used by _render_pose_layers in overlay_api.py)
const DANCE_JOINT_INDICES = [0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

// Confidence thresholds from overlay_api.py _visible_pose_point
const CONF_THRESHOLD = 0.25;
const NOSE_THRESHOLD = 0.2;

export interface JointCoord {
  x: number;
  y: number;
  c: number;
}

export interface JointVelocity {
  vx: number;
  vy: number;
}

export interface PoseFrame {
  t: number;
  joints: Record<string, JointCoord>;
  velocity: Record<string, JointVelocity>;
}

export class PoseExtractor {
  private detector: PoseDetector | null = null;
  private prevJoints: Record<string, JointCoord> = {};
  private prevTime = 0;
  private loading = false;

  async init(): Promise<void> {
    if (this.detector || this.loading) return;
    this.loading = true;
    try {
      await import("@tensorflow/tfjs-backend-webgl");
      const pd = await import("@tensorflow-models/pose-detection");
      this.detector = await pd.createDetector(pd.SupportedModels.MoveNet, {
        modelType: pd.movenet.modelType.SINGLEPOSE_LIGHTNING,
        enableSmoothing: true,
      });
    } finally {
      this.loading = false;
    }
  }

  /**
   * Extract pose from a video frame. Returns null when no person is detected.
   * Mirrors overlay_api.py: normalises coordinates to [0,1] and applies the
   * same per-joint confidence gate as _visible_pose_point.
   */
  async extract(
    source: HTMLVideoElement | HTMLCanvasElement,
    timestamp: number,
  ): Promise<PoseFrame | null> {
    if (!this.detector) return null;

    const poses = await this.detector.estimatePoses(source);
    if (!poses.length) return null;

    const kps = poses[0].keypoints;
    const w = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const h = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    if (w === 0 || h === 0) return null;

    const dt = this.prevTime > 0 ? Math.max(0.001, timestamp - this.prevTime) : 0;
    const joints: Record<string, JointCoord> = {};
    const velocity: Record<string, JointVelocity> = {};

    for (const idx of DANCE_JOINT_INDICES) {
      const kp: Keypoint | undefined = kps[idx];
      if (!kp) continue;

      const threshold = idx === 0 ? NOSE_THRESHOLD : CONF_THRESHOLD;
      const score = kp.score ?? 0;
      if (score < threshold) continue;

      const name = COCO_JOINTS[idx];
      const jx = Math.round((kp.x / w) * 1000) / 1000;
      const jy = Math.round((kp.y / h) * 1000) / 1000;
      joints[name] = { x: jx, y: jy, c: Math.round(score * 100) / 100 };

      if (dt > 0 && this.prevJoints[name]) {
        const prev = this.prevJoints[name];
        velocity[name] = {
          vx: Math.round(((jx - prev.x) / dt) * 1000) / 1000,
          vy: Math.round(((jy - prev.y) / dt) * 1000) / 1000,
        };
      }
    }

    this.prevJoints = joints;
    this.prevTime = timestamp;
    return { t: Math.round(timestamp * 1000) / 1000, joints, velocity };
  }

  reset(): void {
    this.prevJoints = {};
    this.prevTime = 0;
  }

  dispose(): void {
    this.detector?.dispose();
    this.detector = null;
    this.reset();
  }
}
