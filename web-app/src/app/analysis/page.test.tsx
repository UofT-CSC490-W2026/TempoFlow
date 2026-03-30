import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import AnalysisPage from "./page";
import React from "react";

// 1. Mock Next.js navigation
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: vi.fn().mockReturnValue("test-session-id"),
  }),
}));

// 2. Mock storage and processing libraries
vi.mock("../../lib/sessionStorage", () => ({
  getCurrentSessionId: vi.fn().mockReturnValue("test-session-id"),
  getSession: vi.fn(),
  setCurrentSessionId: vi.fn(),
  subscribeSessions: vi.fn(() => vi.fn()), // Returns an unsubscribe function
  updateSession: vi.fn(),
}));

vi.mock("../../lib/videoStorage", () => ({
  getSessionVideo: vi.fn(),
}));

vi.mock("../../lib/ebsStorage", () => ({
  getSessionEbs: vi.fn(),
}));

vi.mock("../../lib/sessionProcessing", () => ({
  ensureSessionProcessing: vi.fn(),
  pauseSessionProcessing: vi.fn(),
  resumeSessionProcessing: vi.fn(),
}));

// 3. Helper to mock URL.createObjectURL
global.URL.createObjectURL = vi.fn(() => "blob:mock-url");
global.URL.revokeObjectURL = vi.fn();

describe("AnalysisPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows an error state if the session is not found", async () => {
    const { getSession } = await import("../../lib/sessionStorage");
    (getSession as any).mockReturnValue(null);

    render(<AnalysisPage />);

    await waitFor(() => {
      expect(screen.getByText(/Session unavailable/i)).toBeInTheDocument();
      expect(screen.getByText(/local session no longer exists/i)).toBeInTheDocument();
    });
  });

  it("loads and displays the session processing state", async () => {
    const { getSession } = await import("../../lib/sessionStorage");
    const { getSessionVideo } = await import("../../lib/videoStorage");
    
    const mockSession = {
      id: "test-session-id",
      ebsStatus: "processing",
      referenceName: "Ref Dance",
      practiceName: "My Practice",
    };

    (getSession as any).mockReturnValue(mockSession);
    (getSessionVideo as any).mockImplementation(() => Promise.resolve(new File([], "test.mp4")));

    render(<AnalysisPage />);

    // Check for "Syncing your clips" which shows when processing
    await waitFor(() => {
      expect(screen.getByText(/Syncing your clips/i)).toBeInTheDocument();
      expect(screen.getByText(/Ref: Ref Dance/i)).toBeInTheDocument();
    });
  });

//   it("transitions to the FeedbackViewer when ebsData is loaded", async () => {
//     const { getSession } = await import("../../lib/sessionStorage");
//     const { getSessionEbs } = await import("../../lib/ebsStorage");
//     const { getSessionVideo } = await import("../../lib/videoStorage");

//     const mockEbsData = { segments: [{ id: 1 }] };
//     (getSession as any).mockReturnValue({ id: "id", ebsStatus: "ready" });
//     (getSessionVideo as any).mockReturnValue(Promise.resolve(new File([], "v.mp4")));
//     (getSessionEbs as any).mockReturnValue(Promise.resolve(mockEbsData));

//     render(<AnalysisPage />);

//     // FeedbackViewer has a title prop "TempoFlow EBS Session"
//     await waitFor(() => {
//       expect(screen.getByText("TempoFlow EBS Session")).toBeInTheDocument();
//     });
//   });

//   it("handles pausing the session processing", async () => {
//     const { getSession } = await import("../../lib/sessionStorage");
//     const { pauseSessionProcessing } = await import("../../lib/sessionProcessing");

//     (getSession as any).mockReturnValue({ id: "test-id", ebsStatus: "processing" });
    
//     render(<AnalysisPage />);

//     const pauseButton = await screen.findByRole("button", { name: /pause processing/i });
//     fireEvent.click(pauseButton);

//     expect(pauseSessionProcessing).toHaveBeenCalledWith("test-id");
//   });
});