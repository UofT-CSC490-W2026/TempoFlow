import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  saveSam3OverlayFrames, 
  loadSam3OverlayFrames, 
  deleteSam3OverlayFrames 
} from './sam3OverlayStorage';
import 'fake-indexeddb/auto'; // Automatically mocks global indexedDB

describe('SAM3 Overlay Storage (IndexedDB)', () => {
  const sessionId = 'test-session-123';
  const role = 'reference';
  const mockDataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='; // Tiny valid base64

  beforeEach(() => {
    // Clear the database between tests
    const request = indexedDB.deleteDatabase('TempoFlowSam3Overlays');
    return new Promise((resolve) => {
      request.onsuccess = resolve;
    });
  });

  it('saves and loads frame data successfully', async () => {
    const frames = [mockDataUrl, mockDataUrl];

    // 1. Save
    await saveSam3OverlayFrames({ sessionId, role, framesDataUrl: frames });

    // 2. Mock URL.createObjectURL since JSDOM doesn't support it
    const mockUrl = 'blob:http://localhost/mock-blob';
    global.URL.createObjectURL = vi.fn().mockReturnValue(mockUrl);

    // 3. Load
    const loadedUrls = await loadSam3OverlayFrames({ sessionId, role });

    expect(loadedUrls).toHaveLength(2);
    expect(loadedUrls?.[0]).toBe(mockUrl);
    expect(global.URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('returns null when loading a non-existent session', async () => {
    const result = await loadSam3OverlayFrames({ 
      sessionId: 'non-existent', 
      role: 'practice' 
    });
    expect(result).toBeNull();
  });

  it('deletes all frames and manifest for a specific session and role', async () => {
    // 1. Setup: Save some data
    await saveSam3OverlayFrames({ 
      sessionId, 
      role, 
      framesDataUrl: [mockDataUrl] 
    });

    // 2. Delete
    await deleteSam3OverlayFrames({ sessionId, role });

    // 3. Verify
    const result = await loadSam3OverlayFrames({ sessionId, role });
    expect(result).toBeNull();
  });
});