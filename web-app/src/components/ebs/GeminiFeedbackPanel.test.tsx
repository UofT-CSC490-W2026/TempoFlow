import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRef } from "react";
import { GeminiFeedbackPanel, type GeminiFeedbackPanelHandle } from "./GeminiFeedbackPanel";
import { getSessionVideo } from "../../lib/videoStorage";

// 1. Mock the video storage utility
vi.mock("../../lib/videoStorage", () => ({
  getSessionVideo: vi.fn(),
}));

vi.mock("../../lib/geminiPosePriors", () => ({
  computePosePriorsForSegment: vi.fn().mockResolvedValue({ moves: [] }),
}));

vi.mock("../../lib/feedbackStorage", () => ({
  GEMINI_FEEDBACK_CACHE_VERSION: "1",
  hashEbsData: vi.fn(() => "test-fp"),
  buildFeedbackSegmentKey: vi.fn(
    (p: { sessionId: string; segmentIndex: number }) => `${p.sessionId}:seg:${p.segmentIndex}`,
  ),
  getFeedbackSegment: vi.fn().mockResolvedValue(null),
  storeFeedbackSegment: vi.fn().mockResolvedValue(undefined),
  deleteFeedbackSegment: vi.fn().mockResolvedValue(undefined),
}));

describe("GeminiFeedbackPanel", () => {
  const mockSessionId = "test-session-123";
  const mockSegments = [
    {
      beat_idx_range: [0, 10],
      shared_start_sec: 0,
      shared_end_sec: 5,
    },
  ];
  const mockEbsData = { version: "1.0", tracks: [] };

  const mockApiResponse = {
    segment_index: 0,
    model: "gemini-2.5-flash-lite",
    moves: [
      {
        move_index: 1,
        time_window: "0:01.2–0:02.0",
        micro_timing_label: "late",
        micro_timing_evidence: "Left foot lagged behind the beat.",
        coaching_note: "Try to anticipate the snare drum.",
        shared_start_sec: 1.2,
        shared_end_sec: 2.0,
        confidence: "high",
        body_parts_involved: ["legs"],
      },
    ],
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    // Mock video files
    (getSessionVideo as any).mockResolvedValue(new File([""], "video.mp4", { type: "video/mp4" }));
    
    // Mock scrollTo since JSDOM doesn't implement it
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders the initial empty state correctly", () => {
    render(
      <GeminiFeedbackPanel
        sessionId={mockSessionId}
        ebsData={mockEbsData as any}
        segments={mockSegments as any}
        sharedTime={0}
        onSeek={vi.fn()}
      />,
    );

    expect(screen.getByText(/Waiting for BodyPix \/ Gemini/i)).toBeInTheDocument();
  });

  it("calls onSeek when a move card is clicked", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockApiResponse),
    });

    const onSeek = vi.fn();
    const ref = createRef<GeminiFeedbackPanelHandle>();
    render(
      <GeminiFeedbackPanel
        ref={ref}
        sessionId={mockSessionId}
        ebsData={mockEbsData as any}
        segments={mockSegments as any}
        sharedTime={0}
        onSeek={onSeek}
      />,
    );

    ref.current?.enqueueSegmentAfterBodyPix(0);

    const moveCard = await screen.findByText(/Move 1/i);
    fireEvent.click(moveCard);

    // Should seek to shared_start_sec (1.2)
    expect(onSeek).toHaveBeenCalledWith(1.2);
  });

  it("handles API errors gracefully", async () => {
    (fetch as any).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "Rate limit exceeded" }),
    });

    const ref = createRef<GeminiFeedbackPanelHandle>();
    render(
      <GeminiFeedbackPanel
        ref={ref}
        sessionId={mockSessionId}
        ebsData={mockEbsData as any}
        segments={mockSegments as any}
        sharedTime={0}
        onSeek={vi.fn()}
      />,
    );

    ref.current?.enqueueSegmentAfterBodyPix(0);

    await waitFor(() => {
      expect(screen.getByText(/Segment 0: Rate limit exceeded/i)).toBeInTheDocument();
    });
  });

  it("highlights the move closest to sharedTime", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockApiResponse),
    });

    const ref = createRef<GeminiFeedbackPanelHandle>();
    const { rerender } = render(
      <GeminiFeedbackPanel
        ref={ref}
        sessionId={mockSessionId}
        ebsData={mockEbsData as any}
        segments={mockSegments as any}
        sharedTime={0}
        onSeek={vi.fn()}
      />,
    );

    ref.current?.enqueueSegmentAfterBodyPix(0);
    await screen.findByText(/Move 1/i);

    // Update sharedTime to be near the move (midpoint is 1.6)
    rerender(
      <GeminiFeedbackPanel
        ref={ref}
        sessionId={mockSessionId}
        ebsData={mockEbsData as any}
        segments={mockSegments as any}
        sharedTime={1.5}
        onSeek={vi.fn()}
      />,
    );

    // The move button should have the highlight class
    const moveButton = screen.getByText(/Move 1/i).closest("button");
    expect(moveButton).toHaveClass("bg-indigo-50/60");
  });
});