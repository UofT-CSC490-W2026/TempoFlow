import { describe, expect, it } from "vitest";

import { KEYPOINT_NAMES, REGION_PARTS, meanOfSamples, stdDeviation } from "./bodyPixComparison";

describe("bodyPixComparison exports", () => {
  it("re-exports bodyPix package symbols from stable path", () => {
    expect(Array.isArray(KEYPOINT_NAMES)).toBe(true);
    expect(KEYPOINT_NAMES.length).toBeGreaterThan(0);
    expect(typeof REGION_PARTS).toBe("object");
    expect(meanOfSamples([1, 2, 3])).toBe(2);
    expect(stdDeviation([2, 2, 2])).toBe(0);
  });
});

import {
  computeAngle,
  generateSampleTimestamps,
  jointAnglesDegFromKeypoints,
  type PoseKeypoint,
} from './bodyPixComparison';

function makeKeypoint(x: number, y: number, score = 1): PoseKeypoint {
  return { x, y, score };
}

function makePose(keypointOverrides: Record<number, PoseKeypoint>): PoseKeypoint[] {
  return Array.from({ length: 17 }, (_, index) => keypointOverrides[index] ?? makeKeypoint(0, 0));
}

describe('bodyPixComparison helpers', () => {
  it('computes signed joint angles from three visible keypoints', () => {
    const angle = computeAngle(makeKeypoint(1, 0), makeKeypoint(0, 0), makeKeypoint(0, 1));

    expect(angle).toBeCloseTo(90, 5);
  });

  it('returns null when any angle keypoint is not visible enough', () => {
    const angle = computeAngle(
      makeKeypoint(1, 0, 1),
      makeKeypoint(0, 0, 0.2),
      makeKeypoint(0, 1, 1),
    );

    expect(angle).toBeNull();
  });

  it('maps the tracked joint names to computed angles', () => {
    const keypoints = makePose({
      5: makeKeypoint(0, 0),
      6: makeKeypoint(2, 0),
      7: makeKeypoint(1, 0),
      8: makeKeypoint(3, 0),
      9: makeKeypoint(1, 1),
      10: makeKeypoint(3, 1),
      11: makeKeypoint(0, -2),
      12: makeKeypoint(2, -2),
      13: makeKeypoint(0, -3),
      14: makeKeypoint(2, -3),
      15: makeKeypoint(0, -4),
      16: makeKeypoint(2, -4),
    });

    const angles = jointAnglesDegFromKeypoints(keypoints);

    expect(Object.keys(angles)).toEqual([
      'left elbow',
      'right elbow',
      'left shoulder',
      'right shoulder',
      'left knee',
      'right knee',
      'left hip',
      'right hip',
    ]);
    expect(angles['left elbow']).toBeCloseTo(-90, 5);
    expect(angles['right elbow']).toBeCloseTo(-90, 5);
    expect(angles['left knee']).toBeCloseTo(-180, 5);
  });

  it('generates at least two timestamps per segment and keeps segment indices aligned', () => {
    const timestamps = generateSampleTimestamps(
      [
        { shared_start_sec: 0, shared_end_sec: 0.6 },
        { shared_start_sec: 2, shared_end_sec: 5 },
      ],
      1,
    );

    expect(timestamps).toEqual([
      { time: 0, segmentIndex: 0 },
      { time: 0.3, segmentIndex: 0 },
      { time: 2, segmentIndex: 1 },
      { time: 3, segmentIndex: 1 },
      { time: 4, segmentIndex: 1 },
    ]);
  });
});
