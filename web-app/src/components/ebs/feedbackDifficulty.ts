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
    hint: "Only obvious misses.",
  },
  {
    value: "standard",
    label: "Standard",
    hint: "Only clear, high-confidence misses.",
  },
  {
    value: "advanced",
    label: "Advanced",
    hint: "Include smaller timing and shape differences.",
  },
];

const VISUAL_MIN_DEVIATION: Record<FeedbackDifficulty, number> = {
  beginner: 0.32,
  standard: 0.24,
  advanced: 0.14,
};

const VISUAL_MIN_ANGLE_SIGNAL_PCT: Record<FeedbackDifficulty, number> = {
  beginner: 300,
  standard: 200,
  advanced: 100,
};

const VISUAL_SEVERITY_SCORE = {
  good: 0,
  minor: 1,
  moderate: 2,
  major: 3,
} as const;

const VISUAL_MIN_SEVERITY_BY_DIFFICULTY: Record<FeedbackDifficulty, number> = {
  beginner: VISUAL_SEVERITY_SCORE.moderate,
  standard: VISUAL_SEVERITY_SCORE.moderate,
  advanced: VISUAL_SEVERITY_SCORE.minor,
};

const GEMINI_MIN_ISSUE_SCORE: Record<FeedbackDifficulty, number> = {
  beginner: 0.72,
  standard: 0.45,
  advanced: 0.2,
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
  beginner: 0.9,
  standard: 0.85,
  advanced: 0.55,
};

const GEMINI_MIN_STRENGTH_BY_DIFFICULTY: Record<FeedbackDifficulty, number> = {
  beginner: 0.58,
  standard: 0.42,
  advanced: 0.16,
};

export function isFeedbackDifficulty(value: string): value is FeedbackDifficulty {
  return FEEDBACK_DIFFICULTY_OPTIONS.some((option) => option.value === value);
}

export function passesVisualFeedbackDifficulty(
  feedback: Pick<DanceFeedback, "deviation" | "severity" | "angleDeltaPct">,
  difficulty: FeedbackDifficulty,
) {
  if (typeof feedback.angleDeltaPct === "number" && Number.isFinite(feedback.angleDeltaPct)) {
    return feedback.angleDeltaPct >= VISUAL_MIN_ANGLE_SIGNAL_PCT[difficulty];
  }
  const severityScore = VISUAL_SEVERITY_SCORE[feedback.severity ?? "good"] ?? 0;
  return (
    feedback.deviation >= VISUAL_MIN_DEVIATION[difficulty] &&
    severityScore >= VISUAL_MIN_SEVERITY_BY_DIFFICULTY[difficulty]
  );
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

function getGeminiPriorAgreementScore(relative: string | null | undefined) {
  const normalized = (relative ?? "").trim().toLowerCase();
  if (!normalized) return 0.8;
  if (normalized.includes("aligned")) return 0.22;
  if (normalized.includes("unclear")) return 0.55;
  if (normalized.includes("ahead") || normalized.includes("behind")) return 1;
  return 0.75;
}

function getGeminiEvidenceCoverageScore(bodyParts: string[] | null | undefined) {
  const count = bodyParts?.filter(Boolean).length ?? 0;
  if (count >= 2) return 1;
  if (count === 1) return 0.96;
  return 0.92;
}

function getGeminiGuardrailPenalty(guardrailNote: string | null | undefined) {
  const normalized = (guardrailNote ?? "").trim().toLowerCase();
  if (!normalized) return 1;
  if (
    normalized.includes("subtle") ||
    normalized.includes("slight") ||
    normalized.includes("small") ||
    normalized.includes("minor") ||
    normalized.includes("acceptable") ||
    normalized.includes("close")
  ) {
    return 0.72;
  }
  return 1;
}

export function getGeminiFeedbackStrength(
  move: Pick<GeminiFlatMove, "micro_timing_label" | "confidence" | "user_relative_to_reference" | "body_parts_involved" | "guardrail_note">,
) {
  const issueScore = getGeminiIssueScore(move.micro_timing_label);
  const confidenceScore = getGeminiConfidenceScore(move.confidence);
  const confidenceWeight = 0.4 + confidenceScore * 0.6;
  const priorScore = getGeminiPriorAgreementScore(move.user_relative_to_reference);
  const evidenceScore = getGeminiEvidenceCoverageScore(move.body_parts_involved);
  const guardrailPenalty = getGeminiGuardrailPenalty(move.guardrail_note);

  return issueScore * confidenceWeight * priorScore * evidenceScore * guardrailPenalty;
}

export function passesGeminiFeedbackDifficulty(
  move: Pick<
    GeminiFlatMove,
    "micro_timing_label" | "confidence" | "user_relative_to_reference" | "body_parts_involved" | "guardrail_note"
  >,
  difficulty: FeedbackDifficulty,
) {
  const issueScore = getGeminiIssueScore(move.micro_timing_label);
  const confidenceScore = getGeminiConfidenceScore(move.confidence);
  return (
    issueScore >= GEMINI_MIN_ISSUE_SCORE[difficulty] &&
    confidenceScore >= GEMINI_MIN_CONFIDENCE_BY_DIFFICULTY[difficulty] &&
    getGeminiFeedbackStrength(move) >= GEMINI_MIN_STRENGTH_BY_DIFFICULTY[difficulty]
  );
}

export function filterGeminiFeedbackByDifficulty<
  T extends Pick<
    GeminiFlatMove,
    "micro_timing_label" | "confidence" | "user_relative_to_reference" | "body_parts_involved" | "guardrail_note"
  >,
>(
  moves: T[],
  difficulty: FeedbackDifficulty,
) {
  return moves.filter((move) => passesGeminiFeedbackDifficulty(move, difficulty));
}
