import { render, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BodyPixOverlay } from "./BodyPixOverlay";
import React from "react";
import * as normalization from "../lib/normalization";

// 1. Mock TensorFlow and BodyPix modules
vi.mock("@tensorflow/tfjs-core", () => ({
  setBackend: vi.fn().mockResolvedValue(true),
  ready: vi.fn().mockResolvedValue(true),
}));

vi.mock("@tensorflow/tfjs-backend-webgl", () => ({}));

vi.mock("@tensorflow-models/body-pix", () => ({
  load: vi.fn().mockResolvedValue({
    segmentPersonParts: vi.fn().mockResolvedValue({
      width: 640,
      height: 480,
      data: new Int32Array(640 * 480).fill(1),
      allPoses: [{ 
        keypoints: Array(17).fill(null).map((_, i) => ({
          score: 1,
          position: { x: 320, y: 240 },
          part: `part_${i}` 
        })) 
      }],
    }),
  }),
}));

// 2. Mock the alignment library
vi.mock("../lib/normalization", () => ({
  calculateAlignmentTransform: vi.fn().mockReturnValue({
    a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 
  }),
}));

describe("BodyPixOverlay", () => {
  let videoRef: { current: HTMLVideoElement };
  const MOCK_RAF_ID = 123;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // 1. Stub Device Pixel Ratio
    vi.stubGlobal('devicePixelRatio', 2);

    // 2. Stub Animation Frames with a consistent ID for cleanup testing
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb) => {
      setTimeout(() => cb(performance.now()), 0);
      return MOCK_RAF_ID;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    // 3. Setup Video Mock with explicit property descriptors
    const mockVideo = document.createElement("video");
    Object.defineProperties(mockVideo, {
      readyState: { value: 4, writable: true },
      videoWidth: { value: 640, writable: true },
      videoHeight: { value: 480, writable: true },
      clientWidth: { value: 640, writable: true },
      clientHeight: { value: 480, writable: true },
      paused: { value: false, writable: true },
      // Add play method to prevent potential internal component errors
      play: { value: vi.fn().mockResolvedValue(undefined) },
    });
    
    videoRef = { current: mockVideo };
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  // Test 1: Visibility
  it("initializes and shows the canvas once ready", async () => {
    render(<BodyPixOverlay videoRef={videoRef as any} />);

    await waitFor(() => {
      const canvas = document.querySelector("canvas");
      expect(canvas).toHaveClass("opacity-100");
    });
  });

  // Test 2: Error Handling
  it("handles loading errors by returning null", async () => {
    const bodyPix = await import("@tensorflow-models/body-pix");
    vi.mocked(bodyPix.load).mockRejectedValueOnce(new Error("Model Load Failed"));

    render(<BodyPixOverlay videoRef={videoRef as any} />);

    await waitFor(() => {
      expect(document.querySelector("canvas")).not.toBeInTheDocument();
    });
  });
});