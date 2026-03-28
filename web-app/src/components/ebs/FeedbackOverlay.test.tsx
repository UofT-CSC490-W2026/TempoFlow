import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FeedbackOverlay } from "./FeedbackOverlay";
import React from "react";

// 1. Mock BodyPix (ensure this matches how FeedbackOverlay imports it)
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
    // 2. Mock Canvas 2D Context more comprehensively
    const mockCtx = {
      clearRect: vi.fn(), 
      drawImage: vi.fn(), 
      save: vi.fn(), 
      restore: vi.fn(),
      beginPath: vi.fn(), 
      arc: vi.fn(), 
      fill: vi.fn(), 
      stroke: vi.fn(),
      createImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(4) }),
      putImageData: vi.fn(),
      scale: vi.fn(),
      translate: vi.fn(),
    };

    // Ensure we mock the prototype correctly for JSDOM
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(mockCtx as any);
    
    // 3. Mock requestAnimationFrame using vi.stubGlobal for better cleanup
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0));
    
    // Cleanup mocks
    vi.clearAllMocks();
  });

  it("does not render a badge if there is no feedback for the current time", async () => {
    // 4. Mock the video element properties more realistically
    const mockVideoElement = { 
      videoWidth: 640, 
      videoHeight: 480, 
      readyState: 4,
      paused: false,
      currentTime: 5.0
    };

    const videoRef = { 
      current: mockVideoElement as unknown as HTMLVideoElement 
    };

    render(
      <FeedbackOverlay
        refVideoRef={videoRef}
        videoRef={videoRef}
        feedback={mockFeedback as any}
        sharedTime={5.0} // Current time is 5.0, but feedback is at 1.0
      />
    );

    // 5. Use a more precise regex to avoid partial matches
    // Also use queryByRole if the badge is rendered as a specific element
    const badge = screen.queryByText(/^Legs$/i);
      expect(badge).not.toBeInTheDocument();
    });
});