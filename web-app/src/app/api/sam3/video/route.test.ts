import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';

describe('SAM 3 Video API Route (Modal)', () => {
  // Mock file for testing
  const createMockFile = (sizeInMb: number) => {
    const bytes = new Uint8Array(sizeInMb * 1024 * 1024);
    return new File([bytes], 'test-video.mp4', { type: 'video/mp4' });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default environment setup for "Modal" backend
    process.env.SAM3_BACKEND = 'modal';
    process.env.SAM3_MODAL_URL = 'https://api.modal.com/user/service';
    process.env.SAM3_MAX_VIDEO_MB = '10';
    
    global.fetch = vi.fn();
  });

  afterEach(() => {
    delete process.env.SAM3_BACKEND;
    delete process.env.SAM3_MODAL_URL;
    delete process.env.SAM3_MAX_VIDEO_MB;
  });

  it('returns 400 if backend is not set to modal', async () => {
    process.env.SAM3_BACKEND = 'roboflow';

    const request = new Request('http://localhost/api/sam3/video', {
      method: 'POST',
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain('configured for Roboflow');
  });

  it('returns 400 if video file is missing', async () => {
    const formData = new FormData();
    formData.append('kind', 'practice');

    const request = new Request('http://localhost/api/sam3/video', {
      method: 'POST',
      body: formData,
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Missing video file.');
  });

  it('returns 400 if video exceeds MAX_VIDEO_MB', async () => {
    const largeFile = createMockFile(15); // 15MB > 10MB limit
    const formData = new FormData();
    formData.append('video', largeFile);

    const request = new Request('http://localhost/api/sam3/video', {
      method: 'POST',
      body: formData,
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain('Keep it under 10 MB');
  });

  it('successfully streams back video bytes from Modal service', async () => {
    const mockVideoBuffer = new Uint8Array([1, 2, 3]).buffer;
    
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => mockVideoBuffer,
      headers: new Headers({ 'content-type': 'video/mp4', 'x-sam3-provider': 'modal' }),
    });

    const formData = new FormData();
    formData.append('video', createMockFile(2));
    formData.append('kind', 'reference');

    const request = new Request('http://localhost/api/sam3/video', {
      method: 'POST',
      body: formData,
    });

    const response = await POST(request);
    const output = await response.arrayBuffer();

    expect(response.status).toBe(200);
    expect(output.byteLength).toBe(3);
    expect(response.headers.get('X-SAM3-Provider')).toBe('modal');
  });

  it('returns 502 if Modal service returns empty buffer', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: new Headers(),
    });

    const formData = new FormData();
    formData.append('video', createMockFile(1));

    const request = new Request('http://localhost/api/sam3/video', {
      method: 'POST',
      body: formData,
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(502);
    expect(data.error).toBe('Modal SAM 3 returned an empty video response.');
  });

  it('handles authorization header when SAM3_MODAL_TOKEN is provided', async () => {
    process.env.SAM3_MODAL_TOKEN = 'secret-token';
    
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(5),
      headers: new Headers(),
    });

    const formData = new FormData();
    formData.append('video', createMockFile(1));

    const request = new Request('http://localhost/api/sam3/video', {
      method: 'POST',
      body: formData,
    });

    await POST(request);

    const fetchArgs = (global.fetch as any).mock.calls[0][1];
    expect(fetchArgs.headers.Authorization).toBe('Bearer secret-token');
  });
});