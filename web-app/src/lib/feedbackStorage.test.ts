import {
  buildFeedbackSegmentKey,
  deleteFeedbackSegment,
  GEMINI_FEEDBACK_CACHE_VERSION,
  getFeedbackSegment,
  hashEbsData,
  storeFeedbackSegment,
} from "./feedbackStorage";
import type { GeminiSegmentResult } from "./geminiFeedbackTypes";

describe("feedbackStorage", () => {
  it("buildFeedbackSegmentKey encodes session, segment, options, and ebs fingerprint", () => {
    expect(
      buildFeedbackSegmentKey({
        sessionId: "s1",
        segmentIndex: 2,
        burnInLabels: true,
        includeAudio: false,
        ebsFingerprint: "abc123",
      }),
    ).toBe(`s1:gemini-feedback:${GEMINI_FEEDBACK_CACHE_VERSION}:2:b1:a0:abc123`);
  });

  it("hashEbsData changes when EBS payload changes", () => {
    const a = hashEbsData({ beats: [1, 2] });
    const b = hashEbsData({ beats: [1, 3] });
    expect(a).not.toBe(b);
    expect(a).toBe(hashEbsData({ beats: [1, 2] }));
  });

  it("stores and reads segment results", async () => {
    const key = buildFeedbackSegmentKey({
      sessionId: "session-store",
      segmentIndex: 0,
      burnInLabels: false,
      includeAudio: false,
      ebsFingerprint: "fp",
    });
    const result: GeminiSegmentResult = {
      segment_index: 0,
      model: "gemini-test",
      moves: [],
    };
    await storeFeedbackSegment(key, result);
    expect(await getFeedbackSegment(key)).toEqual(result);
    await deleteFeedbackSegment(key);
    expect(await getFeedbackSegment(key)).toBeNull();
  });
});
