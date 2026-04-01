import type { PoseKeypoint } from "../../lib/bodyPix";

const MIN_VISIBLE_SCORE = 0.25;

export type OverlayPoseInstance = PoseKeypoint[];

export type OverlayPosePair = {
  reference: OverlayPoseInstance;
  practice: OverlayPoseInstance;
};

type PoseCenter = {
  x: number;
  y: number;
};

type PoseBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  anchor: PoseCenter;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getVisiblePoints(keypoints: OverlayPoseInstance) {
  return keypoints.filter((point) => (point.score ?? 0) >= MIN_VISIBLE_SCORE);
}

function getAveragePoint(keypoints: OverlayPoseInstance, indexes: number[]) {
  const visible = indexes
    .map((index) => keypoints[index] ?? null)
    .filter((point): point is PoseKeypoint => (point?.score ?? 0) >= MIN_VISIBLE_SCORE);
  if (!visible.length) return null;

  return {
    x: visible.reduce((sum, point) => sum + point.x, 0) / visible.length,
    y: visible.reduce((sum, point) => sum + point.y, 0) / visible.length,
  };
}

function getPoseAnchor(keypoints: OverlayPoseInstance): PoseCenter | null {
  return (
    getAveragePoint(keypoints, [11, 12]) ??
    getAveragePoint(keypoints, [5, 6, 11, 12]) ??
    getAveragePoint(keypoints, [5, 6]) ??
    getAveragePoint(keypoints, [15, 16]) ??
    getAveragePoint(keypoints, keypoints.map((_, index) => index))
  );
}

function getPoseTopY(keypoints: OverlayPoseInstance, bounds: { minY: number }) {
  const headOrTorso = [0, 1, 2, 3, 4, 5, 6]
    .map((index) => keypoints[index] ?? null)
    .filter((point): point is PoseKeypoint => (point?.score ?? 0) >= MIN_VISIBLE_SCORE);
  if (!headOrTorso.length) return bounds.minY;
  return Math.min(...headOrTorso.map((point) => point.y));
}

function getPoseBottomY(keypoints: OverlayPoseInstance, bounds: { maxY: number }) {
  const feetOrLegs = [15, 16, 13, 14]
    .map((index) => keypoints[index] ?? null)
    .filter((point): point is PoseKeypoint => (point?.score ?? 0) >= MIN_VISIBLE_SCORE);
  if (!feetOrLegs.length) return bounds.maxY;
  return Math.max(...feetOrLegs.map((point) => point.y));
}

function getPoseBounds(keypoints: OverlayPoseInstance): PoseBounds | null {
  const visible = getVisiblePoints(keypoints);
  if (visible.length < 3) return null;

  const minX = Math.min(...visible.map((point) => point.x));
  const maxX = Math.max(...visible.map((point) => point.x));
  const minY = Math.min(...visible.map((point) => point.y));
  const maxY = Math.max(...visible.map((point) => point.y));
  const anchor = getPoseAnchor(keypoints) ?? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const topY = getPoseTopY(keypoints, { minY });
  const bottomY = getPoseBottomY(keypoints, { maxY });

  return {
    minX,
    maxX,
    minY: Math.min(minY, topY),
    maxY: Math.max(maxY, bottomY),
    width: Math.max(1e-3, maxX - minX),
    height: Math.max(1e-3, bottomY - topY),
    anchor,
  };
}

function sortPoseInstances(instances: OverlayPoseInstance[]) {
  return [...instances]
    .map((instance) => ({ instance, bounds: getPoseBounds(instance) }))
    .filter((entry): entry is { instance: OverlayPoseInstance; bounds: PoseBounds } => entry.bounds != null)
    .sort((a, b) => {
      if (a.bounds.anchor.x !== b.bounds.anchor.x) {
        return a.bounds.anchor.x - b.bounds.anchor.x;
      }
      return a.bounds.anchor.y - b.bounds.anchor.y;
    })
    .map((entry) => entry.instance);
}

function selectDistributedIndex(targetIndex: number, sourceCount: number, outputCount: number) {
  if (sourceCount <= 1) return 0;
  const projected = ((targetIndex + 0.5) * sourceCount) / Math.max(1, outputCount) - 0.5;
  return clamp(Math.round(projected), 0, sourceCount - 1);
}

function selectNearestUnusedIndex(targetIndex: number, sourceCount: number, used: Set<number>) {
  for (let radius = 0; radius < sourceCount; radius += 1) {
    const left = targetIndex - radius;
    if (left >= 0 && !used.has(left)) return left;
    const right = targetIndex + radius;
    if (right < sourceCount && !used.has(right)) return right;
  }
  return clamp(targetIndex, 0, sourceCount - 1);
}

export function buildOverlayPosePairs(
  referenceInstances: OverlayPoseInstance[],
  practiceInstances: OverlayPoseInstance[],
): OverlayPosePair[] {
  const sortedReference = sortPoseInstances(referenceInstances);
  const sortedPractice = sortPoseInstances(practiceInstances);
  if (!sortedReference.length || !sortedPractice.length) return [];

  if (sortedPractice.length >= sortedReference.length) {
    return sortedPractice.map((practice, index) => ({
      reference: sortedReference[selectDistributedIndex(index, sortedReference.length, sortedPractice.length)]!,
      practice,
    }));
  }

  const usedReferenceIndexes = new Set<number>();
  return sortedPractice.map((practice, index) => {
    const distributedIndex = selectDistributedIndex(index, sortedReference.length, sortedPractice.length);
    const referenceIndex = selectNearestUnusedIndex(distributedIndex, sortedReference.length, usedReferenceIndexes);
    usedReferenceIndexes.add(referenceIndex);
    return {
      reference: sortedReference[referenceIndex]!,
      practice,
    };
  });
}

export function transformReferencePoseToPractice(
  referenceKeypoints: OverlayPoseInstance,
  practiceKeypoints: OverlayPoseInstance,
): OverlayPoseInstance {
  const referenceBounds = getPoseBounds(referenceKeypoints);
  const practiceBounds = getPoseBounds(practiceKeypoints);
  if (!referenceBounds || !practiceBounds) {
    return referenceKeypoints;
  }

  const scale = clamp(practiceBounds.height / Math.max(referenceBounds.height, 1e-3), 0.2, 5);

  return referenceKeypoints.map((point) => ({
    ...point,
    x: practiceBounds.anchor.x + (point.x - referenceBounds.anchor.x) * scale,
    y: practiceBounds.anchor.y + (point.y - referenceBounds.anchor.y) * scale,
  }));
}
