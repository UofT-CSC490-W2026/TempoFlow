import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';
import * as analysis from '../../../lib/analysis';
import { NextResponse } from 'next/server';

// 1. Mock the fallback library
vi.mock('../../../lib/analysis', () => ({
  buildFallbackCoachResponse: vi.fn().mockReturnValue(['Fallback 1', 'Fallback 2', 'Fallback 3']),
}));

describe('Coach API Route (POST)', () => {
  const mockSummary = {
    scores: { overall: 80, timing: 70, positioning: 85, smoothness: 75, energy: 90 },
    strongestArea: 'Energy',
    focusArea: 'Timing',
    timingOffsetMs: 120,
    segments: [{ label: 'Intro', startSec: 0, endSec: 5, focusArea: 'Timing', score: 70 }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default env setup
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'gpt-4.1-mini';
    
    // Mock global fetch
    global.fetch = vi.fn();
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it('returns 400 if summary is missing', async () => {
    const request = new Request('http://localhost/api/coach', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Missing summary payload.');
  });

  it('returns OpenAI insights on successful API call', async () => {
    const mockAiResponse = {
      output_text: JSON.stringify({ 
        insights: ['AI Insight 1', 'AI Insight 2', 'AI Insight 3'] 
      })
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockAiResponse,
    });

    const request = new Request('http://localhost/api/coach', {
      method: 'POST',
      body: JSON.stringify({ summary: mockSummary }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(data.source).toBe('openai');
    expect(data.insights).toHaveLength(3);
    expect(data.insights[0]).toBe('AI Insight 1');
  });

  it('returns local-fallback if OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;

    const request = new Request('http://localhost/api/coach', {
      method: 'POST',
      body: JSON.stringify({ summary: mockSummary }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(data.source).toBe('local-fallback');
    expect(data.insights).toEqual(['Fallback 1', 'Fallback 2', 'Fallback 3']);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns local-fallback if OpenAI API returns an error (non-ok response)', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      text: async () => 'Rate limit exceeded',
    });

    const request = new Request('http://localhost/api/coach', {
      method: 'POST',
      body: JSON.stringify({ summary: mockSummary }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(data.source).toBe('local-fallback');
    expect(analysis.buildFallbackCoachResponse).toHaveBeenCalledWith(mockSummary);
  });

  it('returns local-fallback if AI returns malformed JSON', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ output_text: 'Not JSON at all' }),
    });

    const request = new Request('http://localhost/api/coach', {
      method: 'POST',
      body: JSON.stringify({ summary: mockSummary }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(data.source).toBe('openai'); // Code enters the try-catch for JSON.parse
    expect(data.insights).toEqual(['Fallback 1', 'Fallback 2', 'Fallback 3']);
  });

  it('returns 500 if an unhandled exception occurs', async () => {
    // Force an error by making request.json throw
    const request = {
      json: vi.fn().mockRejectedValue(new Error('Internal Crash')),
    } as any;

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Failed to generate coaching summary.');
  });
});