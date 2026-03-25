/**
 * BodyPix-based comparison engine.
 *
 * Samples frames from reference and user videos, runs BodyPix
 * segmentPersonParts to extract 24-part segmentation + pose keypoints,
 * then computes per-region deviations and produces timestamped feedback.
 */

type BodyPixModule = typeof import("@tensorflow-models/body-pix");
type BodyPixNet = Awaited<ReturnType<BodyPixModule["load"]>>;

export type BodyRegion = "head" | "arms" | "torso" | "legs" | "full_body";

export type FeedbackSeverity = "good" | "minor" | "moderate" | "major";

export type DanceFeedback = {
  timestamp: number;
  segmentIndex: number;
  bodyRegion: BodyRegion;
  severity: FeedbackSeverity;
  /** Legacy combined line; per-frame coaching uses attackDecay + transitionToNext when set. */
  message: string;
  deviation: number;
  /** Sample index in the BodyPix run (one row per sampled frame). */
  frameIndex?: number;
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

export type ComparisonOptions = {
  referenceVideoUrl: string;
  userVideoUrl: string;
  timestamps: Array<{ time: number; segmentIndex: number }>;
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
  const { referenceVideoUrl, userVideoUrl, timestamps, onProgress } = opts;
  const totalFrames = timestamps.length;

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

  for (let i = 0; i < refSamples.length; i++) {
    const ref = refSamples[i];
    const user = userSamples[i];

    const refNorm = normalizeKeypoints(ref.keypoints);
    const userNorm = normalizeKeypoints(user.keypoints);

    const regions: BodyRegion[] = ["head", "arms", "torso", "legs"];
    let maxCombined = 0;
    for (const region of regions) {
      const dist = keypointDistance(refNorm, userNorm, REGION_KEYPOINTS[region]);
      const angleDetails: number[] = [];
      for (const ja of JOINT_ANGLES.filter((j) => j.region === region)) {
        const refAngle = computeAngle(
          ref.keypoints[ja.joints[0]],
          ref.keypoints[ja.joints[1]],
          ref.keypoints[ja.joints[2]],
        );
        const userAngle = computeAngle(
          user.keypoints[ja.joints[0]],
          user.keypoints[ja.joints[1]],
          user.keypoints[ja.joints[2]],
        );
        if (refAngle != null && userAngle != null) {
          let diff = Math.abs(refAngle - userAngle);
          if (diff > 180) diff = 360 - diff;
          angleDetails.push(diff);
        }
      }
      const maxAngleDiff = angleDetails.length ? Math.max(...angleDetails) : 0;
      const combinedDeviation = dist * 0.6 + (maxAngleDiff / 180) * 0.4;
      if (combinedDeviation > maxCombined) maxCombined = combinedDeviation;
    }

    const severity = classifySeverity(maxCombined);
    feedback.push({
      timestamp: ref.timestamp,
      segmentIndex: ref.segmentIndex,
      bodyRegion: "full_body",
      severity,
      message: "",
      deviation: maxCombined,
      frameIndex: i,
    });
  }

  feedback.sort((a, b) => a.timestamp - b.timestamp || b.deviation - a.deviation);

  onProgress?.({ currentFrame: totalFrames, totalFrames, phase: "done" });
  return { feedback, refSamples, userSamples };
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
