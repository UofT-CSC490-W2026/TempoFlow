import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateBodyPixOverlayFrames } from "./bodyPixOverlayGenerator";

// 1. Mock the Core TFJS modules to prevent backend initialization errors
vi.mock("@tensorflow/tfjs-core", () => ({
  setBackend: vi.fn().mockResolvedValue(true),
  ready: vi.fn().mockResolvedValue(true),
}));

vi.mock("@tensorflow/tfjs-backend-webgl", () => ({
  // This can be empty, just needs to exist so the import doesn't fail
}));

// 2. Mock BodyPix
vi.mock("@tensorflow-models/body-pix", () => ({
  load: vi.fn().mockResolvedValue({
    segmentPersonParts: vi.fn().mockResolvedValue({
      data: new Int32Array(100).fill(1),
      width: 10,
      height: 10,
    }),
  }),
}));

describe("generateBodyPixOverlayFrames", () => {
  let mockVideo: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup Video Mock
    mockVideo = {
      src: "",
      duration: 2,
      videoWidth: 640,
      videoHeight: 480,
      currentTime: 0,
      muted: false,
      playsInline: false,
      preload: "",
      addEventListener: vi.fn((event, cb) => {
        // Force asynchronous resolution of video events
        if (event === "loadeddata" || event === "seeked") {
          setTimeout(cb, 0);
        }
      }),
      removeEventListener: vi.fn(),
    };

    // Setup Canvas Mock
    const mockCanvas = {
      getContext: vi.fn(() => ({
        createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(400) })),
        putImageData: vi.fn(),
        clearRect: vi.fn(),
        drawImage: vi.fn(),
        imageSmoothingEnabled: true,
        imageSmoothingQuality: "high",
      })),
      toBlob: vi.fn((cb) => cb(new Blob(["mock-frame"], { type: "image/webp" }))),
      width: 640,
      height: 480,
    };

    // Stub document.createElement
    vi.stubGlobal("document", {
      createElement: vi.fn((tag: string) => {
        if (tag === "video") return mockVideo;
        if (tag === "canvas") return mockCanvas;
        return {};
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates the correct number of frames based on FPS and duration", async () => {
    const result = await generateBodyPixOverlayFrames({
      videoUrl: "test.mp4",
      fps: 2, // 2s duration * 2fps = 4 frames
    });

    expect(result.frames).toHaveLength(4);
    expect(result.fps).toBe(2);
  });

  it("reports progress via onProgress callback", async () => {
    const onProgress = vi.fn();
    await generateBodyPixOverlayFrames({
      videoUrl: "test.mp4",
      fps: 5,
      startSec: 0,
      endSec: 1, // 5 frames
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledTimes(5);
    expect(onProgress).toHaveBeenLastCalledWith(5, 5);
  });

  it("throws error if video duration is invalid", async () => {
    // Modify mock for this specific test
    mockVideo.duration = NaN;

    await expect(generateBodyPixOverlayFrames({ videoUrl: "bad.mp4" }))
      .rejects.toThrow("Video duration is unavailable");
  });

  it("respects segment boundaries (startSec and endSec)", async () => {
    const result = await generateBodyPixOverlayFrames({
      videoUrl: "test.mp4",
      fps: 10,
      startSec: 0.5,
      endSec: 1.0, // 0.5s duration = 5 frames
    });

    expect(result.frames).toHaveLength(5);
  });
});