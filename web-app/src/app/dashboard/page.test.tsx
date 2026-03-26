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
  ebsStatus: 'idle' | 'processing' | 'ready' | 'error';
  referenceName: string;
  practiceName: string;
  referenceSize: number;
  practiceSize: number;
  ebsMeta?: {
    segmentCount: number;
    estimatedBpm?: number;
    sharedDurationSec: number;
    generatedAt: string;
  };
};

let mockSessions: MockSession[] = [];

const getSessionsMock = vi.fn(() => mockSessions);
const deleteSessionMetadataMock = vi.fn((sessionId: string) => {
  mockSessions = mockSessions.filter((session) => session.id !== sessionId);
});
const deleteSessionEbsMock = vi.fn(async () => undefined);
const deleteSessionVideosMock = vi.fn(async () => undefined);

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
  deleteSessionMetadata: (sessionId: string) => deleteSessionMetadataMock(sessionId),
}));

vi.mock('../../lib/ebsStorage', () => ({
  deleteSessionEbs: (sessionId: string) => deleteSessionEbsMock(sessionId),
}));

vi.mock('../../lib/videoStorage', () => ({
  deleteSessionVideos: (sessionId: string) => deleteSessionVideosMock(sessionId),
}));

describe('Dashboard page', () => {
  beforeEach(() => {
    mockSessions = [];
    getSessionsMock.mockClear();
    deleteSessionMetadataMock.mockClear();
    deleteSessionEbsMock.mockClear();
    deleteSessionVideosMock.mockClear();
  });

  it('renders the empty state when there are no saved sessions', () => {
    render(React.createElement(DashboardPage));

    expect(screen.getByText(/no dances yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /upload video/i })).toHaveAttribute(
      'href',
      '/upload',
    );
  });

  it('renders existing sessions with ready-state details', () => {
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
        },
      },
    ];

    render(React.createElement(DashboardPage));

    expect(screen.getByRole('heading', { name: /your dances/i })).toBeInTheDocument();
    expect(screen.getByText('practice.mp4')).toBeInTheDocument();
    expect(screen.getByText(/ref: reference\.mp4/i)).toBeInTheDocument();
    expect(screen.getByText('6 segments')).toBeInTheDocument();
    expect(screen.getByText('128 BPM')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open session/i })).toHaveAttribute(
      'href',
      '/analysis?session=session-1',
    );
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
