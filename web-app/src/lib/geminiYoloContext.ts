"use client";

import type { OverlayArtifact, OverlaySegmentArtifact } from "./overlayStorage";
import { getOverlaySegmentByIndex } from "./overlaySegments";

export type GeminiYoloPersonSummary = {
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

export type GeminiYoloPoseSummary = {
  person_count?: number;
  persons?: GeminiYoloPersonSummary[];
};

export type GeminiYoloSegSummary = {
  person_count?: number;
  persons?: GeminiYoloPersonSummary[];
  union?: GeminiYoloPersonSummary | null;
};

export type GeminiYoloSegmentContext = {
  segment_index: number;
  source: "yolo-hybrid-segment";
  reference: {
    start_sec: number;
    end_sec: number;
    segmentation: GeminiYoloSegSummary | null;
    pose: GeminiYoloPoseSummary | null;
  } | null;
  practice: {
    start_sec: number;
    end_sec: number;
    segmentation: GeminiYoloSegSummary | null;
    pose: GeminiYoloPoseSummary | null;
  } | null;
  normalization: Record<string, unknown> | null;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function toPersonSummary(value: unknown): GeminiYoloPersonSummary | null {
  if (!value || typeof value !== "object") return null;
  const person = value as Record<string, unknown>;
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
  const parsed = Object.fromEntries(
    keys.map((key) => [key, Number(person[key])]),
  ) as Record<(typeof keys)[number], number>;
  if (!keys.every((key) => isFiniteNumber(parsed[key]))) return null;
  return parsed as GeminiYoloPersonSummary;
}

function toPoseSummary(value: unknown): GeminiYoloPoseSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const persons = Array.isArray(record.persons)
    ? record.persons.map(toPersonSummary).filter((person): person is GeminiYoloPersonSummary => person != null)
    : [];
  const personCount = Number(record.person_count);
  return {
    person_count: Number.isFinite(personCount) ? personCount : persons.length,
    persons,
  };
}

function toSegSummary(value: unknown): GeminiYoloSegSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const persons = Array.isArray(record.persons)
    ? record.persons.map(toPersonSummary).filter((person): person is GeminiYoloPersonSummary => person != null)
    : [];
  const personCount = Number(record.person_count);
  const union = toPersonSummary(record.union);
  return {
    person_count: Number.isFinite(personCount) ? personCount : persons.length,
    persons,
    union,
  };
}

function buildSideContext(
  segArtifact: OverlayArtifact | null,
  poseArtifact: OverlayArtifact | null,
  segmentIndex: number,
) {
  const segSegment = getOverlaySegmentByIndex(segArtifact, segmentIndex);
  const poseSegment = getOverlaySegmentByIndex(poseArtifact, segmentIndex);
  if (!segSegment && !poseSegment) return null;

  const primarySegment = segSegment ?? poseSegment;
  const segMeta = segSegment?.meta ?? {};
  const poseMeta = poseSegment?.meta ?? {};

  return {
    start_sec: primarySegment?.startSec ?? 0,
    end_sec: primarySegment?.endSec ?? 0,
    segmentation: toSegSummary(segMeta.segSummary),
    pose: toPoseSummary(segMeta.poseSummary ?? poseMeta.poseSummary),
  };
}

function readNormalization(segment: OverlaySegmentArtifact | null | undefined) {
  const value = segment?.meta?.normalization;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function buildGeminiYoloSegmentContext(params: {
  referenceSegArtifact: OverlayArtifact | null;
  practiceSegArtifact: OverlayArtifact | null;
  referencePoseArtifact?: OverlayArtifact | null;
  practicePoseArtifact?: OverlayArtifact | null;
  segmentIndex: number;
}): GeminiYoloSegmentContext | null {
  const {
    referenceSegArtifact,
    practiceSegArtifact,
    referencePoseArtifact = null,
    practicePoseArtifact = null,
    segmentIndex,
  } = params;

  const reference = buildSideContext(referenceSegArtifact, referencePoseArtifact, segmentIndex);
  const practice = buildSideContext(practiceSegArtifact, practicePoseArtifact, segmentIndex);
  if (!reference && !practice) return null;

  return {
    segment_index: segmentIndex,
    source: "yolo-hybrid-segment",
    reference,
    practice,
    normalization: readNormalization(getOverlaySegmentByIndex(referenceSegArtifact, segmentIndex)),
  };
}
