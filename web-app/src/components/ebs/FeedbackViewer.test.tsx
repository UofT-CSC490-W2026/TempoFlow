import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FeedbackViewer } from "./FeedbackViewer";
import { useEbsViewer } from "./useEbsViewer";
import { getSessionOverlay } from "../../lib/overlayStorage";

const { ensureBrowserYoloOverlaysMock } = vi.hoisted(() => ({
  ensureBrowserYoloOverlaysMock: vi.fn().mockResolvedValue(undefined),
}));
const { buildVisualFeedbackFromYoloArtifactsMock } = vi.hoisted(() => ({
  buildVisualFeedbackFromYoloArtifactsMock: vi.fn().mockReturnValue({
    feedback: [
      {
        timestamp: 2.5,
        segmentIndex: 0,
        bodyRegion: "arms",
        severity: "moderate",
        message: "Upper-body shape differs from the reference phrase.",
        deviation: 0.33,
        featureFamily: "upper_body",
      },
    ],
    refSamples: [],
    userSamples: [],
  }),
}));
const { geminiFeedbackMovesMock } = vi.hoisted(() => ({
  geminiFeedbackMovesMock: vi.fn().mockReturnValue([
    {
      segmentIndex: 0,
      move_index: 2,
      shared_start_sec: 4,
      shared_end_sec: 6,
      micro_timing_label: "early",
      confidence: "high",
      user_relative_to_reference: "behind",
      coaching_note: "Delay the right step slightly to match the guide.",
      micro_timing_evidence: "The step starts a touch ahead of the reference.",
      body_parts_involved: ["right leg", "torso"],
    },
  ]),
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
    GeminiFeedbackPanel: React.forwardRef((props: {
      onFeedbackReady?: (moves: unknown[]) => void;
      feedbackDifficulty?: "beginner" | "standard" | "advanced";
      renderUi?: boolean;
    }, ref: unknown) => {
      React.useImperativeHandle(ref, () => ({
        enqueueSegmentForFeedback: vi.fn(),
      }));
      React.useEffect(() => {
        const moves = geminiFeedbackMovesMock();
        props.onFeedbackReady?.(props.feedbackDifficulty === "beginner" ? [] : moves);
      }, [props.feedbackDifficulty, props.onFeedbackReady]);
      return props.renderUi === false ? null : <div data-testid="gemini-panel" />;
    }),
  };
});

// 3. Mock Storage Utils — return cached BodyPix frames so Gemini isn’t blocked
vi.mock("../../lib/overlayStorage", () => ({
  getSessionOverlay: vi.fn(async (key: string) => {
    const side = key.endsWith("-practice") ? "practice" : "reference";
    const baseSegment = {
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
    };

    if (key.startsWith("mock-key-yolo-")) {
      return {
        version: 1,
        type: "yolo",
        side,
        fps: 12,
        width: 64,
        height: 48,
        frameCount: 1,
        createdAt: "",
        segments: [
          {
            ...baseSegment,
            meta: {
              segSummary: { person_count: 1, persons: [] },
              poseSummary: { person_count: 1, persons: [] },
              sharedStartSec: 0,
              sharedEndSec: 5,
              poseFrames: [
                {
                  keypoints: Array.from({ length: 17 }, (_, i) => ({
                    name: `kp-${i}`,
                    x: i,
                    y: i + 1,
                    score: 0.9,
                  })),
                  part_coverage: {
                    head: 1,
                    arms: 1,
                    torso: 1,
                    legs: 1,
                    full_body: 1,
                  },
                },
              ],
            },
          },
        ],
      };
    }

    if (key.startsWith("mock-key-yolo-pose-arms-") || key.startsWith("mock-key-yolo-pose-legs-")) {
      return {
        version: 1,
        type: key.includes("pose-arms") ? "yolo-pose-arms" : "yolo-pose-legs",
        side,
        fps: 12,
        width: 64,
        height: 48,
        frameCount: 1,
        createdAt: "",
        segments: [
          {
            ...baseSegment,
            meta: {
              poseSummary: { person_count: 1, persons: [] },
            },
          },
        ],
      };
    }

    if (!key.startsWith("mock-key-bodypix-")) {
      return null;
    }
    return {
      version: 1,
      type: "bodypix",
      side,
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

vi.mock("../../lib/yoloFeedback", () => ({
  ANGLE_SIGNAL_STANDARD_DEGREES: 30,
  buildVisualFeedbackFromYoloArtifacts: buildVisualFeedbackFromYoloArtifactsMock,
  overlayArtifactHasYoloPoseFrames: vi.fn((artifact: { segments?: Array<{ meta?: { poseFrames?: unknown[] } }> } | null) =>
    Boolean(artifact?.segments?.some((segment) => Array.isArray(segment.meta?.poseFrames))),
  ),
}));

vi.mock("../../lib/visualFeedbackStorage", () => ({
  buildVisualFeedbackKey: vi.fn(() => "visual-cache-key"),
  getVisualFeedbackRun: vi.fn().mockResolvedValue(null),
  storeVisualFeedbackRun: vi.fn().mockResolvedValue(undefined),
}));

describe("FeedbackViewer", () => {
  const mockState = {
    sharedTime: 4.5,
    refTime: 4.5,
    userTime: 4.5,
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
        currentMoveIndex: -1,
        pauseAtMoveEnd: false,
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
    pausePlayback: vi.fn(),
    setPauseAtSegmentEnd: vi.fn(),
    toggleMainSpeed: vi.fn(),
    openPracticeMode: vi.fn(),
    closePracticeMode: vi.fn(),
    replayCurrentMove: vi.fn(),
    setPracticeRepeatMode: vi.fn(),
    setPauseAtMoveEnd: vi.fn(),
    hidePauseOverlay: vi.fn(),
    showPauseOverlay: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    buildVisualFeedbackFromYoloArtifactsMock.mockReturnValue({
      feedback: [
        {
          timestamp: 2.5,
          segmentIndex: 0,
          bodyRegion: "arms",
          severity: "moderate",
          message: "Upper-body shape differs from the reference phrase.",
          deviation: 0.33,
          featureFamily: "upper_body",
        },
      ],
      refSamples: [],
      userSamples: [],
    });
    geminiFeedbackMovesMock.mockReturnValue([
      {
        segmentIndex: 0,
        move_index: 2,
        shared_start_sec: 4,
        shared_end_sec: 6,
        micro_timing_label: "early",
        confidence: "high",
        user_relative_to_reference: "behind",
        coaching_note: "Delay the right step slightly to match the guide.",
        micro_timing_evidence: "The step starts a touch ahead of the reference.",
        body_parts_involved: ["right leg", "torso"],
      },
    ]);
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

  it("toggles mute state from the transport control", () => {
    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    const muteBtn = screen.getByLabelText(/Unmute audio/i);
    fireEvent.click(muteBtn);
    expect(screen.getByLabelText(/Mute audio/i)).toBeInTheDocument();
  });

  it("enables 'Pause at feedback' by default", () => {
    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    expect(screen.getByLabelText(/Pause at feedback/i)).toBeChecked();
  });

  it("handles keyboard shortcuts (Space to toggle play)", () => {
    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    fireEvent.keyDown(window, { code: "Space" });
    expect(mockActions.togglePlay).toHaveBeenCalled();
  });

  it("keeps space playback shortcuts active when the pause checkbox has focus", () => {
    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    const checkbox = screen.getByLabelText(/Pause at section end/i);
    checkbox.focus();
    fireEvent.keyDown(checkbox, { code: "Space" });
    expect(mockActions.togglePlay).toHaveBeenCalled();
  });

  it("keeps Space mapped to play and pause during practice mode", () => {
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
    expect(mockActions.togglePlay).toHaveBeenCalled();
    expect(mockActions.replayCurrentMove).not.toHaveBeenCalled();
  });

  it("starts with 'Pause at move end' off in practice mode", () => {
    (useEbsViewer as any).mockReturnValue({
      state: {
        ...mockState,
        practice: {
          ...mockState.practice,
          enabled: true,
          currentMoveIndex: 0,
          pauseAtMoveEnd: false,
          moves: [
            { idx: 0, num: 1, startSec: 0, endSec: 1, isTransition: false },
          ],
        },
      },
      ...mockActions,
    });

    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    expect(screen.getByLabelText(/Pause at move end/i)).not.toBeChecked();
  });

  it("does not render the old Gemini panel UI in session mode", () => {
    render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{}], alignment: {} } as any}
      />
    );
    expect(screen.queryByTestId("gemini-panel")).not.toBeInTheDocument();
  });

  it("shows Gemini feedback as an on-video caption", async () => {
    const { container } = render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{ shared_start_sec: 0, shared_end_sec: 10 }], alignment: {} } as any}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelector(".overlay-feedback-card-gemini .overlay-feedback-copy")?.textContent,
      ).toContain("Delay the right step slightly to match the guide.");
    });
  });

  it("filters Gemini timing feedback when pose angle support is too weak", async () => {
    const makeAlignedSample = (segmentIndex: number, timestamp: number) => ({
      timestamp,
      segmentIndex,
      frameWidth: 64,
      frameHeight: 48,
      keypoints: Array.from({ length: 17 }, (_, index) => ({
        name: `kp-${index}`,
        x: 20 + index,
        y: 10 + index,
        score: 0.95,
      })),
      partCoverage: {
        head: 1,
        arms: 1,
        torso: 1,
        legs: 1,
        full_body: 1,
      },
    });

    buildVisualFeedbackFromYoloArtifactsMock.mockReturnValue({
      feedback: [],
      refSamples: [makeAlignedSample(0, 4.2), makeAlignedSample(0, 4.8)],
      userSamples: [makeAlignedSample(0, 4.2), makeAlignedSample(0, 4.8)],
    });

    const { container } = render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{ shared_start_sec: 0, shared_end_sec: 10 }], alignment: {} } as any}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(".overlay-feedback-card-gemini")).toBeNull();
      expect(container.querySelector(".timeline-feedback-marker.gemini")).toBeNull();
    });
  });

  it("shows clickable visual and Gemini markers on the section timeline", async () => {
    const { container } = render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{ shared_start_sec: 0, shared_end_sec: 10 }], alignment: {} } as any}
      />,
    );

    const visualMarkers = await screen.findAllByLabelText(/Visual cue at/i);
    expect(visualMarkers.length).toBeGreaterThan(0);
    expect(visualMarkers[0]?.getAttribute("aria-label")).toMatch(/Visual cue at 0:02\.[12]/i);
    expect(await screen.findByLabelText(/Gemini cue at/i)).toBeInTheDocument();
    expect(container.querySelector(".timeline-feedback-marker.visual.moderate")).not.toBeNull();
    expect(container.querySelector(".timeline-feedback-marker.gemini.minor")).not.toBeNull();
  });

  it("hides micro timing feedback cues and markers when toggled off", async () => {
    const { container } = render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{ shared_start_sec: 0, shared_end_sec: 10 }], alignment: {} } as any}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(".overlay-feedback-card-gemini")).not.toBeNull();
      expect(container.querySelector(".timeline-feedback-marker.gemini")).not.toBeNull();
    });

    fireEvent.click(screen.getByLabelText("Toggle Micro Timing feedback"));

    await waitFor(() => {
      expect(container.querySelector(".overlay-feedback-card-gemini")).toBeNull();
      expect(container.querySelector(".timeline-feedback-marker.gemini")).toBeNull();
    });
  });

  it("hides angle feedback cues and markers when toggled off", async () => {
    (useEbsViewer as any).mockReturnValue({
      state: {
        ...mockState,
        sharedTime: 2.5,
        refTime: 2.5,
        userTime: 2.5,
      },
      ...mockActions,
    });

    const { container } = render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{ shared_start_sec: 0, shared_end_sec: 5 }], alignment: {} } as any}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(".timeline-feedback-marker.visual")).not.toBeNull();
    });
    expect(await screen.findByText("Position diff")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Toggle Angle feedback"));

    await waitFor(() => {
      expect(container.querySelector(".timeline-feedback-marker.visual")).toBeNull();
      expect(screen.queryByText("Position diff")).not.toBeInTheDocument();
    });
  });

  it("shows a score and angle skeleton above the section timeline when yolo samples are available", async () => {
    const makeSample = (
      segmentIndex: number,
      timestamp: number,
      overrides: Record<number, { x: number; y: number }>,
    ) => ({
      timestamp,
      segmentIndex,
      frameWidth: 64,
      frameHeight: 48,
      keypoints: Array.from({ length: 17 }, (_, index) => {
        const fallback = { x: 20 + index * 0.4, y: 8 + index * 0.5 };
        const point = overrides[index] ?? fallback;
        return {
          name: `kp-${index}`,
          x: point.x,
          y: point.y,
          score: 0.95,
        };
      }),
      partCoverage: {
        head: 1,
        arms: 1,
        torso: 1,
        legs: 1,
        full_body: 1,
      },
    });

    buildVisualFeedbackFromYoloArtifactsMock.mockReturnValue({
      feedback: [],
      refSamples: [
        makeSample(0, 4.5, {
          0: { x: 32, y: 8 },
          5: { x: 24, y: 16 },
          6: { x: 40, y: 16 },
          7: { x: 22, y: 24 },
          8: { x: 42, y: 24 },
          9: { x: 20, y: 34 },
          10: { x: 44, y: 34 },
          11: { x: 26, y: 30 },
          12: { x: 38, y: 30 },
          13: { x: 27, y: 40 },
          14: { x: 37, y: 40 },
          15: { x: 28, y: 46 },
          16: { x: 36, y: 46 },
        }),
      ],
      userSamples: [
        makeSample(0, 4.5, {
          0: { x: 33, y: 8 },
          5: { x: 25, y: 16 },
          6: { x: 41, y: 16 },
          7: { x: 23, y: 24 },
          8: { x: 43, y: 24 },
          9: { x: 29, y: 28 },
          10: { x: 47, y: 38 },
          11: { x: 27, y: 30 },
          12: { x: 39, y: 30 },
          13: { x: 29, y: 40 },
          14: { x: 35, y: 39 },
          15: { x: 32, y: 46 },
          16: { x: 34, y: 45 },
        }),
      ],
    });

    const { container } = render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{ shared_start_sec: 0, shared_end_sec: 10 }], alignment: {} } as any}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText("Score").length).toBeGreaterThan(0);
      expect(screen.getByLabelText("Angle score skeleton")).toBeInTheDocument();
      expect(container.querySelector(".timeline-score-panel")).not.toBeNull();
    });

    expect(container.querySelector(".timeline-score-number.high, .timeline-score-number.medium, .timeline-score-number.low")).not.toBeNull();
    expect(container.querySelector(".timeline-angle-skeleton")).not.toBeNull();
    expect(screen.queryByText("Section Timeline")).not.toBeInTheDocument();
    expect(container.querySelector(".timeline-header .feedback-type-group")).not.toBeNull();
  });

  it("removes the bottom action row in session mode", () => {
    render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{ shared_start_sec: 0, shared_end_sec: 10 }], alignment: {} } as any}
      />,
    );

    expect(screen.queryByText("Download EBS JSON")).not.toBeInTheDocument();
    expect(screen.queryByText("Practice Current Section")).not.toBeInTheDocument();
  });

  it("colors segments by relative feedback-marker density", async () => {
    buildVisualFeedbackFromYoloArtifactsMock.mockReturnValue({
      feedback: [],
      refSamples: [],
      userSamples: [],
    });
    geminiFeedbackMovesMock.mockReturnValue([
      {
        segmentIndex: 0,
        move_index: 0,
        shared_start_sec: 0.4,
        shared_end_sec: 0.8,
        micro_timing_label: "early",
        confidence: "high",
        user_relative_to_reference: "behind",
        coaching_note: "First cue",
        micro_timing_evidence: "First cue",
        body_parts_involved: ["torso", "right leg"],
      },
      {
        segmentIndex: 0,
        move_index: 1,
        shared_start_sec: 1.4,
        shared_end_sec: 1.8,
        micro_timing_label: "early",
        confidence: "high",
        user_relative_to_reference: "behind",
        coaching_note: "Second cue",
        micro_timing_evidence: "Second cue",
        body_parts_involved: ["torso", "right leg"],
      },
      {
        segmentIndex: 0,
        move_index: 2,
        shared_start_sec: 2.4,
        shared_end_sec: 2.8,
        micro_timing_label: "early",
        confidence: "high",
        user_relative_to_reference: "behind",
        coaching_note: "Third cue",
        micro_timing_evidence: "Third cue",
        body_parts_involved: ["torso", "right leg"],
      },
      {
        segmentIndex: 1,
        move_index: 0,
        shared_start_sec: 4.4,
        shared_end_sec: 4.8,
        micro_timing_label: "late",
        confidence: "high",
        user_relative_to_reference: "ahead",
        coaching_note: "Fourth cue",
        micro_timing_evidence: "Fourth cue",
        body_parts_involved: ["torso", "right leg"],
      },
    ]);
    (useEbsViewer as any).mockReturnValue({
      state: {
        ...mockState,
        segments: [
          { shared_start_sec: 0, shared_end_sec: 4 },
          { shared_start_sec: 4, shared_end_sec: 8 },
          { shared_start_sec: 8, shared_end_sec: 12 },
        ],
        sharedLen: 12,
      },
      ...mockActions,
    });

    const { container } = render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{
          segments: [
            { shared_start_sec: 0, shared_end_sec: 4 },
            { shared_start_sec: 4, shared_end_sec: 8 },
            { shared_start_sec: 8, shared_end_sec: 12 },
          ],
          alignment: {},
        } as any}
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".timeline-feedback-marker.gemini")).toHaveLength(4);
    });

    const segments = Array.from(container.querySelectorAll(".timeline-segment")) as HTMLDivElement[];
    expect(segments).toHaveLength(3);
    expect(segments[0]?.style.borderColor).toBe("rgba(248, 113, 113, 0.98)");
    expect(segments[1]?.style.borderColor).toBe("rgba(234, 179, 8, 0.95)");
    expect(segments[2]?.style.borderColor).toBe("rgba(74, 222, 128, 0.95)");
  });

  it("colors move timeline blocks by relative feedback-marker density", async () => {
    buildVisualFeedbackFromYoloArtifactsMock.mockReturnValue({
      feedback: [],
      refSamples: [],
      userSamples: [],
    });
    geminiFeedbackMovesMock.mockReturnValue([
      {
        segmentIndex: 0,
        move_index: 0,
        shared_start_sec: 0.05,
        shared_end_sec: 0.1,
        micro_timing_label: "early",
        confidence: "high",
        user_relative_to_reference: "behind",
        coaching_note: "Move one cue A",
        micro_timing_evidence: "Move one cue A",
        body_parts_involved: ["torso", "right leg"],
      },
      {
        segmentIndex: 0,
        move_index: 1,
        shared_start_sec: 0.12,
        shared_end_sec: 0.16,
        micro_timing_label: "early",
        confidence: "high",
        user_relative_to_reference: "behind",
        coaching_note: "Move one cue B",
        micro_timing_evidence: "Move one cue B",
        body_parts_involved: ["torso", "right leg"],
      },
      {
        segmentIndex: 0,
        move_index: 2,
        shared_start_sec: 0.18,
        shared_end_sec: 0.22,
        micro_timing_label: "early",
        confidence: "high",
        user_relative_to_reference: "behind",
        coaching_note: "Move one cue C",
        micro_timing_evidence: "Move one cue C",
        body_parts_involved: ["torso", "right leg"],
      },
      {
        segmentIndex: 0,
        move_index: 3,
        shared_start_sec: 0.45,
        shared_end_sec: 0.5,
        micro_timing_label: "late",
        confidence: "high",
        user_relative_to_reference: "ahead",
        coaching_note: "Move two cue",
        micro_timing_evidence: "Move two cue",
        body_parts_involved: ["torso", "right leg"],
      },
    ]);
    (useEbsViewer as any).mockReturnValue({
      state: {
        ...mockState,
        practice: {
          ...mockState.practice,
          enabled: true,
          segmentIndex: 0,
          currentMoveIndex: 0,
          moves: [
            { idx: 0, num: 1, startSec: 0, endSec: 0.3, isTransition: false },
            { idx: 1, num: 2, startSec: 0.3, endSec: 0.6, isTransition: false },
            { idx: 2, num: 3, startSec: 0.6, endSec: 0.9, isTransition: false },
          ],
        },
        segments: [{ shared_start_sec: 0, shared_end_sec: 0.9 }],
        sharedLen: 0.9,
      },
      ...mockActions,
    });

    const { container } = render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{ shared_start_sec: 0, shared_end_sec: 0.9 }], alignment: {} } as any}
      />,
    );

    await waitFor(() => {
      const moveBlocks = container.querySelectorAll(".move-block");
      expect(moveBlocks).toHaveLength(3);
      expect((moveBlocks[0] as HTMLDivElement).style.borderColor).toBe("rgba(248, 113, 113, 0.98)");
      expect((moveBlocks[1] as HTMLDivElement).style.borderColor).toBe("rgba(234, 179, 8, 0.95)");
      expect((moveBlocks[2] as HTMLDivElement).style.borderColor).toBe("rgba(74, 222, 128, 0.95)");
    });
  });

  it("renders clickable feedback markers on the move timeline in practice mode", async () => {
    buildVisualFeedbackFromYoloArtifactsMock.mockReturnValue({
      feedback: [],
      refSamples: [],
      userSamples: [],
    });
    geminiFeedbackMovesMock.mockReturnValue([
      {
        segmentIndex: 0,
        move_index: 0,
        shared_start_sec: 0.45,
        shared_end_sec: 0.5,
        micro_timing_label: "late",
        confidence: "high",
        user_relative_to_reference: "ahead",
        coaching_note: "Move cue",
        micro_timing_evidence: "Move cue",
        body_parts_involved: ["torso", "right leg"],
      },
    ]);
    (useEbsViewer as any).mockReturnValue({
      state: {
        ...mockState,
        practice: {
          ...mockState.practice,
          enabled: true,
          segmentIndex: 0,
          currentMoveIndex: 0,
          moves: [
            { idx: 0, num: 1, startSec: 0, endSec: 0.3, isTransition: false },
            { idx: 1, num: 2, startSec: 0.3, endSec: 0.6, isTransition: false },
          ],
        },
        segments: [{ shared_start_sec: 0, shared_end_sec: 0.6 }],
        sharedLen: 0.6,
      },
      ...mockActions,
    });

    const { container } = render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{ shared_start_sec: 0, shared_end_sec: 0.6 }], alignment: {} } as any}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(".move-tl-track .timeline-feedback-marker.gemini")).not.toBeNull();
    });

    const moveMarker = container.querySelector(".move-tl-track .timeline-feedback-marker.gemini") as HTMLButtonElement;
    fireEvent.click(moveMarker);
    expect(mockActions.seekToShared).toHaveBeenCalledWith(0.45);
  });

  it("seeks when a timeline feedback marker is clicked", async () => {
    render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{ shared_start_sec: 0, shared_end_sec: 10 }], alignment: {} } as any}
      />,
    );

    fireEvent.click(await screen.findByLabelText(/Gemini cue at/i));
    expect(mockActions.seekToShared).toHaveBeenCalledWith(4);
  });

  it("switches to practice mode when requested", () => {
    render(<FeedbackViewer mode="session" sessionId="1" referenceVideoUrl="r" userVideoUrl="u" ebsData={{} as any} />);
    const practiceBtn = screen.getByTitle(/Practice current section/i);
    fireEvent.click(practiceBtn);
    expect(mockActions.openPracticeMode).toHaveBeenCalledWith(0);
  });

  it("shows local visual feedback on the overlay video", async () => {
    (useEbsViewer as any).mockReturnValue({
      state: {
        ...mockState,
        sharedTime: 2.5,
        refTime: 2.5,
        userTime: 2.5,
      },
      ...mockActions,
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

    fireEvent.click(screen.getByTitle(/Overlay view/i));

    expect(await screen.findByText("Position diff")).toBeInTheDocument();
    expect(await screen.findByText(/Upper-body shape differs from the guide phrase/i)).toBeInTheDocument();
  });

  it("renders multiple focus circles when multiple angle cues violate the threshold together", async () => {
    (useEbsViewer as any).mockReturnValue({
      state: {
        ...mockState,
        sharedTime: 2.5,
        refTime: 2.5,
        userTime: 2.5,
      },
      ...mockActions,
    });

    buildVisualFeedbackFromYoloArtifactsMock.mockReturnValue({
      feedback: [
        {
          timestamp: 2.5,
          segmentIndex: 0,
          bodyRegion: "arms",
          severity: "moderate",
          message: "Left Elbow angle differs by 68° from the guide.",
          deviation: 2.26,
          featureFamily: "upper_body",
          frameIndex: 0,
          jointName: "left elbow",
          angleDeltaDeg: 68,
          angleDeltaPct: 226,
          focusSide: "left",
          signalType: "angle_delta",
        },
        {
          timestamp: 2.5,
          segmentIndex: 0,
          bodyRegion: "arms",
          severity: "moderate",
          message: "Right Shoulder angle differs by 64° from the guide.",
          deviation: 2.13,
          featureFamily: "upper_body",
          frameIndex: 0,
          jointName: "right shoulder",
          angleDeltaDeg: 64,
          angleDeltaPct: 213,
          focusSide: "right",
          signalType: "angle_delta",
        },
      ],
      refSamples: [
        {
          timestamp: 2.5,
          segmentIndex: 0,
          frameWidth: 64,
          frameHeight: 48,
          keypoints: Array.from({ length: 17 }, (_, index) => ({
            name: `kp-${index}`,
            x: 18 + index,
            y: 8 + index,
            score: 0.95,
          })),
          partCoverage: { head: 1, arms: 1, torso: 1, legs: 1, full_body: 1 },
        },
      ],
      userSamples: [
        {
          timestamp: 2.5,
          segmentIndex: 0,
          frameWidth: 64,
          frameHeight: 48,
          keypoints: Array.from({ length: 17 }, (_, index) => ({
            name: `kp-${index}`,
            x: 20 + index,
            y: 10 + index,
            score: 0.95,
          })),
          partCoverage: { head: 1, arms: 1, torso: 1, legs: 1, full_body: 1 },
        },
      ],
    });

    const { container } = render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{ shared_start_sec: 0, shared_end_sec: 5 }], alignment: {} } as any}
      />,
    );

    fireEvent.click(screen.getByTitle(/Overlay view/i));

    await waitFor(() => {
      expect(container.querySelectorAll(".overlay-feedback-focus").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("shows local visual feedback on the user clip in split view", async () => {
    (useEbsViewer as any).mockReturnValue({
      state: {
        ...mockState,
        sharedTime: 2.5,
        refTime: 2.5,
        userTime: 2.5,
      },
      ...mockActions,
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

    expect(await screen.findByText("Position diff")).toBeInTheDocument();
    expect(await screen.findByText(/Upper-body shape differs from the guide phrase/i)).toBeInTheDocument();
  });

  it("filters lighter Gemini timing notes when difficulty is set to Beginner", async () => {
    const { container } = render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{ shared_start_sec: 0, shared_end_sec: 10 }], alignment: {} } as any}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelector(".overlay-feedback-card-gemini .overlay-feedback-copy")?.textContent,
      ).toContain("Delay the right step slightly to match the guide.");
    });

    fireEvent.click(screen.getByLabelText("Difficulty: Beginner"));

    await waitFor(() => {
      expect(
        container.querySelector(".overlay-feedback-card-gemini .overlay-feedback-copy"),
      ).toBeNull();
    });
  });

  it("re-initializes visual feedback when difficulty changes", async () => {
    render(
      <FeedbackViewer
        mode="session"
        sessionId="test-session"
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
        ebsData={{ segments: [{ shared_start_sec: 0, shared_end_sec: 10 }], alignment: {} } as any}
      />,
    );

    await waitFor(() => {
      expect(buildVisualFeedbackFromYoloArtifactsMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByLabelText("Difficulty: Beginner"));

    await waitFor(() => {
      expect(buildVisualFeedbackFromYoloArtifactsMock).toHaveBeenCalledTimes(2);
    });
  });

  it("revokes object URLs on unmount in manual mode", () => {
    const { unmount } = render(<FeedbackViewer mode="manual" />);
    unmount();
    // Verify cleanup logic if URLs were set (this would require setting state first)
    expect(global.URL.revokeObjectURL).not.toHaveBeenCalled(); // None set yet
  });

  it("does not abort the in-flight YOLO pipeline when segment artifacts update", async () => {
    vi.mocked(getSessionOverlay as any).mockResolvedValue(null);
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
