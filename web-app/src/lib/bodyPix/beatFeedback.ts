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
import { meanOfSamples, medianOfSamples } from "./stats";
import type {
  AttackFeat,
  BodyRegion,
  DanceFeedback,
  FeedbackFeatureFamily,
  SampledPoseFrame,
} from "./types";

type FrameSample = SampledPoseFrame;
const BODY_CONFIDENCE_MIN = 0.3;
const MIN_FEATURE_FRAME_RATIO = 0.45;
const ARM_SIDE_KEYPOINTS = {
  left: [5, 7, 9],
  right: [6, 8, 10],
} as const;
const LEG_SIDE_KEYPOINTS = {
  left: [11, 13, 15],
  right: [12, 14, 16],
} as const;

function hasConfidence(keypoints: Keypoint[], indices: number[]) {
  return indices.every((index) => (keypoints[index]?.score ?? 0) >= BODY_CONFIDENCE_MIN);
}

function minFeatureSamples(frameCount: number) {
  return Math.max(2, Math.ceil(frameCount * MIN_FEATURE_FRAME_RATIO));
}

function meanIfEnough(samples: number[], minSamples: number) {
  return samples.length >= minSamples ? medianOfSamples(samples) : null;
}

function averageNormalizedSideDelta(
  referenceFrames: FrameSample[],
  practiceFrames: FrameSample[],
  indices: readonly number[],
) {
  const deltas: number[] = [];
  for (let index = 0; index < Math.min(referenceFrames.length, practiceFrames.length); index += 1) {
    const referencePoints = normalizeKeypoints(referenceFrames[index].keypoints);
    const practicePoints = normalizeKeypoints(practiceFrames[index].keypoints);
    const perFrame = indices
      .map((keypointIndex) => {
        const referencePoint = referencePoints[keypointIndex];
        const practicePoint = practicePoints[keypointIndex];
        if (!referencePoint || !practicePoint) return null;
        if (referencePoint.score < BODY_CONFIDENCE_MIN || practicePoint.score < BODY_CONFIDENCE_MIN) return null;
        return Math.hypot(referencePoint.x - practicePoint.x, referencePoint.y - practicePoint.y);
      })
      .filter((value): value is number => value != null);
    if (!perFrame.length) continue;
    deltas.push(meanOfSamples(perFrame));
  }
  return deltas.length ? meanOfSamples(deltas) : null;
}

function dominantSideForFrames(
  referenceFrames: FrameSample[],
  practiceFrames: FrameSample[],
  keypoints: { left: readonly number[]; right: readonly number[] },
): DanceFeedback["focusSide"] {
  const leftDelta = averageNormalizedSideDelta(referenceFrames, practiceFrames, keypoints.left);
  const rightDelta = averageNormalizedSideDelta(referenceFrames, practiceFrames, keypoints.right);
  if (leftDelta == null && rightDelta == null) return "center";
  if (leftDelta == null) return "right";
  if (rightDelta == null) return "left";
  const strongest = Math.max(leftDelta, rightDelta);
  if (strongest < 0.06 || Math.abs(leftDelta - rightDelta) < strongest * 0.12) {
    return "center";
  }
  return leftDelta > rightDelta ? "left" : "right";
}

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
  shoulderY: number | null;
  elbowY: number | null;
  wristY: number | null;
  armOpen: number | null;
  torsoRot: number | null;
};

function upperBodyFeat(frames: FrameSample[]): UpperBodyFeat | null {
  const minSamples = minFeatureSamples(frames.length);
  const shoulderYs: number[] = [];
  const elbowYs: number[] = [];
  const wristYs: number[] = [];
  const armOpens: number[] = [];
  const torsoRots: number[] = [];

  for (const f of frames) {
    const raw = f.keypoints;
    const nk = normalizeKeypoints(raw);
    const ls = nk[5];
    const rs = nk[6];
    const le = nk[7];
    const re = nk[8];
    const lw = nk[9];
    const rw = nk[10];
    const lh = nk[11];
    const rh = nk[12];

    if (hasConfidence(raw, [5, 6])) {
      shoulderYs.push((ls.y + rs.y) / 2);
    }
    if (hasConfidence(raw, [7, 8])) {
      elbowYs.push((le.y + re.y) / 2);
    }
    if (hasConfidence(raw, [9, 10])) {
      wristYs.push((lw.y + rw.y) / 2);
      armOpens.push(Math.hypot(lw.x - rw.x, lw.y - rw.y));
    }
    if (hasConfidence(raw, [5, 6, 11, 12])) {
      const shMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
      const hipMid = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
      torsoRots.push(Math.atan2(shMid.y - hipMid.y, shMid.x - hipMid.x));
    }
  }

  const feat: UpperBodyFeat = {
    shoulderY: meanIfEnough(shoulderYs, minSamples),
    elbowY: meanIfEnough(elbowYs, minSamples),
    wristY: meanIfEnough(wristYs, minSamples),
    armOpen: meanIfEnough(armOpens, minSamples),
    torsoRot: meanIfEnough(torsoRots, minSamples),
  };
  const available = Object.values(feat).filter((value) => value != null).length;
  return available >= 3 ? feat : null;
}

const UPPER_BODY_TOTAL_WEIGHT = 3.55;

function upperBodyDeviation(ref: UpperBodyFeat | null, user: UpperBodyFeat | null): number | null {
  if (!ref || !user) return null;

  let totalWeight = 0;
  let weightedSum = 0;

  const addLinear = (a: number | null, b: number | null, weight: number) => {
    if (a == null || b == null) return;
    totalWeight += weight;
    weightedSum += Math.abs(a - b) * weight;
  };

  addLinear(ref.shoulderY, user.shoulderY, 0.85);
  addLinear(ref.elbowY, user.elbowY, 0.85);
  addLinear(ref.wristY, user.wristY, 0.85);
  addLinear(ref.armOpen, user.armOpen, 0.55);
  if (ref.torsoRot != null && user.torsoRot != null) {
    totalWeight += 0.45;
    weightedSum += wrapAngleDiffRad(ref.torsoRot, user.torsoRot) * 0.45;
  }

  if (totalWeight < UPPER_BODY_TOTAL_WEIGHT * 0.58) {
    return null;
  }

  return Math.min(1, weightedSum * (UPPER_BODY_TOTAL_WEIGHT / totalWeight));
}

type LowerBodyFeat = {
  hipShiftX: number | null;
  kneeBendDeg: number | null;
  stepDir: number | null;
  footSpread: number | null;
};

function findBoundaryFrame(
  frames: FrameSample[],
  indices: number[],
  fromEnd = false,
): FrameSample | null {
  const ordered = fromEnd ? [...frames].reverse() : frames;
  return ordered.find((frame) => hasConfidence(frame.keypoints, indices)) ?? null;
}

function lowerBodyFeat(frames: FrameSample[]): LowerBodyFeat | null {
  const minSamples = minFeatureSamples(frames.length);
  const firstHipFrame = findBoundaryFrame(frames, [11, 12]);
  const lastHipFrame = findBoundaryFrame(frames, [11, 12], true);
  const firstAnkleFrame = findBoundaryFrame(frames, [15, 16]);
  const lastAnkleFrame = findBoundaryFrame(frames, [15, 16], true);
  const firstHip = firstHipFrame ? normalizeKeypoints(firstHipFrame.keypoints) : null;
  const lastHip = lastHipFrame ? normalizeKeypoints(lastHipFrame.keypoints) : null;
  const firstAnkle = firstAnkleFrame ? normalizeKeypoints(firstAnkleFrame.keypoints) : null;
  const lastAnkle = lastAnkleFrame ? normalizeKeypoints(lastAnkleFrame.keypoints) : null;
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
    if (hasConfidence(k, [15, 16])) {
      const nk = normalizeKeypoints(k);
      spreads.push(Math.hypot(nk[15].x - nk[16].x, nk[15].y - nk[16].y));
    }
  }

  const feat: LowerBodyFeat = {
    hipShiftX:
      firstHip && lastHip
        ? (lastHip[11].x + lastHip[12].x) / 2 - (firstHip[11].x + firstHip[12].x) / 2
        : null,
    kneeBendDeg: meanIfEnough(bends, minSamples),
    stepDir:
      firstAnkle && lastAnkle
        ? Math.atan2(
            (lastAnkle[15].y + lastAnkle[16].y) / 2 - (firstAnkle[15].y + firstAnkle[16].y) / 2,
            (lastAnkle[15].x + lastAnkle[16].x) / 2 - (firstAnkle[15].x + firstAnkle[16].x) / 2,
          )
        : null,
    footSpread: meanIfEnough(spreads, minSamples),
  };
  const available = Object.values(feat).filter((value) => value != null).length;
  return available >= 2 ? feat : null;
}

const LOWER_BODY_TOTAL_WEIGHT = 3.05;

function lowerBodyDeviation(ref: LowerBodyFeat | null, user: LowerBodyFeat | null): number | null {
  if (!ref || !user) return null;

  let totalWeight = 0;
  let weightedSum = 0;

  if (ref.hipShiftX != null && user.hipShiftX != null) {
    totalWeight += 0.9;
    weightedSum += Math.abs(ref.hipShiftX - user.hipShiftX) * 0.9;
  }
  if (ref.kneeBendDeg != null && user.kneeBendDeg != null) {
    totalWeight += 1;
    weightedSum += Math.abs(ref.kneeBendDeg - user.kneeBendDeg) / 55;
  }
  if (ref.stepDir != null && user.stepDir != null) {
    totalWeight += 0.5;
    weightedSum += wrapAngleDiffRad(ref.stepDir, user.stepDir) * 0.5;
  }
  if (ref.footSpread != null && user.footSpread != null) {
    totalWeight += 0.65;
    weightedSum += Math.abs(ref.footSpread - user.footSpread) * 0.65;
  }

  if (totalWeight < LOWER_BODY_TOTAL_WEIGHT * 0.55) {
    return null;
  }

  return Math.min(1, weightedSum * (LOWER_BODY_TOTAL_WEIGHT / totalWeight));
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
    const upperDev = upperBodyDeviation(upperBodyFeat(refSeg), upperBodyFeat(userSeg));
    const lowerDev = lowerBodyDeviation(lowerBodyFeat(refSeg), lowerBodyFeat(userSeg));
    if (upperDev != null) {
      families.push({
        family: "upper_body",
        dev: upperDev,
      });
    }
    if (lowerDev != null) {
      families.push({
        family: "lower_body",
        dev: lowerDev,
      });
    }
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
    focusSide:
      family === "upper_body"
        ? dominantSideForFrames(refSeg, userSeg, ARM_SIDE_KEYPOINTS)
        : family === "lower_body"
          ? dominantSideForFrames(refSeg, userSeg, LEG_SIDE_KEYPOINTS)
          : "center",
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
