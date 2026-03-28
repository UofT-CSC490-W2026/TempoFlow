import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';

describe('Roboflow SAM 3 API Route', () => {
  const mockBase64 = 'data:image/png;base64,mockdata';

  beforeEach(() => {
    vi.clearAllMocks();
    // Setup default environment variables
    process.env.ROBOFLOW_API_KEY = 'test_roboflow_key';
    process.env.SAM3_PROMPT = 'dancer';
    
    // Mock global fetch
    global.fetch = vi.fn();
  });

  afterEach(() => {
    delete process.env.ROBOFLOW_API_KEY;
    delete process.env.SAM3_PROMPT;
  });

  it('returns 400 if ROBOFLOW_API_KEY is missing', async () => {
    delete process.env.ROBOFLOW_API_KEY;

    const request = new Request('http://localhost/api/segment', {
      method: 'POST',
      body: JSON.stringify({ imageBase64: mockBase64 }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain('Missing ROBOFLOW_API_KEY');
  });

  it('returns 400 if imageBase64 is missing in body', async () => {
    const request = new Request('http://localhost/api/segment', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'person' }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Missing imageBase64.');
  });

  it('successfully parses Roboflow polygon data', async () => {
    const mockRoboflowResponse = {
      time: 0.45,
      prompt_results: [
        {
          predictions: [
            {
              masks: [
                [[10, 10], [20, 10], [20, 20]], // Polygon 1
              ],
            },
          ],
        },
      ],
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockRoboflowResponse,
    });

    const request = new Request('http://localhost/api/segment', {
      method: 'POST',
      body: JSON.stringify({ imageBase64: mockBase64, prompt: 'dance' }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.provider).toBe('roboflow');
    expect(data.polygons).toHaveLength(1);
    expect(data.polygons[0]).toEqual([[10, 10], [20, 10], [20, 20]]);
    expect(data.time).toBe(0.45);
  });

  it('handles Roboflow API errors gracefully', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized API Key',
    });

    const request = new Request('http://localhost/api/segment', {
      method: 'POST',
      body: JSON.stringify({ imageBase64: mockBase64 }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized API Key');
  });

  it('uses default SAM3_PROMPT from env if body prompt is missing', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prompt_results: [] }),
    });

    const request = new Request('http://localhost/api/segment', {
      method: 'POST',
      body: JSON.stringify({ imageBase64: mockBase64 }),
    });

    await POST(request);

    // Verify the fetch call used the env-defined prompt 'dancer'
    const lastFetchCall = (global.fetch as any).mock.calls[0];
    const requestBody = JSON.parse(lastFetchCall[1].body);
    expect(requestBody.prompts[0].text).toBe('dancer');
  });

  it('returns 500 if the fetch request crashes', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('Network Failure'));

    const request = new Request('http://localhost/api/segment', {
      method: 'POST',
      body: JSON.stringify({ imageBase64: mockBase64 }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Failed to run Roboflow SAM 3 segmentation.');
  });
});