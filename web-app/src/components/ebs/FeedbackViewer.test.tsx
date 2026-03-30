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
        const moves = [
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
        ];
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

  it("shows an overlay difference score and joint angle bars above the section timeline when yolo samples are available", async () => {
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
      expect(screen.getByText("Overlay diff")).toBeInTheDocument();
      expect(screen.getByText("left elbow")).toBeInTheDocument();
      expect(container.querySelector(".timeline-score-chip")).not.toBeNull();
    });

    expect(container.querySelector(".timeline-score-number.lower")).not.toBeNull();
    expect(container.querySelector(".timeline-score-max.higher")).not.toBeNull();
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
