export interface Point { x: number; y: number; }
export interface Keypoint { position: Point; score: number; }

export function calculateAlignmentTransform(
  sourceKp: Keypoint[],
  targetKp: Keypoint[]
): DOMMatrix | null {
  // Use the torso as the stable anchor (indices 5, 6, 11, 12)
  const s = { ls: sourceKp[5]?.position, rs: sourceKp[6]?.position, lh: sourceKp[11]?.position, rh: sourceKp[12]?.position };
  const t = { ls: targetKp[5]?.position, rs: targetKp[6]?.position, lh: targetKp[11]?.position, rh: targetKp[12]?.position };

  if (!s.ls || !t.ls || !s.lh || !t.lh) return null;

  // Calculate midpoints for translation
  const srcMid = { x: (s.ls.x + s.rs.x + s.lh.x + s.rh.x) / 4, y: (s.ls.y + s.rs.y + s.lh.y + s.rh.y) / 4 };
  const tgtMid = { x: (t.ls.x + t.rs.x + t.lh.x + t.rh.x) / 4, y: (t.ls.y + t.rs.y + t.lh.y + t.rh.y) / 4 };

  // Calculate vectors for scale/rotation (Mid-Hip to Mid-Shoulder)
  const srcV = { x: (s.ls.x + s.rs.x)/2 - (s.lh.x + s.rh.x)/2, y: (s.ls.y + s.rs.y)/2 - (s.lh.y + s.rh.y)/2 };
  const tgtV = { x: (t.ls.x + t.rs.x)/2 - (t.lh.x + t.rh.x)/2, y: (t.ls.y + t.rs.y)/2 - (t.lh.y + t.rh.y)/2 };

  const scale = Math.hypot(srcV.x, srcV.y) / (Math.hypot(tgtV.x, tgtV.y) || 1);
  const angle = Math.atan2(srcV.y, srcV.x) - Math.atan2(tgtV.y, tgtV.x);

  const matrix = new DOMMatrix();
  matrix.translateSelf(srcMid.x, srcMid.y);
  matrix.rotateSelf(angle * (180 / Math.PI));
  matrix.scaleSelf(scale, scale);
  matrix.translateSelf(-tgtMid.x, -tgtMid.y);

  return matrix;
}