import {
  buildOverlayKey,
  deleteSessionOverlay,
  getSessionOverlay,
  storeSessionOverlay,
  type OverlayArtifact,
} from './overlayStorage';

describe('overlayStorage helpers', () => {
  it('builds stable keys with default and explicit variants', () => {
    expect(
      buildOverlayKey({
        sessionId: 'session-1',
        type: 'yolo',
        side: 'reference',
        fps: 30,
      }),
    ).toBe('session-1:overlay:yolo:reference:30:default');

    expect(
      buildOverlayKey({
        sessionId: 'session-1',
        type: 'movenet',
        side: 'practice',
        fps: 24,
        variant: 'preview',
      }),
    ).toBe('session-1:overlay:movenet:practice:24:preview');
  });

  it('stores, reads, and deletes overlay artifacts', async () => {
    const key = buildOverlayKey({
      sessionId: 'session-2',
      type: 'fastsam',
      side: 'practice',
      fps: 30,
      variant: 'latest',
    });
    const artifact: OverlayArtifact = {
      version: 1,
      type: 'fastsam',
      side: 'practice',
      fps: 30,
      width: 1280,
      height: 720,
      frameCount: 2,
      createdAt: '2026-03-25T12:00:00.000Z',
      frames: ['frame-a', 'frame-b'],
      meta: { source: 'vitest' },
    };

    await storeSessionOverlay(key, artifact);
    expect(await getSessionOverlay(key)).toEqual(artifact);

    await deleteSessionOverlay(key);
    expect(await getSessionOverlay(key)).toBeNull();
  });
});
