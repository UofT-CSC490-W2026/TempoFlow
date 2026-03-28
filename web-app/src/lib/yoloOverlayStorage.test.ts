import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  saveYoloOverlayFrames, 
  loadYoloOverlayFrames 
} from './yoloOverlayStorage';
import 'fake-indexeddb/auto';

describe('YOLO Overlay Storage V2', () => {
  const sessionId = 'session-456';
  const role = 'practice';
  // Minimal valid base64 data URL
  const mockDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  beforeEach(() => {
    // Ensure we delete the V2 database specifically before each test
    const request = indexedDB.deleteDatabase('TempoFlowYoloOverlaysV2');
    vi.clearAllMocks();
    
    // Mock URL.createObjectURL since it's not in JSDOM
    global.URL.createObjectURL = vi.fn((blob) => `blob:mock-url-${Math.random()}`);
  });

  it('successfully persists and retrieves multiple frames as blobs', async () => {
    const framesToSave = [mockDataUrl, mockDataUrl];

    // 1. Save
    await saveYoloOverlayFrames({ 
      sessionId, 
      role, 
      framesDataUrl: framesToSave 
    });

    // 2. Load
    const loadedUrls = await loadYoloOverlayFrames({ sessionId, role });

    expect(loadedUrls).toHaveLength(2);
    expect(loadedUrls?.[0]).toContain('blob:mock-url-');
    expect(global.URL.createObjectURL).toHaveBeenCalledTimes(2);
  });
});