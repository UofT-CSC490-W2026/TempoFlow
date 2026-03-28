import { describe, expect, it } from "vitest";
import {
  angleDeltaDeg,
  angleDiffDeg,
  buildFallbackEbsCoachText,
  buildFallbackPerFrameOutputs,
  buildPerFrameCoachPayload,
  buildTemporalLlmPayload,
  estimateTimingLagSteps,
  frameMicroTimingOff,
  jointMotion,
  meanOfArray,
  median,
  shapeMismatchBand,
  type EbsTemporalPayload,
  type PerFrameCoachPayload,
} from "./ebsTemporalLlm";
import type { SampledPoseFrame } from "./bodyPix";

function kp(x: number, y: number, score = 1) {
  return { x, y, score };
}

/** 17 MoveNet-style keypoints with valid scores so joint angles resolve. */
function makeKeypoints(seed = 0) {
  return Array.from({ length: 17 }, (_, i) =>
    kp(100 + i * 3 + seed, 80 + i * 2 + seed * 0.5, 1),
  );
}

describe("pure helpers", () => {
  it("angleDiffDeg handles nulls and wrap past 180°", () => {
    expect(angleDiffDeg(null, 10)).toBeNull();
    expect(angleDiffDeg(10, 40)).toBe(30);
    expect(angleDiffDeg(10, 220)).toBe(150);
  });

  it("jointMotion averages deltas and skips nulls", () => {
    const prev: Record<string, number | null> = { "left elbow": 10 };
    const curr: Record<string, number | null> = { "left elbow": 200 };
    expect(jointMotion(prev, curr)).toBeGreaterThan(0);
    expect(jointMotion({ "left elbow": null }, { "left elbow": 10 })).toBe(0);
  });

  it("estimateTimingLagSteps returns 0 for empty or non-overlapping series", () => {
    expect(estimateTimingLagSteps([], [1])).toBe(0);
    expect(estimateTimingLagSteps([1], [])).toBe(0);
    expect(estimateTimingLagSteps([1, 1], [2, 2])).toBe(0);
  });

  it("estimateTimingLagSteps picks a non-zero lag when correlation improves", () => {
    const ref = [1, 0, 0, 0, 0];
    const user = [0, 0, 1, 0, 0];
    const lag = estimateTimingLagSteps(ref, user);
    expect(lag).not.toBe(0);
  });

  it("median handles empty, odd, and even lengths", () => {
    expect(median([])).toBe(0);
    expect(median([5])).toBe(5);
    expect(median([1, 5, 9])).toBe(5);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("angleDeltaDeg wraps through ±180°", () => {
    expect(angleDeltaDeg(null, 1)).toBeNull();
    expect(angleDeltaDeg(170, -170)).toBe(20);
    expect(angleDeltaDeg(-170, 170)).toBe(-20);
  });

  it("shapeMismatchBand maps thresholds", () => {
    expect(shapeMismatchBand(10)).toBe("low");
    expect(shapeMismatchBand(20)).toBe("med");
    expect(shapeMismatchBand(40)).toBe("high");
  });

  it("frameMicroTimingOff detects emphasis mismatch vs median residual", () => {
    expect(frameMicroTimingOff(0, [10, 5], [10, 5], 0)).toBe(false);
    expect(frameMicroTimingOff(99, [10], [10], 0)).toBe(false);
    const refEdges = [10, 5, 5, 5];
    const userEdges = [0, 0, 0, 0];
    expect(frameMicroTimingOff(1, refEdges, userEdges, 0)).toBe(true);
  });

  it("meanOfArray covers the empty-input branch", () => {
    expect(meanOfArray([])).toBe(0);
  });

  it("frameMicroTimingOff uses median fallback when residuals are all zero", () => {
    const refEdges = [2, 2, 2];
    const userEdges = [2, 2, 2];
    expect(frameMicroTimingOff(1, refEdges, userEdges, 0)).toBe(false);
  });

  it("frameMicroTimingOff skips out-of-range user indices when lag is negative", () => {
    const refEdges = [3, 4, 5];
    const userEdges = [10, 11];
    expect(frameMicroTimingOff(2, refEdges, userEdges, -1)).toBe(false);
  });
});

function makeFrame(
  timestamp: number,
  segmentIndex: number,
  keypointSeed = 0,
): SampledPoseFrame {
  return {
    timestamp,
    segmentIndex,
    keypoints: makeKeypoints(keypointSeed),
    partCoverage: { head: 0.1, arms: 0.2, torso: 0.2, legs: 0.2, full_body: 0.3 },
  };
}

describe("buildTemporalLlmPayload", () => {
  it("returns stable defaults when there are no samples", () => {
    const payload = buildTemporalLlmPayload([], [], []);
    expect(payload.sampleIntervalSecEstimate).toBe(1.5);
    expect(payload.aggregates.meanAbsAngleDiffDeg).toBe(0);
    expect(payload.motionWindows).toEqual([]);
    expect(payload.samples).toEqual([]);
    expect(payload.timingLagSec).toBe(0);
  });

  it("handles a single frame (no motion windows, interval estimate 1.5)", () => {
    const seg = [{ shared_start_sec: 0, shared_end_sec: 1 }];
    const ref = [makeFrame(0, 0)];
    const user = [makeFrame(0, 0, 1)];
    const p = buildTemporalLlmPayload(seg, ref, user);
    expect(p.motionWindows).toHaveLength(0);
    expect(p.samples).toHaveLength(1);
    expect(p.sampleIntervalSecEstimate).toBe(1.5);
    expect(p.segments).toEqual([{ index: 0, startSec: 0, endSec: 1 }]);
  });

  it("accumulates motion windows within a segment and skips tiny dt", () => {
    const seg = [{ shared_start_sec: 0, shared_end_sec: 2 }];
    const ref = [
      makeFrame(0, 0, 0),
      makeFrame(0.5, 0, 2),
      makeFrame(0.5 + 1e-7, 0, 4),
      makeFrame(1.0, 0, 6),
    ];
    const user = ref.map((f, i) => ({ ...f, keypoints: makeKeypoints(10 + i) }));
    const p = buildTemporalLlmPayload(seg, ref, user);
    expect(p.motionWindows.length).toBeGreaterThan(0);
  });

  it("skips motion across segment boundaries", () => {
    const seg = [
      { shared_start_sec: 0, shared_end_sec: 1 },
      { shared_start_sec: 1, shared_end_sec: 2 },
    ];
    const ref = [makeFrame(0, 0), makeFrame(0.5, 1)];
    const user = [makeFrame(0, 0, 1), makeFrame(0.5, 1, 2)];
    const p = buildTemporalLlmPayload(seg, ref, user);
    expect(p.motionWindows).toHaveLength(0);
  });

  it("strides samples when there are many frames", () => {
    const seg = [{ shared_start_sec: 0, shared_end_sec: 10 }];
    const ref: SampledPoseFrame[] = [];
    const user: SampledPoseFrame[] = [];
    for (let i = 0; i < 30; i++) {
      ref.push(makeFrame(i * 0.1, 0, i));
      user.push(makeFrame(i * 0.1, 0, i + 50));
    }
    const p = buildTemporalLlmPayload(seg, ref, user);
    expect(p.samples.length).toBeLessThanOrEqual(24);
    // Raw windows are downsampled to max_motion=20 (stride), so length ≤ ceil(29 / mStride).
    expect(p.motionWindows.length).toBeGreaterThan(0);
    expect(p.motionWindows.length).toBeLessThanOrEqual(29);
  });

  it("uses meanDiff 0 when all joint angle diffs are null (low confidence keypoints)", () => {
    const seg = [{ shared_start_sec: 0, shared_end_sec: 1 }];
    const low = Array.from({ length: 17 }, () => kp(0, 0, 0.05));
    const ref = [{ ...makeFrame(0, 0), keypoints: low }];
    const user = [{ ...makeFrame(0, 0), keypoints: low.map((k) => ({ ...k })) }];
    const p = buildTemporalLlmPayload(seg, ref, user);
    expect(p.samples[0]!.meanAngleDiffDeg).toBe(0);
  });

  it("records largestDiffJoint when a later joint beats an earlier one in diff magnitude", () => {
    const seg = [{ shared_start_sec: 0, shared_end_sec: 1 }];
    const ref = [makeFrame(0, 0, 0)];
    const userKp = makeKeypoints(1);
    for (const idx of [6, 8, 10]) {
      userKp[idx] = { ...userKp[idx], x: userKp[idx].x + 500, y: userKp[idx].y + 500 };
    }
    const user = [{ ...makeFrame(0, 0), keypoints: userKp }];
    const p = buildTemporalLlmPayload(seg, ref, user);
    expect(p.samples[0]!.largestDiffJoint.length).toBeGreaterThan(0);
    expect(p.samples[0]!.largestDiffDeg).toBeGreaterThan(0);
  });

  it("covers peak-to-mean ratio fallback when motion mean is near zero", () => {
    const seg = [{ shared_start_sec: 0, shared_end_sec: 1 }];
    const identical = makeKeypoints(0);
    const ref = [
      { ...makeFrame(0, 0), keypoints: identical },
      { ...makeFrame(0.2, 0), keypoints: identical.map((k) => ({ ...k })) },
    ];
    const user = ref.map((f) => ({ ...f }));
    const p = buildTemporalLlmPayload(seg, ref, user);
    expect(p.aggregates.refPeakToMeanMotion).toBe(1);
    expect(p.aggregates.userPeakToMeanMotion).toBe(1);
  });

  it("computes ref/user peak-to-mean ratios when motion means are well above zero", () => {
    const seg = [{ shared_start_sec: 0, shared_end_sec: 2 }];
    const base = makeKeypoints(0);
    const bent = makeKeypoints(0).map((k, i) =>
      i === 7 ? { ...k, x: k.x + 220, y: k.y - 80 } : { ...k },
    );
    const more = makeKeypoints(0).map((k, i) =>
      i === 8 ? { ...k, x: k.x - 180, y: k.y + 120 } : { ...k },
    );
    const ref = [
      { ...makeFrame(0, 0), keypoints: base },
      { ...makeFrame(0.2, 0), keypoints: bent },
      { ...makeFrame(0.4, 0), keypoints: more },
    ];
    const user = ref.map((f, i) => ({
      ...f,
      keypoints: f.keypoints.map((k, j) =>
        j === 9 ? { ...k, x: k.x + 50 * (i + 1), y: k.y + 30 * (i + 1) } : { ...k },
      ),
    }));
    const p = buildTemporalLlmPayload(seg, ref, user);
    expect(p.aggregates.refMotionMean).toBeGreaterThan(1e-3);
    expect(p.aggregates.userMotionMean).toBeGreaterThan(1e-3);
    expect(p.aggregates.refPeakToMeanMotion).not.toBe(1);
    expect(p.aggregates.userPeakToMeanMotion).not.toBe(1);
  });
});

describe("buildPerFrameCoachPayload", () => {
  it("returns one frame per sample with motion zeros when alone", () => {
    const seg = [{ shared_start_sec: 0, shared_end_sec: 1 }];
    const ref = [makeFrame(0, 0)];
    const user = [makeFrame(0, 0, 5)];
    const p = buildPerFrameCoachPayload(seg, ref, user);
    expect(p.frames).toHaveLength(1);
    expect(p.timingLagSteps).toBe(0);
    expect(p.frames[0]!.motion.refInto).toBe(0);
    expect(p.frames[0]!.motion.refOut).toBe(0);
  });

  it("computes in/out motion and shape bands across multiple frames", () => {
    const seg = [{ shared_start_sec: 0, shared_end_sec: 2 }];
    const ref = [makeFrame(0, 0, 0), makeFrame(0.5, 0, 3), makeFrame(1, 0, 6)];
    const user = ref.map((f, i) => ({ ...f, keypoints: makeKeypoints(20 + i * 5) }));
    const p = buildPerFrameCoachPayload(seg, ref, user);
    expect(p.frames).toHaveLength(3);
    expect(["low", "med", "high"]).toContain(p.frames[1]!.shapeMismatch);
  });

  it("inserts zero edges when crossing segment boundaries", () => {
    const seg = [
      { shared_start_sec: 0, shared_end_sec: 1 },
      { shared_start_sec: 1, shared_end_sec: 2 },
    ];
    const ref = [makeFrame(0, 0), makeFrame(0.5, 1)];
    const user = [makeFrame(0, 0, 1), makeFrame(0.5, 1, 2)];
    const p = buildPerFrameCoachPayload(seg, ref, user);
    expect(p.frames).toHaveLength(2);
  });

  it("uses meanDiff 0 when every joint angle diff is null (low confidence)", () => {
    const seg = [{ shared_start_sec: 0, shared_end_sec: 1 }];
    const low = Array.from({ length: 17 }, () => kp(0, 0, 0.05));
    const ref = [
      { ...makeFrame(0, 0), keypoints: low },
      { ...makeFrame(0.5, 0), keypoints: low.map((k) => ({ ...k })) },
    ];
    const user = ref.map((f) => ({ ...f }));
    const p = buildPerFrameCoachPayload(seg, ref, user);
    expect(p.frames[0]!.shapeMismatch).toBe("low");
    expect(p.frames.every((f) => f.shapeMismatch === "low")).toBe(true);
  });
});

describe("buildFallbackPerFrameOutputs", () => {
  function minimalPayload(overrides: Partial<PerFrameCoachPayload["frames"][0]> = {}): PerFrameCoachPayload {
    const base = {
      frameIndex: 0,
      t: 0,
      seg: 0,
      microTimingOff: false,
      shapeMismatch: "low" as const,
      ref: {
        prevAngles: {},
        currAngles: {},
        nextAngles: {},
        deltaPrevToCurr: {},
        deltaCurrToNext: {},
      },
      user: {
        prevAngles: {},
        currAngles: {},
        nextAngles: {},
        deltaPrevToCurr: {},
        deltaCurrToNext: {},
      },
      motion: { refInto: 0, userInto: 0, refOut: 10, userOut: 10 },
    };
    return {
      sampleIntervalSecEstimate: 0.1,
      timingLagSteps: 0,
      frames: [{ ...base, ...overrides }],
    };
  }

  it("covers micro-timing and shape-mismatch branches", () => {
    const a = buildFallbackPerFrameOutputs(minimalPayload({ microTimingOff: true, shapeMismatch: "high" }));
    expect(a[0]!.attackDecay).toContain("Micro-timing sits off");
    expect(a[0]!.attackDecay).toContain("Sharpen the attack");

    const b = buildFallbackPerFrameOutputs(minimalPayload({ shapeMismatch: "med" }));
    expect(b[0]!.attackDecay).toContain("Adjust attack/decay");

    const c = buildFallbackPerFrameOutputs(minimalPayload({ shapeMismatch: "low" }));
    expect(c[0]!.attackDecay).toContain("Fine-tune onset");
  });

  it("covers transition copy for ref vs user outgoing motion", () => {
    const highRef = buildFallbackPerFrameOutputs(
      minimalPayload({ motion: { refInto: 0, userInto: 0, refOut: 12, userOut: 5 } }),
    );
    expect(highRef[0]!.transitionToNext).toContain("carry a bit more energy");

    const highUser = buildFallbackPerFrameOutputs(
      minimalPayload({ motion: { refInto: 0, userInto: 0, refOut: 4, userOut: 10 } }),
    );
    expect(highUser[0]!.transitionToNext).toContain("Ease the outgoing");

    const mid = buildFallbackPerFrameOutputs(
      minimalPayload({ motion: { refInto: 0, userInto: 0, refOut: 10, userOut: 10 } }),
    );
    expect(mid[0]!.transitionToNext).toContain("Carry the line into the next shape");
  });
});

describe("buildFallbackEbsCoachText", () => {
  function basePayload(overrides: Partial<EbsTemporalPayload> = {}): EbsTemporalPayload {
    return {
      sampleIntervalSecEstimate: 0.1,
      segments: [],
      timingLagSec: 0,
      aggregates: {
        meanAbsAngleDiffDeg: 10,
        refMotionMean: 5,
        userMotionMean: 5,
        refPeakToMeanMotion: 1.2,
        userPeakToMeanMotion: 1.2,
      },
      samples: [],
      motionWindows: [],
      ...overrides,
    };
  }

  it("covers timing lag and attack/release branches", () => {
    const aligned = buildFallbackEbsCoachText(basePayload({ timingLagSec: 0.01 }));
    expect(aligned.microTiming).toContain("aligns closely");

    const late = buildFallbackEbsCoachText(basePayload({ timingLagSec: 0.2 }));
    expect(late.microTiming).toContain("after the reference");

    const early = buildFallbackEbsCoachText(basePayload({ timingLagSec: -0.2 }));
    expect(early.microTiming).toContain("ahead of the reference");

    const softAttack = buildFallbackEbsCoachText(
      basePayload({
        aggregates: {
          meanAbsAngleDiffDeg: 10,
          refMotionMean: 5,
          userMotionMean: 5,
          refPeakToMeanMotion: 2,
          userPeakToMeanMotion: 1,
        },
      }),
    );
    expect(softAttack.attackDecay).toContain("softer");

    const sharpAttack = buildFallbackEbsCoachText(
      basePayload({
        aggregates: {
          meanAbsAngleDiffDeg: 10,
          refMotionMean: 5,
          userMotionMean: 5,
          refPeakToMeanMotion: 1,
          userPeakToMeanMotion: 2,
        },
      }),
    );
    expect(sharpAttack.attackDecay).toContain("sharper than the reference");

    const balancedAttack = buildFallbackEbsCoachText(
      basePayload({
        aggregates: {
          meanAbsAngleDiffDeg: 10,
          refMotionMean: 5,
          userMotionMean: 5,
          refPeakToMeanMotion: 1,
          userPeakToMeanMotion: 1,
        },
      }),
    );
    expect(balancedAttack.attackDecay).toContain("similar range");

    const highMotion = buildFallbackEbsCoachText(
      basePayload({
        aggregates: {
          meanAbsAngleDiffDeg: 10,
          refMotionMean: 5,
          userMotionMean: 6,
          refPeakToMeanMotion: 1,
          userPeakToMeanMotion: 1,
        },
      }),
    );
    expect(highMotion.attackDecay).toContain("extra residual");

    const lowMotion = buildFallbackEbsCoachText(
      basePayload({
        aggregates: {
          meanAbsAngleDiffDeg: 10,
          refMotionMean: 5,
          userMotionMean: 4,
          refPeakToMeanMotion: 1,
          userPeakToMeanMotion: 1,
        },
      }),
    );
    expect(lowMotion.attackDecay).toContain("more flow");

    const releaseBalanced = buildFallbackEbsCoachText(
      basePayload({
        aggregates: {
          meanAbsAngleDiffDeg: 10,
          refMotionMean: 5,
          userMotionMean: 5,
          refPeakToMeanMotion: 1,
          userPeakToMeanMotion: 1,
        },
      }),
    );
    expect(releaseBalanced.attackDecay).toContain("matches the reference");
  });
});
