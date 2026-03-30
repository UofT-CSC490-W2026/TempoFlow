import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import UploadPage from "./page";
import React from "react";
import * as sessionStorage from '../../lib/sessionStorage';

// 1. Mock Next.js Navigation
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// 2. Mock Storage Libs
vi.mock('../../lib/sessionStorage', () => ({
  createSession: vi.fn(),
  getAnalysisMode: vi.fn(),
  getStorageMode: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../../lib/videoStorage', () => ({
  storeSessionVideo: vi.fn(),
}));

describe("UploadPage", () => {
  type MockRecorderEvent = { data: Blob };
  type MockMediaRecorderInstance = {
    mimeType?: string;
    ondataavailable: ((event: MockRecorderEvent) => void) | null;
    onstop: (() => void) | null;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    state: 'inactive' | 'recording';
  };

  const advanceToReferenceStep = async () => {
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    global.MediaRecorder = vi.fn().mockImplementation(function(this: MockMediaRecorderInstance) {
      this.start = vi.fn();
      this.stop = vi.fn(() => {
        this.ondataavailable?.({ data: new Blob(["test"], { type: "video/webm" }) });
        this.onstop?.();
      });
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onstop = null;
    }) as unknown as typeof MediaRecorder;
    Object.assign(global.MediaRecorder, {
      isTypeSupported: vi.fn().mockReturnValue(true),
    });

    const mockStream = {
      getTracks: () => [{ stop: vi.fn(), enabled: true }],
      active: true,
    };
    
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mockStream),
      },
    });

    global.URL.createObjectURL = vi.fn(() => "blob:mock-url");
    global.URL.revokeObjectURL = vi.fn();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ url: 'https://aws.com', fields: { key: 'val' } }),
    });

    vi.mocked(sessionStorage.createSession).mockReturnValue({ id: 'mock-id' } as ReturnType<typeof sessionStorage.createSession>);
    vi.mocked(sessionStorage.getAnalysisMode).mockReturnValue('api');
    vi.mocked(sessionStorage.getStorageMode).mockReturnValue('aws');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("handles camera access rejection gracefully", async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(new Error("Permission Denied"));
    render(<UploadPage />);

    await advanceToReferenceStep();
    vi.useRealTimers();

    const recordBtn = screen.getByRole("button", { name: /record reference/i });
    fireEvent.click(recordBtn);

    await waitFor(() => {
      // Adjusted matcher to be case-insensitive to match your UI output
      expect(screen.getByText(/access was blocked/i)).toBeInTheDocument();
    });
  });

  it("only shows continue after going back from practice", async () => {
    const { container } = render(<UploadPage />);
    await advanceToReferenceStep();

    expect(screen.queryByRole("button", { name: /continue/i })).not.toBeInTheDocument();

    const referenceInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const referenceFile = new File(["reference"], "reference.mp4", { type: "video/mp4" });

    await act(async () => {
      fireEvent.change(referenceInput, { target: { files: [referenceFile] } });
    });

    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(screen.getByText(/add your practice clip/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue/i })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /back/i }));
    });

    expect(screen.getByText(/choose a reference clip/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /back/i })).toBeInTheDocument();
  });

  it("applies forward and backward step transition classes", async () => {
    const { container } = render(<UploadPage />);
    await advanceToReferenceStep();

    const referenceInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const referenceFile = new File(["reference"], "reference.mp4", { type: "video/mp4" });

    await act(async () => {
      fireEvent.change(referenceInput, { target: { files: [referenceFile] } });
    });

    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(screen.getByTestId("upload-step-card").className).toContain("upload-step-enter-forward");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /back/i }));
    });

    expect(screen.getByTestId("upload-step-card").className).toContain("upload-step-enter-backward");
  });
});
