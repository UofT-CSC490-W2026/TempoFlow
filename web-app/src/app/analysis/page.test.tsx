import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import AnalysisPage from "./page";
import React from "react";

const mockSubscribeSessions = vi.fn(() => vi.fn());

// 1. Mock Next.js Navigation
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
  subscribeSessions: (...args: unknown[]) => mockSubscribeSessions(...args),
  updateSession: vi.fn((id, data) => ({ id, ...data })),
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
    global.URL.createObjectURL = vi.fn(() => "blob:mock-url");
    global.URL.revokeObjectURL = vi.fn();
    mockSubscribeSessions.mockReturnValue(vi.fn());
    
    vi.mocked(getSession).mockReturnValue(mockSession as ReturnType<typeof getSession>);
    vi.mocked(getSessionVideo).mockResolvedValue(new File([], "test.mp4"));
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
});