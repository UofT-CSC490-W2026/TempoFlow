import { describe, expect, it } from "vitest";

import { ANGLE_SIGNAL_STANDARD_DEGREES, buildVisualFeedbackFromYoloArtifacts } from "./yoloFeedback";
import type { OverlayArtifact } from "./overlayStorage";

function makePoseFrame(overrides: Record<number, { x: number; y: number }>) {
  return {
    keypoints: Array.from({ length: 17 }, (_, index) => {
      const fallback = { x: 24 + index * 0.3, y: 8 + index * 0.6 };
      const point = overrides[index] ?? fallback;
      return {
        name: `kp-${index}`,
        x: point.x,
        y: point.y,
        score: 0.98,
      };
    }),
    part_coverage: {
      head: 1,
      arms: 1,
      torso: 1,
      legs: 1,
      full_body: 1,
    },
  };
}

function makeArtifact(
  side: "reference" | "practice",
  frames: Array<ReturnType<typeof makePoseFrame>>,
): OverlayArtifact {
  return {
    version: 1,
    type: "yolo",
    side,
    fps: 12,
    width: 64,
    height: 48,
    frameCount: frames.length,
    createdAt: "",
    segments: [
      {
        index: 0,
        startSec: 0,
        endSec: 1,
        fps: 12,
        width: 64,
        height: 48,
        frameCount: frames.length,
        createdAt: "",
        meta: {
          sharedStartSec: 0,
          sharedEndSec: 1,
          poseFrames: frames,
        },
      },
    ],
  };
}

describe("yoloFeedback", () => {
  it("emits angle-delta feedback rows when a joint exceeds the standard threshold", () => {
    const referenceFrame = makePoseFrame({
      5: { x: 20, y: 16 },
      7: { x: 20, y: 26 },
      9: { x: 20, y: 36 },
      6: { x: 42, y: 16 },
      8: { x: 42, y: 26 },
      10: { x: 42, y: 36 },
      11: { x: 24, y: 30 },
      12: { x: 38, y: 30 },
      13: { x: 25, y: 40 },
      14: { x: 37, y: 40 },
      15: { x: 26, y: 46 },
      16: { x: 36, y: 46 },
    });
    const userFrame = makePoseFrame({
      5: { x: 20, y: 16 },
      7: { x: 20, y: 26 },
      9: { x: 30, y: 26 },
      6: { x: 42, y: 16 },
      8: { x: 42, y: 26 },
      10: { x: 42, y: 36 },
      11: { x: 24, y: 30 },
      12: { x: 38, y: 30 },
      13: { x: 25, y: 40 },
      14: { x: 37, y: 40 },
      15: { x: 26, y: 46 },
      16: { x: 36, y: 46 },
    });

    const result = buildVisualFeedbackFromYoloArtifacts({
      referenceArtifact: makeArtifact("reference", [referenceFrame, referenceFrame]),
      userArtifact: makeArtifact("practice", [userFrame, userFrame]),
      segments: [{ shared_start_sec: 0, shared_end_sec: 1 }],
    });

    const leftElbow = result.feedback.find((row) => row.jointName === "left elbow");
    expect(leftElbow).toBeDefined();
    expect(leftElbow?.signalType).toBe("angle_delta");
    expect(leftElbow?.angleDeltaPct).toBeGreaterThanOrEqual(100);
    expect(leftElbow?.angleDeltaDeg).toBeGreaterThanOrEqual(ANGLE_SIGNAL_STANDARD_DEGREES);
    expect(leftElbow?.message).toMatch(/Left Elbow angle differs/i);
  });
});
