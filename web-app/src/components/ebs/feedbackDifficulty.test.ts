import { describe, expect, it } from "vitest";

import {
  filterGeminiFeedbackByDifficulty,
  passesVisualFeedbackDifficulty,
} from "./feedbackDifficulty";

describe("feedbackDifficulty", () => {
  it("hides minor visual deviations in standard mode", () => {
    expect(
      passesVisualFeedbackDifficulty(
        { deviation: 0.19, severity: "minor" },
        "beginner",
      ),
    ).toBe(false);
    expect(
      passesVisualFeedbackDifficulty(
        { deviation: 0.19, severity: "minor" },
        "standard",
      ),
    ).toBe(false);
    expect(
      passesVisualFeedbackDifficulty(
        { deviation: 0.28, severity: "moderate" },
        "standard",
      ),
    ).toBe(true);
  });

  it("uses angle-delta percent thresholds for yolo visual feedback", () => {
    expect(
      passesVisualFeedbackDifficulty(
        { deviation: 0.1, severity: "minor", angleDeltaPct: 196 },
        "standard",
      ),
    ).toBe(false);
    expect(
      passesVisualFeedbackDifficulty(
        { deviation: 0.1, severity: "minor", angleDeltaPct: 204 },
        "standard",
      ),
    ).toBe(true);
    expect(
      passesVisualFeedbackDifficulty(
        { deviation: 0.1, severity: "minor", angleDeltaPct: 104 },
        "advanced",
      ),
    ).toBe(true);
    expect(
      passesVisualFeedbackDifficulty(
        { deviation: 0.1, severity: "major", angleDeltaPct: 290 },
        "beginner",
      ),
    ).toBe(false);
    expect(
      passesVisualFeedbackDifficulty(
        { deviation: 0.1, severity: "major", angleDeltaPct: 305 },
        "beginner",
      ),
    ).toBe(true);
  });

  it("filters Gemini moves using stronger standard confidence and prior checks", () => {
    const moves = [
      { micro_timing_label: "on-time", confidence: "high", id: "a" },
      { micro_timing_label: "late", confidence: "high", id: "b" },
      {
        micro_timing_label: "late",
        confidence: "high",
        user_relative_to_reference: "behind",
        body_parts_involved: ["right leg", "torso"],
        id: "c",
      },
      { micro_timing_label: "dragged", confidence: "medium", id: "d" },
      { micro_timing_label: "mixed", confidence: "high", id: "e" },
    ];

    expect(filterGeminiFeedbackByDifficulty(moves, "beginner").map((move) => move.id)).toEqual(["e"]);
    expect(filterGeminiFeedbackByDifficulty(moves, "standard").map((move) => move.id)).toEqual(["c", "e"]);
    expect(filterGeminiFeedbackByDifficulty(moves, "advanced").map((move) => move.id)).toEqual(["b", "c", "d", "e"]);
  });
});
