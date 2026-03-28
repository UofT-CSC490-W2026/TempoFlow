import {
  attackTransitionFeatureFromMotion,
  classifySeverity,
  computeAngle,
  DEFAULT_POSE_FPS,
  extractMicroTimingFeatures,
  familyMessage,
  FEEDBACK_FEATURE_LABELS,
  generateDenseTimestampsForSegments,
  generateSampleTimestamps,
  JOINT_ANGLES,
  jointAnglesDegFromKeypoints,
  meanOfSamples,
  stdDeviation,
  wrapAngleDiffRad,
} from "./index";
import { describe, expect, it } from "vitest";

function kp(x: number, y: number, score = 1) {
  return { x, y, score };
}

describe("constants and labels", () => {
  it("FEEDBACK_FEATURE_LABELS covers every feature family", () => {
    expect(Object.keys(FEEDBACK_FEATURE_LABELS).sort()).toEqual(
      ["attack_transition", "lower_body", "micro_timing", "upper_body"].sort(),
    );
  });

  it("JOINT_ANGLES has 8 entries", () => {
    expect(JOINT_ANGLES).toHaveLength(8);
  });

  it("DEFAULT_POSE_FPS is 6", () => {
    expect(DEFAULT_POSE_FPS).toBe(6);
  });
});

describe("computeAngle", () => {
  it("returns null when any keypoint is low confidence", () => {
    expect(computeAngle(kp(0, 0), kp(1, 0), kp(1, 1, 0.1))).toBeNull();
  });

  it("returns null when the center vertex b is low confidence", () => {
    expect(computeAngle(kp(0, 0), kp(1, 0, 0.1), kp(1, 1))).toBeNull();
  });

  it("returns ±90 degrees for a right angle at b", () => {
    const deg = computeAngle(kp(0, 1), kp(0, 0), kp(1, 0));
    expect(deg).not.toBeNull();
    expect(Math.abs(deg!)).toBeCloseTo(90, 5);
  });

  it("returns ~180° for collinear points (straight angle at b)", () => {
    const deg = computeAngle(kp(0, 0), kp(1, 0), kp(2, 0));
    expect(deg).not.toBeNull();
    expect(Math.abs(deg!)).toBeCloseTo(180, 5);
  });
});

describe("classifySeverity", () => {
  it("maps deviation thresholds to severities", () => {
    expect(classifySeverity(0.05)).toBe("good");
    expect(classifySeverity(0.119)).toBe("good");
    expect(classifySeverity(0.12)).toBe("minor");
    expect(classifySeverity(0.3)).toBe("moderate");
    expect(classifySeverity(0.41)).toBe("major");
  });

  it("uses exact boundary cutoffs (good / minor / moderate / major)", () => {
    expect(classifySeverity(0.119999)).toBe("good");
    expect(classifySeverity(0.12)).toBe("minor");
    expect(classifySeverity(0.249999)).toBe("minor");
    expect(classifySeverity(0.25)).toBe("moderate");
    expect(classifySeverity(0.399999)).toBe("moderate");
    expect(classifySeverity(0.4)).toBe("major");
  });
});

describe("familyMessage", () => {
  it("uses the neutral line when deviation is below threshold", () => {
    expect(familyMessage("attack_transition", 0.06)).toBe("Close to the reference.");
  });

  it("switches from neutral to coaching at dev >= 0.12", () => {
    expect(familyMessage("upper_body", 0.119)).toBe("Close to the reference.");
    expect(familyMessage("upper_body", 0.12)).toContain("Shoulder/elbow");
  });

  it("returns family-specific coaching when deviation is high", () => {
    expect(familyMessage("micro_timing", 0.2)).toContain("When motion starts");
    expect(familyMessage("upper_body", 0.2)).toContain("Shoulder/elbow");
    expect(familyMessage("lower_body", 0.2)).toContain("Hip shift");
    expect(familyMessage("attack_transition", 0.2)).toContain("Attack sharpness");
  });
});

describe("meanOfSamples", () => {
  it("returns 0 for an empty array", () => {
    expect(meanOfSamples([])).toBe(0);
  });

  it("averages non-empty arrays", () => {
    expect(meanOfSamples([2, 4, 6])).toBe(4);
  });
});

describe("jointAnglesDegFromKeypoints", () => {
  it("throws when keypoints array is shorter than joint index lookups require", () => {
    expect(() => jointAnglesDegFromKeypoints([kp(0, 0, 1)])).toThrow();
  });

  it("returns null for each joint when confidence is too low everywhere", () => {
    const pts = Array.from({ length: 17 }, () => kp(0, 0, 0.05));
    const out = jointAnglesDegFromKeypoints(pts);
    expect(out["left elbow"]).toBeNull();
  });

  it("computes angles when keypoints are valid", () => {
    const pts = Array.from({ length: 17 }, (_, i) => kp(i * 0.1, i * 0.05, 1));
    const out = jointAnglesDegFromKeypoints(pts);
    expect(typeof out["left elbow"]).toBe("number");
  });
});

describe("generateDenseTimestampsForSegments", () => {
  it("returns empty when segments array is empty", () => {
    expect(generateDenseTimestampsForSegments([], 6)).toEqual([]);
  });

  it("returns empty when no valid intervals", () => {
    expect(
      generateDenseTimestampsForSegments([{ shared_start_sec: 1, shared_end_sec: 0 }], 6),
    ).toEqual([]);
  });

  it("steps at ~1/fps and caps dt via max(0.5, fps)", () => {
    const out = generateDenseTimestampsForSegments([{ shared_start_sec: 0, shared_end_sec: 1 }], 0.25);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0]!.segmentIndex).toBe(0);
  });

  it("covers multiple segments", () => {
    const out = generateDenseTimestampsForSegments(
      [
        { shared_start_sec: 0, shared_end_sec: 0.5 },
        { shared_start_sec: 1, shared_end_sec: 1.4 },
      ],
      10,
    );
    const segIdx = new Set(out.map((o) => o.segmentIndex));
    expect(segIdx.has(0)).toBe(true);
    expect(segIdx.has(1)).toBe(true);
  });
});

describe("generateSampleTimestamps", () => {
  it("returns empty when segments array is empty", () => {
    expect(generateSampleTimestamps([])).toEqual([]);
  });

  it("uses default sample interval", () => {
    const out = generateSampleTimestamps([{ shared_start_sec: 0, shared_end_sec: 2 }]);
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it("respects custom interval and short segments", () => {
    const out = generateSampleTimestamps([{ shared_start_sec: 0, shared_end_sec: 0.1 }], 0.05);
    expect(out.length).toBeGreaterThanOrEqual(2);
  });
});

describe("metric helpers (branch coverage)", () => {
  it("stdDeviation returns 0 for fewer than 2 values", () => {
    expect(stdDeviation([])).toBe(0);
    expect(stdDeviation([1])).toBe(0);
  });

  it("stdDeviation computes spread for two or more values", () => {
    expect(stdDeviation([1, 5])).toBe(2);
  });

  it("extractMicroTimingFeatures covers empty motion and non-empty onset/peak paths", () => {
    expect(extractMicroTimingFeatures([])).toEqual({
      onsetNorm: 0.5,
      peakNorm: 0.5,
      settleRatio: 1,
    });
    const m = [0, 0, 0, 0, 0, 0.4, 0.9, 0.3];
    const f = extractMicroTimingFeatures(m);
    expect(f.onsetNorm).toBeGreaterThan(0);
    expect(f.peakNorm).toBeGreaterThan(0);
  });

  it("wrapAngleDiffRad uses the short arc when |a−b| ≤ π", () => {
    expect(wrapAngleDiffRad(0.1, 0.4)).toBeCloseTo(0.3 / Math.PI, 10);
  });

  it("wrapAngleDiffRad uses the complementary arc when |a−b| > π", () => {
    const b = Math.PI + 1.2;
    const d = Math.abs(0 - b);
    const wrapped = d > Math.PI ? 2 * Math.PI - d : d;
    expect(wrapAngleDiffRad(0, b)).toBeCloseTo(wrapped / Math.PI, 10);
  });

  it("attackTransitionFeatureFromMotion covers empty, single-sample, and std on second half", () => {
    expect(attackTransitionFeatureFromMotion([])).toEqual({
      sharpness: 1,
      lateVar: 0,
      tailEnergy: 0,
    });
    expect(attackTransitionFeatureFromMotion([7]).tailEnergy).toBe(7);
    const multi = attackTransitionFeatureFromMotion([1, 2, 10, 12]);
    expect(multi.tailEnergy).toBeCloseTo(11, 5);
    expect(multi.lateVar).toBeGreaterThanOrEqual(0);
  });
});
