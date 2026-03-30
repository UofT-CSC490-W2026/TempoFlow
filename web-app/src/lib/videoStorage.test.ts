import {
  clearVideos,
  deleteSessionVideos,
  getSessionVideo,
  storeSessionVideo,
} from './videoStorage';

describe('videoStorage helpers', () => {
  it('stores and retrieves videos by session and role', async () => {
    const file = new File(['reference-video'], 'reference.mp4', { type: 'video/mp4' });

    await storeSessionVideo('session-alpha', 'reference', file);

    const stored = await getSessionVideo('session-alpha', 'reference');

    expect(stored).not.toBeNull();
    await expect(getSessionVideo('session-alpha', 'practice')).resolves.toBeNull();
  });

  it('deletes every stored role for a session', async () => {
    await storeSessionVideo(
      'session-beta',
      'reference',
      new File(['ref'], 'reference.mp4', { type: 'video/mp4' }),
    );
    await storeSessionVideo(
      'session-beta',
      'practice',
      new File(['practice'], 'practice.mp4', { type: 'video/mp4' }),
    );
    await storeSessionVideo(
      'session-beta',
      'reference-sam3',
      new File(['ref-sam3'], 'reference-sam3.mp4', { type: 'video/mp4' }),
    );
    await storeSessionVideo(
      'session-beta',
      'practice-sam3',
      new File(['practice-sam3'], 'practice-sam3.mp4', { type: 'video/mp4' }),
    );

    await deleteSessionVideos('session-beta');

    await expect(getSessionVideo('session-beta', 'reference')).resolves.toBeNull();
    await expect(getSessionVideo('session-beta', 'practice')).resolves.toBeNull();
    await expect(getSessionVideo('session-beta', 'reference-sam3')).resolves.toBeNull();
    await expect(getSessionVideo('session-beta', 'practice-sam3')).resolves.toBeNull();
  });

  it('clears videos across sessions', async () => {
    await storeSessionVideo(
      'session-one',
      'reference',
      new File(['one'], 'one.mp4', { type: 'video/mp4' }),
    );
    await storeSessionVideo(
      'session-two',
      'practice',
      new File(['two'], 'two.mp4', { type: 'video/mp4' }),
    );

    await clearVideos();

    await expect(getSessionVideo('session-one', 'reference')).resolves.toBeNull();
    await expect(getSessionVideo('session-two', 'practice')).resolves.toBeNull();
  });
});
