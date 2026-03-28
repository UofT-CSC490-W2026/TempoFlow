import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 1. Move mock definitions into variables for easier control inside tests
const setBackendMock = vi.fn().mockResolvedValue(undefined);
const readyMock = vi.fn().mockResolvedValue(undefined);
const estimatePosesMock = vi.fn().mockResolvedValue([]);
const createDetectorMock = vi.fn().mockResolvedValue({
  estimatePoses: estimatePosesMock,
  dispose: vi.fn(),
});

// 2. Setup Mocks
vi.mock("@tensorflow/tfjs-core", () => ({
  setBackend: (backend: string) => setBackendMock(backend),
  ready: () => readyMock(),
}));

vi.mock("@tensorflow/tfjs-backend-webgl", () => ({}));

vi.mock("@tensorflow-models/pose-detection", () => ({
  SupportedModels: { MoveNet: "MoveNet" },
  movenet: { modelType: { SINGLEPOSE_LIGHTNING: "singlepose" } },
  createDetector: () => createDetectorMock(),
}));

import PoseOverlay from "./PoseOverlay";

describe("PoseOverlay", () => {
  const mockRaf = vi.fn(() => 123); // Return a specific ID
  const mockCaf = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("requestAnimationFrame", mockRaf);
    vi.stubGlobal("cancelAnimationFrame", mockCaf);
  });

  // Helper to create a dummy video element for the ref
  const createMockVideoRef = () => ({
    current: document.createElement("video"),
  });

  it("renders canvas and initializes detector when video is ready", async () => {
    const videoRef = createMockVideoRef();
    const { container } = render(<PoseOverlay videoRef={videoRef} />);

    // Check that the detector was called
    await vi.waitFor(() => {
      expect(createDetectorMock).toHaveBeenCalled();
    });

    const canvas = container.querySelector("canvas");
    expect(canvas).toBeInTheDocument();
    
    // Verify the animation loop started
    expect(mockRaf).toHaveBeenCalled();
  });

  it("shows error status when tensorflow initialization fails", async () => {
    // Explicitly fail the backend for this specific test
    setBackendMock.mockRejectedValueOnce(new Error("tf backend failed"));
    
    render(<PoseOverlay videoRef={{ current: null }} />);

    // use findBy: built-in waitFor + getBy
    const errorMsg = await screen.findByText(/Pose overlay unavailable: tf backend failed/i);
    expect(errorMsg).toBeInTheDocument();
  });

  it("cleans up animation frame on unmount", async () => {
    const videoRef = createMockVideoRef();
    const { unmount } = render(<PoseOverlay videoRef={videoRef} />);
    
    // Wait for init
    await vi.waitFor(() => expect(mockRaf).toHaveBeenCalled());
    
    unmount();
    
    // Verify the specific RAF ID was cancelled
    expect(mockCaf).toHaveBeenCalledWith(123);
  });
});