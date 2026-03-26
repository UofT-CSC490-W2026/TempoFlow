import type { FeedbackFeatureFamily, FeedbackSeverity } from "./types";

export function classifySeverity(deviation: number): FeedbackSeverity {
  if (deviation < 0.12) return "good";
  if (deviation < 0.25) return "minor";
  if (deviation < 0.4) return "moderate";
  return "major";
}

export function familyMessage(family: FeedbackFeatureFamily, dev: number): string {
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
