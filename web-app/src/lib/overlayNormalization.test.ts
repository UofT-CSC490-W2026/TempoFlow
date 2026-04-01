import { describe, expect, it } from "vitest";

import type { PoseKeypoint } from "./bodyPix";
import { applyOverlayNormalizationToNormalizedKeypoints, readOverlayNormalization } from "./overlayNormalization";
import type { OverlaySegmentArtifact } from "./overlayStorage";

describe("overlayNormalization", () => {
  it("maps normalized points with pivot scale and translate", () => {
    const kp: PoseKeypoint[] = [{ name: "nose", x: 0.5, y: 0.5, score: 1 }];
    const n = {
      scaleX: 2,
      scaleY: 2,
      translateX: 0.1,
      translateY: 0,
      pivotX: 0.5,
      pivotY: 0.5,
    };
    const out = applyOverlayNormalizationToNormalizedKeypoints(kp, n);
    expect(out[0]!.x).toBeCloseTo(0.6);
    expect(out[0]!.y).toBeCloseTo(0.5);
  });

  it("readOverlayNormalization rejects incomplete meta", () => {
    expect(readOverlayNormalization(null)).toBeNull();
    const partial = {
      index: 0,
      startSec: 0,
      endSec: 1,
      width: 640,
      height: 360,
      fps: 12,
      meta: { normalization: { scaleX: 1 } },
    } as unknown as OverlaySegmentArtifact;
    expect(readOverlayNormalization(partial)).toBeNull();
  });
});
