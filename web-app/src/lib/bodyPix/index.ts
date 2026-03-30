/**
 * BodyPix-based comparison engine.
 *
 * Samples pose at a fixed rate within each beat-aligned segment (default 6 FPS),
 * compares multiple feature families per beat (micro-timing, upper/lower body,
 * attack vs transition), ranks feedback by deviation, and returns dense frames for
 * temporal LLM payloads.
 */

export { compareWithBodyPix } from "./compare";
export { KEYPOINT_NAMES, REGION_PARTS } from "./constants";
export { classifySeverity, familyMessage } from "./feedbackCopy";
export {
  computeAngle,
  jointAnglesDegFromKeypoints,
  JOINT_ANGLES,
} from "./geometry";
export {
  attackTransitionFeatureFromMotion,
  extractMicroTimingFeatures,
  wrapAngleDiffRad,
} from "./motionFeatures";
export { meanOfSamples, stdDeviation } from "./stats";
export { generateDenseTimestampsForSegments, generateSampleTimestamps } from "./timestamps";
export {
  DEFAULT_POSE_FPS,
  FEEDBACK_FEATURE_LABELS,
} from "./types";
export type {
  AttackFeat,
  BodyPixComparisonResult,
  BodyRegion,
  ComparisonOptions,
  ComparisonProgress,
  DanceFeedback,
  FeedbackFeatureFamily,
  FeedbackSeverity,
  JointAngle,
  MicroTimingFeat,
  PoseKeypoint,
  SampledPoseFrame,
} from "./types";
