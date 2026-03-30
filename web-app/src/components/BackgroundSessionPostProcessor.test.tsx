import { render, waitFor, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BackgroundSessionPostProcessor } from "./BackgroundSessionPostProcessor";
import * as sessionStorage from "../lib/sessionStorage";
import * as videoStorage from "../lib/videoStorage";
import * as ebsStorage from "../lib/ebsStorage";
import { usePathname, useSearchParams } from "next/navigation";

// Mock Next.js navigation
vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
  useSearchParams: vi.fn(),
}));

// Mock the sub-component to avoid running heavy logic
vi.mock("./ebs/GeminiFeedbackPanel", () => ({
  GeminiFeedbackPanel: vi.fn(() => <div data-testid="gemini-panel" />),
}));

// Mock storage utilities
vi.mock("../lib/sessionStorage");
vi.mock("../lib/videoStorage");
vi.mock("../lib/ebsStorage");
vi.mock("../lib/ensureBrowserYoloOverlays", () => ({
  ensureBrowserYoloOverlays: vi.fn().mockResolvedValue(undefined),
  BROWSER_YOLO_OVERLAY_FPS: 30,
  BROWSER_YOLO_VARIANT: "standard",
}));

describe("BackgroundSessionPostProcessor", () => {
  const mockSession = {
    id: "session-123",
    status: "recorded",
    ebsStatus: "processing", // Initial state
    ebsMeta: {},
  };

  // 1. Fixed Mock Data: Matches the requirements of buildEbsMeta
  const mockEbsData = {
    segments: [{ beat_idx_range: [0, 10] }],
    alignment: { shared_len_sec: 30 }, // Missing in previous run
    beat_tracking: { estimated_bpm: 120 },
    segmentation_mode: "auto"
  };

  beforeEach(() => {
    vi.clearAllMocks();
    global.URL.createObjectURL = vi.fn(() => "blob:mock-url");
    global.URL.revokeObjectURL = vi.fn();

    (usePathname as any).mockReturnValue("/");
    (useSearchParams as any).mockReturnValue({ get: () => null });

    // 2. Mock Implementation: Ensure it returns the session when queried
    (sessionStorage.getSessions as any).mockReturnValue([mockSession]);
    (sessionStorage.getSession as any).mockImplementation((id: string) => 
    id === "session-123" ? mockSession : null
    );
    (ebsStorage.getSessionEbs as any).mockResolvedValue(mockEbsData);
    (videoStorage.getSessionVideo as any).mockResolvedValue(new Blob([], { type: 'video/mp4' }));
  });

  it("should pick up a session that needs processing and start active status", async () => {
    render(<BackgroundSessionPostProcessor />);

    // Increased timeout slightly because chooseNextSession is async
    await waitFor(() => {
      expect(sessionStorage.updateSession).toHaveBeenCalledWith(
        "session-123",
        expect.objectContaining({
          ebsStatus: "processing"
        })
      );
    }, { timeout: 2000 });
  });

  it("cleans up Blob URLs when the component unmounts or session changes", async () => {
    const { unmount } = render(<BackgroundSessionPostProcessor />);

    // Wait for the worker to actually start and create the URLs
    await waitFor(() => {
        expect(global.URL.createObjectURL).toHaveBeenCalled();
    });

    unmount();

    // Verify cleanup
    expect(global.URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });
});