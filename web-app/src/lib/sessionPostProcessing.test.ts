import { describe, it, expect, vi, beforeEach } from "vitest";
import { 
  getGeminiProcessableSegmentCount, 
  mergePostProcessMeta, 
  isSessionPostProcessComplete, 
  shouldTreatSessionAsInProcess 
} from "./sessionPostProcessing";

describe("sessionPostProcessing utilities", () => {
  
  describe("getGeminiProcessableSegmentCount", () => {
    it("returns 0 for null or undefined input", () => {
      expect(getGeminiProcessableSegmentCount(null)).toBe(0);
      expect(getGeminiProcessableSegmentCount(undefined)).toBe(0);
    });

    it("filters out invalid ranges and returns correct count", () => {
      const mockEbsData = {
        segments: [
          { beat_idx_range: [0, 5] },   // Valid: 5 > 0
          { beat_idx_range: [10, 10] }, // Invalid: 10 is not > 10
          { beat_idx_range: [15, 5] },  // Invalid: 5 is not > 15
          { beat_idx_range: null },     // Invalid: null
        ]
      };
      // @ts-ignore - simplified mock
      expect(getGeminiProcessableSegmentCount(mockEbsData)).toBe(1);
    });
  });

  describe("mergePostProcessMeta", () => {
    it("provides defaults when original meta is undefined", () => {
      const updates = { segmentCount: 5 };
      const result = mergePostProcessMeta(undefined, updates);
      
      expect(result.segmentCount).toBe(5);
      expect(result.sharedDurationSec).toBe(0);
      expect(result.generatedAt).toBeDefined();
    });

    it("overwrites existing meta with updates", () => {
      const existing = { 
        segmentCount: 1, 
        sharedDurationSec: 10, 
        generatedAt: "old-date" 
      };
      const updates = { segmentCount: 10 };
      const result = mergePostProcessMeta(existing as any, updates);
      
      expect(result.segmentCount).toBe(10);
      expect(result.sharedDurationSec).toBe(10);
    });
  });

  describe("isSessionPostProcessComplete", () => {
    it("returns false if no meta exists", () => {
      expect(isSessionPostProcessComplete(null)).toBe(false);
    });

    it("returns true if postProcessStatus is 'ready'", () => {
      const session = { ebsMeta: { postProcessStatus: "ready" } };
      expect(isSessionPostProcessComplete(session as any)).toBe(true);
    });

    it("returns true only when all segment counts (YOLO, Visual, Gemini) meet totals", () => {
      const session = {
        ebsMeta: {
          segmentCount: 5,
          geminiTotalSegments: 5,
          yoloReadySegments: 5,
          visualReadySegments: 5,
          geminiReadySegments: 4, // One short
        }
      };
      expect(isSessionPostProcessComplete(session as any)).toBe(false);

      // Complete the last one
      session.ebsMeta.geminiReadySegments = 5;
      expect(isSessionPostProcessComplete(session as any)).toBe(true);
    });

    it("returns true if a finalScore exists and there are segments", () => {
      const session = {
        ebsMeta: { 
            finalScore: 85, 
            segmentCount: 2 
        }
      };
      expect(isSessionPostProcessComplete(session as any)).toBe(true);
    });
  });

  describe("shouldTreatSessionAsInProcess", () => {
    it("returns false for paused or error status", () => {
      expect(shouldTreatSessionAsInProcess({ ebsStatus: "paused" } as any)).toBe(false);
      expect(shouldTreatSessionAsInProcess({ ebsStatus: "error" } as any)).toBe(false);
    });

    it("returns true if explicitly processing or analyzing", () => {
      expect(shouldTreatSessionAsInProcess({ ebsStatus: "processing" } as any)).toBe(true);
      expect(shouldTreatSessionAsInProcess({ status: "analyzing" } as any)).toBe(true);
    });

    it("returns true if session is 'ready' but post-processing is incomplete", () => {
      const session = {
        status: "analyzed",
        ebsStatus: "ready",
        ebsMeta: {
          segmentCount: 10,
          yoloReadySegments: 5, // Incomplete
          postProcessStatus: "idle"
        }
      };
      expect(shouldTreatSessionAsInProcess(session as any)).toBe(true);
    });

    it("returns false if everything is actually finished", () => {
        const session = {
          status: "analyzed",
          ebsStatus: "ready",
          ebsMeta: {
            postProcessStatus: "ready"
          }
        };
        expect(shouldTreatSessionAsInProcess(session as any)).toBe(false);
      });
  });
});