import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRef } from "react";
import { GeminiFeedbackPanel, type GeminiFeedbackPanelHandle } from "./GeminiFeedbackPanel";
import { getSessionVideo } from "../../lib/videoStorage";
import { getFeedbackSegment } from "../../lib/feedbackStorage";

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

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
  const mockYoloArtifact = {
    version: 1,
    type: "yolo",
    side: "reference",
    fps: 12,
    width: 640,
    height: 360,
    frameCount: 1,
    createdAt: "",
    segments: [
      {
        index: 0,
        startSec: 0,
        endSec: 5,
        fps: 12,
        width: 640,
        height: 360,
        frameCount: 1,
        createdAt: "",
        video: new Blob(["v"], { type: "video/webm" }),
        meta: {
          segSummary: {
            person_count: 1,
            persons: [
              {
                anchor_x: 0.5,
                anchor_y: 0.9,
                center_x: 0.5,
                center_y: 0.5,
                width: 0.2,
                height: 0.8,
                min_x: 0.4,
                max_x: 0.6,
                min_y: 0.1,
                max_y: 0.9,
              },
            ],
            union: {
              anchor_x: 0.5,
              anchor_y: 0.9,
              center_x: 0.5,
              center_y: 0.5,
              width: 0.2,
              height: 0.8,
              min_x: 0.4,
              max_x: 0.6,
              min_y: 0.1,
              max_y: 0.9,
            },
          },
          poseSummary: {
            person_count: 1,
            persons: [
              {
                anchor_x: 0.5,
                anchor_y: 0.9,
                center_x: 0.5,
                center_y: 0.5,
                width: 0.18,
                height: 0.75,
                min_x: 0.41,
                max_x: 0.59,
                min_y: 0.12,
                max_y: 0.87,
              },
            ],
          },
        },
      },
    ],
  } as const;

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
        user_relative_to_reference: "behind",
        body_parts_involved: ["left leg", "torso"],
      },
    ],
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    // Mock video files
    (getSessionVideo as any).mockResolvedValue(new File([""], "video.mp4", { type: "video/mp4" }));
    vi.spyOn(window, "setTimeout").mockImplementation(((fn: TimerHandler, _delay?: number, ...args: any[]) => {
      return nativeSetTimeout(fn as any, 0, ...args) as any;
    }) as typeof window.setTimeout);
    
    // Mock scrollTo since JSDOM doesn't implement it
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  function mockGeminiJobSuccess(response = mockApiResponse) {
    (fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ job_id: "job-1" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "done" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(response),
      });
  }

  async function flushAsyncRender() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

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

    expect(screen.getByText(/Waiting for motion feedback/i)).toBeInTheDocument();
  });

  it("calls onSeek when a move card is clicked", async () => {
    (getFeedbackSegment as any).mockResolvedValueOnce(mockApiResponse);

    const onSeek = vi.fn();
    render(
      <GeminiFeedbackPanel
        sessionId={mockSessionId}
        ebsData={mockEbsData as any}
        segments={mockSegments as any}
        sharedTime={0}
        onSeek={onSeek}
      />,
    );

    await flushAsyncRender();
    const moveCard = document.body.querySelector(".cursor-pointer");
    expect(moveCard).toBeTruthy();
    fireEvent.click(moveCard);

    // Should seek to shared_start_sec (1.2)
    expect(onSeek).toHaveBeenCalledWith(1.2);
  });

  it("handles API errors gracefully", async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: "Backend exploded" }),
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

    await act(async () => {
      ref.current?.enqueueSegmentForFeedback(0);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Segment 0: Backend exploded");
    });
  });

  it("keeps the move visible when sharedTime updates", async () => {
    (getFeedbackSegment as any).mockResolvedValueOnce(mockApiResponse);

    const { rerender } = render(
      <GeminiFeedbackPanel
        sessionId={mockSessionId}
        ebsData={mockEbsData as any}
        segments={mockSegments as any}
        sharedTime={0}
        onSeek={vi.fn()}
      />,
    );

    await flushAsyncRender();

    // Update sharedTime to be near the move (midpoint is 1.6)
    rerender(
      <GeminiFeedbackPanel
        sessionId={mockSessionId}
        ebsData={mockEbsData as any}
        segments={mockSegments as any}
        sharedTime={1.5}
        onSeek={vi.fn()}
      />,
    );

    expect(document.body.textContent).toContain("Try to anticipate the snare drum.");
  });

  it("includes yolo context in the Gemini request", async () => {
    mockGeminiJobSuccess();

    const ref = createRef<GeminiFeedbackPanelHandle>();
    render(
      <GeminiFeedbackPanel
        ref={ref}
        sessionId={mockSessionId}
        ebsData={mockEbsData as any}
        segments={mockSegments as any}
        sharedTime={0}
        onSeek={vi.fn()}
        referenceYoloArtifact={mockYoloArtifact as any}
        practiceYoloArtifact={{ ...mockYoloArtifact, side: "practice" } as any}
      />,
    );

    await act(async () => {
      ref.current?.enqueueSegmentForFeedback(0);
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });

    const [, init] = (fetch as any).mock.calls[0];
    const form = init.body as FormData;
    const raw = String(form.get("yolo_context_json") ?? "");
    expect(raw).toContain('"source":"yolo-hybrid-segment"');
    expect(raw).toContain('"segment_index":0');
  });

  it("backs off on Gemini rate limits without immediately processing later queued segments", async () => {
    vi.spyOn(window, "setTimeout").mockImplementation(((fn: TimerHandler, delay?: number, ...args: any[]) => {
      if ((delay ?? 0) > 1000) {
        return 1 as any;
      }
      return nativeSetTimeout(fn as any, 0, ...args) as any;
    }) as typeof window.setTimeout);

    (fetch as any).mockResolvedValueOnce({
      ok: false,
      json: () =>
        Promise.resolve({
          error:
            "429 You exceeded your current quota. Please retry in 38.5s. Quota exceeded for metric.",
        }),
    });

    const ref = createRef<GeminiFeedbackPanelHandle>();
    render(
      <GeminiFeedbackPanel
        ref={ref}
        sessionId={mockSessionId}
        ebsData={mockEbsData as any}
        segments={
          [
            ...mockSegments,
            {
              beat_idx_range: [10, 20],
              shared_start_sec: 5,
              shared_end_sec: 10,
            },
          ] as any
        }
        sharedTime={0}
        onSeek={vi.fn()}
      />,
    );

    await act(async () => {
      ref.current?.enqueueSegmentForFeedback(0);
      ref.current?.enqueueSegmentForFeedback(1);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Gemini rate limited. Retrying in 39s.");
    });

    expect((fetch as any).mock.calls).toHaveLength(1);
  });
});
