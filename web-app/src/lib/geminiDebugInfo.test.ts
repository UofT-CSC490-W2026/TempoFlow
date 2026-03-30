import { describe, it, expect } from "vitest";
import { buildGeminiSegmentDebugRows } from "./geminiDebugInfo";
import type { EbsData, EbsSegment } from "../components/ebs/types";

describe("buildGeminiSegmentDebugRows", () => {
  it("computes ref/user clip bounds and move windows from EBS", () => {
    const ebsData: EbsData = {
      alignment: {
        clip_1_start_sec: 10,
        clip_2_start_sec: 20,
        shared_len_sec: 5,
      },
      segments: [
        {
          shared_start_sec: 1,
          shared_end_sec: 3,
          beat_idx_range: [0, 1],
          clip_1_seg_start_sec: 11,
          clip_1_seg_end_sec: 13,
          clip_2_seg_start_sec: 21,
          clip_2_seg_end_sec: 23,
        },
      ],
      beats_shared_sec: [1.0, 2.0, 3.0],
    };
    const segments: EbsSegment[] = ebsData.segments;
    const rows = buildGeminiSegmentDebugRows(ebsData, segments);
    expect(rows).toHaveLength(1);
    expect(rows[0].refClipStartSec).toBe(11);
    expect(rows[0].userClipEndSec).toBe(23);
    expect(rows[0].moves).toHaveLength(1);
    expect(rows[0].moves[0].moveIndex).toBe(1);
    expect(rows[0].moves[0].sharedStartSec).toBe(1);
    expect(rows[0].moves[0].sharedEndSec).toBe(2);
  });
});
