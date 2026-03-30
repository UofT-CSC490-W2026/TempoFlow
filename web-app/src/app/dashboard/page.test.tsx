import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import DashboardPage from './page';

type MockSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  storageMode: 'local' | 'api' | 'aws';
  analysisMode: 'local' | 'api';
  status: 'uploaded' | 'analyzing' | 'analyzed' | 'error';
  ebsStatus: 'idle' | 'processing' | 'paused' | 'ready' | 'error';
  referenceName: string;
  practiceName: string;
  referenceSize: number;
  practiceSize: number;
  ebsMeta?: {
    segmentCount: number;
    estimatedBpm?: number;
    sharedDurationSec: number;
    generatedAt: string;
    finalScore?: number;
  };
};

let mockSessions: MockSession[] = [];

const getSessionsMock = vi.fn(() => mockSessions);
const subscribeSessionsMock = vi.fn(() => () => undefined);
const deleteSessionMetadataMock = vi.fn((sessionId: string) => {
  mockSessions = mockSessions.filter((session) => session.id !== sessionId);
});
const deleteSessionEbsMock = vi.fn(async () => undefined);
const deleteSessionVideosMock = vi.fn(async () => undefined);
const getSessionVideoMock = vi.fn(async () => null);
const ensureSessionProcessingMock = vi.fn(async () => undefined);
const pauseSessionProcessingMock = vi.fn(() => undefined);
const resumeSessionProcessingMock = vi.fn(async () => undefined);

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    React.createElement('a', { href, ...props }, children),
}));

vi.mock('../../lib/sessionStorage', () => ({
  getSessions: () => getSessionsMock(),
  subscribeSessions: () => subscribeSessionsMock(),
  deleteSessionMetadata: (sessionId: string) => deleteSessionMetadataMock(sessionId),
}));

vi.mock('../../lib/ebsStorage', () => ({
  deleteSessionEbs: (sessionId: string) => deleteSessionEbsMock(sessionId),
}));

vi.mock('../../lib/sessionProcessing', () => ({
  ensureSessionProcessing: (sessionId: string) => ensureSessionProcessingMock(sessionId),
  pauseSessionProcessing: (sessionId: string) => pauseSessionProcessingMock(sessionId),
  resumeSessionProcessing: (sessionId: string) => resumeSessionProcessingMock(sessionId),
}));

vi.mock('../../lib/sessionPostProcessing', () => ({
  isSessionPostProcessComplete: (session: MockSession) =>
    session.ebsMeta?.postProcessStatus === 'ready' || session.ebsMeta?.finalScore != null,
  shouldTreatSessionAsInProcess: (session: MockSession) =>
    session.ebsStatus === 'processing' || session.status === 'analyzing',
}));

vi.mock('../../lib/videoStorage', () => ({
  deleteSessionVideos: (sessionId: string) => deleteSessionVideosMock(sessionId),
  getSessionVideo: (sessionId: string, role: string) => getSessionVideoMock(sessionId, role),
}));

describe('Dashboard page', () => {
  beforeEach(() => {
    mockSessions = [];
    getSessionsMock.mockClear();
    deleteSessionMetadataMock.mockClear();
    deleteSessionEbsMock.mockClear();
    deleteSessionVideosMock.mockClear();
    getSessionVideoMock.mockClear();
    subscribeSessionsMock.mockClear();
    ensureSessionProcessingMock.mockClear();
    pauseSessionProcessingMock.mockClear();
    resumeSessionProcessingMock.mockClear();
  });

  it('renders the empty state when there are no saved sessions', () => {
    render(React.createElement(DashboardPage));

    expect(screen.getByText(/no sessions/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /start/i })).toHaveAttribute(
      'href',
      '/upload',
    );
  });

  it('renders processed sessions with score details', () => {
    mockSessions = [
      {
        id: 'session-1',
        createdAt: '2026-03-25T11:00:00.000Z',
        updatedAt: '2026-03-25T12:00:00.000Z',
        storageMode: 'local',
        analysisMode: 'api',
        status: 'analyzed',
        ebsStatus: 'ready',
        referenceName: 'reference.mp4',
        practiceName: 'practice.mp4',
        referenceSize: 100,
        practiceSize: 200,
        ebsMeta: {
          segmentCount: 6,
          estimatedBpm: 128,
          sharedDurationSec: 14,
          generatedAt: '2026-03-25T12:00:00.000Z',
          finalScore: 87,
        },
      },
    ];

    render(React.createElement(DashboardPage));

    expect(screen.getByRole('heading', { name: /sessions/i })).toBeInTheDocument();
    expect(screen.getByText('practice.mp4')).toBeInTheDocument();
    expect(screen.getByText(/ref: reference\.mp4/i)).toBeInTheDocument();
    expect(screen.getByText(/score 87\/100/i)).toBeInTheDocument();
    expect(screen.getByText(/latest processed score:/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^open$/i })).toHaveAttribute(
      'href',
      '/analysis?session=session-1',
    );
  });

  it('shows pause and resume controls for background processing states', async () => {
    mockSessions = [
      {
        id: 'session-processing',
        createdAt: '2026-03-25T11:00:00.000Z',
        updatedAt: '2026-03-25T12:00:00.000Z',
        storageMode: 'local',
        analysisMode: 'local',
        status: 'analyzing',
        ebsStatus: 'processing',
        referenceName: 'reference.mp4',
        practiceName: 'practice.mp4',
        referenceSize: 100,
        practiceSize: 200,
      },
      {
        id: 'session-paused',
        createdAt: '2026-03-25T11:00:00.000Z',
        updatedAt: '2026-03-25T12:00:00.000Z',
        storageMode: 'local',
        analysisMode: 'local',
        status: 'analyzing',
        ebsStatus: 'paused',
        referenceName: 'reference-2.mp4',
        practiceName: 'practice-2.mp4',
        referenceSize: 100,
        practiceSize: 200,
      },
    ];

    render(React.createElement(DashboardPage));

    expect(ensureSessionProcessingMock).toHaveBeenCalledWith('session-processing');
    expect(screen.getByText(/in process/i)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /pause processing/i })[0]!);
    expect(pauseSessionProcessingMock).toHaveBeenCalledWith('session-processing');

    fireEvent.click(screen.getByRole('button', { name: /resume processing/i }));
    await waitFor(() => {
      expect(resumeSessionProcessingMock).toHaveBeenCalledWith('session-paused');
    });
  });

  it('deletes a session and refreshes the list', async () => {
    mockSessions = [
      {
        id: 'session-delete',
        createdAt: '2026-03-25T11:00:00.000Z',
        updatedAt: '2026-03-25T12:00:00.000Z',
        storageMode: 'local',
        analysisMode: 'local',
        status: 'analyzed',
        ebsStatus: 'ready',
        referenceName: 'reference.mp4',
        practiceName: 'practice.mp4',
        referenceSize: 100,
        practiceSize: 200,
        ebsMeta: {
          segmentCount: 4,
          sharedDurationSec: 9,
          generatedAt: '2026-03-25T12:00:00.000Z',
        },
      },
    ];

    render(React.createElement(DashboardPage));
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    await waitFor(() => {
      expect(deleteSessionVideosMock).toHaveBeenCalledWith('session-delete');
      expect(deleteSessionEbsMock).toHaveBeenCalledWith('session-delete');
      expect(deleteSessionMetadataMock).toHaveBeenCalledWith('session-delete');
      expect(screen.queryByText('practice.mp4')).not.toBeInTheDocument();
    });
  });
});
