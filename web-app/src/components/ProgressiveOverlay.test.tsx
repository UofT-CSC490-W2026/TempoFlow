import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProgressiveOverlay } from "./ProgressiveOverlay";

describe("ProgressiveOverlay", () => {
  const videoRef = { current: document.createElement("video") };

  it("renders nothing when artifact is null", () => {
    const { container } = render(<ProgressiveOverlay videoRef={videoRef} artifact={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders precomputed video overlay when artifact.video exists", () => {
    const artifact = {
      version: 1,
      type: "bodypix",
      side: "reference",
      fps: 12,
      width: 640,
      height: 360,
      frameCount: 1,
      createdAt: new Date().toISOString(),
      video: new Blob(["v"], { type: "video/webm" }),
    } as const;
    const { container } = render(<ProgressiveOverlay videoRef={videoRef} artifact={artifact} />);
    expect(container.querySelector("video")).toBeTruthy();
  });

  it("renders precomputed frame overlay when artifact.frames exists", () => {
    const artifact = {
      version: 1,
      type: "bodypix",
      side: "practice",
      fps: 12,
      width: 640,
      height: 360,
      frameCount: 2,
      createdAt: new Date().toISOString(),
      frames: ["frame-1", "frame-2"],
    } as const;
    const { container } = render(<ProgressiveOverlay videoRef={videoRef} artifact={artifact} />);
    expect(container.querySelector("canvas")).toBeTruthy();
  });

  it("prefers segmented video overlay when segments include video", () => {
    const artifact = {
      version: 1,
      type: "bodypix",
      side: "reference",
      fps: 12,
      width: 640,
      height: 360,
      frameCount: 2,
      createdAt: new Date().toISOString(),
      segments: [
        {
          index: 0,
          startSec: 0,
          endSec: 1,
          fps: 12,
          width: 640,
          height: 360,
          frameCount: 1,
          createdAt: new Date().toISOString(),
          video: new Blob(["v"], { type: "video/webm" }),
        },
      ],
    } as const;
    const { container } = render(<ProgressiveOverlay videoRef={videoRef} artifact={artifact} />);
    expect(container.querySelector("video")).toBeTruthy();
  });

  it("renders segmented frame overlay when segments include frames only", () => {
    const artifact = {
      version: 1,
      type: "bodypix",
      side: "practice",
      fps: 12,
      width: 640,
      height: 360,
      frameCount: 2,
      createdAt: new Date().toISOString(),
      segments: [
        {
          index: 0,
          startSec: 0,
          endSec: 1,
          fps: 12,
          width: 640,
          height: 360,
          frameCount: 1,
          createdAt: new Date().toISOString(),
          frames: ["f1"],
        },
      ],
    } as const;
    const { container } = render(<ProgressiveOverlay videoRef={videoRef} artifact={artifact} />);
    expect(container.querySelector("canvas")).toBeTruthy();
  });
});

