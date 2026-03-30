import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PrecomputedVideoOverlay } from "./PrecomputedVideoOverlay";

describe("PrecomputedVideoOverlay", () => {
  it("creates and revokes object URL on mount/unmount", () => {
    const createSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:overlay");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const baseVideo = document.createElement("video");
    baseVideo.currentTime = 1.2;
    const videoRef = { current: baseVideo };

    const { unmount, container } = render(
      <PrecomputedVideoOverlay
        videoRef={videoRef}
        overlayBlob={new Blob(["x"], { type: "video/webm" })}
      />,
    );

    const overlayVideo = container.querySelector("video");
    expect(overlayVideo).toBeTruthy();
    expect(createSpy).toHaveBeenCalled();

    unmount();
    expect(revokeSpy).toHaveBeenCalledWith("blob:overlay");
  });
});

