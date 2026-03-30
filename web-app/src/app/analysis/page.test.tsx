import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import AnalysisPage from "./page"; // Adjust path accordingly
import { getSession } from "../../lib/sessionStorage";
import { getSessionVideo } from "../../lib/videoStorage";

const mockSubscribeSessions = vi.fn(() => vi.fn());

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
  subscribeSessions: (...args: unknown[]) => mockSubscribeSessions(...args),
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

  beforeEach(() => {
    vi.clearAllMocks();
    global.URL.createObjectURL = vi.fn(() => "blob:mock-url");
    global.URL.revokeObjectURL = vi.fn();
    mockSubscribeSessions.mockReturnValue(vi.fn());
    
    vi.mocked(getSession).mockReturnValue(mockSession as ReturnType<typeof getSession>);
    vi.mocked(getSessionVideo).mockResolvedValue(new File([], "test.mp4"));
  });

  it("shows loading spinner initially", () => {
    render(<AnalysisPage />);
    expect(screen.getByText(/Loading session/i)).toBeInTheDocument();
  });

});
