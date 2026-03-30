import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBrowserYoloOverlays } from "./ensureBrowserYoloOverlays";
import { getSessionVideo } from "./videoStorage";

vi.mock("./ebsProcessorUrl", () => ({
  getPublicEbsProcessorUrl: vi.fn(() => "http://127.0.0.1:8787/api/process"),
}));

vi.mock("./videoStorage", () => ({
  getSessionVideo: vi.fn(),
}));

vi.mock("./overlayStorage", () => ({
  buildOverlayKey: vi.fn(() => "overlay-key"),
  storeSessionOverlay: vi.fn().mockResolvedValue(undefined),
}));

describe("ensureBrowserYoloOverlays", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionVideo).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not throw when called with no segment plans", async () => {
    await expect(
      ensureBrowserYoloOverlays({
        sessionId: "session-1",
        referenceVideoUrl: "ref.mp4",
        userVideoUrl: "user.mp4",
        ebsData: { alignment: {} as any, segments: [] },
        refVideo: { current: null },
        userVideo: { current: null },
        existingRef: null,
        existingUser: null,
        setRefArtifact: vi.fn(),
        setUserArtifact: vi.fn(),
        onStatus: vi.fn(),
      }),
    ).rejects.toThrow("Missing session videos for YOLO overlay generation.");
  });

  it("starts one hybrid job per side for segmented overlays", async () => {
    vi.mocked(getSessionVideo).mockImplementation(async (_sessionId, side) => {
      return new File([`${side}-video`], `${side}.mp4`, { type: "video/mp4" });
    });

    const fetchCalls: string[] = [];
    const jsonResponse = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const videoResponse = () =>
      new Response(new Blob(["video"], { type: "video/webm" }), {
        status: 200,
        headers: { "content-type": "video/webm" },
      });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        fetchCalls.push(url);

        if (url.endsWith("/api/overlay/yolo-hybrid/start")) {
          return jsonResponse({ job_id: `hybrid-${fetchCalls.length}` });
        }
        if (url.includes("/api/overlay/yolo-hybrid/status")) {
          return jsonResponse({ status: "done", progress: 1 });
        }
        if (url.includes("/api/overlay/yolo-hybrid/pose-data")) {
          return jsonResponse({
            frames: [
              {
                keypoints: Array.from({ length: 17 }, (_, index) => ({
                  name: `kp-${index}`,
                  x: index,
                  y: index + 1,
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
          });
        }
        if (url.includes("/api/overlay/yolo-hybrid/result")) {
          return videoResponse();
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    await ensureBrowserYoloOverlays({
      sessionId: "session-1",
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      ebsData: {
        alignment: {
          clip_1_start_sec: 0,
          clip_2_start_sec: 0,
          shared_len_sec: 1,
        },
        segments: [
          {
            shared_start_sec: 0,
            shared_end_sec: 1,
          },
        ],
      },
      refVideo: { current: null },
      userVideo: { current: null },
      existingRef: null,
      existingUser: null,
      existingRefArms: null,
      existingRefLegs: null,
      existingUserArms: null,
      existingUserLegs: null,
      setRefArtifact: vi.fn(),
      setUserArtifact: vi.fn(),
      setRefArmsArtifact: vi.fn(),
      setRefLegsArtifact: vi.fn(),
      setUserArmsArtifact: vi.fn(),
      setUserLegsArtifact: vi.fn(),
      onStatus: vi.fn(),
      onSegmentProgress: vi.fn(),
      onSegmentComplete: vi.fn(),
    });

    expect(fetchCalls.slice(0, 2).every((url) => url.endsWith("/api/overlay/yolo-hybrid/start"))).toBe(true);
    expect(fetchCalls.filter((url) => url.endsWith("/api/overlay/yolo-hybrid/start"))).toHaveLength(2);
  });
});
