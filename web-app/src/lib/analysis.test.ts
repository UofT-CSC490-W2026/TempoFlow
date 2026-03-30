import { buildAnalysisSummary, buildFallbackCoachResponse, type PoseSample } from './analysis';

const TEST_NOW = new Date('2026-03-25T12:00:00.000Z');

function makeSample(overrides: Partial<PoseSample> = {}): PoseSample {
  return {
    timeSec: 0,
    quality: 0.95,
    motion: 0.2,
    energy: 0.3,
    smoothness: 0.1,
    bodyAreas: {
      upperBody: 0.1,
      arms: 0.1,
      core: 0.1,
      legs: 0.1,
      ...overrides.bodyAreas,
    },
    ...overrides,
  };
}

describe('buildAnalysisSummary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /*
   * These cases are the edge-case map for the assignment write-up:
   * 1. perfect-match happy path
   * 2. mismatched sample counts
   * 3. uneven segment splitting
   * 4. near-perfect timing messaging
   * 5. late timing drift messaging
   * 6. early timing drift messaging
   * 7. score clamping under extreme differences
   * 8. strongest-area and focus-area selection
   * 9. worst-segment timestamps feeding the coaching insights
   * 10. empty-input fallback handling
   * 11. fallback coach response formatting
   */

  it('returns perfect scores when reference and practice samples match', () => {
    const reference = [
      makeSample({ timeSec: 0, motion: 0.2 }),
      makeSample({ timeSec: 1, motion: 0.9 }),
      makeSample({ timeSec: 2, motion: 0.4 }),
    ];
    const practice = reference.map((sample) => ({
      ...sample,
      bodyAreas: { ...sample.bodyAreas },
    }));

    const summary = buildAnalysisSummary({
      reference,
      practice,
      referenceDurationSec: 12,
      practiceDurationSec: 10,
    });

    expect(summary.scores).toEqual({
      overall: 100,
      timing: 100,
      positioning: 100,
      smoothness: 100,
      energy: 100,
    });
    expect(summary.durationSec).toBe(10);
    expect(summary.timingOffsetMs).toBe(0);
    expect(summary.generatedAt).toBe(TEST_NOW.toISOString());
    expect(summary.insights).toHaveLength(3);
  });

  it('uses only the shared sample count when the practice run is shorter', () => {
    const reference = [
      makeSample({ timeSec: 0, motion: 0.1 }),
      makeSample({ timeSec: 1, motion: 0.7 }),
      makeSample({ timeSec: 2, motion: 0.3 }),
    ];
    const practice = [
      makeSample({ timeSec: 0, motion: 0.1 }),
      makeSample({ timeSec: 1, motion: 0.72 }),
    ];

    const summary = buildAnalysisSummary({
      reference,
      practice,
      referenceDurationSec: 8,
      practiceDurationSec: 6,
    });

    expect(summary.durationSec).toBe(6);
    expect(summary.segments).toHaveLength(2);
    expect(summary.segments[1]?.endSec).toBe(1);
  });

  it('splits samples into at most three segments and keeps the trailing remainder together', () => {
    const reference = [
      makeSample({ timeSec: 0 }),
      makeSample({ timeSec: 1 }),
      makeSample({ timeSec: 2 }),
      makeSample({ timeSec: 3 }),
      makeSample({ timeSec: 4 }),
    ];
    const practice = reference.map((sample, index) =>
      makeSample({
        ...sample,
        bodyAreas: {
          upperBody: index * 0.02,
          arms: index * 0.04,
          core: index * 0.01,
          legs: index * 0.03,
        },
      }),
    );

    const summary = buildAnalysisSummary({
      reference,
      practice,
      referenceDurationSec: 5,
      practiceDurationSec: 5,
    });

    expect(summary.segments.map((segment) => segment.id)).toEqual([
      'segment-1',
      'segment-2',
      'segment-3',
    ]);
    expect(summary.segments[2]).toMatchObject({
      startSec: 2,
      endSec: 4,
      label: 'Segment 3',
    });
  });

  it('uses the close-timing coaching message when the offset is under 60ms', () => {
    const reference = [
      makeSample({ timeSec: 0, motion: 0.2 }),
      makeSample({ timeSec: 1, motion: 0.95 }),
    ];
    const practice = [
      makeSample({ timeSec: 0, motion: 0.1 }),
      makeSample({ timeSec: 1.04, motion: 0.96 }),
    ];

    const summary = buildAnalysisSummary({
      reference,
      practice,
      referenceDurationSec: 2,
      practiceDurationSec: 2,
    });

    expect(summary.timingOffsetMs).toBe(40);
    expect(summary.insights.find((insight) => insight.id === 'timing')?.body).toContain(
      'Your timing is already close to the reference.',
    );
  });

  it('describes a late practice peak when the timing offset is positive', () => {
    const reference = [
      makeSample({ timeSec: 0, motion: 0.2 }),
      makeSample({ timeSec: 1, motion: 0.95 }),
    ];
    const practice = [
      makeSample({ timeSec: 0, motion: 0.1 }),
      makeSample({ timeSec: 1.25, motion: 0.96 }),
    ];

    const summary = buildAnalysisSummary({
      reference,
      practice,
      referenceDurationSec: 2,
      practiceDurationSec: 2,
    });

    expect(summary.timingOffsetMs).toBe(250);
    expect(summary.insights.find((insight) => insight.id === 'timing')?.body).toContain(
      '250ms late',
    );
  });

  it('describes an early practice peak when the timing offset is negative', () => {
    const reference = [
      makeSample({ timeSec: 0, motion: 0.2 }),
      makeSample({ timeSec: 1, motion: 0.95 }),
    ];
    const practice = [
      makeSample({ timeSec: 0, motion: 0.96 }),
      makeSample({ timeSec: 1, motion: 0.1 }),
    ];

    const summary = buildAnalysisSummary({
      reference,
      practice,
      referenceDurationSec: 2,
      practiceDurationSec: 2,
    });

    expect(summary.timingOffsetMs).toBe(-1000);
    expect(summary.insights.find((insight) => insight.id === 'timing')?.body).toContain(
      '1000ms early',
    );
  });

  it('clamps severely mismatched runs down to zero scores', () => {
    const reference = [
      makeSample({
        motion: 0,
        energy: 0,
        smoothness: 0,
        bodyAreas: { upperBody: 0, arms: 0, core: 0, legs: 0 },
      }),
    ];
    const practice = [
      makeSample({
        motion: 10,
        energy: 10,
        smoothness: 10,
        bodyAreas: { upperBody: 10, arms: 10, core: 10, legs: 10 },
      }),
    ];

    const summary = buildAnalysisSummary({
      reference,
      practice,
      referenceDurationSec: 1,
      practiceDurationSec: 1,
    });

    expect(summary.scores).toEqual({
      overall: 0,
      timing: 0,
      positioning: 0,
      smoothness: 0,
      energy: 0,
    });
    expect(summary.segments[0]?.score).toBe(0);
  });

  it('chooses the strongest and focus areas from averaged body-area differences', () => {
    const reference = [
      makeSample({ bodyAreas: { upperBody: 0, arms: 0, core: 0, legs: 0 } }),
      makeSample({ bodyAreas: { upperBody: 0, arms: 0, core: 0, legs: 0 } }),
    ];
    const practice = [
      makeSample({ bodyAreas: { upperBody: 0.2, arms: 0.5, core: 0.05, legs: 0.3 } }),
      makeSample({ bodyAreas: { upperBody: 0.25, arms: 0.45, core: 0.04, legs: 0.35 } }),
    ];

    const summary = buildAnalysisSummary({
      reference,
      practice,
      referenceDurationSec: 2,
      practiceDurationSec: 2,
    });

    expect(summary.strongestArea).toBe('Core');
    expect(summary.focusArea).toBe('Arms');
  });

  it('anchors timing and segment coaching to the worst-scoring segment', () => {
    const reference = [
      makeSample({ timeSec: 0, bodyAreas: { upperBody: 0, arms: 0, core: 0, legs: 0 } }),
      makeSample({ timeSec: 5, bodyAreas: { upperBody: 0, arms: 0, core: 0, legs: 0 } }),
      makeSample({ timeSec: 10, bodyAreas: { upperBody: 0, arms: 0, core: 0, legs: 0 } }),
    ];
    const practice = [
      makeSample({ timeSec: 0, bodyAreas: { upperBody: 0.02, arms: 0.02, core: 0.02, legs: 0.02 } }),
      makeSample({ timeSec: 5, bodyAreas: { upperBody: 0.6, arms: 0.9, core: 0.6, legs: 0.6 } }),
      makeSample({ timeSec: 10, bodyAreas: { upperBody: 0.01, arms: 0.01, core: 0.01, legs: 0.01 } }),
    ];

    const summary = buildAnalysisSummary({
      reference,
      practice,
      referenceDurationSec: 10,
      practiceDurationSec: 10,
    });

    const timingInsight = summary.insights.find((insight) => insight.id === 'timing');
    const segmentInsight = summary.insights.find((insight) => insight.id === 'segment');

    expect(timingInsight?.timestampSec).toBe(5);
    expect(segmentInsight?.timestampSec).toBe(5);
    expect(segmentInsight?.title).toBe('Review segment 2');
  });

  it('falls back safely when no pose samples are available', () => {
    const summary = buildAnalysisSummary({
      reference: [],
      practice: [],
      referenceDurationSec: 0,
      practiceDurationSec: 0,
    });

    expect(summary.scores).toEqual({
      overall: 0,
      timing: 0,
      positioning: 0,
      smoothness: 0,
      energy: 0,
    });
    expect(summary.segments).toEqual([]);
    expect(summary.insights.find((insight) => insight.id === 'segment')?.title).toBe(
      'Replay your hardest section',
    );
  });

  it('formats the fallback coach response from the generated insights', () => {
    const summary = buildAnalysisSummary({
      reference: [makeSample({ timeSec: 0 }), makeSample({ timeSec: 1, motion: 0.8 })],
      practice: [makeSample({ timeSec: 0 }), makeSample({ timeSec: 1.1, motion: 0.9 })],
      referenceDurationSec: 2,
      practiceDurationSec: 2,
    });

    expect(buildFallbackCoachResponse(summary)).toEqual(
      summary.insights.map((insight) => `${insight.title}: ${insight.body}`),
    );
  });
});
