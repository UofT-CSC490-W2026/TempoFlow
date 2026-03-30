import type { DanceFeedback } from "../../lib/bodyPix";
import type { GeminiFlatMove } from "../../lib/geminiFeedbackTypes";

export type FeedbackDifficulty = "beginner" | "standard" | "advanced";

export const FEEDBACK_DIFFICULTY_OPTIONS: Array<{
  value: FeedbackDifficulty;
  label: string;
  hint: string;
}> = [
  {
    value: "beginner",
    label: "Beginner",
    hint: "Only show bigger misses.",
  },
  {
    value: "standard",
    label: "Standard",
    hint: "Balanced coaching detail.",
  },
  {
    value: "advanced",
    label: "Advanced",
    hint: "Surface smaller timing differences.",
  },
];

const VISUAL_MIN_DEVIATION: Record<FeedbackDifficulty, number> = {
  beginner: 0.25,
  standard: 0.18,
  advanced: 0.12,
};

const GEMINI_MIN_ISSUE_SCORE: Record<FeedbackDifficulty, number> = {
  beginner: 0.7,
  standard: 0.4,
  advanced: 0.15,
};

const GEMINI_ISSUE_SCORE_BY_LABEL: Record<string, number> = {
  "on-time": 0,
  uncertain: 0.08,
  early: 0.45,
  late: 0.45,
  rushed: 0.72,
  dragged: 0.72,
  mixed: 0.92,
};

const GEMINI_MIN_CONFIDENCE_BY_DIFFICULTY: Record<FeedbackDifficulty, number> = {
  beginner: 0.75,
  standard: 0.75,
  advanced: 0.35,
};

export function isFeedbackDifficulty(value: string): value is FeedbackDifficulty {
  return FEEDBACK_DIFFICULTY_OPTIONS.some((option) => option.value === value);
}

export function passesVisualFeedbackDifficulty(
  feedback: Pick<DanceFeedback, "deviation">,
  difficulty: FeedbackDifficulty,
) {
  return feedback.deviation >= VISUAL_MIN_DEVIATION[difficulty];
}

export function getGeminiIssueScore(label: string | null | undefined) {
  if (!label) return 0;
  return GEMINI_ISSUE_SCORE_BY_LABEL[label] ?? 0.4;
}

export function getGeminiConfidenceScore(confidence: string | null | undefined) {
  const normalized = (confidence ?? "").trim().toLowerCase();
  if (!normalized) return 0;
  if (normalized.includes("high")) return 0.9;
  if (normalized.includes("medium")) return 0.6;
  if (normalized.includes("low")) return 0.25;
  return 0.5;
}

export function passesGeminiFeedbackDifficulty(
  move: Pick<GeminiFlatMove, "micro_timing_label" | "confidence">,
  difficulty: FeedbackDifficulty,
) {
  return (
    getGeminiIssueScore(move.micro_timing_label) >= GEMINI_MIN_ISSUE_SCORE[difficulty] &&
    getGeminiConfidenceScore(move.confidence) >= GEMINI_MIN_CONFIDENCE_BY_DIFFICULTY[difficulty]
  );
}

export function filterGeminiFeedbackByDifficulty<T extends Pick<GeminiFlatMove, "micro_timing_label" | "confidence">>(
  moves: T[],
  difficulty: FeedbackDifficulty,
) {
  return moves.filter((move) => passesGeminiFeedbackDifficulty(move, difficulty));
}
