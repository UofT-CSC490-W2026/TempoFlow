import { describe, it, expect } from "vitest";
import { 
  EbsData, 
  EbsAlignment, 
  PracticeMove, 
  EbsBeatTracking 
} from "./types"; // Adjust path to your types file

describe("EbsData Type Definitions", () => {
  
  it("validates a complete EbsData object structure", () => {
    const validData: EbsData = {
      alignment: {
        clip_1_start_sec: 0,
        clip_2_start_sec: 1.5,
        shared_len_sec: 30.0,
        auto_align_mode: "chroma_sw"
      },
      segments: [
        {
          seg_id: "seg_001",
          shared_start_sec: 0,
          shared_end_sec: 5.0,
          clip_1_seg_start_sec: 0,
          clip_2_seg_start_sec: 1.5
        }
      ],
      beats_shared_sec: [0.5, 1.0, 1.5, 2.0],
      beat_tracking: {
        estimated_bpm: 120,
        num_beats: 60,
        source: "madmom"
      },
      segmentation_mode: "bodypix",
      video_meta: {
        clip_1: { fps: 30, duration_sec: 35 },
        clip_2: { fps: 60, duration_sec: 40 }
      }
    };

    expect(validData.alignment.shared_len_sec).toBe(30.0);
    expect(validData.segments).toHaveLength(1);
    expect(validData.beat_tracking?.estimated_bpm).toBe(120);
  });

  it("validates a minimal EbsData object (optional fields omitted)", () => {
    const minimalData: EbsData = {
      alignment: {
        clip_1_start_sec: 0,
        clip_2_start_sec: 0,
        shared_len_sec: 10
      },
      segments: []
    };

    expect(minimalData.alignment.clip_1_start_sec).toBe(0);
    expect(minimalData.segments).toEqual([]);
    expect(minimalData.beat_tracking).toBeUndefined();
  });

  it("validates PracticeMove structure", () => {
    const move: PracticeMove = {
      idx: 0,
      num: 1,
      startSec: 10.5,
      endSec: 15.0,
      isTransition: false
    };

    expect(move.num).toBe(1);
    expect(typeof move.isTransition).toBe("boolean");
  });

  describe("Edge Cases & Optionality", () => {
    it("allows both string and number for segment IDs", () => {
      const segWithNumber: EbsData["segments"][0] = {
        seg_id: 101,
        shared_start_sec: 0,
        shared_end_sec: 1
      };
      const segWithString: EbsData["segments"][0] = {
        seg_id: "intro-01",
        shared_start_sec: 0,
        shared_end_sec: 1
      };

      expect(segWithNumber.seg_id).toBe(101);
      expect(segWithString.seg_id).toBe("intro-01");
    });

    it("supports the specific auto_align_mode union types", () => {
      const alignment1: EbsAlignment = {
        clip_1_start_sec: 0,
        clip_2_start_sec: 0,
        shared_len_sec: 5,
        auto_align_mode: "chroma_sw"
      };

      const alignment2: EbsAlignment = {
        clip_1_start_sec: 0,
        clip_2_start_sec: 0,
        shared_len_sec: 5,
        auto_align_mode: "onset_xcorr"
      };

      expect(alignment1.auto_align_mode).toBe("chroma_sw");
      expect(alignment2.auto_align_mode).toBe("onset_xcorr");
    });
  });
});