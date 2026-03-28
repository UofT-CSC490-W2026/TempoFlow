import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FeedbackOverlay } from "./FeedbackOverlay";
import React from "react";

// 1. Mock BodyPix at the very top to ensure hoisting
vi.mock("@tensorflow-models/body-pix", () => ({
  load: vi.fn().mockResolvedValue({
    segmentPerson: vi.fn().mockResolvedValue({
      width: 640,
      height: 480,
      data: new Uint8Array(640 * 480).fill(0),
      allPoses: [{ keypoints: [] }],
    }),
  }),
}));

describe("FeedbackOverlay", () => {
  const mockFeedback = [
    {
      timestamp: 1.0,
      severity: "major",
      bodyRegion: "legs",
      message: "Keep legs bent",
      deviation: 0.8,
      regions: { legs: "major" }
    },
  ];

  beforeEach(() => {
    // 2. Mock Canvas 2D Context
    const mockCtx = {
      clearRect: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
      createImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(4) }),
      putImageData: vi.fn(),
    };
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx) as any;
    
    // 3. Mock requestAnimationFrame
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0));
  });
  it("does not render a badge if there is no feedback for the current time", async () => {
    const videoRef = { 
        current: { videoWidth: 640, videoHeight: 480, readyState: 4 } as any 
    };

    render(
      <FeedbackOverlay
        refVideoRef={videoRef}
        videoRef={videoRef}
        feedback={mockFeedback as any}
        sharedTime={5.0} 
      />
    );

    expect(screen.queryByText(/Legs/i)).not.toBeInTheDocument();
  });
});