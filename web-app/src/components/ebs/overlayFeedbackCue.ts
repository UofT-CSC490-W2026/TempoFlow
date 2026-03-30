import type { DanceFeedback, FeedbackFeatureFamily, FeedbackSeverity } from "../../lib/bodyPix";
import type { OverlayArtifact, OverlaySegmentArtifact } from "../../lib/overlayStorage";
import { getOverlaySegmentByIndex } from "../../lib/overlaySegments";
import { passesVisualFeedbackDifficulty, type FeedbackDifficulty } from "./feedbackDifficulty";
import type { EbsSegment } from "./types";

type OverlayPersonSummary = {
  anchor_x: number;
  anchor_y: number;
  center_x: number;
  center_y: number;
  width: number;
  height: number;
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;
};

export type OverlayVisualCue = {
  id: string;
  title: string;
  message: string;
  severityLabel: string;
  color: string;
  xPct: number;
  yPct: number;
  focusSizePct: number;
  horizontalAlign: "left" | "center" | "right";
  verticalAlign: "above" | "below";
};

const DEFAULT_BOUNDS: OverlayPersonSummary = {
  anchor_x: 0.5,
  anchor_y: 0.88,
  center_x: 0.5,
  center_y: 0.48,
  width: 0.28,
  height: 0.78,
  min_x: 0.36,
  max_x: 0.64,
  min_y: 0.1,
  max_y: 0.88,
};

const SEVERITY_WEIGHTS: Record<FeedbackSeverity, number> = {
  good: 0,
  minor: 1,
  moderate: 2,
  major: 3,
};

const SEVERITY_LABELS: Record<FeedbackSeverity, string> = {
  good: "Close",
  minor: "Minor",
  moderate: "Moderate",
  major: "Major",
};

const SEVERITY_COLORS: Record<FeedbackSeverity, string> = {
  good: "#10b981",
  minor: "#f59e0b",
  moderate: "#fb923c",
  major: "#ef4444",
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function cleanText(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/\breference\b/gi, "guide")
    .trim();
}

function summarizeMessage(feedback: DanceFeedback) {
  const message = cleanText(feedback.message);
  if (message.length <= 88) {
    return message;
  }
  return `${message.slice(0, 85).trimEnd()}...`;
}

function toFeatureTitle(family: FeedbackFeatureFamily | undefined) {
  switch (family) {
    case "micro_timing":
      return "Timing cue";
    case "upper_body":
    case "lower_body":
      return "Position diff";
    case "attack_transition":
      return "Transition cue";
    default:
      return "Movement cue";
  }
}

function toPersonSummary(value: unknown): OverlayPersonSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const keys = [
    "anchor_x",
    "anchor_y",
    "center_x",
    "center_y",
    "width",
    "height",
    "min_x",
    "max_x",
    "min_y",
    "max_y",
  ] as const;
  const parsed = Object.fromEntries(keys.map((key) => [key, Number(record[key])])) as Record<
    (typeof keys)[number],
    number
  >;
  if (!keys.every((key) => Number.isFinite(parsed[key]))) return null;
  return parsed as OverlayPersonSummary;
}

function getLargestPersonSummary(values: unknown) {
  if (!Array.isArray(values)) return null;
  const people = values
    .map(toPersonSummary)
    .filter((person): person is OverlayPersonSummary => person != null);
  if (!people.length) return null;
  return people.reduce((best, candidate) => {
    const bestArea = best.width * best.height;
    const candidateArea = candidate.width * candidate.height;
    return candidateArea > bestArea ? candidate : best;
  });
}

function getSegmentBounds(segment: OverlaySegmentArtifact | null | undefined) {
  const meta = (segment?.meta ?? {}) as Record<string, unknown>;
  const segSummary =
    meta.segSummary && typeof meta.segSummary === "object"
      ? (meta.segSummary as Record<string, unknown>)
      : null;
  const poseSummary =
    meta.poseSummary && typeof meta.poseSummary === "object"
      ? (meta.poseSummary as Record<string, unknown>)
      : null;

  return (
    getLargestPersonSummary(segSummary?.persons) ??
    toPersonSummary(segSummary?.union) ??
    getLargestPersonSummary(poseSummary?.persons)
  );
}

function getCueAnchor(
  bodyRegion: DanceFeedback["bodyRegion"],
  bounds: OverlayPersonSummary,
) {
  switch (bodyRegion) {
    case "head":
      return { x: bounds.center_x, y: bounds.min_y + bounds.height * 0.16 };
    case "arms":
      return { x: bounds.center_x, y: bounds.min_y + bounds.height * 0.34 };
    case "legs":
      return { x: bounds.center_x, y: bounds.min_y + bounds.height * 0.77 };
    case "torso":
      return { x: bounds.center_x, y: bounds.min_y + bounds.height * 0.5 };
    case "full_body":
    default:
      return { x: bounds.center_x, y: bounds.min_y + bounds.height * 0.4 };
  }
}

function getCueSize(
  bodyRegion: DanceFeedback["bodyRegion"],
  bounds: OverlayPersonSummary,
) {
  const bodySpan = Math.max(bounds.width, bounds.height * 0.55);
  switch (bodyRegion) {
    case "head":
      return clamp(bodySpan * 0.34, 0.09, 0.16);
    case "arms":
      return clamp(bodySpan * 0.44, 0.11, 0.22);
    case "legs":
      return clamp(bodySpan * 0.4, 0.11, 0.22);
    case "torso":
      return clamp(bodySpan * 0.38, 0.12, 0.24);
    case "full_body":
    default:
      return clamp(bodySpan * 0.7, 0.18, 0.34);
  }
}

function chooseStrongest(feedback: DanceFeedback[]) {
  return [...feedback].sort((a, b) => {
    if (b.deviation !== a.deviation) return b.deviation - a.deviation;
    return (SEVERITY_WEIGHTS[b.severity] ?? 0) - (SEVERITY_WEIGHTS[a.severity] ?? 0);
  })[0] ?? null;
}

function choosePositionFeedback(feedback: DanceFeedback[]) {
  return chooseStrongest(
    feedback.filter(
      (row) => row.featureFamily === "upper_body" || row.featureFamily === "lower_body",
    ),
  );
}

export function pickActiveSegmentFeedback(params: {
  feedback: DanceFeedback[];
  segment: EbsSegment | null;
  segmentIndex: number;
  sharedTime: number;
  difficulty?: FeedbackDifficulty;
}) {
  const { feedback, segment, segmentIndex, sharedTime, difficulty = "standard" } = params;
  if (!segment || segmentIndex < 0) return null;

  const relevant = feedback.filter(
    (row) =>
      row.segmentIndex === segmentIndex &&
      (SEVERITY_WEIGHTS[row.severity] ?? 0) > 0 &&
      passesVisualFeedbackDifficulty(row, difficulty),
  );
  if (!relevant.length) return null;

  const duration = Math.max(0.001, segment.shared_end_sec - segment.shared_start_sec);
  const phase = clamp((sharedTime - segment.shared_start_sec) / duration, 0, 1);
  const byFamily = new Map<FeedbackFeatureFamily, DanceFeedback>();

  relevant.forEach((row) => {
    if (!row.featureFamily) return;
    const current = byFamily.get(row.featureFamily);
    if (!current || row.deviation > current.deviation) {
      byFamily.set(row.featureFamily, row);
    }
  });

  const micro = byFamily.get("micro_timing") ?? null;
  const position = choosePositionFeedback(relevant);
  const transition = byFamily.get("attack_transition") ?? null;
  const strongest = chooseStrongest(relevant);

  if (phase < 0.28) {
    return micro ?? position ?? transition ?? strongest;
  }
  if (phase < 0.72) {
    return position ?? micro ?? transition ?? strongest;
  }
  return transition ?? position ?? micro ?? strongest;
}

export function buildOverlayVisualCue(params: {
  feedback: DanceFeedback | null;
  practiceArtifact: OverlayArtifact | null;
  referenceArtifact?: OverlayArtifact | null;
}) {
  const { feedback, practiceArtifact, referenceArtifact = null } = params;
  if (!feedback) return null;

  const practiceSegment = getOverlaySegmentByIndex(practiceArtifact, feedback.segmentIndex);
  const referenceSegment = getOverlaySegmentByIndex(referenceArtifact, feedback.segmentIndex);
  const bounds = getSegmentBounds(practiceSegment) ?? getSegmentBounds(referenceSegment) ?? DEFAULT_BOUNDS;
  const anchor = getCueAnchor(feedback.bodyRegion, bounds);

  return {
    id: `${feedback.segmentIndex}:${feedback.featureFamily ?? "generic"}:${feedback.timestamp.toFixed(3)}`,
    title: toFeatureTitle(feedback.featureFamily),
    message: summarizeMessage(feedback),
    severityLabel: SEVERITY_LABELS[feedback.severity] ?? "Cue",
    color: SEVERITY_COLORS[feedback.severity] ?? "#38bdf8",
    xPct: clamp(anchor.x, 0.1, 0.9),
    yPct: clamp(anchor.y, 0.12, 0.88),
    focusSizePct: getCueSize(feedback.bodyRegion, bounds),
    horizontalAlign: anchor.x < 0.26 ? "left" : anchor.x > 0.74 ? "right" : "center",
    verticalAlign: anchor.y < 0.28 ? "below" : "above",
  } satisfies OverlayVisualCue;
}
