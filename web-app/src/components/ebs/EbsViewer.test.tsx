import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EbsViewer } from "./EbsViewer";
import { useEbsViewer } from "./useEbsViewer";

vi.mock("./useEbsViewer", () => ({
  useEbsViewer: vi.fn(),
}));

vi.mock("../PoseOverlay", () => ({ default: () => <div data-testid="pose-overlay" /> }));
vi.mock("../SegmentOverlay", () => ({ default: () => <div data-testid="segment-overlay" /> }));
vi.mock("../BodyPixOverlay", () => ({ BodyPixOverlay: () => <div data-testid="bodypix-overlay" /> }));
vi.mock("../ProgressiveOverlay", () => ({ ProgressiveOverlay: () => <div data-testid="progressive-overlay" /> }));
vi.mock("../../lib/videoStorage", () => ({
  getSessionVideo: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../lib/overlayStorage", () => ({
  buildOverlayKey: vi.fn(() => "mock-key"),
  getSessionOverlay: vi.fn().mockResolvedValue(null),
  storeSessionOverlay: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/overlaySegments", () => ({
  buildOverlaySegmentPlans: vi.fn(() => []),
  createSegmentedOverlayArtifact: vi.fn(),
  getOverlaySegmentByIndex: vi.fn(),
  isOverlayArtifactComplete: vi.fn(() => false),
  overlayArtifactHasRenderableData: vi.fn(() => false),
  upsertOverlaySegment: vi.fn(),
}));
vi.mock("../../lib/movenetOverlayGenerator", () => ({
  generateMoveNetOverlayFrames: vi.fn(),
}));
vi.mock("../../lib/yoloOverlayGenerator", () => ({
  generateYoloOverlayFrames: vi.fn(),
}));
vi.mock("../../lib/fastSamOverlayGenerator", () => ({
  generateFastSamOverlayFrames: vi.fn(),
}));
vi.mock("../../lib/bodyPixOverlayGenerator", () => ({
  generateBodyPixOverlayFrames: vi.fn(),
}));
vi.mock("../../lib/ebsProcessorUrl", () => ({
  getPublicEbsProcessorUrl: vi.fn(() => "https://example.com/api/process"),
}));

describe("EbsViewer", () => {
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
      playbackRate: 1,
    },
    beats: [1, 2, 3],
    sharedLen: 20,
    pauseAtSegmentEnd: true,
    pauseOverlay: {
      visible: true,
      label: "Seg 0",
      completionLabel: "Segment complete",
    },
    beatFlashOn: false,
    ebs: {
      alignment: { clip_1_start_sec: 0, clip_2_start_sec: 0, shared_len_sec: 20 },
      segments: [
        { shared_start_sec: 0, shared_end_sec: 5 },
        { shared_start_sec: 5, shared_end_sec: 10 },
      ],
      beats_shared_sec: [1, 2, 3],
    },
  };

  const mockActions = {
    loadFromJson: vi.fn(),
    resetViewer: vi.fn(),
    hidePauseOverlay: vi.fn(),
    seekToShared: vi.fn(),
    seekToSegment: vi.fn(),
    seekToPrevSegment: vi.fn(),
    seekToNextSegment: vi.fn(),
    togglePlay: vi.fn(),
    pausePlayback: vi.fn(),
    playSegment: vi.fn(),
    setPauseAtSegmentEnd: vi.fn(),
    toggleMainSpeed: vi.fn(),
    openPracticeMode: vi.fn(),
    closePracticeMode: vi.fn(),
    seekToMove: vi.fn(),
    seekToPrevMove: vi.fn(),
    seekToNextMove: vi.fn(),
    setPracticeLoop: vi.fn(),
    setPauseAtMoveEnd: vi.fn(),
    togglePracticeSpeed: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (useEbsViewer as any).mockReturnValue({
      state: mockState,
      ...mockActions,
    });
  });

  it("keeps space playback shortcuts active when the pause checkbox has focus", () => {
    render(
      <EbsViewer
        mode="session"
        sessionId="1"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={mockState.ebs as any}
      />,
    );

    const checkbox = screen.getByLabelText(/Pause at segment end/i);
    checkbox.focus();

    fireEvent.keyDown(checkbox, { code: "Space" });

    expect(mockActions.togglePlay).toHaveBeenCalled();
  });
});
