import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateYoloOverlayFrames } from './yoloOverlayGenerator';

// --- Configuration & Mocks ---

let mockDuration = 2.0;
let rvfcSupported = true;

// Shared spy objects for tracking internal factory calls
const sharedCtx = {
  clearRect: vi.fn(),
  drawImage: vi.fn(),
  getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(640 * 640 * 4) })),
  fillRect: vi.fn(),
  putImageData: vi.fn(),
  createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(160 * 160 * 4) })),
  save: vi.fn(),
  restore: vi.fn(),
  clip: vi.fn(),
  rect: vi.fn(),
  beginPath: vi.fn(),
  canvas: { width: 640, height: 480 },
  imageSmoothingEnabled: true,
  imageSmoothingQuality: "high",
};

const sharedVideo = {
  get duration() { return mockDuration; },
  videoWidth: 640,
  videoHeight: 480,
  currentTime: 0,
  play: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn(),
  addEventListener: vi.fn((event, cb) => {
    if (event === 'loadeddata' || event === 'seeked') setTimeout(cb, 0);
  }),
  removeEventListener: vi.fn(),
  requestVideoFrameCallback: vi.fn(function(this: any, cb) {
    if (!rvfcSupported) return 0;
    
    // Increment time slightly each call so the generator thinks video is moving
    sharedVideo.currentTime += 0.1; 
    
    // Trigger the callback with a mock metadata object
    setTimeout(() => {
      cb(Date.now(), { mediaTime: sharedVideo.currentTime });
    }, 0);
    return 1;
  }),
};

// Mock ONNX Runtime (ort)
vi.mock('onnxruntime-web', () => {
  // Define a constructible function for the Tensor
  const MockTensor = vi.fn(function (this: any, type: string, data: any, dims: number[]) {
    this.type = type;
    this.data = data;
    this.dims = dims;
    return this;
  });

  return {
    InferenceSession: {
      create: vi.fn().mockResolvedValue({
        inputNames: ['images'],
        run: vi.fn().mockResolvedValue({
          output0: { 
            data: new Float32Array(8400 * 116).fill(0), 
            dims: [1, 116, 8400] 
          },
          output1: { 
            data: new Float32Array(32 * 160 * 160).fill(0), 
            dims: [1, 32, 160, 160] 
          }
        }),
      }),
    },
    // This allows 'new ort.Tensor(...)' to work
    Tensor: MockTensor,
    env: { wasm: { wasmPaths: '', numThreads: 1 } }
  };
});

// Global DOM Mocking
vi.stubGlobal('document', {
  createElement: vi.fn((tagName: string) => {
    if (tagName === 'canvas') {
      return {
        getContext: () => sharedCtx,
        width: 640,
        height: 480,
        toBlob: vi.fn((cb) => cb(new Blob(['frame'], { type: 'image/webp' }))),
      };
    }
    if (tagName === 'video') {
      const v = { ...sharedVideo };
      if (!rvfcSupported) delete (v as any).requestVideoFrameCallback;
      return v;
    }
    return {};
  }),
});

// Mock URL and Blob for Node environment
vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:mock') });

// --- Test Suite ---

describe('generateYoloOverlayFrames', () => {
  const params = {
    videoUrl: 'dance_session_001.mp4',
    color: '#3b82f6',
    fps: 10,
    inferFps: 10,
    startSec: 0,
    endSec: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDuration = 2.0;
    rvfcSupported = true;
    // Set a timeout limit for the "while (!cancelled)" loops
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initializes the InferenceSession with the requested provider', async () => {
    const { InferenceSession } = await import('onnxruntime-web');
    
    // We don't await the whole generator here because the loop would block 
    // unless we advance timers, but we can check the initialization
    generateYoloOverlayFrames({ ...params, provider: 'webgpu' });
    
    await vi.waitFor(() => {
        expect(InferenceSession.create).toHaveBeenCalledWith(
          expect.stringContaining('yolo26n-seg.onnx'),
          expect.objectContaining({ executionProviders: ['webgpu', 'wasm'] })
        );
    });
  });

  it('calculates total frames correctly for the requested segment', async () => {
    // Manually trigger the "done" state for the loop
    const generatorPromise = generateYoloOverlayFrames(params);
    
    // Fast-forward through the "while (!cancelled)" polling
    await vi.advanceTimersByTimeAsync(1000);
    
    // Result length should match segmentDurationSec * fps (1 * 10)
    const result = await generatorPromise;
    expect(result.length).toBe(10);
  });


  it('executes NMS and drawing logic for each inferred frame', async () => {
    // Total 10 frames, infer every frame
    const generatorPromise = generateYoloOverlayFrames(params);
    await vi.advanceTimersByTimeAsync(1000);
    await generatorPromise;

    // sharedCtx.drawImage is called twice per inference: 
    // 1. preprocessFrame (offscreen) 
    // 2. drawMasks (output)
    expect(sharedCtx.drawImage).toHaveBeenCalled();
    expect(sharedCtx.clearRect).toHaveBeenCalled();
  });

});