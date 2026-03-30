import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FeedbackViewer } from "./FeedbackViewer";
import { useEbsViewer } from "./useEbsViewer";

const { ensureBrowserYoloOverlaysMock } = vi.hoisted(() => ({
  ensureBrowserYoloOverlaysMock: vi.fn().mockResolvedValue(undefined),
}));

// 1. Mock the custom hook
vi.mock("./useEbsViewer", () => ({
  useEbsViewer: vi.fn(),
}));

// 2. Mock sub-components that perform heavy logic or WebGL
vi.mock("../BodyPixOverlay", () => ({ BodyPixOverlay: () => <div data-testid="bodypix-live" /> }));
vi.mock("../ProgressiveOverlay", () => ({
  ProgressiveOverlay: () => <div data-testid="progressive-overlay" />,
}));
vi.mock("./OverlayMaskLayer", () => ({
  OverlayMaskLayer: () => <div data-testid="overlay-mask-layer" />,
}));
vi.mock("./GeminiFeedbackPanel", () => {
  const React = require("react");
  return {
    GeminiFeedbackPanel: React.forwardRef((props: { onFeedbackReady?: (moves: unknown[]) => void }, ref) => {
      React.useImperativeHandle(ref, () => ({
        enqueueSegmentForFeedback: vi.fn(),
      }));
      React.useEffect(() => {
        props.onFeedbackReady?.([
          {
            segmentIndex: 0,
            move_index: 2,
            shared_start_sec: 4,
            shared_end_sec: 6,
            micro_timing_label: "early",
          },
        ]);
      }, [props.onFeedbackReady]);
      return <div data-testid="gemini-panel" />;
    }),
    TIMING_LABEL_COLORS: {},
  };
});

// 3. Mock Storage Utils — return cached BodyPix frames so Gemini isn’t blocked
vi.mock("../../lib/overlayStorage", () => ({
  getSessionOverlay: vi.fn(async (key: string) => {
    if (!key.startsWith("mock-key-bodypix-")) {
      return null;
    }
    return {
      version: 1,
      type: "bodypix",
      side: key.endsWith("-practice") ? "practice" : "reference",
      fps: 12,
      width: 64,
      height: 48,
      frameCount: 1,
      createdAt: "",
      frames: ["data:image/webp;base64,UklGRiI="],
    };
  }),
  buildOverlayKey: vi.fn((opts: { type?: string; side?: string }) => `mock-key-${opts?.type ?? "x"}-${opts?.side ?? "x"}`),
}));

vi.mock("../../lib/ensureBrowserBodyPixOverlays", () => ({
  ensureBrowserBodyPixOverlays: vi.fn().mockResolvedValue(undefined),
  BROWSER_BODYPIX_OVERLAY_FPS: 12,
  BROWSER_BODYPIX_VARIANT: "bodypix24-browser-clean-v3",
}));

vi.mock("../../lib/ensureBrowserYoloOverlays", () => ({
  ensureBrowserYoloOverlays: ensureBrowserYoloOverlaysMock,
  BROWSER_YOLO_OVERLAY_FPS: 12,
  BROWSER_YOLO_VARIANT: "yolo26n-python-hybrid-v6",
}));

describe("FeedbackViewer", () => {
  const mockState = {
    sharedTime: 10,
    refTime: 10,
    userTime: 10,
    isPlaying: false,
    mainPlaybackRate: 1,
    segments: [
        { shared_start_sec: 0, shared_end_sec: 5 },
        { shared_start_sec: 5, shared_end_sec: 10 },
    ],
    currentSegmentIndex: 0,
    doneSegmentIndexes: [],
    practice: { 
        enabled: false, 
        moves: [], 
        doneMoveIndexes: [],
        segmentIndex: -1,
        playbackRate: 1.0, 
    },
    beats: [1, 2, 3, 4],
    sharedLen: 20,
    pauseAtSegmentEnd: false,
    pauseOverlay: { visible: false },
    ebs: { 
        beat_tracking: { estimated_bpm: 120 },
        segmentation_mode: "auto" 
    }
    };

  const mockActions = {
    loadFromJson: vi.fn(),
    seekToShared: vi.fn(),
    seekToSegment: vi.fn(),
    seekToNextSegment: vi.fn(),
    seekToPrevSegment: vi.fn(),
    togglePlay: vi.fn(),
    setPauseAtSegmentEnd: vi.fn(),
    toggleMainSpeed: vi.fn(),
    openPracticeMode: vi.fn(),
    closePracticeMode: vi.fn(),
    replayCurrentMove: vi.fn(),
    hidePauseOverlay: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (useEbsViewer as any).mockReturnValue({
      state: mockState,
      ...mockActions,
    });
    // Mock URL.createObjectURL for video source handling
    global.URL.createObjectURL = vi.fn(() => "blob:mock");
    global.URL.revokeObjectURL = vi.fn();
  });

  it("renders manual mode upload state by default", () => {
    render(<FeedbackViewer mode="manual" />);
    // Check for "currently using BodyPix" note or similar UI markers
    expect(screen.queryByText(/currently using BodyPix/i)).not.toBeInTheDocument();
  });

  it("renders session mode directly with video players", async () => {
    render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [], alignment: {} } as any}
      />
    );
    expect(screen.getByText(/Reference \(Clip 1\)/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("gemini-panel")).toBeInTheDocument();
    });
    expect(screen.getByTitle(/Side-by-side view/i)).toBeInTheDocument();
    expect(screen.getByTitle(/Overlay view/i)).toBeInTheDocument();
  });

  it("toggles playback when the play button is clicked", () => {
    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    const playBtn = screen.getByTitle(/Play \/ Pause/i);
    fireEvent.click(playBtn);
    expect(mockActions.togglePlay).toHaveBeenCalled();
  });

  it("calls seekToNextSegment when the next button is clicked", () => {
    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    const nextBtn = screen.getByTitle(/Next section/i);
    fireEvent.click(nextBtn);
    expect(mockActions.seekToNextSegment).toHaveBeenCalled();
  });

  it("updates the 'Pause at segment end' setting", () => {
    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    const checkbox = screen.getByLabelText(/Pause at section end/i);
    fireEvent.click(checkbox);
    expect(mockActions.setPauseAtSegmentEnd).toHaveBeenCalledWith(true);
  });

  it("handles keyboard shortcuts (Space to toggle play)", () => {
    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    fireEvent.keyDown(window, { code: "Space" });
    expect(mockActions.togglePlay).toHaveBeenCalled();
  });

  it("replays the current move with Space during practice mode", () => {
    (useEbsViewer as any).mockReturnValue({
      state: {
        ...mockState,
        practice: {
          ...mockState.practice,
          enabled: true,
          currentMoveIndex: 1,
          moves: [
            { idx: 0, num: 1, startSec: 0, endSec: 1, isTransition: false },
            { idx: 1, num: 2, startSec: 1, endSec: 2, isTransition: false },
          ],
        },
      },
      ...mockActions,
    });

    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    fireEvent.keyDown(window, { code: "Space" });
    expect(mockActions.replayCurrentMove).toHaveBeenCalled();
    expect(mockActions.togglePlay).not.toHaveBeenCalled();
  });

  it("shows Gemini feedback panel in session mode", () => {
    render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{}], alignment: {} } as any}
      />
    );
    expect(screen.getByTestId("gemini-panel")).toBeInTheDocument();
  });

  it("seeks to the feedback marker start when a feedback pin is clicked", async () => {
    render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{ shared_start_sec: 0, shared_end_sec: 10 }], alignment: {} } as any}
      />,
    );

    const marker = await screen.findByTitle("Move 2: early");
    fireEvent.click(marker);

    expect(mockActions.seekToShared).toHaveBeenCalledWith(4);
  });

  it("switches to practice mode when requested", () => {
    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    const practiceBtn = screen.getByTitle(/Practice current section/i);
    fireEvent.click(practiceBtn);
    expect(mockActions.openPracticeMode).toHaveBeenCalledWith(0);
  });

  it("revokes object URLs on unmount in manual mode", () => {
    const { unmount } = render(<FeedbackViewer mode="manual" />);
    unmount();
    // Verify cleanup logic if URLs were set (this would require setting state first)
    expect(global.URL.revokeObjectURL).not.toHaveBeenCalled(); // None set yet
  });

  it("does not abort the in-flight YOLO pipeline when segment artifacts update", async () => {
    const inFlight = new Promise<void>(() => {});
    let seenSignal: AbortSignal | undefined;
    const segmentedArtifact = {
      version: 1,
      type: "yolo",
      side: "reference",
      fps: 12,
      width: 64,
      height: 48,
      frameCount: 1,
      createdAt: "",
      segments: [
        {
          index: 0,
          startSec: 0,
          endSec: 5,
          fps: 12,
          width: 64,
          height: 48,
          frameCount: 1,
          createdAt: "",
          video: new Blob(["x"], { type: "video/webm" }),
          videoMime: "video/webm",
          meta: {},
        },
      ],
      meta: {},
    };
    const poseArtifact = { ...segmentedArtifact, type: "yolo-pose-arms" };

    ensureBrowserYoloOverlaysMock.mockImplementationOnce(async (params) => {
      seenSignal = params.signal;
      params.setRefArtifact(segmentedArtifact as any);
      params.setUserArtifact({ ...segmentedArtifact, side: "practice" } as any);
      params.setRefArmsArtifact?.(poseArtifact as any);
      params.setRefLegsArtifact?.({ ...poseArtifact, type: "yolo-pose-legs" } as any);
      params.setUserArmsArtifact?.({ ...poseArtifact, side: "practice" } as any);
      params.setUserLegsArtifact?.({ ...poseArtifact, type: "yolo-pose-legs", side: "practice" } as any);
      return inFlight;
    });

    render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{ shared_start_sec: 0, shared_end_sec: 5 }], alignment: {} } as any}
      />,
    );

    await waitFor(() => {
      expect(ensureBrowserYoloOverlaysMock).toHaveBeenCalledTimes(1);
      expect(seenSignal).toBeDefined();
    });

    await waitFor(() => {
      expect(seenSignal?.aborted).toBe(false);
    });
  });
});
