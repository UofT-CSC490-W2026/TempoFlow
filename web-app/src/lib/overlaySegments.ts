"use client";

import type { EbsData, EbsSegment } from "../components/ebs/types";
import type {
  OverlayArtifact,
  OverlaySegmentArtifact,
  OverlaySide,
  OverlayType,
} from "./overlayStorage";

const MIN_SEGMENT_DURATION_SEC = 0.05;

export type OverlaySegmentPlan = {
  index: number;
  sharedStartSec: number;
  sharedEndSec: number;
  reference: {
    startSec: number;
    endSec: number;
  };
  practice: {
    startSec: number;
    endSec: number;
  };
};

function normalizeRange(startSec: number, endSec: number) {
  const safeStart = Number.isFinite(startSec) ? Math.max(0, startSec) : 0;
  const safeEnd = Number.isFinite(endSec) ? Math.max(safeStart, endSec) : safeStart;
  if (safeEnd - safeStart < MIN_SEGMENT_DURATION_SEC) {
    return null;
  }
  return { startSec: safeStart, endSec: safeEnd };
}

function buildClipRange(
  segment: EbsSegment,
  side: OverlaySide,
  clipStartSec: number,
) {
  const clipSegStart =
    side === "reference" ? segment.clip_1_seg_start_sec : segment.clip_2_seg_start_sec;
  const clipSegEnd =
    side === "reference" ? segment.clip_1_seg_end_sec : segment.clip_2_seg_end_sec;

  const startSec = clipSegStart ?? clipStartSec + segment.shared_start_sec;
  const endSec = clipSegEnd ?? clipStartSec + segment.shared_end_sec;
  return normalizeRange(startSec, endSec);
}

export function buildOverlaySegmentPlans(ebs: EbsData | null): OverlaySegmentPlan[] {
  if (!ebs?.alignment) return [];

  return (ebs.segments ?? [])
    .map((segment, index) => {
      const shared = normalizeRange(segment.shared_start_sec, segment.shared_end_sec);
      const reference = buildClipRange(segment, "reference", ebs.alignment.clip_1_start_sec);
      const practice = buildClipRange(segment, "practice", ebs.alignment.clip_2_start_sec);
      if (!shared || !reference || !practice) {
        return null;
      }
      return {
        index,
        sharedStartSec: shared.startSec,
        sharedEndSec: shared.endSec,
        reference,
        practice,
      } satisfies OverlaySegmentPlan;
    })
    .filter((value): value is OverlaySegmentPlan => value != null);
}

function segmentHasRenderableData(segment: OverlaySegmentArtifact | null | undefined) {
  if (!segment) return false;
  return Boolean(segment.video || (segment.frames && segment.frames.length > 0));
}

export function getOverlaySegmentByIndex(
  artifact: OverlayArtifact | null,
  index: number,
) {
  return (artifact?.segments ?? []).find((segment) => segment.index === index) ?? null;
}

export function overlayArtifactHasRenderableData(
  artifact: OverlayArtifact | null,
) {
  if (!artifact) return false;
  if (artifact.video || (artifact.frames && artifact.frames.length > 0)) {
    return true;
  }
  return (artifact.segments ?? []).some((segment) => segmentHasRenderableData(segment));
}

export function getReadyOverlaySegmentCount(artifact: OverlayArtifact | null) {
  return new Set(
    (artifact?.segments ?? [])
      .filter((segment) => segmentHasRenderableData(segment))
      .map((segment) => segment.index),
  ).size;
}

export function isOverlayArtifactComplete(
  artifact: OverlayArtifact | null,
  totalSegments: number,
) {
  if (!artifact) return false;
  if (artifact.video || (artifact.frames && artifact.frames.length > 0)) {
    return true;
  }
  if (totalSegments <= 0) {
    return overlayArtifactHasRenderableData(artifact);
  }
  return getReadyOverlaySegmentCount(artifact) >= totalSegments;
}

export function createSegmentedOverlayArtifact(params: {
  existing?: OverlayArtifact | null;
  type: OverlayType;
  side: OverlaySide;
  fps: number;
  width: number;
  height: number;
  meta?: Record<string, unknown>;
}) {
  const { existing, type, side, fps, width, height, meta } = params;
  return {
    version: 1 as const,
    type,
    side,
    fps,
    width: existing?.width || width,
    height: existing?.height || height,
    frameCount: existing?.frameCount || 0,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    segments: [...(existing?.segments ?? [])].sort((a, b) => a.startSec - b.startSec),
    meta: {
      ...(existing?.meta ?? {}),
      ...(meta ?? {}),
      segmented: true,
    },
  } satisfies OverlayArtifact;
}

export function upsertOverlaySegment(
  artifact: OverlayArtifact,
  segment: OverlaySegmentArtifact,
) {
  const nextSegments = [...(artifact.segments ?? []).filter((item) => item.index !== segment.index), segment].sort(
    (a, b) => a.startSec - b.startSec || a.index - b.index,
  );

  return {
    ...artifact,
    width: segment.width || artifact.width,
    height: segment.height || artifact.height,
    frameCount: nextSegments.reduce(
      (total, item) => total + (item.frameCount || item.frames?.length || 0),
      0,
    ),
    segments: nextSegments,
    meta: {
      ...(artifact.meta ?? {}),
      segmented: true,
    },
  } satisfies OverlayArtifact;
}
