"use client";

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';

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
    <div className="min-h-screen bg-slate-50">
      <div className="fixed top-0 left-0 right-0 bg-white/80 backdrop-blur-md border-b border-slate-100 z-10">
        <div className="flex items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center">
            <Image 
              src="/logo.png" 
              alt="TempoFlow" 
              width={140} 
              height={40}
              className="rounded"
              priority
            />
          </Link>
          <Link
            href="/upload"
            className="px-4 py-2 bg-gradient-to-r from-blue-500 to-cyan-400 text-white rounded-full text-sm font-medium hover:from-blue-600 hover:to-cyan-500 transition-all active:scale-95"
          >
            New Session
          </Link>
        </div>
      </div>

      <div className="px-6 pt-24 pb-12 max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-800 mb-1">Sessions</h1>
        </div>

        {sessions.length > 0 ? (
          <div className="space-y-4">
            {sessions.map((session) => (
              <div
                key={session.id}
                className="rounded-2xl border border-slate-200 bg-white p-5 transition-all hover:border-blue-300 hover:shadow-sm"
              >
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div className="flex items-center gap-4">
                    <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-cyan-400">
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

                  <div className="flex flex-wrap items-center gap-2">
                    {session.ebsStatus === 'ready' && session.ebsMeta ? (
                      <div className="rounded-xl bg-slate-50 px-3 py-2 text-right">
                        <div className="text-base font-bold text-slate-800">{session.ebsMeta.segmentCount} segments</div>
                        <div className="text-xs text-slate-500">
                          {session.ebsMeta.estimatedBpm ? `${Math.round(session.ebsMeta.estimatedBpm)} BPM` : 'EBS ready'}
                        </div>
                      </div>
                    ) : session.status === 'error' ? (
                      <div className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">
                        Needs retry
                      </div>
                    ) : (
                      <div className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700">
                        Analyzing
                      </div>
                    )}

                    <Link
                      href={`/analysis?session=${session.id}`}
                      className="rounded-full bg-gradient-to-r from-blue-500 to-cyan-400 px-4 py-2 text-sm font-medium text-white transition-all hover:from-blue-600 hover:to-cyan-500"
                    >
                      Open
                    </Link>
                    <button
                      onClick={() => handleDelete(session.id)}
                      className="rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-600 transition-all hover:bg-slate-200"
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
            <div className="w-16 h-16 mx-auto bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-slate-800 mb-2">No sessions</h3>
            <Link
              href="/upload"
              className="inline-flex items-center justify-center px-5 py-2.5 text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full hover:from-blue-600 hover:to-cyan-500 transition-all active:scale-95"
            >
              Start
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
