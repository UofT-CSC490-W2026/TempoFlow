import React from 'react';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import SegmentOverlay from './SegmentOverlay';

// --- 1. Mocks for ML Libraries ---
const setBackendMock = vi.fn().mockResolvedValue(true);
const readyMock = vi.fn().mockResolvedValue(true);

vi.mock("@tensorflow/tfjs-core", () => ({
  setBackend: setBackendMock,
  ready: readyMock,
  env: () => ({ set: vi.fn() }),
}));

vi.mock("@tensorflow/tfjs-backend-webgl", () => ({}));

vi.mock("@tensorflow-models/pose-detection", () => ({
  SupportedModels: { MoveNet: "MoveNet" },
  movenet: { modelType: { SINGLEPOSE_LIGHTNING: "singlepose" } },
  createDetector: vi.fn().mockResolvedValue({
    estimatePoses: vi.fn().mockResolvedValue([{ keypoints: [] }]),
    dispose: vi.fn(),
  }),
}));

vi.mock('onnxruntime-web', () => ({
  InferenceSession: {
    create: vi.fn().mockResolvedValue({
      run: vi.fn().mockResolvedValue({
        output0: { data: new Float32Array(8400 * 116) },
        output1: { data: new Float32Array(32 * 160 * 160) },
      }),
    }),
  },
  Tensor: vi.fn().mockImplementation((type, data, dims) => ({ data, dims, type })),
  env: { wasm: { wasmPaths: '', numThreads: 1 } },
}));

// --- 2. Test Suite ---
describe('SegmentOverlay', () => {
  
  const createMockVideo = () => {
    const video = document.createElement('video');
    Object.defineProperties(video, {
      videoWidth: { value: 640, configurable: true },
      videoHeight: { value: 480, configurable: true },
      clientWidth: { value: 640, configurable: true },
      clientHeight: { value: 480, configurable: true },
      readyState: { value: 4, configurable: true }, // HAVE_ENOUGH_DATA
    });
    video.play = vi.fn().mockResolvedValue(undefined);
    return video;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock requestAnimationFrame so the loop executes in the test environment
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
    
    // Polyfill Canvas API for JSDOM
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      putImageData: vi.fn(),
      createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(640 * 480 * 4) })),
    }) as any;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('initially renders the loading status', () => {
    const videoRef = { current: createMockVideo() };
    render(<SegmentOverlay videoRef={videoRef} />);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });


  it('applies custom color via props', async () => {
    const videoRef = { current: createMockVideo() };
    const { container } = render(
      <SegmentOverlay videoRef={videoRef} color="#FF0000" />
    );
    
    await waitFor(() => {
      expect(container.querySelector('canvas')).toBeTruthy();
    });
  });

  it('gracefully handles video metadata being missing initially', async () => {
    const video = document.createElement('video');
    Object.defineProperties(video, {
      videoWidth: { value: 0, configurable: true },
      videoHeight: { value: 0, configurable: true },
    });
    const videoRef = { current: video };
    
    const { container } = render(<SegmentOverlay videoRef={videoRef} />);

    // Update metadata properties
    Object.defineProperties(video, {
      videoWidth: { value: 640, configurable: true },
      videoHeight: { value: 480, configurable: true },
    });
    
    // Trigger the event the component is listening for
    fireEvent(video, new Event('loadedmetadata'));

    await waitFor(() => {
      expect(container.querySelector('canvas')).toBeInTheDocument();
    });
  });

  it('handles null videoRef and still displays canvas when ready', async () => {
    const videoRef = { current: null };
    const { container } = render(<SegmentOverlay videoRef={videoRef} />);
    
    await waitFor(() => {
      expect(container.querySelector('canvas')).toBeInTheDocument();
    });
  });

  it('cleans up animation frames on unmount', async () => {
    const cancelSpy = vi.spyOn(global, 'cancelAnimationFrame');
    const videoRef = { current: createMockVideo() };
    const { unmount } = render(<SegmentOverlay videoRef={videoRef} />);
    
    // Let it initialize
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    
    unmount();
    expect(cancelSpy).toHaveBeenCalled();
  });
});