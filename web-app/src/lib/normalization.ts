/**
 * normalization.ts
 * Core logic for Pose Alignment and Coordinate Normalization.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Keypoint {
  part: string;
  position: Point;
  score: number;
}

/**
 * Calculates a 2D Affine Transformation Matrix to align target to source.
 * This solves the "student is to the right of the teacher" problem.
 */
export function calculateAlignmentTransform(
  sourceKp: Keypoint[],
  targetKp: Keypoint[]
): DOMMatrix | null {
  // BodyPix Keypoint Map: 
  // 5: L Shoulder, 6: R Shoulder, 11: L Hip, 12: R Hip
  const s = {
    ls: sourceKp[5]?.position,
    rs: sourceKp[6]?.position,
    lh: sourceKp[11]?.position,
    rh: sourceKp[12]?.position,
  };

  const t = {
    ls: targetKp[5]?.position,
    rs: targetKp[6]?.position,
    lh: targetKp[11]?.position,
    rh: targetKp[12]?.position,
  };

  // Guard: Ensure we have enough points to define a torso on both actors
  if (!s.ls || !s.rs || !s.lh || !s.rh || !t.ls || !t.rs || !t.lh || !t.rh) {
    return null;
  }

  // 1. Find the Centroid (The average "center of gravity" of the torso)
  const getCenter = (pts: Point[]) => ({
    x: pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
    y: pts.reduce((sum, p) => sum + p.y, 0) / pts.length,
  });

  const srcCenter = getCenter([s.ls, s.rs, s.lh, s.rh]);
  const tgtCenter = getCenter([t.ls, t.rs, t.lh, t.rh]);

  // 2. Calculate Scale and Rotation using the "Spine Vector"
  // Vector from the midpoint of hips to the midpoint of shoulders
  const getSpineVec = (ls: Point, rs: Point, lh: Point, rh: Point) => ({
    x: (ls.x + rs.x) / 2 - (lh.x + rh.x) / 2,
    y: (ls.y + rs.y) / 2 - (lh.y + rh.y) / 2,
  });

  const srcSpine = getSpineVec(s.ls, s.rs, s.lh, s.rh);
  const tgtSpine = getSpineVec(t.ls, t.rs, t.lh, t.rh);

  const srcMag = Math.hypot(srcSpine.x, srcSpine.y);
  const tgtMag = Math.hypot(tgtSpine.x, tgtSpine.y);

  // Scale: How much to blow up/shrink the student to match teacher's height
  const scale = srcMag / (tgtMag || 1);

  // Rotation: Angle difference between teacher's spine and student's spine
  const rotation = Math.atan2(srcSpine.y, srcSpine.x) - Math.atan2(tgtSpine.y, tgtSpine.x);

  // 3. Construct the Linear Transformation Matrix
  const matrix = new DOMMatrix();
  
  // Step A: Move to the Source position
  matrix.translateSelf(srcCenter.x, srcCenter.y);
  
  // Step B: Apply Rotation (converted to degrees for DOMMatrix)
  matrix.rotateSelf(rotation * (180 / Math.PI));
  
  // Step C: Apply Scaling
  matrix.scaleSelf(scale, scale);
  
  // Step D: Move the Target to the origin (0,0) so rotation/scale happen around its center
  matrix.translateSelf(-tgtCenter.x, -tgtCenter.y);

  return matrix;
}

/**
 * Optional: Euclidean distance between two normalized keypoint sets.
 * Useful for real-time "Match Score" feedback in TempoFlow.
 */
export function calculatePoseSimilarity(
  sourceKp: Keypoint[],
  targetKp: Keypoint[]
): number {
  let totalDist = 0;
  let count = 0;

  // Compare the 17 standard COCO keypoints
  for (let i = 0; i < 17; i++) {
    if (sourceKp[i]?.score > 0.5 && targetKp[i]?.score > 0.5) {
      const dx = sourceKp[i].position.x - targetKp[i].position.x;
      const dy = sourceKp[i].position.y - targetKp[i].position.y;
      totalDist += Math.hypot(dx, dy);
      count++;
    }
  }

  return count > 0 ? totalDist / count : Infinity;
}