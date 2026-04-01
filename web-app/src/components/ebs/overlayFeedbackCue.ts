import { JOINT_ANGLES, type DanceFeedback, type FeedbackFeatureFamily, type FeedbackSeverity, type SampledPoseFrame } from "../../lib/bodyPix";
import { normalizeKeypoints } from "../../lib/bodyPix/geometry";
import type { GeminiFlatMove } from "../../lib/geminiFeedbackTypes";
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

type Point2d = {
  x: number;
  y: number;
};

type SideKeypointSet = {
  left: number[];
  right: number[];
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
  hotspots?: Array<{
    id: string;
    xPct: number;
    yPct: number;
    focusSizePct: number;
  }>;
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

const GEMINI_LABEL_COLORS: Record<string, string> = {
  "on-time": "#34d399",
  early: "#fbbf24",
  late: "#fbbf24",
  rushed: "#fb923c",
  dragged: "#fb923c",
  mixed: "#a78bfa",
  uncertain: "#94a3b8",
};

const ARM_KEYPOINTS: SideKeypointSet = {
  left: [5, 7, 9],
  right: [6, 8, 10],
};

const LEG_KEYPOINTS: SideKeypointSet = {
  left: [11, 13, 15],
  right: [12, 14, 16],
};

const TORSO_KEYPOINTS: SideKeypointSet = {
  left: [5, 11],
  right: [6, 12],
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

function toFeatureTitle(feedback: DanceFeedback) {
  if (feedback.signalType === "angle_delta" || feedback.jointName) {
    return "Angle diff";
  }

  const family = feedback.featureFamily;
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

function getSampleBounds(sample: SampledPoseFrame | null | undefined) {
  if (!sample) return null;
  const visible = sample.keypoints
    .filter((point) => (point.score ?? 0) > 0.25)
    .map((point) => ({
      x: point.x / Math.max(1, sample.frameWidth),
      y: point.y / Math.max(1, sample.frameHeight),
    }));
  if (visible.length < 4) return null;

  const min_x = Math.min(...visible.map((point) => point.x));
  const max_x = Math.max(...visible.map((point) => point.x));
  const min_y = Math.min(...visible.map((point) => point.y));
  const max_y = Math.max(...visible.map((point) => point.y));

  return {
    anchor_x: (min_x + max_x) / 2,
    anchor_y: max_y,
    center_x: (min_x + max_x) / 2,
    center_y: (min_y + max_y) / 2,
    width: Math.max(0.05, max_x - min_x),
    height: Math.max(0.08, max_y - min_y),
    min_x,
    max_x,
    min_y,
    max_y,
  } satisfies OverlayPersonSummary;
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

function isAnchorFinite(anchor: Point2d | null): anchor is Point2d {
  return !!anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y);
}

function stabilizeAnchorWithinBounds(
  anchor: Point2d | null,
  bounds: OverlayPersonSummary,
  fallbackAnchor: Point2d,
) {
  if (!isAnchorFinite(anchor)) return fallbackAnchor;

  const marginX = Math.max(0.06, bounds.width * 0.28);
  const marginY = Math.max(0.06, bounds.height * 0.22);
  const minX = Math.max(0.02, bounds.min_x - marginX);
  const maxX = Math.min(0.98, bounds.max_x + marginX);
  const minY = Math.max(0.02, bounds.min_y - marginY);
  const maxY = Math.min(0.98, bounds.max_y + marginY);

  if (anchor.x < minX || anchor.x > maxX || anchor.y < minY || anchor.y > maxY) {
    return fallbackAnchor;
  }

  return {
    x: clamp(anchor.x, minX, maxX),
    y: clamp(anchor.y, minY, maxY),
  };
}

function averagePoint(points: Point2d[]) {
  if (!points.length) return null;
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function getNormalizedScreenAnchor(sample: SampledPoseFrame, keypointIndices: number[]) {
  const points = keypointIndices
    .map((index) => sample.keypoints[index])
    .filter((point) => point && point.score > 0.25)
    .map((point) => ({
      x: point.x / Math.max(1, sample.frameWidth),
      y: point.y / Math.max(1, sample.frameHeight),
    }));
  return averagePoint(points);
}

function getJointAnchor(sample: SampledPoseFrame, jointName: string | undefined) {
  if (!jointName) return null;
  const joint = JOINT_ANGLES.find((candidate) => candidate.name === jointName);
  if (!joint) return null;
  return getNormalizedScreenAnchor(sample, [joint.joints[1]]);
}

function scoreNormalizedSideDelta(
  referencePoints: ReturnType<typeof normalizeKeypoints>,
  practicePoints: ReturnType<typeof normalizeKeypoints>,
  practiceIndices: number[],
  referenceIndices: number[],
) {
  const deltas: number[] = [];
  for (let index = 0; index < Math.min(practiceIndices.length, referenceIndices.length); index += 1) {
    const practicePoint = practicePoints[practiceIndices[index]];
    const referencePoint = referencePoints[referenceIndices[index]];
    if (!practicePoint || !referencePoint) continue;
    if (practicePoint.score <= 0.25 || referencePoint.score <= 0.25) continue;
    deltas.push(Math.hypot(practicePoint.x - referencePoint.x, practicePoint.y - referencePoint.y));
  }
  return deltas.length
    ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length
    : Number.NEGATIVE_INFINITY;
}

function chooseMirroredSideAnchor(
  practiceSample: SampledPoseFrame,
  referenceSample: SampledPoseFrame,
  keypoints: SideKeypointSet,
) {
  const normalizedPractice = normalizeKeypoints(practiceSample.keypoints);
  const normalizedReference = normalizeKeypoints(referenceSample.keypoints);

  const directLeft = scoreNormalizedSideDelta(
    normalizedReference,
    normalizedPractice,
    keypoints.left,
    keypoints.left,
  );
  const directRight = scoreNormalizedSideDelta(
    normalizedReference,
    normalizedPractice,
    keypoints.right,
    keypoints.right,
  );
  const mirroredLeft = scoreNormalizedSideDelta(
    normalizedReference,
    normalizedPractice,
    keypoints.left,
    keypoints.right,
  );
  const mirroredRight = scoreNormalizedSideDelta(
    normalizedReference,
    normalizedPractice,
    keypoints.right,
    keypoints.left,
  );

  const directTotal = Math.max(0, directLeft) + Math.max(0, directRight);
  const mirroredTotal = Math.max(0, mirroredLeft) + Math.max(0, mirroredRight);
  const useMirrored = mirroredTotal < directTotal;
  const leftScore = useMirrored ? mirroredLeft : directLeft;
  const rightScore = useMirrored ? mirroredRight : directRight;
  const preferLeft = leftScore >= rightScore;
  const anchor = getNormalizedScreenAnchor(
    practiceSample,
    preferLeft ? keypoints.left : keypoints.right,
  );

  return anchor;
}

function getSampleCueAnchor(
  feedback: DanceFeedback,
  practiceSample: SampledPoseFrame | null,
  referenceSample: SampledPoseFrame | null,
) {
  if (!practiceSample) return null;
  if (feedback.signalType === "angle_delta" || feedback.jointName) {
    const jointAnchor = getJointAnchor(practiceSample, feedback.jointName);
    if (jointAnchor) return jointAnchor;
  }
  if (!referenceSample) {
    if (feedback.bodyRegion === "arms") return getNormalizedScreenAnchor(practiceSample, ARM_KEYPOINTS.right);
    if (feedback.bodyRegion === "legs") return getNormalizedScreenAnchor(practiceSample, LEG_KEYPOINTS.right);
    return null;
  }

  switch (feedback.bodyRegion) {
    case "arms":
      if (feedback.focusSide === "left" || feedback.focusSide === "right") {
        return getNormalizedScreenAnchor(practiceSample, ARM_KEYPOINTS[feedback.focusSide]);
      }
      return chooseMirroredSideAnchor(practiceSample, referenceSample, ARM_KEYPOINTS);
    case "legs":
      if (feedback.focusSide === "left" || feedback.focusSide === "right") {
        return getNormalizedScreenAnchor(practiceSample, LEG_KEYPOINTS[feedback.focusSide]);
      }
      return chooseMirroredSideAnchor(practiceSample, referenceSample, LEG_KEYPOINTS);
    case "torso":
      if (feedback.focusSide === "left" || feedback.focusSide === "right") {
        return getNormalizedScreenAnchor(practiceSample, TORSO_KEYPOINTS[feedback.focusSide]);
      }
      return chooseMirroredSideAnchor(practiceSample, referenceSample, TORSO_KEYPOINTS);
    case "head":
      return getNormalizedScreenAnchor(practiceSample, [0, 1, 2]);
    case "full_body":
    default:
      return (
        chooseMirroredSideAnchor(practiceSample, referenceSample, ARM_KEYPOINTS) ??
        chooseMirroredSideAnchor(practiceSample, referenceSample, LEG_KEYPOINTS)
      );
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

function clampBoundsAnchor(value: number, bodyMin: number, bodyMax: number) {
  return clamp(value, Math.max(0.08, bodyMin - 0.08), Math.min(0.92, bodyMax + 0.08));
}

function inferGeminiBodyRegion(move: GeminiFlatMove) {
  const parts = (move.body_parts_involved ?? []).map((part) => part.toLowerCase());
  if (parts.some((part) => part.includes("arm") || part.includes("shoulder") || part.includes("hand"))) {
    return "arms" as const;
  }
  if (parts.some((part) => part.includes("leg") || part.includes("hip") || part.includes("knee") || part.includes("foot"))) {
    return "legs" as const;
  }
  if (parts.some((part) => part.includes("head") || part.includes("face"))) {
    return "head" as const;
  }
  if (parts.some((part) => part.includes("torso") || part.includes("core") || part.includes("chest"))) {
    return "torso" as const;
  }
  return "full_body" as const;
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

function getVisualCueTargetPhase(family: FeedbackFeatureFamily | undefined) {
  switch (family) {
    case "micro_timing":
      return 0.14;
    case "attack_transition":
      return 0.86;
    case "upper_body":
    case "lower_body":
    default:
      return 0.5;
  }
}

function getVisualCueHalfWindowSec(durationSec: number, family: FeedbackFeatureFamily | undefined) {
  switch (family) {
    case "micro_timing":
    case "attack_transition":
      return clamp(durationSec * 0.05, 0.18, 0.35);
    case "upper_body":
    case "lower_body":
    default:
      return clamp(durationSec * 0.07, 0.22, 0.45);
  }
}

export function getVisualCueTimingWindow(
  segment: EbsSegment,
  family: FeedbackFeatureFamily | undefined,
) {
  const duration = Math.max(0.001, segment.shared_end_sec - segment.shared_start_sec);
  const targetPhase = getVisualCueTargetPhase(family);
  const targetTime = segment.shared_start_sec + duration * targetPhase;
  const halfWindowSec = getVisualCueHalfWindowSec(duration, family);

  return {
    targetTime,
    startTime: Math.max(segment.shared_start_sec, targetTime - halfWindowSec),
    endTime: Math.min(segment.shared_end_sec, targetTime + halfWindowSec),
  };
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

  if (difficulty === "advanced") {
    const activeRows = relevant.filter((row) => {
      const duration = Math.max(0.001, segment.shared_end_sec - segment.shared_start_sec);
      const halfWindowSec = Math.min(0.28, Math.max(0.12, duration * 0.04));
      const startTime = Math.max(segment.shared_start_sec, row.timestamp - halfWindowSec);
      const endTime = Math.min(segment.shared_end_sec, row.timestamp + halfWindowSec);
      return sharedTime >= startTime && sharedTime <= endTime;
    });
    if (!activeRows.length) return null;

    return [...activeRows].sort((a, b) => {
      if ((b.angleDeltaPct ?? 0) !== (a.angleDeltaPct ?? 0)) {
        return (b.angleDeltaPct ?? 0) - (a.angleDeltaPct ?? 0);
      }
      if (b.deviation !== a.deviation) return b.deviation - a.deviation;
      const aDistance = Math.abs(a.timestamp - sharedTime);
      const bDistance = Math.abs(b.timestamp - sharedTime);
      if (aDistance !== bDistance) return aDistance - bDistance;
      return a.timestamp - b.timestamp;
    })[0] ?? null;
  }

  const curatedRelevant =
    difficulty === "beginner"
      ? [...relevant]
          .sort((a, b) => {
            if ((b.angleDeltaPct ?? 0) !== (a.angleDeltaPct ?? 0)) {
              return (b.angleDeltaPct ?? 0) - (a.angleDeltaPct ?? 0);
            }
            if (b.deviation !== a.deviation) return b.deviation - a.deviation;
            return a.timestamp - b.timestamp;
          })
          .slice(0, 2)
      : relevant;

  const duration = Math.max(0.001, segment.shared_end_sec - segment.shared_start_sec);
  const phase = clamp((sharedTime - segment.shared_start_sec) / duration, 0, 1);
  const byFamily = new Map<FeedbackFeatureFamily, DanceFeedback>();

  curatedRelevant.forEach((row) => {
    if (!row.featureFamily) return;
    const current = byFamily.get(row.featureFamily);
    if (!current || row.deviation > current.deviation) {
      byFamily.set(row.featureFamily, row);
    }
  });

  const micro = byFamily.get("micro_timing") ?? null;
  const position = choosePositionFeedback(curatedRelevant);
  const transition = byFamily.get("attack_transition") ?? null;
  const strongest = chooseStrongest(curatedRelevant);

  const candidate =
    phase < 0.28
      ? (micro ?? position ?? transition ?? strongest)
      : phase < 0.72
        ? (position ?? micro ?? transition ?? strongest)
        : (transition ?? position ?? micro ?? strongest);

  if (!candidate) return null;

  const cueWindow = getVisualCueTimingWindow(segment, candidate.featureFamily);
  return sharedTime >= cueWindow.startTime && sharedTime <= cueWindow.endTime ? candidate : null;
}

export function buildOverlayVisualCue(params: {
  feedback: DanceFeedback | null;
  practiceArtifact: OverlayArtifact | null;
  referenceArtifact?: OverlayArtifact | null;
  practiceSample?: SampledPoseFrame | null;
  referenceSample?: SampledPoseFrame | null;
}) {
  const {
    feedback,
    practiceArtifact,
    referenceArtifact = null,
    practiceSample = null,
    referenceSample = null,
  } = params;
  if (!feedback) return null;

  const practiceSegment = getOverlaySegmentByIndex(practiceArtifact, feedback.segmentIndex);
  const referenceSegment = getOverlaySegmentByIndex(referenceArtifact, feedback.segmentIndex);
  const bounds =
    getSampleBounds(practiceSample) ??
    getSampleBounds(referenceSample) ??
    getSegmentBounds(practiceSegment) ??
    getSegmentBounds(referenceSegment) ??
    DEFAULT_BOUNDS;
  const sampleAnchor = getSampleCueAnchor(feedback, practiceSample, referenceSample);
  const fallbackAnchor = getCueAnchor(feedback.bodyRegion, bounds);
  const anchor = stabilizeAnchorWithinBounds(sampleAnchor, bounds, fallbackAnchor);

  return {
    id: `${feedback.segmentIndex}:${feedback.featureFamily ?? "generic"}:${feedback.jointName ?? "generic"}:${feedback.timestamp.toFixed(3)}`,
    title: toFeatureTitle(feedback),
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

export function buildGeminiOverlayCue(params: {
  move: GeminiFlatMove | null;
  practiceArtifact: OverlayArtifact | null;
  referenceArtifact?: OverlayArtifact | null;
}) {
  const { move, practiceArtifact, referenceArtifact = null } = params;
  if (!move) return null;

  const practiceSegment = getOverlaySegmentByIndex(practiceArtifact, move.segmentIndex);
  const referenceSegment = getOverlaySegmentByIndex(referenceArtifact, move.segmentIndex);
  const bounds = getSegmentBounds(practiceSegment) ?? getSegmentBounds(referenceSegment) ?? DEFAULT_BOUNDS;
  const bodyRegion = inferGeminiBodyRegion(move);
  const bodyAnchor = getCueAnchor(bodyRegion, bounds);
  const anchorX = clampBoundsAnchor(bounds.center_x, bounds.min_x, bounds.max_x);
  const anchorY = clampBoundsAnchor(
    Math.min(bodyAnchor.y, bounds.min_y + bounds.height * 0.32),
    bounds.min_y,
    bounds.max_y,
  );
  const focusSizePct = clamp(getCueSize(bodyRegion, bounds) * 0.56, 0.12, 0.18);

  return {
    id: `gemini:${move.segmentIndex}:${move.move_index}:${move.micro_timing_label}`,
    title: "Timing note",
    message: cleanText(
      move.coaching_note || move.micro_timing_evidence || "Adjust this move to better match the guide.",
    ),
    severityLabel: move.micro_timing_label ? move.micro_timing_label.replace(/(^|-)(\w)/g, (_, p1, p2) => `${p1}${p2.toUpperCase()}`) : "Cue",
    color: GEMINI_LABEL_COLORS[move.micro_timing_label] ?? "#38bdf8",
    xPct: anchorX,
    yPct: anchorY,
    focusSizePct,
    horizontalAlign: anchorX < 0.28 ? "left" as const : anchorX > 0.72 ? "right" as const : "center" as const,
    verticalAlign: bounds.min_y > 0.2 ? "above" as const : "below" as const,
  } satisfies OverlayVisualCue;
}
