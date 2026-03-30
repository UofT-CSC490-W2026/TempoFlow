import type { BodyRegion, JointAngle, PoseKeypoint } from "./types";

export type Keypoint = PoseKeypoint;

export const JOINT_ANGLES: JointAngle[] = [
  { name: "left elbow", region: "arms", joints: [5, 7, 9] },
  { name: "right elbow", region: "arms", joints: [6, 8, 10] },
  { name: "left shoulder", region: "torso", joints: [7, 5, 11] },
  { name: "right shoulder", region: "torso", joints: [8, 6, 12] },
  { name: "left knee", region: "legs", joints: [11, 13, 15] },
  { name: "right knee", region: "legs", joints: [12, 14, 16] },
  { name: "left hip", region: "legs", joints: [5, 11, 13] },
  { name: "right hip", region: "legs", joints: [6, 12, 14] },
];

export function computeAngle(a: Keypoint, b: Keypoint, c: Keypoint): number | null {
  if (a.score < 0.3 || b.score < 0.3 || c.score < 0.3) return null;
  const ba = { x: a.x - b.x, y: a.y - b.y };
  const bc = { x: c.x - b.x, y: c.y - b.y };
  const dot = ba.x * bc.x + ba.y * bc.y;
  const cross = ba.x * bc.y - ba.y * bc.x;
  return Math.atan2(cross, dot) * (180 / Math.PI);
}

export function jointAnglesDegFromKeypoints(
  keypoints: PoseKeypoint[],
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const ja of JOINT_ANGLES) {
    out[ja.name] = computeAngle(
      keypoints[ja.joints[0]],
      keypoints[ja.joints[1]],
      keypoints[ja.joints[2]],
    );
  }
  return out;
}

export function normalizeKeypoints(keypoints: Keypoint[]): Keypoint[] {
  const valid = keypoints.filter((kp) => kp.score > 0.3);
  if (valid.length < 2) return keypoints;

  const cx = valid.reduce((s, kp) => s + kp.x, 0) / valid.length;
  const cy = valid.reduce((s, kp) => s + kp.y, 0) / valid.length;
  const maxDist = Math.max(
    ...valid.map((kp) => Math.hypot(kp.x - cx, kp.y - cy)),
    1,
  );

  return keypoints.map((kp) => ({
    ...kp,
    x: (kp.x - cx) / maxDist,
    y: (kp.y - cy) / maxDist,
  }));
}
