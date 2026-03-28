import { describe, expect, it } from "vitest";

import { buildOverlaySegmentPlans, createSegmentedOverlayArtifact, getReadyOverlaySegmentCount, isOverlayArtifactComplete, overlayArtifactHasRenderableData, upsertOverlaySegment } from "./overlaySegments";
import type { OverlayArtifact } from "./overlayStorage";

describe("overlaySegments helpers", () => {
  it("builds clip-specific overlay segment plans from EBS data", () => {
    const plans = buildOverlaySegmentPlans({
      alignment: {
        clip_1_start_sec: 1,
        clip_2_start_sec: 2,
        shared_len_sec: 10,
      },
      segments: [
        {
          shared_start_sec: 0,
          shared_end_sec: 2,
          clip_1_seg_start_sec: 1.1,
          clip_1_seg_end_sec: 3.1,
        },
        {
          shared_start_sec: 2,
          shared_end_sec: 4,
        },
      ],
    });

    expect(plans).toEqual([
      {
        index: 0,
        sharedStartSec: 0,
        sharedEndSec: 2,
        reference: { startSec: 1.1, endSec: 3.1 },
        practice: { startSec: 2, endSec: 4 },
      },
      {
        index: 1,
        sharedStartSec: 2,
        sharedEndSec: 4,
        reference: { startSec: 3, endSec: 5 },
        practice: { startSec: 4, endSec: 6 },
      },
    ]);
  });

  it("tracks progressive segment readiness and completion", () => {
    const base = createSegmentedOverlayArtifact({
      type: "bodypix",
      side: "reference",
      fps: 12,
      width: 640,
      height: 480,
      meta: { generator: "python" },
    });

    expect(overlayArtifactHasRenderableData(base)).toBe(false);
    expect(getReadyOverlaySegmentCount(base)).toBe(0);
    expect(isOverlayArtifactComplete(base, 2)).toBe(false);

    const partial = upsertOverlaySegment(base, {
      index: 0,
      startSec: 1,
      endSec: 3,
      fps: 12,
      width: 640,
      height: 480,
      frameCount: 24,
      createdAt: new Date().toISOString(),
      frames: [new Blob(["one"], { type: "image/webp" })],
    });

    expect(overlayArtifactHasRenderableData(partial)).toBe(true);
    expect(getReadyOverlaySegmentCount(partial)).toBe(1);
    expect(isOverlayArtifactComplete(partial, 2)).toBe(false);

    const complete = upsertOverlaySegment(partial, {
      index: 1,
      startSec: 3,
      endSec: 5,
      fps: 12,
      width: 640,
      height: 480,
      frameCount: 24,
      createdAt: new Date().toISOString(),
      video: new Blob(["two"], { type: "video/webm" }),
      videoMime: "video/webm",
    });

    expect(getReadyOverlaySegmentCount(complete)).toBe(2);
    expect(isOverlayArtifactComplete(complete, 2)).toBe(true);
  });

  it("treats legacy full artifacts as already renderable and complete", () => {
    const artifact: OverlayArtifact = {
      version: 1,
      type: "yolo",
      side: "practice",
      fps: 12,
      width: 640,
      height: 480,
      frameCount: 120,
      createdAt: new Date().toISOString(),
      video: new Blob(["overlay"], { type: "video/webm" }),
      videoMime: "video/webm",
    };

    expect(overlayArtifactHasRenderableData(artifact)).toBe(true);
    expect(isOverlayArtifactComplete(artifact, 5)).toBe(true);
  });
});
