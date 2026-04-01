import type { PoseKeypoint } from "./bodyPix";
import type { OverlaySegmentArtifact } from "./overlayStorage";

export type OverlayNormalization = {
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
  pivotX: number;
  pivotY: number;
};

export function readOverlayNormalization(segment: OverlaySegmentArtifact | null): OverlayNormalization | null {
  const normalization = segment?.meta?.normalization as
    | {
        scaleX?: number;
        scaleY?: number;
        translateX?: number;
        translateY?: number;
        pivotX?: number;
        pivotY?: number;
      }
    | undefined;
  if (!normalization) return null;

  const scaleX = Number(normalization.scaleX);
  const scaleY = Number(normalization.scaleY);
  const translateX = Number(normalization.translateX);
  const translateY = Number(normalization.translateY);
  const pivotX = Number(normalization.pivotX);
  const pivotY = Number(normalization.pivotY);

  if (
    !Number.isFinite(scaleX) ||
    !Number.isFinite(scaleY) ||
    !Number.isFinite(translateX) ||
    !Number.isFinite(translateY) ||
    !Number.isFinite(pivotX) ||
    !Number.isFinite(pivotY)
  ) {
    return null;
  }

  return { scaleX, scaleY, translateX, translateY, pivotX, pivotY };
}

/** Map reference keypoints already in normalized [0,1] space into practice-frame space (same transform as CSS overlay + raster layers). */
export function applyOverlayNormalizationToNormalizedKeypoints(
  keypoints: PoseKeypoint[],
  normalization: OverlayNormalization | null,
): PoseKeypoint[] {
  if (!normalization) return keypoints;
  return keypoints.map((keypoint) => ({
    ...keypoint,
    x:
      normalization.pivotX +
      (keypoint.x - normalization.pivotX) * normalization.scaleX +
      normalization.translateX,
    y:
      normalization.pivotY +
      (keypoint.y - normalization.pivotY) * normalization.scaleY +
      normalization.translateY,
  }));
}
