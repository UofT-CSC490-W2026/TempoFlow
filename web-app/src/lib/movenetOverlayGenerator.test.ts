import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateMoveNetOverlayFrames } from './movenetOverlayGenerator';

// --- Configuration & Mocks ---

let mockDuration = 2.0;

// Shared spy objects so that every created element points to the same tracked functions
const sharedCtx = {
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  fill: vi.fn(),
  closePath: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  canvas: { width: 640, height: 480 },
  // Mock properties used by withAlpha and drawPoseFill
  shadowColor: '',
  shadowBlur: 0,
  lineWidth: 0,
  lineCap: '',
  strokeStyle: '',
  fillStyle: '',
};

const sharedVideo = {
  get duration() { return mockDuration; },
  videoWidth: 640,
  videoHeight: 480,
  currentTime: 0,
  src: '',
  muted: false,
  playsInline: false,
  preload: '',
  addEventListener: vi.fn((event, cb) => {
    // Simulate immediate async event firing
    if (event === 'loadeddata' || event === 'seeked') {
      setTimeout(cb, 0);
    }
  }),
  removeEventListener: vi.fn(),
};

// Mock TFJS and Pose Detection
vi.mock('@tensorflow/tfjs-core', () => ({
  setBackend: vi.fn(),
  ready: vi.fn(() => Promise.resolve()),
}));

vi.mock('@tensorflow-models/pose-detection', () => ({
  createDetector: vi.fn(() => Promise.resolve({
    estimatePoses: vi.fn(() => Promise.resolve([{
      keypoints: [
        { x: 100, y: 100, score: 0.9, name: 'left_shoulder' },
        { x: 200, y: 100, score: 0.9, name: 'right_shoulder' },
        { x: 100, y: 300, score: 0.9, name: 'left_hip' },
        { x: 200, y: 300, score: 0.9, name: 'right_hip' },
        { x: 50, y: 150, score: 0.9, name: 'left_elbow' },
        { x: 250, y: 150, score: 0.9, name: 'right_elbow' },
        { x: 50, y: 200, score: 0.9, name: 'left_wrist' },
        { x: 250, y: 200, score: 0.9, name: 'right_wrist' },
        { x: 100, y: 400, score: 0.9, name: 'left_knee' },
        { x: 200, y: 400, score: 0.9, name: 'right_knee' },
        { x: 100, y: 500, score: 0.9, name: 'left_ankle' },
        { x: 200, y: 500, score: 0.9, name: 'right_ankle' },
      ]
    }]))
  })),
  SupportedModels: { MoveNet: 'movenet' },
  movenet: { modelType: { SINGLEPOSE_LIGHTNING: 'lightning' } }
}));

// Global DOM Mocking
vi.stubGlobal('document', {
  createElement: vi.fn((tagName: string) => {
    if (tagName === 'canvas') {
      return {
        getContext: () => sharedCtx,
        toDataURL: vi.fn(() => 'data:image/webp;base64,mock'),
        width: 640,
        height: 480,
      };
    }
    if (tagName === 'video') {
      return sharedVideo;
    }
    return {};
  }),
});

// --- Test Suite ---

describe('generateMoveNetOverlayFrames', () => {
  const params = {
    videoUrl: 'test-dance.mp4',
    color: '#2563eb',
    fps: 10,
    startSec: 0,
    endSec: 1, // 1 second @ 10fps = 10 frames
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDuration = 2.0; // Reset duration for each test
  });

  it('generates the correct number of frames based on duration and FPS', async () => {
    const result = await generateMoveNetOverlayFrames(params);

    expect(result.frames.length).toBe(10);
    expect(result.fps).toBe(10);
    expect(result.width).toBe(640);
  });

  it('calls onProgress for every frame generated', async () => {
    const onProgress = vi.fn();
    await generateMoveNetOverlayFrames({ ...params, onProgress });

    expect(onProgress).toHaveBeenCalledTimes(10);
    expect(onProgress).toHaveBeenLastCalledWith(10, 10);
  });

  it('clears the canvas and draws the pose for each frame', async () => {
    await generateMoveNetOverlayFrames(params);

    // Now we check the sharedCtx which was used inside the generator
    expect(sharedCtx.clearRect).toHaveBeenCalledTimes(10);
    expect(sharedCtx.save).toHaveBeenCalled();
    expect(sharedCtx.beginPath).toHaveBeenCalled();
    // drawLimb calls lineTo multiple times per frame
    expect(sharedCtx.lineTo).toHaveBeenCalled();
  });

  it('handles custom time segments correctly', async () => {
    const shortParams = {
      ...params,
      startSec: 0.5,
      endSec: 0.7, // 0.2s @ 10fps = 2 frames
    };
    const result = await generateMoveNetOverlayFrames(shortParams);
    expect(result.frames.length).toBe(2);
  });

  it('throws an error if video duration is invalid', async () => {
    // We update the variable that the sharedVideo.duration getter uses
    mockDuration = 0;

    await expect(generateMoveNetOverlayFrames(params))
      .rejects.toThrow('Video duration is unavailable for MoveNet overlay generation.');
  });

  it('throws an error if segment duration is 0 or negative', async () => {
    const invalidParams = {
      ...params,
      startSec: 1.0,
      endSec: 0.5,
    };

    await expect(generateMoveNetOverlayFrames(invalidParams))
      .rejects.toThrow('MoveNet overlay segment duration must be greater than 0.');
  });
});