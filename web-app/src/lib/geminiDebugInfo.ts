import type { EbsData, EbsSegment } from "../components/ebs/types";
import { buildMovesForSegment } from "../components/ebs/ebsViewerLogic";

/** Per-segment clip bounds sent to Gemini (matches A5 `run_move_feedback_pipeline`). */
export type GeminiSegmentDebugRow = {
  segmentIndex: number;
  sharedStartSec: number;
  sharedEndSec: number;
  beatIdxRange: [number, number] | null;
  refClipStartSec: number;
  refClipEndSec: number;
  userClipStartSec: number;
  userClipEndSec: number;
  moveCount: number;
  moves: Array<{ moveIndex: number; sharedStartSec: number; sharedEndSec: number }>;
};

export function buildGeminiSegmentDebugRows(ebsData: EbsData, segments: EbsSegment[]): GeminiSegmentDebugRow[] {
  const alignment = ebsData.alignment ?? {
    clip_1_start_sec: 0,
    clip_2_start_sec: 0,
    shared_len_sec: 0,
  };
  const beats = ebsData.beats_shared_sec ?? [];

  return segments.map((seg, segmentIndex) => {
    const clip1Start = alignment.clip_1_start_sec;
    const clip2Start = alignment.clip_2_start_sec;
    const refStart = seg.clip_1_seg_start_sec ?? clip1Start + seg.shared_start_sec;
    const refEnd = seg.clip_1_seg_end_sec ?? clip1Start + seg.shared_end_sec;
    const userStart = seg.clip_2_seg_start_sec ?? clip2Start + seg.shared_start_sec;
    const userEnd = seg.clip_2_seg_end_sec ?? clip2Start + seg.shared_end_sec;

    const br = seg.beat_idx_range;
    const beatIdxRange: [number, number] | null =
      br && br[1] > br[0] ? [br[0], br[1]] : null;

    const movesBuilt = buildMovesForSegment(beats, segments, segmentIndex);
    const moves = movesBuilt.map((m) => ({
      moveIndex: m.num,
      sharedStartSec: m.startSec,
      sharedEndSec: m.endSec,
    }));

    return {
      segmentIndex,
      sharedStartSec: seg.shared_start_sec,
      sharedEndSec: seg.shared_end_sec,
      beatIdxRange,
      refClipStartSec: refStart,
      refClipEndSec: refEnd,
      userClipStartSec: userStart,
      userClipEndSec: userEnd,
      moveCount: moves.length,
      moves,
    };
  });
}
