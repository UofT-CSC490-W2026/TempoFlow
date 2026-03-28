import React from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import RoboflowVideoOverlay from './RoboflowVideoOverlay';

const setBackendMock = vi.fn(async () => {});
const readyMock = vi.fn(async () => {});
const createDetectorMock = vi.fn(async () => ({
  estimatePoses: vi.fn(async () => []),
}));

vi.mock("@tensorflow/tfjs-core", () => ({
  setBackend: setBackendMock,
  ready: readyMock,
}));

vi.mock("@tensorflow/tfjs-backend-webgl", () => ({}));

vi.mock("@tensorflow-models/pose-detection", () => ({
  SupportedModels: { MoveNet: "MoveNet" },
  movenet: { modelType: { SINGLEPOSE_LIGHTNING: "singlepose" } },
  createDetector: createDetectorMock,
}));

describe('RoboflowVideoOverlay', () => {
  const mockFrames = [
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  ];

  const createMockVideo = (currentTime = 0, duration = 10) => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: currentTime, writable: true });
    Object.defineProperty(video, 'duration', { value: duration, writable: true });
    Object.defineProperty(video, 'videoWidth', { value: 1280, writable: true });
    Object.defineProperty(video, 'videoHeight', { value: 720, writable: true });
    return video;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Use a non-recursive mock for rAF that runs on the next tick
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      setTimeout(() => cb(Date.now()), 0);
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders a canvas element overlaying the video area', async () => {
    const videoRef = { current: createMockVideo() };
    const { container } = render(
      <RoboflowVideoOverlay frames={mockFrames} videoRef={videoRef} />
    );

    // Using waitFor because the canvas might need one tick to appear
    await waitFor(() => {
      expect(container.querySelector('canvas')).not.toBeNull();
    });
  });

  it('syncs canvas dimensions with video videoWidth/Height', async () => {
    const video = createMockVideo(2, 10);
    const videoRef = { current: video };
    
    const { container } = render(
      <RoboflowVideoOverlay frames={mockFrames} videoRef={videoRef} />
    );

    // Wait for the loop to run once and update the canvas dimensions from 300 to 1280
    await waitFor(() => {
      const canvas = container.querySelector('canvas') as HTMLCanvasElement;
      expect(canvas?.width).toBe(1280);
      expect(canvas?.height).toBe(720);
    });
  });

  it('handles empty frames array by returning null (no canvas)', () => {
    const videoRef = { current: createMockVideo() };
    const { container } = render(
      <RoboflowVideoOverlay frames={[]} videoRef={videoRef} />
    );
    
    const canvas = container.querySelector('canvas');
    // Per component logic: if (!frames.length) return null;
    expect(canvas).toBeNull();
  });

  it('attempts to set image src based on video time', async () => {
    const video = createMockVideo(5, 10); // Middle of video (Index 1)
    const videoRef = { current: video };
    
    const imgSpy = vi.spyOn(window.Image.prototype, 'src', 'set');

    render(<RoboflowVideoOverlay frames={mockFrames} videoRef={videoRef} />);

    await waitFor(() => {
      expect(imgSpy).toHaveBeenCalledWith(mockFrames[1]);
    });
  });
});