"use client";

import { useState } from 'react';
import Link from 'next/link';

import { deleteSessionMetadata, getSessions, TempoFlowSession } from '../../lib/sessionStorage';
import { deleteSessionEbs } from '../../lib/ebsStorage';
import { deleteSessionVideos } from '../../lib/videoStorage';

export default function DashboardPage() {
  const [sessions, setSessions] = useState<TempoFlowSession[]>(() => getSessions());

  const handleDelete = async (sessionId: string) => {
    await Promise.all([deleteSessionVideos(sessionId), deleteSessionEbs(sessionId)]);
    deleteSessionMetadata(sessionId);
    setSessions(getSessions());
  };

  const formatUpdatedAt = (value: string) => {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(value));
  };

  return (
    <div className="min-h-screen bg-white">
      <div className="fixed top-0 left-0 right-0 bg-white/80 backdrop-blur-md border-b border-gray-100 z-10">
        <div className="flex items-center justify-between px-6 py-4">
          <Link href="/" className="text-2xl font-bold text-gray-900">
            TempoFlow
          </Link>
            <Link
              href="/upload"
              className="px-4 py-2 bg-gray-900 text-white rounded-full text-sm font-medium hover:bg-gray-800 transition-all active:scale-95"
            >
              New Session
            </Link>
        </div>
      </div>

      <div className="px-6 py-24 max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">Your Dances</h1>
          <p className="text-gray-600">Track local sessions, reopen EBS practice views, and keep iterating quickly.</p>
        </div>

        {sessions.length > 0 ? (
          <div className="space-y-4">
            {sessions.map((session) => (
              <div
                key={session.id}
                className="rounded-3xl border border-gray-200 bg-gray-50 p-6 transition-all hover:border-gray-300 hover:bg-white"
              >
                <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
                  <div className="flex items-center gap-4">
                    <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-purple-500 to-pink-500">
                      <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>

                    <div className="min-w-0">
                      <h3 className="truncate font-semibold text-gray-900">
                        {session.practiceName}
                      </h3>
                      <p className="text-sm text-gray-500">
                        Ref: {session.referenceName}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Updated {formatUpdatedAt(session.updatedAt)} · Storage {session.storageMode} · Analysis {session.analysisMode}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    {session.ebsStatus === 'ready' && session.ebsMeta ? (
                      <div className="rounded-2xl bg-white px-4 py-3 text-right shadow-sm">
                        <div className="text-lg font-bold text-gray-900">{session.ebsMeta.segmentCount} segments</div>
                        <div className="text-xs text-gray-500">
                          {session.ebsMeta.estimatedBpm ? `${Math.round(session.ebsMeta.estimatedBpm)} BPM` : 'EBS ready'}
                        </div>
                      </div>
                    ) : session.status === 'error' ? (
                      <div className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">
                        Needs retry
                      </div>
                    ) : (
                      <div className="rounded-full bg-yellow-100 px-3 py-1 text-xs font-medium text-yellow-700">
                        Analyzing
                      </div>
                    )}

                    <Link
                      href={`/analysis?session=${session.id}`}
                      className="rounded-full bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-gray-800"
                    >
                      Open Session
                    </Link>
                    <button
                      onClick={() => handleDelete(session.id)}
                      className="rounded-full bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition-all hover:bg-gray-200"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-16">
            <div className="w-20 h-20 mx-auto bg-gray-100 rounded-3xl flex items-center justify-center mb-4">
              <svg className="w-10 h-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-gray-900 mb-2">No dances yet</h3>
            <p className="text-gray-600 mb-6">Upload your first video to get started</p>
            <Link
              href="/upload"
              className="inline-flex items-center justify-center px-6 py-3 text-base font-medium text-white bg-gray-900 rounded-full hover:bg-gray-800 transition-all active:scale-95"
            >
              Upload Video
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
