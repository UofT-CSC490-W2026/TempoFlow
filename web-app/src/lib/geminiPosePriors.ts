/**
 * Browser-side pose timing priors for Gemini move-feedback.
 * Uses TensorFlow.js BodyPix (`loadBodyPix` / `sampleFrame`) — same stack as overlay masks,
 * not YOLO/MoveNet. Per move window we sample keypoints, build a motion-energy curve,
 * compare ref vs user peak times → phase_offset_ms and ahead/behind hints for the backend.
 */
import type { EbsData, EbsSegment } from "../components/ebs/types";
import { buildMovesForSegment } from "../components/ebs/ebsViewerLogic";
import { JOINT_ANGLES, jointAnglesDegFromKeypoints } from "./bodyPix";
import { loadBodyPix, sampleFrame } from "./bodyPix/segmentation";
import type { PoseKeypoint, SampledPoseFrame } from "./bodyPix/types";
import { DEFAULT_POSE_FPS } from "./bodyPix/types";

function jointMotionBetweenFrames(prev: PoseKeypoint[], curr: PoseKeypoint[]): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < Math.min(prev.length, curr.length); i++) {
    const dx = curr[i].x - prev[i].x;
    const dy = curr[i].y - prev[i].y;
    if (prev[i].score < 0.15 || curr[i].score < 0.15) continue;
    sum += Math.hypot(dx, dy);
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}

function motionSeries(frames: SampledPoseFrame[]): number[] {
  const sorted = [...frames].sort((a, b) => a.timestamp - b.timestamp);
  const m: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    m.push(jointMotionBetweenFrames(sorted[i - 1].keypoints, sorted[i].keypoints));
  }
  return m;
}

function argMax(arr: number[]): number {
  if (arr.length === 0) return -1;
  let j = 0;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > arr[j]) j = i;
  }
  return j;
}

export type MovePosePrior = {
  move_index: number;
  phase_offset_ms: number;
  user_relative_to_reference: "ahead" | "behind" | "aligned" | "unclear";
  prior_confidence: "high" | "medium" | "low";
  peak_joint_angle_signal_pct?: number;
  avg_joint_angle_signal_pct?: number;
  top_joint_diffs?: Array<{
    joint: string;
    avg_delta_deg: number;
    peak_delta_deg: number;
    peak_signal_pct: number;
  }>;
};

export type PosePriorsPayload = {
  moves: MovePosePrior[];
};

const ALIGN_FRAC = 0.12;

function smallestAngleDifferenceDegrees(a: number, b: number) {
  let delta = Math.abs(a - b);
  if (delta > 180) delta = 360 - delta;
  return delta;
}

function summarizeJointAngleDiffs(referenceFrames: SampledPoseFrame[], userFrames: SampledPoseFrame[]) {
  const jointSummaries = JOINT_ANGLES.map((joint) => {
    const deltas: number[] = [];
    for (let index = 0; index < Math.min(referenceFrames.length, userFrames.length); index += 1) {
      const referenceAngles = jointAnglesDegFromKeypoints(referenceFrames[index]!.keypoints);
      const userAngles = jointAnglesDegFromKeypoints(userFrames[index]!.keypoints);
      const referenceAngle = referenceAngles[joint.name];
      const userAngle = userAngles[joint.name];
      if (!Number.isFinite(referenceAngle) || !Number.isFinite(userAngle)) continue;
      const safeReferenceAngle = referenceAngle as number;
      const safeUserAngle = userAngle as number;
      deltas.push(smallestAngleDifferenceDegrees(safeReferenceAngle, safeUserAngle));
    }

    if (deltas.length === 0) return null;
    const avg_delta_deg = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    const peak_delta_deg = Math.max(...deltas);
    const peak_signal_pct = (peak_delta_deg / 30) * 100;
    return {
      joint: joint.name,
      avg_delta_deg,
      peak_delta_deg,
      peak_signal_pct,
    };
  }).filter((value): value is NonNullable<typeof value> => value != null);

  if (jointSummaries.length === 0) {
    return {
      peak_joint_angle_signal_pct: 0,
      avg_joint_angle_signal_pct: 0,
      top_joint_diffs: [],
    };
  }

  const sorted = [...jointSummaries].sort((a, b) => b.peak_signal_pct - a.peak_signal_pct);
  return {
    peak_joint_angle_signal_pct: sorted[0]?.peak_signal_pct ?? 0,
    avg_joint_angle_signal_pct:
      jointSummaries.reduce((sum, summary) => sum + summary.peak_signal_pct, 0) / jointSummaries.length,
    top_joint_diffs: sorted.slice(0, 4).map((summary) => ({
      joint: summary.joint,
      avg_delta_deg: Math.round(summary.avg_delta_deg),
      peak_delta_deg: Math.round(summary.peak_delta_deg),
      peak_signal_pct: Math.round(summary.peak_signal_pct),
    })),
  };
}

/**
 * Sample poses in shared time for each beat-to-beat move in one segment; estimate
 * peak motion offset (user vs reference) as a soft prior for Gemini.
 */
export async function computePosePriorsForSegment(opts: {
  referenceVideoUrl: string;
  userVideoUrl: string;
  ebsData: EbsData;
  segments: EbsSegment[];
  segmentIndex: number;
  poseFps?: number;
}): Promise<PosePriorsPayload> {
  const { referenceVideoUrl, userVideoUrl, ebsData, segments, segmentIndex } = opts;
  const poseFps = opts.poseFps ?? DEFAULT_POSE_FPS;
  const beats = ebsData.beats_shared_sec ?? [];
  const moves = buildMovesForSegment(beats, segments, segmentIndex);
  if (moves.length === 0) {
    return { moves: [] };
  }

  const net = await loadBodyPix();
  const refVideo = document.createElement("video");
  refVideo.src = referenceVideoUrl;
  refVideo.muted = true;
  refVideo.playsInline = true;
  refVideo.crossOrigin = "anonymous";
  const userVideo = document.createElement("video");
  userVideo.src = userVideoUrl;
  userVideo.muted = true;
  userVideo.playsInline = true;
  userVideo.crossOrigin = "anonymous";

  await Promise.all([
    new Promise<void>((r) => {
      refVideo.onloadedmetadata = () => r();
    }),
    new Promise<void>((r) => {
      userVideo.onloadedmetadata = () => r();
    }),
  ]);

  const dt = 1 / Math.max(0.5, poseFps);
  const out: MovePosePrior[] = [];

  for (const mv of moves) {
    const start = mv.startSec;
    const end = mv.endSec;
    const duration = end - start;
    if (!(duration > 1e-6)) {
      out.push({
        move_index: mv.num,
        phase_offset_ms: 0,
        user_relative_to_reference: "unclear",
        prior_confidence: "low",
      });
      continue;
    }

    const times: number[] = [];
    for (let t = start; t < end - 1e-6; t += dt) {
      times.push(t);
    }
    if (times.length < 2) {
      out.push({
        move_index: mv.num,
        phase_offset_ms: 0,
        user_relative_to_reference: "unclear",
        prior_confidence: "low",
      });
      continue;
    }

    const refFrames: SampledPoseFrame[] = [];
    const userFrames: SampledPoseFrame[] = [];
    for (const t of times) {
      refFrames.push(await sampleFrame(refVideo, net, t, segmentIndex));
      userFrames.push(await sampleFrame(userVideo, net, t, segmentIndex));
    }

    const refM = motionSeries(refFrames);
    const userM = motionSeries(userFrames);
    const maxRef = refM.length ? Math.max(...refM, 1e-9) : 0;
    const maxUser = userM.length ? Math.max(...userM, 1e-9) : 0;
    const weakMotion = maxRef < 0.02 && maxUser < 0.02;

    const iRef = argMax(refM);
    const iUser = argMax(userM);
    const tRefPeak = iRef >= 0 && iRef + 1 < times.length ? times[iRef + 1] : (start + end) / 2;
    const tUserPeak = iUser >= 0 && iUser + 1 < times.length ? times[iUser + 1] : (start + end) / 2;
    const phaseSec = tUserPeak - tRefPeak;
    const phase_offset_ms = phaseSec * 1000;

    const alignThreshSec = Math.max(0.04, ALIGN_FRAC * duration);
    let user_relative_to_reference: MovePosePrior["user_relative_to_reference"];
    if (weakMotion) {
      user_relative_to_reference = "unclear";
    } else if (Math.abs(phaseSec) <= alignThreshSec) {
      user_relative_to_reference = "aligned";
    } else if (phaseSec > 0) {
      user_relative_to_reference = "behind";
    } else {
      user_relative_to_reference = "ahead";
    }

    let prior_confidence: MovePosePrior["prior_confidence"];
    if (times.length >= 8 && !weakMotion) {
      prior_confidence = "high";
    } else if (times.length >= 4 && !weakMotion) {
      prior_confidence = "medium";
    } else {
      prior_confidence = "low";
    }

    out.push({
      move_index: mv.num,
      phase_offset_ms,
      user_relative_to_reference,
      prior_confidence,
      ...summarizeJointAngleDiffs(refFrames, userFrames),
    });
  }

  return { moves: out };
}
