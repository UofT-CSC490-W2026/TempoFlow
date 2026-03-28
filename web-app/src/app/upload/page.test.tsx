import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import UploadPage from "./page";
import React from "react";
import * as sessionStorage from '../../lib/sessionStorage';
import * as videoStorage from '../../lib/videoStorage';

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
  let recorderHandlers: Record<string, any> = {};

  beforeEach(() => {
    // FIX: Use 'function' so it can be used as a constructor
    global.MediaRecorder = vi.fn().mockImplementation(function(this: any) {
      this.start = vi.fn();
      this.stop = vi.fn(() => {
        if (recorderHandlers['dataavailable']) {
          recorderHandlers['dataavailable']({ data: new Blob(["test"], { type: "video/webm" }) });
        }
        if (recorderHandlers['stop']) recorderHandlers['stop']();
      });
      this.state = 'inactive';
      this.addEventListener = vi.fn((ev, cb) => { recorderHandlers[ev] = cb; });
    }) as any;
    (global.MediaRecorder as any).isTypeSupported = vi.fn().mockReturnValue(true);

    // FIX: Provide a "real" MediaStream structure for Happy DOM
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

    vi.mocked(sessionStorage.createSession).mockReturnValue({ id: 'mock-id' } as any);
    vi.mocked(sessionStorage.getAnalysisMode).mockReturnValue('api');
    vi.mocked(sessionStorage.getStorageMode).mockReturnValue('aws');
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    recorderHandlers = {};
  });

  it("handles camera access rejection gracefully", async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(new Error("Permission Denied"));
    render(<UploadPage />);
    
    const recordBtn = screen.getByRole("button", { name: /record practice video/i });
    fireEvent.click(recordBtn);

    await waitFor(() => {
      // Adjusted matcher to be case-insensitive to match your UI output
      expect(screen.getByText(/access was blocked/i)).toBeInTheDocument();
    });
  });
});