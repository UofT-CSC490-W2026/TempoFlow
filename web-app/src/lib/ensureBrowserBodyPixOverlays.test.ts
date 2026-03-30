import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureBrowserBodyPixOverlays } from "./ensureBrowserBodyPixOverlays";
import { generateBodyPixOverlayFrames } from "./bodyPixOverlayGenerator";
import { storeSessionOverlay, buildOverlayKey } from "./overlayStorage";
import { 
  buildOverlaySegmentPlans, 
  isOverlayArtifactComplete,
  getOverlaySegmentByIndex 
} from "./overlaySegments";

// 1. Mock Dependencies
vi.mock("./bodyPixOverlayGenerator", () => ({
  generateBodyPixOverlayFrames: vi.fn(),
}));

vi.mock("./overlayStorage", () => ({
  storeSessionOverlay: vi.fn().mockResolvedValue(undefined),
  buildOverlayKey: vi.fn((opts) => `key-${opts.side}-${opts.type}`),
}));

vi.mock("./overlaySegments", () => {
  const actual = vi.importActual("./overlaySegments");
  return {
    ...actual,
    buildOverlaySegmentPlans: vi.fn(),
    isOverlayArtifactComplete: vi.fn(),
    getOverlaySegmentByIndex: vi.fn(),
    createSegmentedOverlayArtifact: vi.fn((opts) => ({ ...opts, segments: [] })),
    upsertOverlaySegment: vi.fn((art, seg) => ({
      ...art,
      segments: [...(art.segments || []), seg]
    })),
  };
});

describe("BodyPix Overlay Pipeline", () => {
  const mockParams = {
    sessionId: "session-123",
    referenceVideoUrl: "ref.mp4",
    userVideoUrl: "user.mp4",
    ebsData: { segments: [{ id: 0 }] } as any,
    refVideo: { current: { videoWidth: 640, videoHeight: 480 } } as any,
    userVideo: { current: { videoWidth: 640, videoHeight: 480 } } as any,
    existingRef: null,
    existingUser: null,
    setRefArtifact: vi.fn(),
    setUserArtifact: vi.fn(),
    onStatus: vi.fn(),
    onSegmentComplete: vi.fn(),
    onSegmentProgress: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips processing if overlays are already complete", async () => {
    // Setup: 2 segments planned, mark artifacts as complete
    (buildOverlaySegmentPlans as any).mockReturnValue([
      { index: 0, reference: {}, practice: {} },
      { index: 1, reference: {}, practice: {} }
    ]);
    (isOverlayArtifactComplete as any).mockReturnValue(true);

    await ensureBrowserBodyPixOverlays({
      ...mockParams,
      existingRef: { segments: [{}, {}] } as any,
      existingUser: { segments: [{}, {}] } as any,
    });

    expect(generateBodyPixOverlayFrames).not.toHaveBeenCalled();
    expect(mockParams.onStatus).toHaveBeenCalledWith(expect.stringContaining("already ready"));
    expect(mockParams.onSegmentComplete).toHaveBeenCalledTimes(2);
  });

  it("processes missing segments and stores them", async () => {
    // Setup: 1 segment planned, no existing segments found
    const mockPlan = [{ index: 0, reference: { startSec: 0, endSec: 1 }, practice: { startSec: 0, endSec: 1 } }];
    (buildOverlaySegmentPlans as any).mockReturnValue(mockPlan);
    (isOverlayArtifactComplete as any).mockReturnValue(false);
    (getOverlaySegmentByIndex as any).mockReturnValue(null); // Force processing

    (generateBodyPixOverlayFrames as any).mockResolvedValue({
      fps: 12,
      width: 640,
      height: 480,
      frames: ["frame1", "frame2"],
    });

    await ensureBrowserBodyPixOverlays(mockParams);

    // Verify generation was called for both videos
    expect(generateBodyPixOverlayFrames).toHaveBeenCalledTimes(2);
    
    // Verify storage was called
    expect(storeSessionOverlay).toHaveBeenCalled();

    // Verify status updates
    expect(mockParams.onStatus).toHaveBeenCalledWith(expect.stringContaining("processing…"));
    expect(mockParams.onSegmentComplete).toHaveBeenCalledWith(0);
    
    // Verify results were passed back to state
    expect(mockParams.setRefArtifact).toHaveBeenCalled();
    expect(mockParams.setUserArtifact).toHaveBeenCalled();
  });

  it("handles partial cache (skips reference if exists, only processes user)", async () => {
    (buildOverlaySegmentPlans as any).mockReturnValue([{ index: 0, reference: {}, practice: {} }]);
    (isOverlayArtifactComplete as any).mockReturnValue(false);

    // Mock: Reference segment exists, User segment missing
    (getOverlaySegmentByIndex as any).mockImplementation((art: any) => {
      return art.side === "reference" ? { index: 0 } : null;
    });

    (generateBodyPixOverlayFrames as any).mockResolvedValue({
      fps: 12,
      width: 640,
      height: 480,
      frames: ["u-frame1"],
    });

    await ensureBrowserBodyPixOverlays(mockParams);

    // Should only call generator once (for user/practice)
    expect(generateBodyPixOverlayFrames).toHaveBeenCalledTimes(1);
    // Specifically check the progress logic
    expect(mockParams.onSegmentProgress).toHaveBeenCalledWith(0, expect.any(Number));
  });

  it("falls back to full video processing if segmented pipeline returns false", async () => {
    // If buildOverlaySegmentPlans returns empty, usedSegmented becomes false
    (buildOverlaySegmentPlans as any).mockReturnValue([]);
    
    (generateBodyPixOverlayFrames as any).mockResolvedValue({
      fps: 12,
      width: 640,
      height: 480,
      frames: ["full-frame"],
    });

    await ensureBrowserBodyPixOverlays(mockParams);

    // Verify it used the fallback non-segmented generator
    expect(generateBodyPixOverlayFrames).toHaveBeenCalledTimes(2);
    expect(mockParams.onStatus).toHaveBeenCalledWith("BodyPix overlays ready.");
  });
});