import { NextResponse } from 'next/server';

import { buildFallbackCoachResponse } from '../../../lib/analysis';
import type { AnalysisSummary } from '../../../lib/sessionStorage';

interface CoachRequestBody {
  sessionId?: string;
  summary?: AnalysisSummary;
}

function buildPrompt(summary: AnalysisSummary) {
  return [
    'You are helping generate short dance coaching feedback.',
    'Write exactly 3 concise coaching paragraphs for a dancer.',
    'Each paragraph should be one or two sentences max.',
    'Prioritize timing first, then movement precision.',
    'Be specific, encouraging, and easy to act on.',
    `Overall score: ${summary.scores.overall}`,
    `Timing: ${summary.scores.timing}`,
    `Positioning: ${summary.scores.positioning}`,
    `Smoothness: ${summary.scores.smoothness}`,
    `Energy: ${summary.scores.energy}`,
    `Strongest area: ${summary.strongestArea}`,
    `Focus area: ${summary.focusArea}`,
    `Timing offset ms: ${summary.timingOffsetMs}`,
    `Segments: ${summary.segments
      .map((segment) => `${segment.label} ${segment.startSec.toFixed(1)}-${segment.endSec.toFixed(1)} focus=${segment.focusArea} score=${segment.score}`)
      .join('; ')}`,
    'Return strict JSON with this shape: {"insights":["...", "...", "..."]}',
  ].join('\n');
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CoachRequestBody;
    const summary = body.summary;

    if (!summary) {
      return NextResponse.json({ error: 'Missing summary payload.' }, { status: 400 });
    }

    const fallbackInsights = buildFallbackCoachResponse(summary);
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

    if (!apiKey) {
      return NextResponse.json({ insights: fallbackInsights, source: 'local-fallback' });
    }

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: buildPrompt(summary),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Coach API request failed:', errorText);
      return NextResponse.json({ insights: fallbackInsights, source: 'local-fallback' });
    }

    const data = await response.json();
    const rawOutput = data.output_text;

    if (typeof rawOutput !== 'string') {
      return NextResponse.json({ insights: fallbackInsights, source: 'local-fallback' });
    }

    let insights = fallbackInsights;

    try {
      const parsed = JSON.parse(rawOutput) as { insights?: string[] };
      if (Array.isArray(parsed.insights) && parsed.insights.length > 0) {
        insights = parsed.insights.slice(0, 3);
      }
    } catch {
      insights = fallbackInsights;
    }

    return NextResponse.json({ insights, source: 'openai' });
  } catch (error) {
    console.error('Coach API route failed:', error);
    return NextResponse.json({ error: 'Failed to generate coaching summary.' }, { status: 500 });
  }
}
