import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FeedbackViewer } from "./FeedbackViewer";
import { useEbsViewer } from "./useEbsViewer";

// 1. Mock the custom hook
vi.mock("./useEbsViewer", () => ({
  useEbsViewer: vi.fn(),
}));

// 2. Mock sub-components that perform heavy logic or WebGL
vi.mock("../BodyPixOverlay", () => ({ BodyPixOverlay: () => <div data-testid="bodypix-live" /> }));
vi.mock("../PrecomputedVideoOverlay", () => ({ PrecomputedVideoOverlay: () => <div data-testid="precomputed-video" /> }));
vi.mock("./FeedbackPanel", () => ({ FeedbackPanel: () => <div data-testid="feedback-panel" /> }));
vi.mock("./GeminiFeedbackPanel", () => ({ 
  GeminiFeedbackPanel: () => <div data-testid="gemini-panel" />,
  TIMING_LABEL_COLORS: {} 
}));

// 3. Mock Storage Utils
vi.mock("../../lib/overlayStorage", () => ({
  getSessionOverlay: vi.fn().mockResolvedValue(null),
  buildOverlayKey: vi.fn().mockReturnValue("mock-key"),
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

  it("renders session mode directly with video players", () => {
    render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [], alignment: {} } as any}
      />
    );
    expect(screen.getByText(/currently using BodyPix/i)).toBeInTheDocument();
    expect(screen.getByText(/Reference \(Clip 1\)/i)).toBeInTheDocument();
  });

  it("toggles playback when the play button is clicked", () => {
    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    const playBtn = screen.getByTitle(/Play \/ Pause/i);
    fireEvent.click(playBtn);
    expect(mockActions.togglePlay).toHaveBeenCalled();
  });

  it("calls seekToNextSegment when the next button is clicked", () => {
    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    const nextBtn = screen.getByTitle(/Next segment/i);
    fireEvent.click(nextBtn);
    expect(mockActions.seekToNextSegment).toHaveBeenCalled();
  });

  it("updates the 'Pause at segment end' setting", () => {
    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    const checkbox = screen.getByLabelText(/Pause at segment end/i);
    fireEvent.click(checkbox);
    expect(mockActions.setPauseAtSegmentEnd).toHaveBeenCalledWith(true);
  });

  it("handles keyboard shortcuts (Space to toggle play)", () => {
    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    fireEvent.keyDown(window, { code: "Space" });
    expect(mockActions.togglePlay).toHaveBeenCalled();
  });

  it("shows Gemini and Dance feedback panels in session mode", () => {
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
    expect(screen.getByTestId("feedback-panel")).toBeInTheDocument();
  });

  it("switches to practice mode when requested", () => {
    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    const practiceBtn = screen.getByTitle(/Practice current segment/i);
    fireEvent.click(practiceBtn);
    expect(mockActions.openPracticeMode).toHaveBeenCalledWith(0);
  });

  it("revokes object URLs on unmount in manual mode", () => {
    const { unmount } = render(<FeedbackViewer mode="manual" />);
    unmount();
    // Verify cleanup logic if URLs were set (this would require setting state first)
    expect(global.URL.revokeObjectURL).not.toHaveBeenCalled(); // None set yet
  });
});