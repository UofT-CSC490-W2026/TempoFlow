import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateFastSamOverlayFrames } from "./fastSamOverlayGenerator";

// 1. Mock onnxruntime-web correctly using a constructible function
vi.mock("onnxruntime-web", () => {
  return {
    env: { wasm: {} },
    // Use a standard function so it can be called with 'new'
    Tensor: vi.fn().mockImplementation(function (type, data, dims) {
      return {
        type,
        data,
        dims,
      };
    }),
    InferenceSession: {
      create: vi.fn().mockResolvedValue({
        inputNames: ["images"],
        run: vi.fn().mockResolvedValue({
          output: {
            data: new Float32Array(256 * 256).fill(0.5),
          },
        }),
      }),
    },
  };
});

describe("generateFastSamOverlayFrames", () => {
  let mockVideo: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockVideo = {
      src: "",
      duration: 1, 
      videoWidth: 640,
      videoHeight: 480,
      currentTime: 0,
      addEventListener: vi.fn((event, cb) => {
        if (event === "loadeddata" || event === "seeked") {
          setTimeout(cb, 0);
        }
      }),
      removeEventListener: vi.fn(),
    };

    const mockContext = {
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(512 * 512 * 4).fill(255),
      })),
      createImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(256 * 256 * 4),
      })),
      putImageData: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "high",
    };

    const mockCanvas = {
      getContext: vi.fn(() => mockContext),
      toDataURL: vi.fn(() => "data:image/webp;base64,mock"),
      width: 640,
      height: 480,
    };

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

  it("generates frames at 30 FPS for the full duration", async () => {
    const result = await generateFastSamOverlayFrames({
      videoUrl: "test-fastsam.mp4",
      color: "#FF0000",
    });

    expect(result.frames).toHaveLength(30);
    expect(result.fps).toBe(30);
  });

  it("triggers onProgress for every frame generated", async () => {
    const onProgress = vi.fn();
    await generateFastSamOverlayFrames({
      videoUrl: "test-fastsam.mp4",
      color: "#00FF00",
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledTimes(30);
  });

  it("throws an error if the video fails to provide a duration", async () => {
    mockVideo.duration = 0;
    await expect(
      generateFastSamOverlayFrames({
        videoUrl: "broken.mp4",
        color: "#000",
      })
    ).rejects.toThrow("Video duration is unavailable");
  });

  it("correctly calculates totalFrames for short videos", async () => {
    mockVideo.duration = 0.1; 
    const result = await generateFastSamOverlayFrames({
      videoUrl: "short.mp4",
      color: "#fff",
    });
    expect(result.frames).toHaveLength(3);
  });
});

describe("generateFastSamOverlayFrames", () => {
  let mockVideo: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup Video Mock with basic duration and dimensions
    mockVideo = {
      src: "",
      duration: 1, // 1 second = 30 frames at 30 FPS
      videoWidth: 640,
      videoHeight: 480,
      currentTime: 0,
      addEventListener: vi.fn((event, cb) => {
        if (event === "loadeddata" || event === "seeked") {
          setTimeout(cb, 0); // Trigger events asynchronously
        }
      }),
      removeEventListener: vi.fn(),
    };

    // Setup Canvas/Context Mock
    const mockContext = {
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(512 * 512 * 4).fill(255),
      })),
      createImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(256 * 256 * 4),
      })),
      putImageData: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
    };

    const mockCanvas = {
      getContext: vi.fn(() => mockContext),
      toDataURL: vi.fn(() => "data:image/webp;base64,mock"),
      width: 640,
      height: 480,
    };

    // Stub document.createElement for Video and Canvas
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

  it("generates frames at 30 FPS for the full duration", async () => {
    const result = await generateFastSamOverlayFrames({
      videoUrl: "test-fastsam.mp4",
      color: "#FF0000",
    });

    // 1 second duration at 30 FPS = 30 frames
    expect(result.frames).toHaveLength(30);
    expect(result.fps).toBe(30);
    expect(result.frames[0]).toContain("data:image/webp");
  });

  it("triggers onProgress for every frame generated", async () => {
    const onProgress = vi.fn();
    
    await generateFastSamOverlayFrames({
      videoUrl: "test-fastsam.mp4",
      color: "#00FF00",
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledTimes(30);
    expect(onProgress).toHaveBeenLastCalledWith(30, 30);
  });

  it("handles custom canvas drawing logic (hexToRgb and clipping)", async () => {
    // This test ensures the generator completes even with complex drawing
    const result = await generateFastSamOverlayFrames({
      videoUrl: "test.mp4",
      color: "#aabbcc",
    });

    expect(result.width).toBe(640);
    expect(result.height).toBe(480);
  });

  it("throws an error if the video fails to provide a duration", async () => {
    mockVideo.duration = 0;

    await expect(
      generateFastSamOverlayFrames({
        videoUrl: "broken.mp4",
        color: "#000",
      })
    ).rejects.toThrow("Video duration is unavailable");
  });

  it("correctly calculates totalFrames for short videos", async () => {
    mockVideo.duration = 0.1; // 10% of a second

    const result = await generateFastSamOverlayFrames({
      videoUrl: "short.mp4",
      color: "#fff",
    });

    // ceil(0.1 * 30) = 3 frames
    expect(result.frames).toHaveLength(3);
  });
});