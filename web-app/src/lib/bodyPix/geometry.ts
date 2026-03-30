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

  const leftShoulder = keypoints[5];
  const rightShoulder = keypoints[6];
  const leftHip = keypoints[11];
  const rightHip = keypoints[12];
  const hasTorso =
    (leftShoulder?.score ?? 0) > 0.3 &&
    (rightShoulder?.score ?? 0) > 0.3 &&
    (leftHip?.score ?? 0) > 0.3 &&
    (rightHip?.score ?? 0) > 0.3;

  const shoulderMid = hasTorso
    ? {
        x: (leftShoulder.x + rightShoulder.x) / 2,
        y: (leftShoulder.y + rightShoulder.y) / 2,
      }
    : null;
  const hipMid = hasTorso
    ? {
        x: (leftHip.x + rightHip.x) / 2,
        y: (leftHip.y + rightHip.y) / 2,
      }
    : null;

  const cx = hasTorso && shoulderMid && hipMid
    ? (shoulderMid.x + hipMid.x) / 2
    : valid.reduce((s, kp) => s + kp.x, 0) / valid.length;
  const cy = hasTorso && shoulderMid && hipMid
    ? (shoulderMid.y + hipMid.y) / 2
    : valid.reduce((s, kp) => s + kp.y, 0) / valid.length;

  const torsoScale =
    hasTorso && shoulderMid && hipMid
      ? Math.max(
          Math.hypot(shoulderMid.x - hipMid.x, shoulderMid.y - hipMid.y),
          Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y),
          Math.hypot(leftHip.x - rightHip.x, leftHip.y - rightHip.y),
          1,
        )
      : 0;
  const scale =
    torsoScale > 0
      ? torsoScale
      : Math.max(
          ...valid.map((kp) => Math.hypot(kp.x - cx, kp.y - cy)),
          1,
        );
  const torsoAngle =
    hasTorso && shoulderMid && hipMid
      ? Math.atan2(shoulderMid.y - hipMid.y, shoulderMid.x - hipMid.x)
      : -Math.PI / 2;
  const rotation = (-Math.PI / 2) - torsoAngle;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  return keypoints.map((kp) => ({
    ...kp,
    x: ((kp.x - cx) * cos - (kp.y - cy) * sin) / scale,
    y: ((kp.x - cx) * sin + (kp.y - cy) * cos) / scale,
  }));
}
