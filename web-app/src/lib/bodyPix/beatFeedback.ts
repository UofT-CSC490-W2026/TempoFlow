import { classifySeverity, familyMessage } from "./feedbackCopy";
import {
  computeAngle,
  jointAnglesDegFromKeypoints,
  JOINT_ANGLES,
  normalizeKeypoints,
  type Keypoint,
} from "./geometry";
import {
  attackTransitionFeatureFromMotion,
  extractMicroTimingFeatures,
  wrapAngleDiffRad,
} from "./motionFeatures";
import { meanOfSamples } from "./stats";
import type {
  AttackFeat,
  BodyRegion,
  DanceFeedback,
  FeedbackFeatureFamily,
  SampledPoseFrame,
} from "./types";

type FrameSample = SampledPoseFrame;

function jointMotionBetweenFrames(prev: Keypoint[], curr: Keypoint[]): number {
  const prevA = jointAnglesDegFromKeypoints(prev);
  const currA = jointAnglesDegFromKeypoints(curr);
  const deltas: number[] = [];
  for (const ja of JOINT_ANGLES) {
    const p = prevA[ja.name];
    const q = currA[ja.name];
    if (p == null || q == null) continue;
    let d = Math.abs(q - p);
    if (d > 180) d = 360 - d;
    deltas.push(d);
  }
  return deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
}

function motionProfile(frames: FrameSample[]): number[] {
  const sorted = [...frames].sort((a, b) => a.timestamp - b.timestamp);
  const m: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    m.push(jointMotionBetweenFrames(sorted[i - 1].keypoints, sorted[i].keypoints));
  }
  return m;
}

function microTimingDeviation(refM: number[], userM: number[]): number {
  const rf = extractMicroTimingFeatures(refM);
  const uf = extractMicroTimingFeatures(userM);
  const dOnset = Math.abs(rf.onsetNorm - uf.onsetNorm);
  const dPeak = Math.abs(rf.peakNorm - uf.peakNorm);
  const base = Math.max(0.15, rf.settleRatio, uf.settleRatio);
  const dSettle = Math.abs(rf.settleRatio - uf.settleRatio) / base;
  return Math.min(1, dOnset * 0.38 + dPeak * 0.38 + Math.min(0.5, dSettle * 0.45));
}

type UpperBodyFeat = {
  shoulderY: number;
  elbowY: number;
  wristY: number;
  armOpen: number;
  torsoRot: number;
};

function upperBodyFeat(frames: FrameSample[]): UpperBodyFeat {
  const rows: UpperBodyFeat[] = [];
  for (const f of frames) {
    const nk = normalizeKeypoints(f.keypoints);
    const ls = nk[5];
    const rs = nk[6];
    if (ls.score < 0.2 || rs.score < 0.2) continue;
    const le = nk[7];
    const re = nk[8];
    const lw = nk[9];
    const rw = nk[10];
    const lh = nk[11];
    const rh = nk[12];
    const shoulderY = (ls.y + rs.y) / 2;
    const elbowY = (le.y + re.y) / 2;
    const wristY = (lw.y + rw.y) / 2;
    const armOpen = Math.hypot(lw.x - rw.x, lw.y - rw.y);
    const shMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    const hipMid = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
    const torsoRot = Math.atan2(shMid.y - hipMid.y, shMid.x - hipMid.x);
    rows.push({ shoulderY, elbowY, wristY, armOpen, torsoRot });
  }
  if (rows.length === 0) {
    return { shoulderY: 0, elbowY: 0, wristY: 0, armOpen: 0, torsoRot: 0 };
  }
  return {
    shoulderY: meanOfSamples(rows.map((r) => r.shoulderY)),
    elbowY: meanOfSamples(rows.map((r) => r.elbowY)),
    wristY: meanOfSamples(rows.map((r) => r.wristY)),
    armOpen: meanOfSamples(rows.map((r) => r.armOpen)),
    torsoRot: meanOfSamples(rows.map((r) => r.torsoRot)),
  };
}

function upperBodyDeviation(ref: UpperBodyFeat, user: UpperBodyFeat): number {
  return Math.min(
    1,
    Math.abs(ref.shoulderY - user.shoulderY) * 0.85 +
      Math.abs(ref.elbowY - user.elbowY) * 0.85 +
      Math.abs(ref.wristY - user.wristY) * 0.85 +
      Math.abs(ref.armOpen - user.armOpen) * 0.55 +
      wrapAngleDiffRad(ref.torsoRot, user.torsoRot) * 0.45,
  );
}

type LowerBodyFeat = {
  hipShiftX: number;
  kneeBendDeg: number;
  stepDir: number;
  footSpread: number;
};

function lowerBodyFeat(frames: FrameSample[]): LowerBodyFeat {
  const first = normalizeKeypoints(frames[0]!.keypoints);
  const last = normalizeKeypoints(frames[frames.length - 1]!.keypoints);
  const hip0 = (first[11].x + first[12].x) / 2;
  const hip1 = (last[11].x + last[12].x) / 2;
  const hipShiftX = hip1 - hip0;
  const a0x = (first[15].x + first[16].x) / 2;
  const a0y = (first[15].y + first[16].y) / 2;
  const a1x = (last[15].x + last[16].x) / 2;
  const a1y = (last[15].y + last[16].y) / 2;
  const stepDir = Math.atan2(a1y - a0y, a1x - a0x);
  const bends: number[] = [];
  const spreads: number[] = [];
  for (const f of frames) {
    const k = f.keypoints;
    const lk = computeAngle(k[11], k[13], k[15]);
    const rk = computeAngle(k[12], k[14], k[16]);
    if (lk != null && rk != null) {
      bends.push(Math.max(0, 180 - lk));
      bends.push(Math.max(0, 180 - rk));
    }
    const nk = normalizeKeypoints(k);
    spreads.push(Math.hypot(nk[15].x - nk[16].x, nk[15].y - nk[16].y));
  }
  return {
    hipShiftX,
    kneeBendDeg: bends.length ? meanOfSamples(bends) : 0,
    stepDir,
    footSpread: meanOfSamples(spreads),
  };
}

function lowerBodyDeviation(ref: LowerBodyFeat, user: LowerBodyFeat): number {
  return Math.min(
    1,
    Math.abs(ref.hipShiftX - user.hipShiftX) * 0.9 +
      Math.abs(ref.kneeBendDeg - user.kneeBendDeg) / 55 +
      wrapAngleDiffRad(ref.stepDir, user.stepDir) * 0.5 +
      Math.abs(ref.footSpread - user.footSpread) * 0.65,
  );
}

function attackTransitionDeviation(ref: AttackFeat, user: AttackFeat): number {
  return Math.min(
    1,
    Math.abs(ref.sharpness - user.sharpness) / 4.5 * 0.42 +
      Math.abs(ref.lateVar - user.lateVar) * 0.3 +
      Math.abs(ref.tailEnergy - user.tailEnergy) / 28 * 0.38,
  );
}

function familyToBodyRegion(family: FeedbackFeatureFamily): BodyRegion {
  switch (family) {
    case "upper_body":
      return "arms";
    case "lower_body":
      return "legs";
    case "micro_timing":
      return "torso";
    case "attack_transition":
      return "full_body";
  }
}

export function buildFamilyFeedbackForSegment(
  segIdx: number,
  midT: number,
  frameIndex: number,
  refSeg: FrameSample[],
  userSeg: FrameSample[],
): DanceFeedback[] {
  const refM = motionProfile(refSeg);
  const userM = motionProfile(userSeg);
  const families: Array<{
    family: FeedbackFeatureFamily;
    dev: number;
  }> = [];

  if (refM.length > 0 && userM.length > 0) {
    families.push({
      family: "micro_timing",
      dev: microTimingDeviation(refM, userM),
    });
  }

  if (refSeg.length > 0 && userSeg.length > 0) {
    families.push({
      family: "upper_body",
      dev: upperBodyDeviation(upperBodyFeat(refSeg), upperBodyFeat(userSeg)),
    });
    families.push({
      family: "lower_body",
      dev: lowerBodyDeviation(lowerBodyFeat(refSeg), lowerBodyFeat(userSeg)),
    });
  }

  if (refM.length > 0 && userM.length > 0) {
    families.push({
      family: "attack_transition",
      dev: attackTransitionDeviation(
        attackTransitionFeatureFromMotion(refM),
        attackTransitionFeatureFromMotion(userM),
      ),
    });
  }

  return families.map(({ family, dev }) => ({
    timestamp: midT,
    segmentIndex: segIdx,
    bodyRegion: familyToBodyRegion(family),
    severity: classifySeverity(dev),
    message: familyMessage(family, dev),
    deviation: dev,
    frameIndex,
    featureFamily: family,
    microTimingOff: family === "micro_timing" && dev >= 0.12,
  }));
}

export function representativeDenseFrameIndex(samples: FrameSample[], segIdx: number): number {
  const indexed = samples
    .map((f, i) => ({ f, i }))
    .filter((x) => x.f.segmentIndex === segIdx);
  const t0 = indexed[0]!.f.timestamp;
  const t1 = indexed[indexed.length - 1]!.f.timestamp;
  const midT = (t0 + t1) / 2;
  let best = indexed[0];
  let bestD = Math.abs(indexed[0].f.timestamp - midT);
  for (const x of indexed) {
    const d = Math.abs(x.f.timestamp - midT);
    if (d < bestD) {
      bestD = d;
      best = x;
    }
  }
  return best.i;
}
