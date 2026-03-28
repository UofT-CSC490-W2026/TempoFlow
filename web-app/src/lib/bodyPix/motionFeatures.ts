import type { AttackFeat, MicroTimingFeat } from "./types";
import { meanOfSamples, stdDeviation } from "./stats";

export function extractMicroTimingFeatures(m: number[]): MicroTimingFeat {
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
  const early = meanOfSamples(m.slice(0, Math.max(1, Math.ceil(n / 3))));
  const late = meanOfSamples(m.slice(Math.floor((2 * n) / 3)));
  const settleRatio = early > 1e-6 ? late / early : 1;
  return {
    onsetNorm: (onsetIdx + 0.5) / n,
    peakNorm: (peakIdx + 0.5) / n,
    settleRatio: Math.min(3, Math.max(0.2, settleRatio)),
  };
}

export function wrapAngleDiffRad(a: number, b: number): number {
  let d = Math.abs(a - b);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d / Math.PI;
}

export function attackTransitionFeatureFromMotion(m: number[]): AttackFeat {
  if (m.length === 0) return { sharpness: 1, lateVar: 0, tailEnergy: 0 };
  const meanM = meanOfSamples(m);
  const maxM = Math.max(...m, 1e-6);
  const sharpness = maxM / (meanM + 1e-3);
  const half = Math.floor(m.length / 2);
  const second = m.slice(half);
  const lateVar =
    second.length > 1 ? stdDeviation(second) / (meanOfSamples(second) + 1e-3) : 0;
  const tailEnergy = m.length >= 2 ? meanOfSamples(m.slice(-2)) : m[0];
  return { sharpness, lateVar, tailEnergy };
}
