import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEbsViewer, EbsViewerRefs } from "./useEbsViewer";
import * as logic from "./ebsViewerLogic";

// Mock the logic module
vi.mock("./ebsViewerLogic");

describe("useEbsViewer", () => {
  let mockRefs: EbsViewerRefs;
  let mockVideoElement: HTMLVideoElement;

  const mockEbsData = {
    alignment: {
      clip_1_start_sec: 10,
      clip_2_start_sec: 20,
      shared_len_sec: 100,
    },
    segments: [
      { shared_start_sec: 0, shared_end_sec: 10 },
      { shared_start_sec: 10, shared_end_sec: 20 },
    ],
    beats_shared_sec: [1, 2, 3],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Create a mock HTMLVideoElement
    mockVideoElement = {
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      currentTime: 0,
      playbackRate: 1,
    } as unknown as HTMLVideoElement;

    mockRefs = {
      refVideo: { current: { ...mockVideoElement } } as any,
      userVideo: { current: { ...mockVideoElement } } as any,
    };

    // Default logic returns
    (logic.findActiveSegmentIndex as any).mockReturnValue(-1);
  });

  it("initializes with default state", () => {
    const { result } = renderHook(() => useEbsViewer(mockRefs));
    expect(result.current.state.isPlaying).toBe(false);
    expect(result.current.state.sharedTime).toBe(0);
  });

  it("loads data correctly via loadFromJson", () => {
    const { result } = renderHook(() => useEbsViewer(mockRefs));

    act(() => {
      result.current.loadFromJson(mockEbsData as any);
    });

    expect(result.current.state.ebs).toEqual(mockEbsData);
    expect(result.current.state.segments).toHaveLength(2);
    expect(result.current.state.sharedLen).toBe(100);
  });

  it("syncs video elements during seekToShared", () => {
    const { result } = renderHook(() => useEbsViewer(mockRefs));

    act(() => {
      result.current.loadFromJson(mockEbsData as any);
    });

    act(() => {
      result.current.seekToShared(5);
    });

    expect(mockRefs.refVideo.current!.currentTime).toBe(15);
    expect(mockRefs.userVideo.current!.currentTime).toBe(25);
    expect(result.current.state.sharedTime).toBe(5);
  });

  it("toggles playback and updates video state", async () => {
    const { result } = renderHook(() => useEbsViewer(mockRefs));

    act(() => {
      result.current.togglePlay();
    });

    expect(mockRefs.refVideo.current!.play).toHaveBeenCalled();
    expect(result.current.state.isPlaying).toBe(true);

    act(() => {
      result.current.togglePlay();
    });

    expect(mockRefs.refVideo.current!.pause).toHaveBeenCalled();
    expect(result.current.state.isPlaying).toBe(false);
  });

  it("handles practice mode activation", () => {
    const mockMoves = [{ num: 1, startSec: 0, endSec: 5, isTransition: false }];
    (logic.buildMovesForSegment as any).mockReturnValue(mockMoves);

    const { result } = renderHook(() => useEbsViewer(mockRefs));

    act(() => {
      result.current.loadFromJson(mockEbsData as any);
    });

    act(() => {
      result.current.openPracticeMode(0);
    });

    expect(result.current.state.practice.enabled).toBe(true);
    expect(result.current.state.practice.moves).toEqual(mockMoves);
    expect(mockRefs.refVideo.current!.playbackRate).toBe(0.5);
  });

  it("switches playback rates via toggleMainSpeed", () => {
    const { result } = renderHook(() => useEbsViewer(mockRefs));

    act(() => {
      result.current.toggleMainSpeed();
    });

    expect(result.current.state.mainPlaybackRate).toBe(0.5);
    expect(mockRefs.refVideo.current!.playbackRate).toBe(0.5);

    act(() => {
      result.current.toggleMainSpeed();
    });

    expect(result.current.state.mainPlaybackRate).toBe(1);
  });

  it("triggers pause overlay when a segment completes", () => {
    const { result } = renderHook(() => useEbsViewer(mockRefs));

    act(() => {
      result.current.loadFromJson(mockEbsData as any);
      result.current.setPauseAtSegmentEnd(true);
    });

    (logic.findActiveSegmentIndex as any).mockReturnValue(0);

    act(() => {
      result.current.togglePlay();
      mockRefs.refVideo.current!.currentTime = 15; // sharedTime = 5
    });

    act(() => {
      result.current.markSegmentDone(0);
    });
    expect(result.current.state.doneSegmentIndexes).toContain(0);
  });

});