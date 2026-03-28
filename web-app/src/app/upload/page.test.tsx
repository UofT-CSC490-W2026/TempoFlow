import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import UploadPage from "./page";
import React from "react";

// 1. Mock Next.js Navigation
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// 2. Mock Session & Video Storage
vi.mock('../../lib/sessionStorage', () => ({
  createSession: vi.fn(() => ({ id: 'mock-session-id' })),
  getAnalysisMode: vi.fn(() => 'api'),
  getStorageMode: vi.fn(() => 'aws'),
  updateSession: vi.fn(),
}));

vi.mock('../../lib/videoStorage', () => ({
  storeSessionVideo: vi.fn().mockResolvedValue(undefined),
}));

describe("UploadPage", () => {
  // Define event handlers at the top level so we can trigger them manually
  let recorderHandlers: Record<string, any> = {};

  beforeEach(() => {
    // A. Mock MediaRecorder with Event Support
    global.MediaRecorder = vi.fn().mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn().mockImplementation(function(this: any) {
        // When stop is called, manually trigger the data and stop handlers
        if (recorderHandlers['dataavailable']) {
          recorderHandlers['dataavailable']({ data: new Blob(["rec"], { type: "video/webm" }) });
        }
        if (recorderHandlers['stop']) {
          recorderHandlers['stop']();
        }
      }),
      state: 'inactive',
      set ondataavailable(fn: any) { recorderHandlers['dataavailable'] = fn; },
      set onstop(fn: any) { recorderHandlers['stop'] = fn; },
      mimeType: 'video/webm',
    })) as any;
    (global.MediaRecorder as any).isTypeSupported = vi.fn().mockReturnValue(true);

    // B. Mock navigator.mediaDevices
    const mockStream = {
      getTracks: () => [{ stop: vi.fn() }],
    };
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mockStream),
      },
    });

    // C. Mock URL & Blobs
    global.URL.createObjectURL = vi.fn(() => "blob:mock-url");
    global.URL.revokeObjectURL = vi.fn();

    // D. Mock Global Fetch (for AWS uploads)
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ url: 'https://aws.com', fields: { key: 'val' } }),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    recorderHandlers = {};
  });

  it("handles camera access rejection gracefully", async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(new Error("Permission Denied"));
    
    render(<UploadPage />);
    fireEvent.click(screen.getByRole("button", { name: /record practice video/i }));

    await waitFor(() => {
      expect(screen.getByText(/access was blocked/i)).toBeInTheDocument();
    });
  });
});