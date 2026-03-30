import {
  createSession,
  deleteSessionMetadata,
  getAnalysisMode,
  getCurrentSessionId,
  getSession,
  getSessions,
  getStorageMode,
  updateSession,
} from './sessionStorage';

const STORAGE_KEY = 'tempoflow.sessions';

describe('sessionStorage helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to local modes when env vars are unset', () => {
    expect(getStorageMode()).toBe('local');
    expect(getAnalysisMode()).toBe('local');
  });

  it('reads the configured storage and analysis modes from env vars', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_STORAGE_MODE', 'aws');
    vi.stubEnv('NEXT_PUBLIC_APP_ANALYSIS_MODE', 'api');

    expect(getStorageMode()).toBe('aws');
    expect(getAnalysisMode()).toBe('api');
  });

  it('creates a session, persists it, and marks it current', () => {
    const session = createSession({
      referenceName: 'ref.mp4',
      practiceName: 'practice.mp4',
      referenceSize: 123,
      practiceSize: 456,
    });

    expect(getCurrentSessionId()).toBe(session.id);
    expect(getSession(session.id)).toMatchObject({
      id: session.id,
      status: 'uploaded',
      ebsStatus: 'idle',
      referenceName: 'ref.mp4',
      practiceName: 'practice.mp4',
    });
  });

  it('returns sessions sorted by most recently updated first', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: 'older',
          createdAt: '2026-03-25T09:00:00.000Z',
          updatedAt: '2026-03-25T09:00:00.000Z',
          storageMode: 'local',
          analysisMode: 'local',
          status: 'uploaded',
          ebsStatus: 'idle',
          referenceName: 'older-ref.mp4',
          practiceName: 'older-practice.mp4',
          referenceSize: 1,
          practiceSize: 1,
        },
        {
          id: 'newer',
          createdAt: '2026-03-25T10:00:00.000Z',
          updatedAt: '2026-03-25T11:00:00.000Z',
          storageMode: 'local',
          analysisMode: 'local',
          status: 'analyzed',
          ebsStatus: 'ready',
          referenceName: 'newer-ref.mp4',
          practiceName: 'newer-practice.mp4',
          referenceSize: 1,
          practiceSize: 1,
        },
      ]),
    );

    expect(getSessions().map((session) => session.id)).toEqual(['newer', 'older']);
  });

  it('updates an existing session and refreshes its timestamp', () => {
    const session = createSession({
      referenceName: 'ref.mp4',
      practiceName: 'practice.mp4',
      referenceSize: 123,
      practiceSize: 456,
    });

    vi.setSystemTime(new Date('2026-03-25T12:05:00.000Z'));
    const updated = updateSession(session.id, {
      status: 'analyzed',
      errorMessage: 'Recovered from a transient issue.',
    });

    expect(updated).toMatchObject({
      id: session.id,
      status: 'analyzed',
      errorMessage: 'Recovered from a transient issue.',
      updatedAt: '2026-03-25T12:05:00.000Z',
    });
  });

  it('returns null for a missing session update or lookup', () => {
    expect(getSession('missing-session')).toBeNull();
    expect(updateSession('missing-session', { status: 'error' })).toBeNull();
  });

  it('removes a deleted session and clears the current session pointer', () => {
    const session = createSession({
      referenceName: 'ref.mp4',
      practiceName: 'practice.mp4',
      referenceSize: 123,
      practiceSize: 456,
    });

    deleteSessionMetadata(session.id);

    expect(getSession(session.id)).toBeNull();
    expect(getCurrentSessionId()).toBeNull();
  });

  it('falls back to an empty session list when storage contains malformed JSON', () => {
    window.localStorage.setItem(STORAGE_KEY, 'not-json');

    expect(getSessions()).toEqual([]);
  });
});
