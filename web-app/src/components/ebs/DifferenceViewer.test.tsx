import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/bodyPixOverlayGenerator", () => ({
  generateBodyPixOverlayFrames: vi
    .fn()
    .mockResolvedValueOnce({
      fps: 12,
      frames: ["ref-1", "ref-2"],
      width: 320,
      height: 180,
    })
    .mockResolvedValueOnce({
      fps: 12,
      frames: ["user-1", "user-2"],
      width: 320,
      height: 180,
    }),
}));

import { DifferenceViewer } from "./DifferenceViewer";

describe("DifferenceViewer", () => {
  it("renders and completes generation flow", async () => {
    render(
      <DifferenceViewer
        referenceVideoUrl="ref.mp4"
        userVideoUrl="user.mp4"
      />,
    );

    expect(screen.getByText(/Initializing|Extracting Instructor Ghost/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Sync Active")).toBeInTheDocument();
    });
    expect(screen.getByText(/Engine: EBS_DIFF_V2/i)).toBeInTheDocument();
  });
});

