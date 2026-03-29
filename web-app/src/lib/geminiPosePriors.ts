/**
 * Browser-side pose timing priors for Gemini move-feedback.
 * Uses TensorFlow.js BodyPix (`loadBodyPix` / `sampleFrame`) — same stack as overlay masks,
 * not YOLO/MoveNet. Per move window we sample keypoints, build a motion-energy curve,
 * compare ref vs user peak times → phase_offset_ms and ahead/behind hints for the backend.
 */
import type { EbsData, EbsSegment } from "../components/ebs/types";
import { buildMovesForSegment } from "../components/ebs/ebsViewerLogic";
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
};

export type PosePriorsPayload = {
  moves: MovePosePrior[];
};

const ALIGN_FRAC = 0.12;

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
    });
  }

  return { moves: out };
}
