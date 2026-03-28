import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 1. MOCK HOISTING
const compareMock = vi.fn();
vi.mock("../../lib/bodyPixComparison", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    compareWithBodyPix: (...args: any[]) => compareMock(...args),
  };
});

vi.mock("../../lib/ebsTemporalLlm", () => ({
  buildPerFrameCoachPayload: vi.fn(() => ({ frames: [] })),
  buildFallbackPerFrameOutputs: vi.fn(() => []),
}));

import { FeedbackPanel } from "./FeedbackPanel";

const FeedbackPanelComponent = FeedbackPanel as React.ComponentType<any>;

describe("FeedbackPanel", () => {
  const defaultProps = {
    referenceVideoUrl: "ref.mp4",
    userVideoUrl: "user.mp4",
    segments: [{ start: 0, end: 10 }],
    sharedTime: 0,
    onSeek: vi.fn(),
    onFeedbackReady: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
    Element.prototype.scrollTo = vi.fn();
  });

  it("renders the empty state initially", () => {
    render(<FeedbackPanelComponent {...defaultProps} />);
    expect(screen.getByText(/Ready to compare/i)).toBeInTheDocument();
    // Verify specifically that the button exists and is enabled
    expect(screen.getByRole("button", { name: /Run Comparison/i })).toBeEnabled();
  });

  it("shows progress bar while running comparison", async () => {
    compareMock.mockReturnValue(new Promise(() => {}));

    render(<FeedbackPanelComponent {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /Run Comparison/i }));

    expect(screen.getByText(/Analyzing.../i)).toBeInTheDocument();
  });

  it("displays feedback items and body diagram after successful run", async () => {
    const mockFeedback = [
      {
        timestamp: 1.5,
        severity: "major",
        featureFamily: "upper_body",
        message: "Arm too high",
        importanceRank: 1,
      },
    ];

    compareMock.mockResolvedValue({
      feedback: mockFeedback,
      refSamples: [],
      userSamples: [],
    });

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ frames: [], source: "groq" }),
    });

    render(<FeedbackPanelComponent {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /Run Comparison/i }));

    await waitFor(() => {
      expect(screen.getByText(/1 finding/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Body diagram/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Arm too high/i)).toBeInTheDocument();
    expect(screen.getByText(/Upper body/i)).toBeInTheDocument();
  });

  it("filters feedback list by severity", async () => {
    const mockFeedback = [
      { timestamp: 1, severity: "major", message: "Error 1" },
      { timestamp: 2, severity: "minor", message: "Error 2" },
    ];

    compareMock.mockResolvedValue({ feedback: mockFeedback, refSamples: [], userSamples: [] });
    (global.fetch as any).mockResolvedValue({ ok: true, json: async () => ({}) });

    render(<FeedbackPanelComponent {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /Run Comparison/i }));

    await screen.findByText("Error 1");

    const majorFilter = screen.getByRole("button", { 
        name: /^Focus here$/i 
        });
    fireEvent.click(majorFilter);

    expect(screen.getByText("Error 1")).toBeInTheDocument();
    expect(screen.queryByText("Error 2")).not.toBeInTheDocument();
  });

  it("triggers onSeek when a feedback item is clicked", async () => {
    const mockFeedback = [{ timestamp: 5.5, severity: "moderate", message: "Jump early" }];
    compareMock.mockResolvedValue({ feedback: mockFeedback, refSamples: [], userSamples: [] });
    (global.fetch as any).mockResolvedValue({ ok: true, json: async () => ({}) });

    render(<FeedbackPanelComponent {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /Run Comparison/i }));

    const feedbackBtn = await screen.findByText(/Jump early/i);
    fireEvent.click(feedbackBtn);

    expect(defaultProps.onSeek).toHaveBeenCalledWith(5.5);
  });
});