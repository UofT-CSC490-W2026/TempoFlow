import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as poseDetection from '@tensorflow-models/pose-detection';
import { analyzeVideoPoses } from './poseAnalysis';

// 1. Mock TensorFlow and Pose Detection
vi.mock('@tensorflow/tfjs-core', () => ({
  setBackend: vi.fn().mockResolvedValue(true),
  ready: vi.fn().mockResolvedValue(true),
}));

vi.mock('@tensorflow-models/pose-detection', () => ({
  SupportedModels: { MoveNet: 'MoveNet' },
  movenet: { modelType: { SINGLEPOSE_LIGHTNING: 'lightning' } },
  createDetector: vi.fn().mockResolvedValue({
    estimatePoses: vi.fn().mockResolvedValue([{
      keypoints: Array(17).fill(null).map((_, i) => ({
        x: 100 + i,
        y: 200 + i,
        score: 0.9,
        name: `kp_${i}`
      }))
    }]),
    dispose: vi.fn(),
  }),
}));

describe('analyzeVideoPoses', () => {
  let mockVideo: HTMLVideoElement;

  beforeEach(() => {
    vi.clearAllMocks();

    // 2. Mock HTMLVideoElement
    // We create a mock object that mimics the properties and event behavior
    mockVideo = {
      duration: 10,
      currentTime: 0,
      src: '',
      load: vi.fn(),
      removeAttribute: vi.fn(),
      addEventListener: vi.fn((event, cb) => {
        if (event === 'seeked') {
          // Simulate the async seek completing
          setTimeout(cb, 0);
        }
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as any;

    // Stub document.createElement to return our mock video
    vi.stubGlobal('document', {
      createElement: vi.fn((tag) => {
        if (tag === 'video') {
          // Trigger the 'onloadedmetadata' immediately after creation simulation
          setTimeout(() => (mockVideo as any).onloadedmetadata(), 0);
          return mockVideo;
        }
        return {};
      }),
    });
  });

  it('calculates the correct number of samples based on duration', async () => {
    // For 10 seconds: Math.max(12, Math.min(28, Math.round(10 * 2.5))) = 25
    const result = await analyzeVideoPoses('test-url.mp4');

    expect(result.samples.length).toBe(25);
    expect(result.durationSec).toBe(10);
  });

  it('calls onProgress with incremental values', async () => {
    const onProgress = vi.fn();
    await analyzeVideoPoses('test-url.mp4', onProgress);

    // Should be called 25 times
    expect(onProgress).toHaveBeenCalledTimes(25);
    // Last call should be 1.0 (100%)
    expect(onProgress).toHaveBeenLastCalledWith(1, expect.stringContaining('25/25'));
  });

  it('normalizes keypoints relative to torso scale', async () => {
    const result = await analyzeVideoPoses('test-url.mp4');
    const firstSample = result.samples[0];

    // Check that quality is within 0-1 range
    expect(firstSample.quality).toBeGreaterThan(0);
    expect(firstSample.quality).toBeLessThanOrEqual(1);

    // Check body areas are calculated
    expect(firstSample.bodyAreas).toHaveProperty('upperBody');
    expect(firstSample.bodyAreas).toHaveProperty('legs');
  });

  it('disposes the detector and cleans up video src on completion', async () => {
    const detector = await poseDetection.createDetector(null as any, null as any);
    vi.mocked(poseDetection.createDetector).mockResolvedValueOnce(detector);

    await analyzeVideoPoses('test-url.mp4');

    expect(detector.dispose).toHaveBeenCalled();
    expect(mockVideo.removeAttribute).toHaveBeenCalledWith('src');
    expect(mockVideo.load).toHaveBeenCalled();
  });

  it('handles videos where no poses are detected in some frames', async () => {
    const detector = await poseDetection.createDetector(null as any, null as any);
    // Mock first frame success, second frame empty
    vi.mocked(detector.estimatePoses)
      .mockResolvedValueOnce([{ keypoints: Array(17).fill({ x: 0, y: 0, score: 0.9 }) }])
      .mockResolvedValueOnce([]); // Empty detection

    vi.mocked(poseDetection.createDetector).mockResolvedValueOnce(detector);

    const result = await analyzeVideoPoses('test-url.mp4');

    // Samples should be less than the iteration count because we 'continue' on empty keypoints
    expect(result.samples.length).toBeLessThan(25);
  });
});