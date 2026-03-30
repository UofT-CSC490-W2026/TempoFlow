import { describe, expect, it } from "vitest";

import {
  filterGeminiFeedbackByDifficulty,
  passesVisualFeedbackDifficulty,
} from "./feedbackDifficulty";

describe("feedbackDifficulty", () => {
  it("hides smaller visual deviations on easier difficulty", () => {
    expect(
      passesVisualFeedbackDifficulty(
        { deviation: 0.19 },
        "beginner",
      ),
    ).toBe(false);
    expect(
      passesVisualFeedbackDifficulty(
        { deviation: 0.19 },
        "standard",
      ),
    ).toBe(true);
  });

  it("filters Gemini moves using the shared difficulty thresholds", () => {
    const moves = [
      { micro_timing_label: "on-time", confidence: "high", id: "a" },
      { micro_timing_label: "late", confidence: "high", id: "b" },
      { micro_timing_label: "dragged", confidence: "medium", id: "c" },
      { micro_timing_label: "mixed", confidence: "high", id: "d" },
    ];

    expect(filterGeminiFeedbackByDifficulty(moves, "beginner").map((move) => move.id)).toEqual(["d"]);
    expect(filterGeminiFeedbackByDifficulty(moves, "standard").map((move) => move.id)).toEqual(["b", "d"]);
    expect(filterGeminiFeedbackByDifficulty(moves, "advanced").map((move) => move.id)).toEqual(["b", "c", "d"]);
  });
});
