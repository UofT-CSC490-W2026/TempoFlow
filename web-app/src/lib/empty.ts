// Stub module for @mediapipe/pose when using the tfjs runtime.
// The pose-detection package expects these exports to exist even though
// this app does not use the MediaPipe runtime directly.

export class Pose {
  constructor() {}
  setOptions() {}
  onResults() {}
  send() {}
  close() {}
  reset() {}
  initialize() {
    return Promise.resolve();
  }
}

export const POSE_CONNECTIONS: Array<[number, number]> = [];
export const POSE_LANDMARKS: Record<string, number> = {};
export const POSE_LANDMARKS_LEFT: Record<string, number> = {};
export const POSE_LANDMARKS_RIGHT: Record<string, number> = {};
export const POSE_LANDMARKS_NEUTRAL: Record<string, number> = {};
