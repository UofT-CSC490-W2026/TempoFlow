import type { BodyRegion } from "./types";

/** BodyPix part-id layout for segmentation masks (24 parts). */
export const REGION_PARTS: Record<BodyRegion, number[]> = {
  head: [0, 1],
  arms: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  torso: [12, 13],
  legs: [14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
  full_body: Array.from({ length: 24 }, (_, i) => i),
};

/** PoseNet keypoint names in display order (17 points). */
export const KEYPOINT_NAMES = [
  "nose",
  "leftEye",
  "rightEye",
  "leftEar",
  "rightEar",
  "leftShoulder",
  "rightShoulder",
  "leftElbow",
  "rightElbow",
  "leftWrist",
  "rightWrist",
  "leftHip",
  "rightHip",
  "leftKnee",
  "rightKnee",
  "leftAnkle",
  "rightAnkle",
] as const;
