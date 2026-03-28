import type { SampledPoseFrame } from "./bodyPix";
import { JOINT_ANGLES, jointAnglesDegFromKeypoints } from "./bodyPix";

export type EbsSegmentMeta = { shared_start_sec: number; shared_end_sec: number };

export type EbsTemporalPayload = {
  sampleIntervalSecEstimate: number;
  segments: Array<{ index: number; startSec: number; endSec: number }>;
  /** Positive ≈ practice motion peaks slightly after reference (late); negative ≈ early. */
  timingLagSec: number;
  aggregates: {
    meanAbsAngleDiffDeg: number;
    refMotionMean: number;
    userMotionMean: number;
    refPeakToMeanMotion: number;
    userPeakToMeanMotion: number;
  };
  /** Strided snapshot for micro-timing vs reference shape. */
  samples: Array<{
    t: number;
    seg: number;
    meanAngleDiffDeg: number;
    largestDiffJoint: string;
    largestDiffDeg: number;
  }>;
  /** Adjacent-frame motion (proxy for attack/release). */
  motionWindows: Array<{
    tMid: number;
    seg: number;
    dtSec: number;
    refMotion: number;
    userMotion: number;
  }>;
};

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Exposed for tests (`mean([])` branch) and optional reuse. */
export function meanOfArray(nums: number[]): number {
  return mean(nums);
}

/** Exported for unit tests (pure geometry helpers). */
export function angleDiffDeg(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  let d = Math.abs(a - b);
  if (d > 180) d = 360 - d;
  return d;
}

/** Exported for unit tests. */
export function jointMotion(prev: Record<string, number | null>, curr: Record<string, number | null>): number {
  const deltas: number[] = [];
  for (const ja of JOINT_ANGLES) {
    const p = prev[ja.name];
    const q = curr[ja.name];
    if (p == null || q == null) continue;
    let d = Math.abs(q - p);
    if (d > 180) d = 360 - d;
    deltas.push(d);
  }
  return deltas.length ? mean(deltas) : 0;
}

/**
 * Find integer lag (in steps) that best aligns user motion energy with reference.
 */
/** Exported for unit tests. */
export function estimateTimingLagSteps(refMag: number[], userMag: number[]): number {
  if (refMag.length === 0 || userMag.length === 0) return 0;
  const maxLag = Math.min(6, Math.floor(refMag.length / 2));
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0;
    let c = 0;
    for (let i = 0; i < refMag.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= userMag.length) continue;
      s += refMag[i] * userMag[j];
      c++;
    }
    if (c > 0 && s > bestScore) {
      bestScore = s;
      bestLag = lag;
    }
  }
  return bestLag;
}

export function buildTemporalLlmPayload(
  segments: EbsSegmentMeta[],
  refSamples: SampledPoseFrame[],
  userSamples: SampledPoseFrame[],
): EbsTemporalPayload {
  const perSampleRaw: Array<{
    t: number;
    seg: number;
    diffs: Record<string, number>;
    meanDiff: number;
  }> = [];

  for (let i = 0; i < refSamples.length; i++) {
    const refA = jointAnglesDegFromKeypoints(refSamples[i].keypoints);
    const userA = jointAnglesDegFromKeypoints(userSamples[i].keypoints);
    const diffs: Record<string, number> = {};
    for (const ja of JOINT_ANGLES) {
      const d = angleDiffDeg(refA[ja.name], userA[ja.name]);
      if (d != null) diffs[ja.name] = d;
    }
    const values = Object.values(diffs);
    const meanDiff = values.length ? mean(values) : 0;
    perSampleRaw.push({
      t: refSamples[i].timestamp,
      seg: refSamples[i].segmentIndex,
      diffs,
      meanDiff,
    });
  }

  const motionWindows: EbsTemporalPayload["motionWindows"] = [];
  const refMag: number[] = [];
  const userMag: number[] = [];

  for (let i = 1; i < refSamples.length; i++) {
    if (refSamples[i].segmentIndex !== refSamples[i - 1].segmentIndex) continue;
    const dt = refSamples[i].timestamp - refSamples[i - 1].timestamp;
    if (dt < 1e-6) continue;

    const refPrev = jointAnglesDegFromKeypoints(refSamples[i - 1].keypoints);
    const refCurr = jointAnglesDegFromKeypoints(refSamples[i].keypoints);
    const userPrev = jointAnglesDegFromKeypoints(userSamples[i - 1].keypoints);
    const userCurr = jointAnglesDegFromKeypoints(userSamples[i].keypoints);

    const refM = jointMotion(refPrev, refCurr);
    const userM = jointMotion(userPrev, userCurr);
    refMag.push(refM);
    userMag.push(userM);
    motionWindows.push({
      tMid: (refSamples[i - 1].timestamp + refSamples[i].timestamp) / 2,
      seg: refSamples[i].segmentIndex,
      dtSec: dt,
      refMotion: refM,
      userMotion: userM,
    });
  }

  const avgDt =
    motionWindows.length > 0
      ? motionWindows.reduce((s, m) => s + m.dtSec, 0) / motionWindows.length
      : 1.5;
  const lagSteps = estimateTimingLagSteps(refMag, userMag);
  const timingLagSec = lagSteps * avgDt;

  const allDiffs = perSampleRaw.flatMap((p) => Object.values(p.diffs));
  const meanAbsAngleDiffDeg = allDiffs.length ? mean(allDiffs) : 0;

  const refMotionMean = refMag.length ? mean(refMag) : 0;
  const userMotionMean = userMag.length ? mean(userMag) : 0;
  const refPeak = refMag.length ? Math.max(...refMag) : 0;
  const userPeak = userMag.length ? Math.max(...userMag) : 0;
  const refPeakToMeanMotion = refMotionMean > 1e-6 ? refPeak / refMotionMean : 1;
  const userPeakToMeanMotion = userMotionMean > 1e-6 ? userPeak / userMotionMean : 1;

  const sampleIntervalSecEstimate =
    refSamples.length > 1
      ? (refSamples[refSamples.length - 1].timestamp - refSamples[0].timestamp) /
        Math.max(1, refSamples.length - 1)
      : 1.5;

  const maxSamples = 24;
  const stride = Math.max(1, Math.ceil(perSampleRaw.length / maxSamples));
  const samples: EbsTemporalPayload["samples"] = [];
  for (let i = 0; i < perSampleRaw.length; i += stride) {
    const p = perSampleRaw[i];
    let largestDiffJoint = "";
    let largestDiffDeg = 0;
    for (const [name, deg] of Object.entries(p.diffs)) {
      if (deg > largestDiffDeg) {
        largestDiffDeg = deg;
        largestDiffJoint = name;
      }
    }
    samples.push({
      t: p.t,
      seg: p.seg,
      meanAngleDiffDeg: Math.round(p.meanDiff * 10) / 10,
      largestDiffJoint,
      largestDiffDeg: Math.round(largestDiffDeg * 10) / 10,
    });
  }

  const maxMotion = 20;
  const mStride = Math.max(1, Math.ceil(motionWindows.length / maxMotion));
  const slimMotion = motionWindows.filter((_, idx) => idx % mStride === 0).map((m) => ({
    tMid: Math.round(m.tMid * 10) / 10,
    seg: m.seg,
    dtSec: Math.round(m.dtSec * 100) / 100,
    refMotion: Math.round(m.refMotion * 10) / 10,
    userMotion: Math.round(m.userMotion * 10) / 10,
  }));

  return {
    sampleIntervalSecEstimate: Math.round(sampleIntervalSecEstimate * 100) / 100,
    segments: segments.map((s, index) => ({
      index,
      startSec: s.shared_start_sec,
      endSec: s.shared_end_sec,
    })),
    timingLagSec: Math.round(timingLagSec * 1000) / 1000,
    aggregates: {
      meanAbsAngleDiffDeg: Math.round(meanAbsAngleDiffDeg * 10) / 10,
      refMotionMean: Math.round(refMotionMean * 10) / 10,
      userMotionMean: Math.round(userMotionMean * 10) / 10,
      refPeakToMeanMotion: Math.round(refPeakToMeanMotion * 100) / 100,
      userPeakToMeanMotion: Math.round(userPeakToMeanMotion * 100) / 100,
    },
    samples,
    motionWindows: slimMotion,
  };
}

export type EbsLlmCoachDimensions = {
  microTiming: string;
  attackDecay: string;
};

/** One sampled frame for per-frame LLM + UI. */
export type PerFrameCoachRow = {
  frameIndex: number;
  t: number;
  seg: number;
  microTimingOff: boolean;
  shapeMismatch: "low" | "med" | "high";
  ref: {
    prevAngles: Record<string, number | null>;
    currAngles: Record<string, number | null>;
    nextAngles: Record<string, number | null>;
    deltaPrevToCurr: Record<string, number>;
    deltaCurrToNext: Record<string, number>;
  };
  user: {
    prevAngles: Record<string, number | null>;
    currAngles: Record<string, number | null>;
    nextAngles: Record<string, number | null>;
    deltaPrevToCurr: Record<string, number>;
    deltaCurrToNext: Record<string, number>;
  };
  motion: {
    refInto: number;
    userInto: number;
    refOut: number;
    userOut: number;
  };
};

export type PerFrameCoachPayload = {
  sampleIntervalSecEstimate: number;
  timingLagSteps: number;
  frames: PerFrameCoachRow[];
};

/** Exported for unit tests. */
export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Exported for unit tests. */
export function angleDeltaDeg(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/** Exported for unit tests. */
export function shapeMismatchBand(meanDiffDeg: number): "low" | "med" | "high" {
  if (meanDiffDeg < 18) return "low";
  if (meanDiffDeg < 35) return "med";
  return "high";
}

/** Exported for unit tests. */
export function frameMicroTimingOff(
  frameIndex: number,
  refEdges: number[],
  userEdges: number[],
  lagSteps: number,
): boolean {
  // refEdges[k] = motion from frame k -> k+1
  if (frameIndex <= 0 || frameIndex >= refEdges.length) return false;
  const er = refEdges[frameIndex - 1];
  const uj = frameIndex - 1 + lagSteps;
  if (uj < 0 || uj >= userEdges.length) return false;
  const eu = userEdges[uj];
  const residuals: number[] = [];
  for (let k = 0; k < refEdges.length; k++) {
    const uk = k + lagSteps;
    if (uk < 0 || uk >= userEdges.length) continue;
    residuals.push(Math.abs(refEdges[k] - userEdges[uk]));
  }
  const med = median(residuals) || 1e-6;
  const res = Math.abs(er - eu);
  return er > med * 0.35 && res > med * 1.35;
}

export function buildPerFrameCoachPayload(
  segments: EbsSegmentMeta[],
  refSamples: SampledPoseFrame[],
  userSamples: SampledPoseFrame[],
): PerFrameCoachPayload {
  const n = refSamples.length;
  const refAngles = refSamples.map((s) => jointAnglesDegFromKeypoints(s.keypoints));
  const userAngles = userSamples.map((s) => jointAnglesDegFromKeypoints(s.keypoints));

  const refEdges: number[] = [];
  const userEdges: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    if (refSamples[i].segmentIndex !== refSamples[i + 1].segmentIndex) {
      refEdges.push(0);
      userEdges.push(0);
      continue;
    }
    refEdges.push(jointMotion(refAngles[i], refAngles[i + 1]));
    userEdges.push(jointMotion(userAngles[i], userAngles[i + 1]));
  }

  const lagSteps = estimateTimingLagSteps(refEdges, userEdges);
  const sampleIntervalSecEstimate =
    n > 1
      ? (refSamples[n - 1].timestamp - refSamples[0].timestamp) / Math.max(1, n - 1)
      : 1.5;

  const frames: PerFrameCoachRow[] = [];

  for (let i = 0; i < n; i++) {
    const pi = Math.max(0, i - 1);
    const ni = Math.min(n - 1, i + 1);

    const delta = (prev: Record<string, number | null>, curr: Record<string, number | null>) => {
      const out: Record<string, number> = {};
      for (const ja of JOINT_ANGLES) {
        const d = angleDeltaDeg(prev[ja.name], curr[ja.name]);
        if (d != null) out[ja.name] = Math.round(d * 10) / 10;
      }
      return out;
    };

    const refPrev = refAngles[pi];
    const refCurr = refAngles[i];
    const refNext = refAngles[ni];
    const userPrev = userAngles[pi];
    const userCurr = userAngles[i];
    const userNext = userAngles[ni];

    const diffs: number[] = [];
    for (const ja of JOINT_ANGLES) {
      const d = angleDiffDeg(refCurr[ja.name], userCurr[ja.name]);
      if (d != null) diffs.push(d);
    }
    const meanDiff = diffs.length ? mean(diffs) : 0;

    const refInto = i > 0 && refSamples[i].segmentIndex === refSamples[i - 1].segmentIndex
      ? jointMotion(refAngles[i - 1], refCurr)
      : 0;
    const userInto =
      i > 0 && userSamples[i].segmentIndex === userSamples[i - 1].segmentIndex
        ? jointMotion(userAngles[i - 1], userCurr)
        : 0;
    const refOut =
      i < n - 1 && refSamples[i].segmentIndex === refSamples[i + 1].segmentIndex
        ? jointMotion(refCurr, refAngles[i + 1])
        : 0;
    const userOut =
      i < n - 1 && userSamples[i].segmentIndex === userSamples[i + 1].segmentIndex
        ? jointMotion(userCurr, userAngles[i + 1])
        : 0;

    frames.push({
      frameIndex: i,
      t: Math.round(refSamples[i].timestamp * 100) / 100,
      seg: refSamples[i].segmentIndex,
      microTimingOff: frameMicroTimingOff(i, refEdges, userEdges, lagSteps),
      shapeMismatch: shapeMismatchBand(meanDiff),
      ref: {
        prevAngles: refPrev,
        currAngles: refCurr,
        nextAngles: refNext,
        deltaPrevToCurr: delta(refPrev, refCurr),
        deltaCurrToNext: delta(refCurr, refNext),
      },
      user: {
        prevAngles: userPrev,
        currAngles: userCurr,
        nextAngles: userNext,
        deltaPrevToCurr: delta(userPrev, userCurr),
        deltaCurrToNext: delta(userCurr, userNext),
      },
      motion: {
        refInto: Math.round(refInto * 10) / 10,
        userInto: Math.round(userInto * 10) / 10,
        refOut: Math.round(refOut * 10) / 10,
        userOut: Math.round(userOut * 10) / 10,
      },
    });
  }

  return {
    sampleIntervalSecEstimate: Math.round(sampleIntervalSecEstimate * 100) / 100,
    timingLagSteps: lagSteps,
    frames,
  };
}

export type PerFrameLlmOutput = {
  frameIndex: number;
  microTimingOff: boolean;
  attackDecay: string;
  transitionToNext: string;
};

export function buildFallbackPerFrameOutputs(payload: PerFrameCoachPayload): PerFrameLlmOutput[] {
  return payload.frames.map((f) => {
    const timing =
      f.microTimingOff
        ? "Micro-timing sits off the reference motion emphasis here—shift the pocket slightly to match the reference line."
        : "Micro-timing aligns with the reference at this sample.";
    const attack =
      f.shapeMismatch === "high"
        ? "Sharpen the attack and clean up the release: commit the hit, then control the decay so the shape matches the reference energy."
        : f.shapeMismatch === "med"
          ? "Adjust attack/decay contrast—tighter stop on the hold, smoother release into the next shape."
          : "Fine-tune onset and release so the phrase breathes like the reference.";
    const transition =
      f.motion.refOut > f.motion.userOut * 1.2
        ? "From here, let the next transition carry a bit more energy out of the shape, matching the reference’s sweep into the following pose."
        : f.motion.refOut < f.motion.userOut * 0.8
          ? "Ease the outgoing motion toward the next pose—avoid overshooting the reference’s path."
          : "Carry the line into the next shape with the same clarity as the reference—match the reference’s transition path from this pose to the next.";

    return {
      frameIndex: f.frameIndex,
      microTimingOff: f.microTimingOff,
      attackDecay: `${timing} ${attack}`,
      transitionToNext: transition,
    };
  });
}

export function buildFallbackEbsCoachText(payload: EbsTemporalPayload): EbsLlmCoachDimensions {
  const { timingLagSec, aggregates } = payload;
  const lateEarly =
    Math.abs(timingLagSec) < 0.08
      ? "Your phrase shaping aligns closely with the reference’s motion emphasis."
      : timingLagSec > 0
        ? "Practice motion peaks arrive slightly after the reference—place accents a hair earlier to lock to the same pocket."
        : "You are ahead of the reference’s motion emphasis—let accents settle slightly later to match the reference line.";

  const attack =
    aggregates.userPeakToMeanMotion < aggregates.refPeakToMeanMotion * 0.85
      ? "Attacks read softer than the reference; sharpen the onset and commit the position in fewer frames."
      : aggregates.userPeakToMeanMotion > aggregates.refPeakToMeanMotion * 1.2
        ? "Onsets are sharper than the reference; ease the hit slightly and control the top of the shape."
        : "Attack contrast is in a similar range to the reference; keep monitoring clean stops on holds.";

  const release =
    aggregates.userMotionMean > aggregates.refMotionMean * 1.15
      ? "Transitions carry extra residual motion—use a cleaner release and quieter joints between shapes."
      : aggregates.userMotionMean < aggregates.refMotionMean * 0.85
        ? "Between shapes, add a touch more flow so releases don’t feel clipped relative to the reference."
        : "Release energy between positions matches the reference’s general range.";

  return {
    microTiming: lateEarly,
    attackDecay: `${attack} ${release}`,
  };
}
