/**
 * BodyPix-based comparison engine.
 *
 * Samples pose at a fixed rate within each beat-aligned segment (default 6 FPS),
 * compares multiple feature families per beat (micro-timing, upper/lower body,
 * attack vs transition), ranks feedback by deviation, and returns dense frames for
 * temporal LLM payloads.
 */

type BodyPixModule = typeof import("@tensorflow-models/body-pix");
type BodyPixNet = Awaited<ReturnType<BodyPixModule["load"]>>;

export type BodyRegion = "head" | "arms" | "torso" | "legs" | "full_body";

/** Feature family for multi-axis feedback within a beat (ranked by deviation). */
export type FeedbackFeatureFamily =
  | "micro_timing"
  | "upper_body"
  | "lower_body"
  | "attack_transition";

export const FEEDBACK_FEATURE_LABELS: Record<FeedbackFeatureFamily, string> = {
  micro_timing: "Micro-timing",
  upper_body: "Upper body",
  lower_body: "Lower body",
  attack_transition: "Attack & transition",
};

export type FeedbackSeverity = "good" | "minor" | "moderate" | "major";

export type DanceFeedback = {
  timestamp: number;
  segmentIndex: number;
  bodyRegion: BodyRegion;
  severity: FeedbackSeverity;
  /** Legacy combined line; per-frame coaching uses attackDecay + transitionToNext when set. */
  message: string;
  deviation: number;
  /** Index into dense pose samples (closest to beat midpoint) for LLM coaching merge. */
  frameIndex?: number;
  /** Which feature family this row compares (omit for legacy single-row feedback). */
  featureFamily?: FeedbackFeatureFamily;
  /** 1 = highest deviation / most important within the full run (after sorting). */
  importanceRank?: number;
  /** Heuristic: motion emphasis misaligned vs reference at this sample. */
  microTimingOff?: boolean;
  /** Coaching: onset, stops, release (no joint degrees). */
  attackDecay?: string;
  /** Coaching: how this shape should move toward the next sampled pose. */
  transitionToNext?: string;
};

export type ComparisonProgress = {
  currentFrame: number;
  totalFrames: number;
  phase: "loading" | "sampling" | "comparing" | "llm" | "done";
};

export type PoseKeypoint = { x: number; y: number; score: number; name?: string };

type Keypoint = PoseKeypoint;

export type SampledPoseFrame = {
  timestamp: number;
  segmentIndex: number;
  keypoints: Keypoint[];
  partCoverage: Record<BodyRegion, number>;
};

type FrameSample = SampledPoseFrame;

const KEYPOINT_NAMES = [
  "nose", "leftEye", "rightEye", "leftEar", "rightEar",
  "leftShoulder", "rightShoulder", "leftElbow", "rightElbow",
  "leftWrist", "rightWrist", "leftHip", "rightHip",
  "leftKnee", "rightKnee", "leftAnkle", "rightAnkle",
];

const REGION_KEYPOINTS: Record<BodyRegion, number[]> = {
  head: [0, 1, 2, 3, 4],
  arms: [7, 8, 9, 10],
  torso: [5, 6, 11, 12],
  legs: [13, 14, 15, 16],
  full_body: Array.from({ length: 17 }, (_, i) => i),
};

const REGION_PARTS: Record<BodyRegion, number[]> = {
  head: [0, 1],
  arms: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  torso: [12, 13],
  legs: [14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
  full_body: Array.from({ length: 24 }, (_, i) => i),
};

let cachedNet: BodyPixNet | null = null;

async function loadBodyPix(): Promise<BodyPixNet> {
  if (cachedNet) return cachedNet;
  const tf = await import("@tensorflow/tfjs-core");
  await import("@tensorflow/tfjs-backend-webgl");
  await tf.setBackend("webgl");
  await tf.ready();
  const bodyPix = await import("@tensorflow-models/body-pix");
  cachedNet = await bodyPix.load({
    architecture: "MobileNetV1",
    outputStride: 16,
    multiplier: 0.75,
    quantBytes: 2,
  });
  return cachedNet;
}

function computePartCoverage(
  partData: Int32Array,
  totalPixels: number,
): Record<BodyRegion, number> {
  const counts: Record<number, number> = {};
  for (let i = 0; i < partData.length; i++) {
    const p = partData[i];
    if (p >= 0) counts[p] = (counts[p] ?? 0) + 1;
  }

  const result: Record<BodyRegion, number> = {
    head: 0, arms: 0, torso: 0, legs: 0, full_body: 0,
  };
  for (const region of Object.keys(REGION_PARTS) as BodyRegion[]) {
    let sum = 0;
    for (const part of REGION_PARTS[region]) {
      sum += counts[part] ?? 0;
    }
    result[region] = totalPixels > 0 ? sum / totalPixels : 0;
  }
  return result;
}

function normalizeKeypoints(keypoints: Keypoint[]): Keypoint[] {
  const valid = keypoints.filter((kp) => kp.score > 0.3);
  if (valid.length < 2) return keypoints;

  const cx = valid.reduce((s, kp) => s + kp.x, 0) / valid.length;
  const cy = valid.reduce((s, kp) => s + kp.y, 0) / valid.length;
  const maxDist = Math.max(
    ...valid.map((kp) => Math.hypot(kp.x - cx, kp.y - cy)),
    1,
  );

  return keypoints.map((kp) => ({
    ...kp,
    x: (kp.x - cx) / maxDist,
    y: (kp.y - cy) / maxDist,
  }));
}

function keypointDistance(a: Keypoint[], b: Keypoint[], indices: number[]): number {
  let totalDist = 0;
  let count = 0;
  for (const idx of indices) {
    if (!a[idx] || !b[idx]) continue;
    if (a[idx].score < 0.3 || b[idx].score < 0.3) continue;
    totalDist += Math.hypot(a[idx].x - b[idx].x, a[idx].y - b[idx].y);
    count++;
  }
  return count > 0 ? totalDist / count : 0;
}

export function computeAngle(a: Keypoint, b: Keypoint, c: Keypoint): number | null {
  if (a.score < 0.3 || b.score < 0.3 || c.score < 0.3) return null;
  const ba = { x: a.x - b.x, y: a.y - b.y };
  const bc = { x: c.x - b.x, y: c.y - b.y };
  const dot = ba.x * bc.x + ba.y * bc.y;
  const cross = ba.x * bc.y - ba.y * bc.x;
  return Math.atan2(cross, dot) * (180 / Math.PI);
}

export type JointAngle = { name: string; region: BodyRegion; joints: [number, number, number] };

export const JOINT_ANGLES: JointAngle[] = [
  { name: "left elbow", region: "arms", joints: [5, 7, 9] },
  { name: "right elbow", region: "arms", joints: [6, 8, 10] },
  { name: "left shoulder", region: "torso", joints: [7, 5, 11] },
  { name: "right shoulder", region: "torso", joints: [8, 6, 12] },
  { name: "left knee", region: "legs", joints: [11, 13, 15] },
  { name: "right knee", region: "legs", joints: [12, 14, 16] },
  { name: "left hip", region: "legs", joints: [5, 11, 13] },
  { name: "right hip", region: "legs", joints: [6, 12, 14] },
];

export function jointAnglesDegFromKeypoints(
  keypoints: PoseKeypoint[],
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const ja of JOINT_ANGLES) {
    out[ja.name] = computeAngle(
      keypoints[ja.joints[0]],
      keypoints[ja.joints[1]],
      keypoints[ja.joints[2]],
    );
  }
  return out;
}

function classifySeverity(deviation: number): FeedbackSeverity {
  if (deviation < 0.12) return "good";
  if (deviation < 0.25) return "minor";
  if (deviation < 0.4) return "moderate";
  return "major";
}

/** Timestamps at ~`fps` within each segment [start, end). */
export function generateDenseTimestampsForSegments(
  segments: Array<{ shared_start_sec: number; shared_end_sec: number }>,
  fps: number,
): Array<{ time: number; segmentIndex: number }> {
  const dt = 1 / Math.max(0.5, fps);
  const out: Array<{ time: number; segmentIndex: number }> = [];
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const start = segments[segIdx].shared_start_sec;
    const end = segments[segIdx].shared_end_sec;
    if (!(end > start)) continue;
    let t = start;
    while (t < end - 1e-5) {
      out.push({ time: t, segmentIndex: segIdx });
      t += dt;
    }
  }
  return out;
}

function jointMotionBetweenFrames(prev: Keypoint[], curr: Keypoint[]): number {
  const prevA = jointAnglesDegFromKeypoints(prev);
  const currA = jointAnglesDegFromKeypoints(curr);
  const deltas: number[] = [];
  for (const ja of JOINT_ANGLES) {
    const p = prevA[ja.name];
    const q = currA[ja.name];
    if (p == null || q == null) continue;
    let d = Math.abs(q - p);
    if (d > 180) d = 360 - d;
    deltas.push(d);
  }
  return deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
}

function mean(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function std(nums: number[]): number {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  return Math.sqrt(mean(nums.map((x) => (x - m) ** 2)));
}

function segmentFramesSorted(frames: FrameSample[], segIdx: number): FrameSample[] {
  return frames.filter((f) => f.segmentIndex === segIdx).sort((a, b) => a.timestamp - b.timestamp);
}

function motionProfile(frames: FrameSample[]): number[] {
  const sorted = [...frames].sort((a, b) => a.timestamp - b.timestamp);
  const m: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    m.push(jointMotionBetweenFrames(sorted[i - 1].keypoints, sorted[i].keypoints));
  }
  return m;
}

type MicroTimingFeat = { onsetNorm: number; peakNorm: number; settleRatio: number };

function extractMicroTimingFeat(m: number[]): MicroTimingFeat {
  if (m.length === 0) return { onsetNorm: 0.5, peakNorm: 0.5, settleRatio: 1 };
  const maxM = Math.max(...m, 1e-9);
  const thresh = 0.12 * maxM;
  let onsetIdx = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i] > thresh) {
      onsetIdx = i;
      break;
    }
  }
  let peakIdx = 0;
  for (let i = 1; i < m.length; i++) {
    if (m[i] > m[peakIdx]) peakIdx = i;
  }
  const n = m.length;
  const early = mean(m.slice(0, Math.max(1, Math.ceil(n / 3))));
  const late = mean(m.slice(Math.floor((2 * n) / 3)));
  const settleRatio = early > 1e-6 ? late / early : 1;
  return {
    onsetNorm: (onsetIdx + 0.5) / n,
    peakNorm: (peakIdx + 0.5) / n,
    settleRatio: Math.min(3, Math.max(0.2, settleRatio)),
  };
}

function microTimingDeviation(refM: number[], userM: number[]): number {
  const rf = extractMicroTimingFeat(refM);
  const uf = extractMicroTimingFeat(userM);
  const dOnset = Math.abs(rf.onsetNorm - uf.onsetNorm);
  const dPeak = Math.abs(rf.peakNorm - uf.peakNorm);
  const base = Math.max(0.15, rf.settleRatio, uf.settleRatio);
  const dSettle = Math.abs(rf.settleRatio - uf.settleRatio) / base;
  return Math.min(1, dOnset * 0.38 + dPeak * 0.38 + Math.min(0.5, dSettle * 0.45));
}

type UpperBodyFeat = {
  shoulderY: number;
  elbowY: number;
  wristY: number;
  armOpen: number;
  torsoRot: number;
};

function upperBodyFeat(frames: FrameSample[]): UpperBodyFeat {
  const rows: UpperBodyFeat[] = [];
  for (const f of frames) {
    const nk = normalizeKeypoints(f.keypoints);
    const ls = nk[5];
    const rs = nk[6];
    if (ls.score < 0.2 || rs.score < 0.2) continue;
    const le = nk[7];
    const re = nk[8];
    const lw = nk[9];
    const rw = nk[10];
    const lh = nk[11];
    const rh = nk[12];
    const shoulderY = (ls.y + rs.y) / 2;
    const elbowY = (le.y + re.y) / 2;
    const wristY = (lw.y + rw.y) / 2;
    const armOpen = Math.hypot(lw.x - rw.x, lw.y - rw.y);
    const shMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    const hipMid = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
    const torsoRot = Math.atan2(shMid.y - hipMid.y, shMid.x - hipMid.x);
    rows.push({ shoulderY, elbowY, wristY, armOpen, torsoRot });
  }
  if (rows.length === 0) {
    return { shoulderY: 0, elbowY: 0, wristY: 0, armOpen: 0, torsoRot: 0 };
  }
  return {
    shoulderY: mean(rows.map((r) => r.shoulderY)),
    elbowY: mean(rows.map((r) => r.elbowY)),
    wristY: mean(rows.map((r) => r.wristY)),
    armOpen: mean(rows.map((r) => r.armOpen)),
    torsoRot: mean(rows.map((r) => r.torsoRot)),
  };
}

function wrapAngleDiffRad(a: number, b: number): number {
  let d = Math.abs(a - b);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d / Math.PI;
}

function upperBodyDeviation(ref: UpperBodyFeat, user: UpperBodyFeat): number {
  return Math.min(
    1,
    Math.abs(ref.shoulderY - user.shoulderY) * 0.85 +
      Math.abs(ref.elbowY - user.elbowY) * 0.85 +
      Math.abs(ref.wristY - user.wristY) * 0.85 +
      Math.abs(ref.armOpen - user.armOpen) * 0.55 +
      wrapAngleDiffRad(ref.torsoRot, user.torsoRot) * 0.45,
  );
}

type LowerBodyFeat = {
  hipShiftX: number;
  kneeBendDeg: number;
  stepDir: number;
  footSpread: number;
};

function lowerBodyFeat(frames: FrameSample[]): LowerBodyFeat {
  if (frames.length === 0) {
    return { hipShiftX: 0, kneeBendDeg: 0, stepDir: 0, footSpread: 0 };
  }
  const first = normalizeKeypoints(frames[0].keypoints);
  const last = normalizeKeypoints(frames[frames.length - 1].keypoints);
  const hip0 = (first[11].x + first[12].x) / 2;
  const hip1 = (last[11].x + last[12].x) / 2;
  const hipShiftX = hip1 - hip0;
  const a0x = (first[15].x + first[16].x) / 2;
  const a0y = (first[15].y + first[16].y) / 2;
  const a1x = (last[15].x + last[16].x) / 2;
  const a1y = (last[15].y + last[16].y) / 2;
  const stepDir = Math.atan2(a1y - a0y, a1x - a0x);
  const bends: number[] = [];
  const spreads: number[] = [];
  for (const f of frames) {
    const k = f.keypoints;
    const lk = computeAngle(k[11], k[13], k[15]);
    const rk = computeAngle(k[12], k[14], k[16]);
    if (lk != null && rk != null) {
      bends.push(Math.max(0, 180 - lk));
      bends.push(Math.max(0, 180 - rk));
    }
    const nk = normalizeKeypoints(k);
    spreads.push(Math.hypot(nk[15].x - nk[16].x, nk[15].y - nk[16].y));
  }
  return {
    hipShiftX,
    kneeBendDeg: bends.length ? mean(bends) : 0,
    stepDir,
    footSpread: spreads.length ? mean(spreads) : 0,
  };
}

function lowerBodyDeviation(ref: LowerBodyFeat, user: LowerBodyFeat): number {
  return Math.min(
    1,
    Math.abs(ref.hipShiftX - user.hipShiftX) * 0.9 +
      Math.abs(ref.kneeBendDeg - user.kneeBendDeg) / 55 +
      wrapAngleDiffRad(ref.stepDir, user.stepDir) * 0.5 +
      Math.abs(ref.footSpread - user.footSpread) * 0.65,
  );
}

type AttackFeat = { sharpness: number; lateVar: number; tailEnergy: number };

function attackTransitionFeat(m: number[]): AttackFeat {
  if (m.length === 0) return { sharpness: 1, lateVar: 0, tailEnergy: 0 };
  const meanM = mean(m);
  const maxM = Math.max(...m, 1e-6);
  const sharpness = maxM / (meanM + 1e-3);
  const half = Math.floor(m.length / 2);
  const second = m.slice(half);
  const lateVar =
    second.length > 1 ? std(second) / (mean(second) + 1e-3) : 0;
  const tailEnergy = m.length >= 2 ? mean(m.slice(-2)) : m[0];
  return { sharpness, lateVar, tailEnergy };
}

function attackTransitionDeviation(ref: AttackFeat, user: AttackFeat): number {
  return Math.min(
    1,
    Math.abs(ref.sharpness - user.sharpness) / 4.5 * 0.42 +
      Math.abs(ref.lateVar - user.lateVar) * 0.3 +
      Math.abs(ref.tailEnergy - user.tailEnergy) / 28 * 0.38,
  );
}

function familyToBodyRegion(family: FeedbackFeatureFamily): BodyRegion {
  switch (family) {
    case "upper_body":
      return "arms";
    case "lower_body":
      return "legs";
    case "micro_timing":
      return "torso";
    case "attack_transition":
      return "full_body";
    default:
      return "full_body";
  }
}

function familyMessage(family: FeedbackFeatureFamily, dev: number): string {
  if (dev < 0.12) return "Close to the reference.";
  if (family === "micro_timing") {
    return "When motion starts, peaks, and settles differs from the reference phrase.";
  }
  if (family === "upper_body") {
    return "Shoulder/elbow/wrist height, arm openness, or torso line differs from the reference.";
  }
  if (family === "lower_body") {
    return "Hip shift, knee bend, step direction, or foot spread differs from the reference.";
  }
  return "Attack sharpness vs decay smoothness and end-of-beat energy differ from the reference.";
}

function buildFamilyFeedbackForSegment(
  segIdx: number,
  midT: number,
  frameIndex: number,
  refSeg: FrameSample[],
  userSeg: FrameSample[],
): DanceFeedback[] {
  const refM = motionProfile(refSeg);
  const userM = motionProfile(userSeg);
  const families: Array<{
    family: FeedbackFeatureFamily;
    dev: number;
  }> = [];

  if (refM.length > 0 && userM.length > 0) {
    families.push({
      family: "micro_timing",
      dev: microTimingDeviation(refM, userM),
    });
  }

  if (refSeg.length > 0 && userSeg.length > 0) {
    families.push({
      family: "upper_body",
      dev: upperBodyDeviation(upperBodyFeat(refSeg), upperBodyFeat(userSeg)),
    });
    families.push({
      family: "lower_body",
      dev: lowerBodyDeviation(lowerBodyFeat(refSeg), lowerBodyFeat(userSeg)),
    });
  }

  if (refM.length > 0 && userM.length > 0) {
    families.push({
      family: "attack_transition",
      dev: attackTransitionDeviation(
        attackTransitionFeat(refM),
        attackTransitionFeat(userM),
      ),
    });
  }

  return families.map(({ family, dev }) => ({
    timestamp: midT,
    segmentIndex: segIdx,
    bodyRegion: familyToBodyRegion(family),
    severity: classifySeverity(dev),
    message: familyMessage(family, dev),
    deviation: dev,
    frameIndex,
    featureFamily: family,
    microTimingOff: family === "micro_timing" && dev >= 0.12,
  }));
}

function representativeDenseFrameIndex(samples: FrameSample[], segIdx: number): number {
  const indexed = samples
    .map((f, i) => ({ f, i }))
    .filter((x) => x.f.segmentIndex === segIdx);
  if (indexed.length === 0) return 0;
  const t0 = indexed[0].f.timestamp;
  const t1 = indexed[indexed.length - 1].f.timestamp;
  const midT = (t0 + t1) / 2;
  let best = indexed[0];
  let bestD = Math.abs(indexed[0].f.timestamp - midT);
  for (const x of indexed) {
    const d = Math.abs(x.f.timestamp - midT);
    if (d < bestD) {
      bestD = d;
      best = x;
    }
  }
  return best.i;
}

async function sampleFrame(
  video: HTMLVideoElement,
  net: BodyPixNet,
  timestamp: number,
  segmentIndex: number,
): Promise<FrameSample> {
  video.currentTime = timestamp;
  await new Promise<void>((r) => {
    video.onseeked = () => r();
  });
  await new Promise((r) => setTimeout(r, 50));

  const seg = (await net.segmentPersonParts(video, {
    flipHorizontal: false,
    internalResolution: "medium",
    segmentationThreshold: 0.5,
    maxDetections: 1,
    scoreThreshold: 0.2,
    nmsRadius: 20,
  })) as {
    data: Int32Array;
    width: number;
    height: number;
    allPoses?: Array<{ keypoints: Array<{ position: { x: number; y: number }; score: number; part: string }> }>;
  };

  const keypoints: Keypoint[] = KEYPOINT_NAMES.map((name) => {
    const pose = seg.allPoses?.[0];
    const kp = pose?.keypoints?.find((k) => k.part === name);
    return kp
      ? { x: kp.position.x, y: kp.position.y, score: kp.score, name }
      : { x: 0, y: 0, score: 0, name };
  });

  const totalPixels = seg.width * seg.height;
  const partCoverage = computePartCoverage(seg.data, totalPixels);

  return { timestamp, segmentIndex, keypoints, partCoverage };
}

/** Default pose sampling rate inside each beat interval. */
export const DEFAULT_POSE_FPS = 6;

export type ComparisonOptions = {
  referenceVideoUrl: string;
  userVideoUrl: string;
  /** Beat intervals (shared timeline). Used to generate dense timestamps and per-beat summaries. */
  segments: Array<{ shared_start_sec: number; shared_end_sec: number }>;
  /** Samples per second within each segment (default {@link DEFAULT_POSE_FPS}). */
  poseFps?: number;
  onProgress?: (progress: ComparisonProgress) => void;
};

export type BodyPixComparisonResult = {
  feedback: DanceFeedback[];
  refSamples: SampledPoseFrame[];
  userSamples: SampledPoseFrame[];
};

export async function compareWithBodyPix(
  opts: ComparisonOptions,
): Promise<BodyPixComparisonResult> {
  const { referenceVideoUrl, userVideoUrl, segments, poseFps = DEFAULT_POSE_FPS, onProgress } = opts;
  const timestamps = generateDenseTimestampsForSegments(segments, poseFps);
  const totalFrames = timestamps.length;

  if (totalFrames === 0) {
    onProgress?.({ currentFrame: 0, totalFrames: 0, phase: "done" });
    return { feedback: [], refSamples: [], userSamples: [] };
  }

  onProgress?.({ currentFrame: 0, totalFrames, phase: "loading" });

  const net = await loadBodyPix();

  const refVideo = document.createElement("video");
  refVideo.src = referenceVideoUrl;
  refVideo.muted = true;
  refVideo.playsInline = true;
  refVideo.crossOrigin = "anonymous";

  const userVideoEl = document.createElement("video");
  userVideoEl.src = userVideoUrl;
  userVideoEl.muted = true;
  userVideoEl.playsInline = true;
  userVideoEl.crossOrigin = "anonymous";

  await Promise.all([
    new Promise<void>((r) => { refVideo.onloadedmetadata = () => r(); }),
    new Promise<void>((r) => { userVideoEl.onloadedmetadata = () => r(); }),
  ]);

  onProgress?.({ currentFrame: 0, totalFrames, phase: "sampling" });

  const refSamples: FrameSample[] = [];
  const userSamples: FrameSample[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const { time, segmentIndex } = timestamps[i];
    onProgress?.({ currentFrame: i + 1, totalFrames, phase: "sampling" });

    const refSample = await sampleFrame(refVideo, net, time, segmentIndex);
    const userSample = await sampleFrame(userVideoEl, net, time, segmentIndex);
    refSamples.push(refSample);
    userSamples.push(userSample);
  }

  onProgress?.({ currentFrame: totalFrames, totalFrames, phase: "comparing" });

  const feedback: DanceFeedback[] = [];
  const segmentIndices = [...new Set(timestamps.map((t) => t.segmentIndex))].sort((a, b) => a - b);

  for (const segIdx of segmentIndices) {
    const segMeta = segments[segIdx];
    if (!segMeta) continue;
    const midT = (segMeta.shared_start_sec + segMeta.shared_end_sec) / 2;
    const refSeg = segmentFramesSorted(refSamples, segIdx);
    const userSeg = segmentFramesSorted(userSamples, segIdx);
    const frameIndex = representativeDenseFrameIndex(refSamples, segIdx);
    feedback.push(
      ...buildFamilyFeedbackForSegment(segIdx, midT, frameIndex, refSeg, userSeg),
    );
  }

  const orderFam: FeedbackFeatureFamily[] = [
    "micro_timing",
    "upper_body",
    "lower_body",
    "attack_transition",
  ];
  feedback.sort((a, b) => {
    if (Math.abs(b.deviation - a.deviation) > 1e-9) return b.deviation - a.deviation;
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    const ai = a.featureFamily != null ? orderFam.indexOf(a.featureFamily) : 99;
    const bi = b.featureFamily != null ? orderFam.indexOf(b.featureFamily) : 99;
    return ai - bi;
  });

  const ranked = feedback.map((fb, i) => ({ ...fb, importanceRank: i + 1 }));

  onProgress?.({ currentFrame: totalFrames, totalFrames, phase: "done" });
  return { feedback: ranked, refSamples, userSamples };
}

export function generateSampleTimestamps(
  segments: Array<{ shared_start_sec: number; shared_end_sec: number }>,
  sampleInterval: number = 1.0,
): Array<{ time: number; segmentIndex: number }> {
  const timestamps: Array<{ time: number; segmentIndex: number }> = [];

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    const duration = seg.shared_end_sec - seg.shared_start_sec;
    const numSamples = Math.max(2, Math.ceil(duration / sampleInterval));
    const step = duration / numSamples;

    for (let j = 0; j < numSamples; j++) {
      timestamps.push({
        time: seg.shared_start_sec + j * step,
        segmentIndex: segIdx,
      });
    }
  }

  return timestamps;
}
