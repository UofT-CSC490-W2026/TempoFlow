import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PrecomputedFrameOverlay } from "./PrecomputedFrameOverlay";

describe("PrecomputedFrameOverlay", () => {
  it("renders overlay canvas and supports invalid fps fallback", () => {
    const baseVideo = document.createElement("video");
    Object.defineProperty(baseVideo, "clientWidth", { value: 320, configurable: true });
    Object.defineProperty(baseVideo, "clientHeight", { value: 180, configurable: true });
    const videoRef = { current: baseVideo };

    const { container } = render(
      <PrecomputedFrameOverlay
        videoRef={videoRef}
        frames={["a.png", "b.png"]}
        fps={Number.NaN}
      />,
    );

    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();
    expect(canvas?.className).toContain("opacity-70");
  });
});

