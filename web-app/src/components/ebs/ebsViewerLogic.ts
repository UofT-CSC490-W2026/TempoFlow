import type { EbsSegment, PracticeMove } from "./types";

export const SEGMENT_BOUNDARY_TOLERANCE = 0.02;
export const BEAT_FLASH_TOLERANCE = 0.06;

export function clampIndex(idx: number, length: number) {
  if (!Number.isFinite(idx) || length <= 0) return -1;
  return Math.max(0, Math.min(idx, length - 1));
}

export function findActiveSegmentIndex(sharedTime: number, segments: EbsSegment[]) {
  if (!Number.isFinite(sharedTime) || segments.length === 0) return -1;
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    if (sharedTime >= s.shared_start_sec && sharedTime < s.shared_end_sec) return i;
  }
  return -1;
}

export function buildMovesForSegment(
  beats: number[],
  segments: EbsSegment[],
  segmentIndex: number,
): PracticeMove[] {
  const segment = segments[segmentIndex];
  if (!segment?.beat_idx_range) return [];
  const [beatStart, beatEnd] = segment.beat_idx_range;
  if (beatEnd <= beatStart) return [];

  const moves: PracticeMove[] = [];
  const total = beatEnd - beatStart;
  for (let i = beatStart; i < beatEnd; i += 1) {
    if (beats[i] == null || beats[i + 1] == null) break;
    const num = i - beatStart + 1;
    moves.push({
      idx: num - 1,
      num,
      startSec: beats[i],
      endSec: beats[i + 1],
      isTransition: num === total,
    });
  }
  return moves;
}

export function findActiveMoveIndex(sharedTime: number, moves: PracticeMove[]) {
  if (!Number.isFinite(sharedTime) || moves.length === 0) return -1;
  for (let i = 0; i < moves.length; i += 1) {
    const m = moves[i];
    if (sharedTime >= m.startSec - 0.01 && sharedTime < m.endSec) return i;
  }
  return -1;
}

export function shouldLoopPracticeSegment(sharedTime: number, segment: EbsSegment) {
  return sharedTime >= segment.shared_end_sec - SEGMENT_BOUNDARY_TOLERANCE;
}

export function getClosestBeatIndex(sharedTime: number, beats: number[]) {
  if (!Number.isFinite(sharedTime) || beats.length === 0) return -1;
  for (let i = 0; i < beats.length; i += 1) {
    if (Math.abs(sharedTime - beats[i]) < BEAT_FLASH_TOLERANCE) return i;
  }
  return -1;
}

