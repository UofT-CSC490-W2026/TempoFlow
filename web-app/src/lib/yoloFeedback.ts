"use client";

import type { EbsSegment } from "../components/ebs/types";
import { JOINT_ANGLES, jointAnglesDegFromKeypoints } from "./bodyPix";
import { KEYPOINT_NAMES } from "./bodyPix/constants";
import type {
  BodyPixComparisonResult,
  BodyRegion,
  DanceFeedback,
  PoseKeypoint,
  SampledPoseFrame,
} from "./bodyPix/types";
import type { OverlayArtifact, OverlaySegmentArtifact } from "./overlayStorage";
import { getOverlaySegmentByIndex } from "./overlaySegments";

type StoredPoseFrame = {
  keypoints?: Array<{
    name?: string;
    x: number;
    y: number;
    score: number;
  }>;
  part_coverage?: Record<string, number> | null;
  instances?: Array<{
    keypoints?: Array<{
      name?: string;
      x: number;
      y: number;
      score: number;
    }>;
    part_coverage?: Record<string, number> | null;
  }> | null;
};

const BODY_REGION_KEYPOINTS: Record<BodyRegion, number[]> = {
  head: [0, 1, 2, 3, 4],
  arms: [5, 6, 7, 8, 9, 10],
  torso: [5, 6, 11, 12],
  legs: [11, 12, 13, 14, 15, 16],
  full_body: Array.from({ length: KEYPOINT_NAMES.length }, (_, index) => index),
};
export const ANGLE_SIGNAL_STANDARD_DEGREES = 30;
const MIN_ANGLE_SIGNAL_PCT = 100;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function emptyKeypoints(): PoseKeypoint[] {
  return KEYPOINT_NAMES.map((name) => ({ name, x: 0, y: 0, score: 0 }));
}

function computePartCoverage(keypoints: PoseKeypoint[]): Record<BodyRegion, number> {
  return {
    head: BODY_REGION_KEYPOINTS.head.filter((index) => (keypoints[index]?.score ?? 0) >= 0.25).length / BODY_REGION_KEYPOINTS.head.length,
    arms: BODY_REGION_KEYPOINTS.arms.filter((index) => (keypoints[index]?.score ?? 0) >= 0.25).length / BODY_REGION_KEYPOINTS.arms.length,
    torso: BODY_REGION_KEYPOINTS.torso.filter((index) => (keypoints[index]?.score ?? 0) >= 0.25).length / BODY_REGION_KEYPOINTS.torso.length,
    legs: BODY_REGION_KEYPOINTS.legs.filter((index) => (keypoints[index]?.score ?? 0) >= 0.25).length / BODY_REGION_KEYPOINTS.legs.length,
    full_body:
      BODY_REGION_KEYPOINTS.full_body.filter((index) => (keypoints[index]?.score ?? 0) >= 0.25).length /
      BODY_REGION_KEYPOINTS.full_body.length,
  };
}

function toPoseKeypoints(value: unknown): PoseKeypoint[] {
  const keypoints = emptyKeypoints();
  if (!Array.isArray(value)) {
    return keypoints;
  }

  value.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || index >= keypoints.length) return;
    const record = raw as Record<string, unknown>;
    keypoints[index] = {
      name: typeof record.name === "string" ? record.name : KEYPOINT_NAMES[index],
      x: isFiniteNumber(record.x) ? record.x : 0,
      y: isFiniteNumber(record.y) ? record.y : 0,
      score: isFiniteNumber(record.score) ? record.score : 0,
    };
  });

  return keypoints;
}

function toPartCoverage(value: unknown, keypoints: PoseKeypoint[]): Record<BodyRegion, number> {
  const fallback = computePartCoverage(keypoints);
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const record = value as Record<string, unknown>;
  return {
    head: isFiniteNumber(record.head) ? record.head : fallback.head,
    arms: isFiniteNumber(record.arms) ? record.arms : fallback.arms,
    torso: isFiniteNumber(record.torso) ? record.torso : fallback.torso,
    legs: isFiniteNumber(record.legs) ? record.legs : fallback.legs,
    full_body: isFiniteNumber(record.full_body) ? record.full_body : fallback.full_body,
  };
}

function readStoredPoseFrames(segment: OverlaySegmentArtifact | null | undefined): Array<StoredPoseFrame | null> {
  const poseFrames = segment?.meta?.poseFrames;
  return Array.isArray(poseFrames) ? (poseFrames as Array<StoredPoseFrame | null>) : [];
}

export function overlaySegmentHasYoloPoseFrames(segment: OverlaySegmentArtifact | null | undefined) {
  return readStoredPoseFrames(segment).some((frame) => Array.isArray(frame?.keypoints) && frame.keypoints.length > 0);
}

export function overlayArtifactHasYoloPoseFrames(artifact: OverlayArtifact | null) {
  return (artifact?.segments ?? []).some((segment) => overlaySegmentHasYoloPoseFrames(segment));
}

function buildSamplesForSegment(params: {
  segment: OverlaySegmentArtifact;
  segmentIndex: number;
  sharedSegment?: EbsSegment | null;
}): SampledPoseFrame[] {
  const { segment, segmentIndex, sharedSegment } = params;
  const poseFrames = readStoredPoseFrames(segment);
  const meta = (segment.meta ?? {}) as Record<string, unknown>;
  const sharedStartSec = isFiniteNumber(meta.sharedStartSec)
    ? meta.sharedStartSec
    : sharedSegment?.shared_start_sec ?? segment.startSec;
  const sharedEndSec = isFiniteNumber(meta.sharedEndSec)
    ? meta.sharedEndSec
    : sharedSegment?.shared_end_sec ?? segment.endSec;
  const durationSec = Math.max(0, sharedEndSec - sharedStartSec);
  const fps = Math.max(1, segment.fps || 1);

  return poseFrames.map((frame, frameIndex) => {
    const keypoints = toPoseKeypoints(frame?.keypoints);
    const timestamp = sharedStartSec + Math.min(durationSec, frameIndex / fps);
    return {
      timestamp,
      segmentIndex,
      frameWidth: Math.max(1, segment.width),
      frameHeight: Math.max(1, segment.height),
      keypoints,
      partCoverage: toPartCoverage(frame?.part_coverage, keypoints),
    };
  });
}

function smallestAngleDifferenceDegrees(a: number, b: number) {
  let delta = Math.abs(a - b);
  if (delta > 180) delta = 360 - delta;
  return delta;
}

function toSignalPercent(deltaDeg: number) {
  return (deltaDeg / ANGLE_SIGNAL_STANDARD_DEGREES) * 100;
}

function angleSeverity(signalPct: number): DanceFeedback["severity"] {
  if (signalPct >= 300) return "major";
  if (signalPct >= 200) return "moderate";
  if (signalPct >= 100) return "minor";
  return "good";
}

function jointToBodyRegion(jointName: string): BodyRegion {
  if (jointName.includes("elbow")) return "arms";
  if (jointName.includes("shoulder")) return "torso";
  return "legs";
}

function jointToFeatureFamily(jointName: string): DanceFeedback["featureFamily"] {
  return jointName.includes("elbow") || jointName.includes("shoulder")
    ? "upper_body"
    : "lower_body";
}

function jointToFocusSide(jointName: string): DanceFeedback["focusSide"] {
  if (jointName.startsWith("left")) return "left";
  if (jointName.startsWith("right")) return "right";
  return "center";
}

function formatJointLabel(jointName: string) {
  return jointName.replace(/\b\w/g, (match) => match.toUpperCase());
}

function buildAngleFeedbackForSegment(params: {
  segmentIndex: number;
  globalOffset: number;
  referenceSamples: SampledPoseFrame[];
  userSamples: SampledPoseFrame[];
}) {
  const { segmentIndex, globalOffset, referenceSamples, userSamples } = params;
  const frameCount = Math.min(referenceSamples.length, userSamples.length);
  if (frameCount <= 0) return [];

  const referenceAngles = referenceSamples
    .slice(0, frameCount)
    .map((sample) => jointAnglesDegFromKeypoints(sample.keypoints));
  const userAngles = userSamples
    .slice(0, frameCount)
    .map((sample) => jointAnglesDegFromKeypoints(sample.keypoints));
  const feedback: DanceFeedback[] = [];

  for (const joint of JOINT_ANGLES) {
    const deltas: Array<{
      localFrameIndex: number;
      timestamp: number;
      deltaDeg: number;
    }> = [];

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const referenceAngle = referenceAngles[frameIndex]?.[joint.name];
      const userAngle = userAngles[frameIndex]?.[joint.name];
      if (!isFiniteNumber(referenceAngle) || !isFiniteNumber(userAngle)) continue;

      deltas.push({
        localFrameIndex: frameIndex,
        timestamp: userSamples[frameIndex]?.timestamp ?? referenceSamples[frameIndex]?.timestamp ?? 0,
        deltaDeg: smallestAngleDifferenceDegrees(referenceAngle, userAngle),
      });
    }

    if (!deltas.length) continue;

    const ranked = [...deltas].sort((a, b) => b.deltaDeg - a.deltaDeg);
    const representativeDeg =
      ranked.length >= 2
        ? (ranked[0]!.deltaDeg + ranked[1]!.deltaDeg) / 2
        : ranked[0]!.deltaDeg;
    const signalPct = toSignalPercent(representativeDeg);
    if (signalPct < MIN_ANGLE_SIGNAL_PCT) continue;

    const peak = ranked[0]!;
    const jointLabel = formatJointLabel(joint.name);
    feedback.push({
      timestamp: peak.timestamp,
      segmentIndex,
      bodyRegion: jointToBodyRegion(joint.name),
      severity: angleSeverity(signalPct),
      message: `${jointLabel} angle differs by ${Math.round(representativeDeg)}° from the guide.`,
      deviation: signalPct / 100,
      frameIndex: globalOffset + peak.localFrameIndex,
      featureFamily: jointToFeatureFamily(joint.name),
      focusSide: jointToFocusSide(joint.name),
      jointName: joint.name,
      angleDeltaDeg: representativeDeg,
      angleDeltaPct: signalPct,
      signalType: "angle_delta",
    });
  }

  return feedback;
}

export function buildVisualFeedbackFromYoloArtifacts(params: {
  referenceArtifact: OverlayArtifact | null;
  userArtifact: OverlayArtifact | null;
  segments: EbsSegment[];
}): BodyPixComparisonResult {
  const { referenceArtifact, userArtifact, segments } = params;
  const refSamples: SampledPoseFrame[] = [];
  const userSamples: SampledPoseFrame[] = [];
  const feedback: DanceFeedback[] = [];

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const refSegment = getOverlaySegmentByIndex(referenceArtifact, segmentIndex);
    const userSegment = getOverlaySegmentByIndex(userArtifact, segmentIndex);
    if (!refSegment || !userSegment) continue;
    if (!overlaySegmentHasYoloPoseFrames(refSegment) || !overlaySegmentHasYoloPoseFrames(userSegment)) continue;

    const refSegmentSamples = buildSamplesForSegment({
      segment: refSegment,
      segmentIndex,
      sharedSegment: segments[segmentIndex] ?? null,
    });
    const userSegmentSamples = buildSamplesForSegment({
      segment: userSegment,
      segmentIndex,
      sharedSegment: segments[segmentIndex] ?? null,
    });
    if (!refSegmentSamples.length || !userSegmentSamples.length) continue;

    const globalOffset = refSamples.length;
    refSamples.push(...refSegmentSamples);
    userSamples.push(...userSegmentSamples);

    feedback.push(
      ...buildAngleFeedbackForSegment({
        segmentIndex,
        globalOffset,
        referenceSamples: refSegmentSamples,
        userSamples: userSegmentSamples,
      }),
    );
  }

  feedback.sort((a, b) => {
    const deltaPctDiff = (b.angleDeltaPct ?? 0) - (a.angleDeltaPct ?? 0);
    if (Math.abs(deltaPctDiff) > 1e-9) return deltaPctDiff;
    if (Math.abs(b.deviation - a.deviation) > 1e-9) return b.deviation - a.deviation;
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return (a.jointName ?? "").localeCompare(b.jointName ?? "");
  });

  return {
    feedback: feedback.map((item, index) => ({ ...item, importanceRank: index + 1 })),
    refSamples,
    userSamples,
  };
}
