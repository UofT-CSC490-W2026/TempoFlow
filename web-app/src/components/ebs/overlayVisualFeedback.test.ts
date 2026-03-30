import { describe, expect, it } from "vitest";

import { buildOverlayVisualCue, pickActiveSegmentFeedback } from "./overlayFeedbackCue";

describe("overlayVisualFeedback", () => {
  it("prefers position-diff feedback in the middle of a section", () => {
    const feedback = [
      {
        timestamp: 2.5,
        segmentIndex: 0,
        bodyRegion: "torso" as const,
        severity: "minor" as const,
        message: "Timing differs from the guide phrase.",
        deviation: 0.18,
        featureFamily: "micro_timing" as const,
      },
      {
        timestamp: 2.5,
        segmentIndex: 0,
        bodyRegion: "arms" as const,
        severity: "moderate" as const,
        message: "Upper-body shape differs from the guide phrase.",
        deviation: 0.31,
        featureFamily: "upper_body" as const,
      },
    ];

    const active = pickActiveSegmentFeedback({
      feedback,
      segment: { shared_start_sec: 0, shared_end_sec: 5 },
      segmentIndex: 0,
      sharedTime: 2.7,
    });

    expect(active?.featureFamily).toBe("upper_body");
  });

  it("anchors a cue using normalized practice segmentation bounds", () => {
    const cue = buildOverlayVisualCue({
      feedback: {
        timestamp: 2.5,
        segmentIndex: 0,
        bodyRegion: "arms",
        severity: "moderate",
        message: "Upper-body shape differs from the reference phrase.",
        deviation: 0.31,
        featureFamily: "upper_body",
      },
      practiceArtifact: {
        version: 1,
        type: "yolo",
        side: "practice",
        fps: 12,
        width: 1280,
        height: 720,
        frameCount: 1,
        createdAt: "",
        segments: [
          {
            index: 0,
            startSec: 0,
            endSec: 5,
            fps: 12,
            width: 1280,
            height: 720,
            frameCount: 1,
            createdAt: "",
            meta: {
              segSummary: {
                persons: [
                  {
                    anchor_x: 0.62,
                    anchor_y: 0.88,
                    center_x: 0.62,
                    center_y: 0.48,
                    width: 0.22,
                    height: 0.76,
                    min_x: 0.51,
                    max_x: 0.73,
                    min_y: 0.1,
                    max_y: 0.86,
                  },
                ],
              },
            },
          },
        ],
      },
    });

    expect(cue).not.toBeNull();
    expect(cue?.xPct).toBeCloseTo(0.62, 3);
    expect(cue?.yPct).toBeCloseTo(0.3584, 3);
    expect(cue?.title).toBe("Position diff");
  });

  it("suppresses smaller visual cues on beginner difficulty", () => {
    const active = pickActiveSegmentFeedback({
      feedback: [
        {
          timestamp: 2.5,
          segmentIndex: 0,
          bodyRegion: "torso" as const,
          severity: "minor" as const,
          message: "Timing differs from the guide phrase.",
          deviation: 0.19,
          featureFamily: "micro_timing" as const,
        },
      ],
      segment: { shared_start_sec: 0, shared_end_sec: 5 },
      segmentIndex: 0,
      sharedTime: 0.8,
      difficulty: "beginner",
    });

    expect(active).toBeNull();
  });
});
