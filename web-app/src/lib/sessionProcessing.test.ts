import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { 
  ensureSessionProcessing, 
  pauseSessionProcessing, 
  resumeSessionProcessing 
} from "./sessionProcessing";
import { getSession, updateSession } from "./sessionStorage";
import { getSessionVideo } from "./videoStorage";
import { getSessionEbs, storeSessionEbs } from "./ebsStorage";

// --- Mock Setup ---

vi.mock("./sessionStorage", () => ({
  getSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock("./videoStorage", () => ({
  getSessionVideo: vi.fn(),
}));

vi.mock("./ebsStorage", () => ({
  getSessionEbs: vi.fn(),
  storeSessionEbs: vi.fn(),
}));

vi.mock("./ebsProcessorUrl", () => ({
  getProcessorBaseUrl: () => "http://localhost:5000",
  getPublicEbsProcessorUrl: () => "http://localhost:5000/process",
  isLocalDevProcessorUrl: () => true,
}));

// Helper to provide a valid EbsData structure for buildEbsMeta
const createMockEbsData = (overrides = {}) => ({
  segments: [],
  segmentation_mode: "auto",
  beat_tracking: { estimated_bpm: 120 },
  alignment: { shared_len_sec: 30 }, // Fixed the TypeError source
  ...overrides,
});

describe("Session Processing Logic", () => {
  const sessionId = "test-session-123";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("ensureSessionProcessing", () => {
    it("stops immediately if session is already 'ready'", async () => {
      (getSession as any).mockReturnValue({ ebsStatus: "ready" });
      await ensureSessionProcessing(sessionId);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("adopts a cached artifact if found in local storage", async () => {
      (getSession as any).mockReturnValue({ 
        id: sessionId, 
        ebsStatus: "processing",
        ebsMeta: {} 
      });
      
      const mockCachedData = createMockEbsData();
      (getSessionEbs as any).mockResolvedValue(mockCachedData);

      await ensureSessionProcessing(sessionId);

      expect(storeSessionEbs).toHaveBeenCalledWith(sessionId, mockCachedData);
      expect(updateSession).toHaveBeenCalledWith(
        sessionId, 
        expect.objectContaining({ status: "analyzed" })
      );
    });

    it("starts polling if the remote server reports it is already processing", async () => {
      (getSession as any).mockReturnValue({ ebsStatus: "processing" });
      (getSessionEbs as any).mockResolvedValue(null);
      
      // Mock /api/status response
      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "processing" }),
      });

      // Fire the async process
      const processingPromise = ensureSessionProcessing(sessionId);

      // Advance timers to trigger the first interval check
      await vi.advanceTimersByTimeAsync(1200); 
      
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/status"), 
        expect.anything()
      );
    });

    it("starts a fresh upload if no remote processing is found", async () => {
      (getSession as any).mockReturnValue({ ebsStatus: "processing" });
      (getSessionEbs as any).mockResolvedValue(null);
      (getSessionVideo as any).mockResolvedValue(new File([], "video.mp4"));
      
      // Initial status check says nothing is on the server
      (fetch as any).mockResolvedValueOnce({ ok: false }); 
      
      // Mock the POST upload result
      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(createMockEbsData()),
      });

      await ensureSessionProcessing(sessionId);

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/process"), 
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  describe("Pause and Resume", () => {
    it("pauses an active runtime and updates session status", () => {
      (getSession as any).mockReturnValue({ id: sessionId, ebsStatus: "processing" });

      pauseSessionProcessing(sessionId);

      expect(updateSession).toHaveBeenCalledWith(sessionId, expect.objectContaining({
        ebsStatus: "paused"
      }));
    });

    it("resumes a paused session", async () => {
      (getSession as any).mockReturnValue({ id: sessionId, ebsStatus: "paused" });
      (getSessionEbs as any).mockResolvedValue(null);
      (fetch as any).mockResolvedValue({ ok: false });

      await resumeSessionProcessing(sessionId);

      expect(updateSession).toHaveBeenCalledWith(sessionId, expect.objectContaining({
        ebsStatus: "processing"
      }));
    });
  });

  describe("Error Handling", () => {
    it("handles fetch failure with a friendly error message", async () => {
      (getSession as any).mockReturnValue({ ebsStatus: "processing" });
      (getSessionVideo as any).mockResolvedValue(new File([], "video.mp4"));
      (fetch as any).mockRejectedValue(new Error("Failed to fetch"));

      await ensureSessionProcessing(sessionId);

      expect(updateSession).toHaveBeenCalledWith(sessionId, expect.objectContaining({
        ebsStatus: "error",
        ebsErrorMessage: expect.stringContaining("Couldn't reach the clip processor")
      }));
    });

    it("aborts processing if MAX_EBS_PROCESSING_SECONDS is exceeded", async () => {
      (getSession as any).mockReturnValue({ ebsStatus: "processing" });
      (getSessionVideo as any).mockResolvedValue(new File([], "v.mp4"));
      
      // Mock initial status check to return nothing
      (fetch as any).mockResolvedValueOnce({ ok: false });
      
      // Start the upload
      const uploadPromise = ensureSessionProcessing(sessionId);

      // Advance time past the 5-minute limit (300 seconds)
      await vi.advanceTimersByTimeAsync(301000);

      // The catch block in startUpload should trigger the error state update
      expect(updateSession).toHaveBeenCalledWith(sessionId, expect.objectContaining({
        ebsStatus: "error"
      }));
    });
  });
});