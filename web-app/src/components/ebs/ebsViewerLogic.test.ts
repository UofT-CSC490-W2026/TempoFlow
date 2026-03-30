import { describe, expect, it } from "vitest";

import {
  buildMovesForSegment,
  findActiveMoveIndex,
  findActiveSegmentIndex,
  getClosestBeatIndex,
  shouldLoopPracticeSegment,
} from "./ebsViewerLogic";

describe("ebsViewerLogic", () => {
  it("findActiveSegmentIndex returns -1 when not inside any segment", () => {
    expect(findActiveSegmentIndex(0.5, [{ shared_start_sec: 1, shared_end_sec: 2 }])).toBe(-1);
  });

  it("findActiveSegmentIndex returns correct segment", () => {
    const segments = [
      { shared_start_sec: 0, shared_end_sec: 1 },
      { shared_start_sec: 1, shared_end_sec: 2 },
    ];
    expect(findActiveSegmentIndex(1.2, segments)).toBe(1);
  });

  it("buildMovesForSegment builds beat-to-beat moves and marks last as transition", () => {
    const beats = [0, 0.5, 1.0, 1.5];
    const segments = [{ shared_start_sec: 0, shared_end_sec: 2, beat_idx_range: [0, 3] as [number, number] }];
    const moves = buildMovesForSegment(beats, segments, 0);
    expect(moves).toHaveLength(3);
    expect(moves[0]).toMatchObject({ startSec: 0, endSec: 0.5, isTransition: false });
    expect(moves[2]).toMatchObject({ startSec: 1.0, endSec: 1.5, isTransition: true });
  });

  it("findActiveMoveIndex returns -1 when moves empty or outside range", () => {
    expect(findActiveMoveIndex(0, [])).toBe(-1);
    expect(findActiveMoveIndex(9, [{ idx: 0, num: 1, startSec: 0, endSec: 1, isTransition: false }])).toBe(-1);
  });

  it("findActiveMoveIndex finds current move", () => {
    const moves = [
      { idx: 0, num: 1, startSec: 0, endSec: 1, isTransition: false },
      { idx: 1, num: 2, startSec: 1, endSec: 2, isTransition: true },
    ];
    expect(findActiveMoveIndex(1.5, moves)).toBe(1);
  });

  it("getClosestBeatIndex returns -1 when no beat within tolerance", () => {
    expect(getClosestBeatIndex(10, [0, 1, 2])).toBe(-1);
  });

  it("getClosestBeatIndex returns beat when within tolerance", () => {
    expect(getClosestBeatIndex(1.02, [0, 1, 2])).toBe(1);
  });

  it("shouldLoopPracticeSegment becomes true near segment end", () => {
    const seg = { shared_start_sec: 0, shared_end_sec: 2 };
    expect(shouldLoopPracticeSegment(1.5, seg)).toBe(false);
    expect(shouldLoopPracticeSegment(1.99, seg)).toBe(true);
  });
});

