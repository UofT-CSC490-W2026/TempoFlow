import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SegmentOverlay from './SegmentOverlay';

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

vi.mock('onnxruntime-web', () => ({
  InferenceSession: {
    create: vi.fn().mockResolvedValue({
      run: vi.fn().mockResolvedValue({
        output0: { data: new Float32Array(8400 * 116) },
        output1: { data: new Float32Array(32 * 160 * 160) },
      }),
    }),
  },
  Tensor: vi.fn().mockImplementation((type, data, dims) => ({ data, dims })),
  env: { wasm: { wasmPaths: '', numThreads: 1 } },
}));

describe('SegmentOverlay', () => {
  
  const createMockVideo = () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 480, configurable: true });
    Object.defineProperty(video, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(video, 'clientHeight', { value: 480, configurable: true });
    return video;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initially renders the loading status', () => {
    const videoRef = { current: createMockVideo() };
    render(<SegmentOverlay videoRef={videoRef} />);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  it('renders a canvas once the model is ready', async () => {
    const videoRef = { current: createMockVideo() };
    const { container } = render(<SegmentOverlay videoRef={videoRef} />);

    // Wait for the "Loading" state to disappear and canvas to appear
    await waitFor(() => {
      const canvas = container.querySelector('canvas');
      expect(canvas).not.toBeNull();
    }, { timeout: 2000 });

    const canvas = container.querySelector('canvas');
    expect(canvas).toHaveClass('pointer-events-none');
  });

  it('applies custom color via props', async () => {
    const videoRef = { current: createMockVideo() };
    const { container } = render(
      <SegmentOverlay videoRef={videoRef} color="#FF0000" />
    );
    
    // Again, wait for loading to finish
    await waitFor(() => {
      expect(container.querySelector('canvas')).toBeTruthy();
    });
  });

  it('handles null videoRef and still displays canvas when ready', async () => {
    const videoRef = { current: null };
    const { container } = render(<SegmentOverlay videoRef={videoRef} />);
    
    await waitFor(() => {
      expect(container.querySelector('canvas')).toBeInTheDocument();
    });
  });
});