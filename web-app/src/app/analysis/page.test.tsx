import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import AnalysisPage from "./page"; // Adjust path accordingly
import { getSession, getCurrentSessionId } from "../../lib/sessionStorage";
import { getSessionVideo } from "../../lib/videoStorage";
import { getSessionEbs } from "../../lib/ebsStorage";

// 1. Mock Next.js Navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams({ session: "test-session-123" }),
}));

// 2. Mock Storage Libs
vi.mock("../../lib/sessionStorage", () => ({
  getSession: vi.fn(),
  getCurrentSessionId: vi.fn(),
  setCurrentSessionId: vi.fn(),
  updateSession: vi.fn((id, data) => ({ id, ...data })),
}));

vi.mock("../../lib/videoStorage", () => ({
  getSessionVideo: vi.fn(),
}));

vi.mock("../../lib/ebsStorage", () => ({
  getSessionEbs: vi.fn(),
  storeSessionEbs: vi.fn(),
}));

// 3. Mock Sub-components (to keep tests focused on page logic)
vi.mock("../../components/ebs/FeedbackViewer", () => ({
  FeedbackViewer: () => <div data-testid="feedback-viewer">Analysis viewer</div>,
}));

describe("AnalysisPage", () => {
  const mockSession = {
    id: "test-session-123",
    referenceName: "ref.mp4",
    practiceName: "prac.mp4",
    status: "idle",
  };

  const mockEbsData = {
    segments: [{ id: 1, start: 0, end: 5 }],
    alignment: { shared_len_sec: 10 },
    beat_tracking: { estimated_bpm: 120 },
    segmentation_mode: "auto",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    global.URL.createObjectURL = vi.fn(() => "blob:mock-url");
    global.URL.revokeObjectURL = vi.fn();
    
    // Default mock returns
    (getSession as any).mockReturnValue(mockSession);
    (getSessionVideo as any).mockResolvedValue(new File([], "test.mp4"));
  });

  it("shows loading spinner initially", () => {
    render(<AnalysisPage />);
    expect(screen.getByText(/Loading session/i)).toBeInTheDocument();
  });

});