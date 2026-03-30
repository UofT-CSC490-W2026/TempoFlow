import type {
  AnalysisInsight,
  AnalysisScores,
  AnalysisSegment,
  AnalysisSummary,
} from './sessionStorage';

export interface PoseSample {
  timeSec: number;
  quality: number;
  motion: number;
  energy: number;
  smoothness: number;
  bodyAreas: Record<string, number>;
}

export interface PoseAnalysisInput {
  reference: PoseSample[];
  practice: PoseSample[];
  referenceDurationSec: number;
  practiceDurationSec: number;
}

const BODY_AREA_LABELS: Record<string, string> = {
  upperBody: 'Upper body',
  arms: 'Arms',
  core: 'Core',
  legs: 'Legs',
};

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeDifference(diff: number, maxDiff: number) {
  return 1 - Math.min(diff / maxDiff, 1);
}

function buildSegments(samples: PoseSample[], areaValues: Record<string, number>[]): AnalysisSegment[] {
  if (samples.length === 0) return [];

  const segmentCount = Math.min(3, samples.length);
  const baseSize = Math.floor(samples.length / segmentCount);
  const segments: AnalysisSegment[] = [];

  for (let index = 0; index < segmentCount; index += 1) {
    const start = index * baseSize;
    const end = index === segmentCount - 1 ? samples.length : (index + 1) * baseSize;
    const range = samples.slice(start, end);
    const rangeAreas = areaValues.slice(start, end);

    const averagedAreas = Object.keys(BODY_AREA_LABELS).reduce<Record<string, number>>((acc, key) => {
      acc[key] = average(rangeAreas.map((value) => value[key] ?? 0));
      return acc;
    }, {});

    const focusArea = Object.entries(averagedAreas).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'arms';
    const avgError = average(Object.values(averagedAreas));

    segments.push({
      id: `segment-${index + 1}`,
      label: `Segment ${index + 1}`,
      focusArea: BODY_AREA_LABELS[focusArea] ?? 'Body alignment',
      startSec: range[0]?.timeSec ?? 0,
      endSec: range[range.length - 1]?.timeSec ?? range[0]?.timeSec ?? 0,
      score: clampScore(100 - avgError * 180),
    });
  }

  return segments;
}

function buildInsights(input: {
  scores: AnalysisScores;
  focusArea: string;
  strongestArea: string;
  timingOffsetMs: number;
  segments: AnalysisSegment[];
}): AnalysisInsight[] {
  const worstSegment = input.segments.slice().sort((a, b) => a.score - b.score)[0];
  const offsetDirection = input.timingOffsetMs >= 0 ? 'late' : 'early';
  const offsetAmount = Math.abs(input.timingOffsetMs);

  return [
    {
      id: 'strength',
      tone: 'positive',
      title: `${input.strongestArea} is your strongest area`,
      body: `Your overall control looks most consistent in ${input.strongestArea.toLowerCase()}, so keep that shape as the anchor for the rest of the routine.`,
    },
    {
      id: 'timing',
      tone: 'focus',
      title: 'Timing should be the main focus',
      body:
        offsetAmount < 60
          ? 'Your timing is already close to the reference. Keep the same rhythm and tighten the transition moments.'
          : `Your practice run trends about ${offsetAmount}ms ${offsetDirection} versus the reference. Try matching the beat accents before chasing cleaner shapes.`,
      timestampSec: worstSegment?.startSec,
    },
    {
      id: 'segment',
      tone: 'tip',
      title: worstSegment
        ? `Review ${worstSegment.label.toLowerCase()}`
        : 'Replay your hardest section',
      body: worstSegment
        ? `The biggest gap shows up around ${worstSegment.startSec.toFixed(1)}s-${worstSegment.endSec.toFixed(1)}s, especially in ${worstSegment.focusArea.toLowerCase()}. Loop that range and compare it side by side.`
        : `Your biggest gap is in ${input.focusArea.toLowerCase()}. Slow it down and compare one phrase at a time.`,
      timestampSec: worstSegment?.startSec,
    },
  ];
}

export function buildAnalysisSummary(input: PoseAnalysisInput): AnalysisSummary {
  const sampleCount = Math.min(input.reference.length, input.practice.length);
  const reference = input.reference.slice(0, sampleCount);
  const practice = input.practice.slice(0, sampleCount);

  const bodyAreaDiffs = reference.map((refSample, index) => {
    const practiceSample = practice[index];

    return Object.keys(BODY_AREA_LABELS).reduce<Record<string, number>>((acc, key) => {
      acc[key] = Math.abs((refSample.bodyAreas[key] ?? 0) - (practiceSample.bodyAreas[key] ?? 0));
      return acc;
    }, {});
  });

  const timingScore = clampScore(
    average(
      reference.map((refSample, index) =>
        normalizeDifference(Math.abs(refSample.motion - practice[index].motion), 0.45),
      ),
    ) * 100,
  );

  const positioningScore = clampScore(
    average(
      bodyAreaDiffs.map((diffs) => normalizeDifference(average(Object.values(diffs)), 0.55)),
    ) * 100,
  );

  const smoothnessScore = clampScore(
    average(
      reference.map((refSample, index) =>
        normalizeDifference(Math.abs(refSample.smoothness - practice[index].smoothness), 0.5),
      ),
    ) * 100,
  );

  const energyScore = clampScore(
    average(
      reference.map((refSample, index) =>
        normalizeDifference(Math.abs(refSample.energy - practice[index].energy), 0.65),
      ),
    ) * 100,
  );

  const scores: AnalysisScores = {
    timing: timingScore,
    positioning: positioningScore,
    smoothness: smoothnessScore,
    energy: energyScore,
    overall: clampScore(
      timingScore * 0.35 + positioningScore * 0.25 + smoothnessScore * 0.2 + energyScore * 0.2,
    ),
  };

  const areaAverages = Object.keys(BODY_AREA_LABELS).reduce<Record<string, number>>((acc, key) => {
    acc[key] = average(bodyAreaDiffs.map((diffs) => diffs[key] ?? 0));
    return acc;
  }, {});

  const sortedAreas = Object.entries(areaAverages).sort((a, b) => a[1] - b[1]);
  const strongestAreaKey = sortedAreas[0]?.[0] ?? 'core';
  const focusAreaKey = sortedAreas[sortedAreas.length - 1]?.[0] ?? 'arms';

  const durationSec = Math.min(input.referenceDurationSec, input.practiceDurationSec);
  const referencePeak = reference.slice().sort((a, b) => b.motion - a.motion)[0];
  const practicePeak = practice.slice().sort((a, b) => b.motion - a.motion)[0];
  const timingOffsetMs = Math.round(((practicePeak?.timeSec ?? 0) - (referencePeak?.timeSec ?? 0)) * 1000);
  const segments = buildSegments(reference, bodyAreaDiffs);

  return {
    scores,
    strongestArea: BODY_AREA_LABELS[strongestAreaKey] ?? 'Core',
    focusArea: BODY_AREA_LABELS[focusAreaKey] ?? 'Arms',
    timingOffsetMs,
    durationSec,
    segments,
    insights: buildInsights({
      scores,
      strongestArea: BODY_AREA_LABELS[strongestAreaKey] ?? 'Core',
      focusArea: BODY_AREA_LABELS[focusAreaKey] ?? 'Arms',
      timingOffsetMs,
      segments,
    }),
    generatedAt: new Date().toISOString(),
  };
}

export function buildFallbackCoachResponse(summary: AnalysisSummary): string[] {
  return summary.insights.map((insight) => `${insight.title}: ${insight.body}`);
}
