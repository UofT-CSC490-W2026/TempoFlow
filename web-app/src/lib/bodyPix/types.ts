/**
 * Shared types and labels for BodyPix pose comparison and feedback.
 */

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

export type SampledPoseFrame = {
  timestamp: number;
  segmentIndex: number;
  keypoints: PoseKeypoint[];
  partCoverage: Record<BodyRegion, number>;
};

export type JointAngle = {
  name: string;
  region: BodyRegion;
  joints: [number, number, number];
};

export type MicroTimingFeat = {
  onsetNorm: number;
  peakNorm: number;
  settleRatio: number;
};

export type AttackFeat = {
  sharpness: number;
  lateVar: number;
  tailEnergy: number;
};

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
