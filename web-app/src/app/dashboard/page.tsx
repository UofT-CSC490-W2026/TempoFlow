"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { AppHeader } from '../../components/AppHeader';
import { deleteSessionMetadata, getSessions, TempoFlowSession } from '../../lib/sessionStorage';
import { deleteSessionEbs } from '../../lib/ebsStorage';
import { deleteSessionVideos, getSessionVideo } from '../../lib/videoStorage';

export default function DashboardPage() {
  const [sessions, setSessions] = useState<TempoFlowSession[]>(() => getSessions());
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});

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

  useEffect(() => {
    let active = true;
    const createdUrls: string[] = [];

    const loadPreviews = async () => {
      const nextUrls = await Promise.all(
        sessions.map(async (session) => {
          try {
            const file = await getSessionVideo(session.id, 'practice');
            if (!file) return null;

            const url = URL.createObjectURL(file);
            return { id: session.id, url };
          } catch {
            return null;
          }
        }),
      );

      if (!active) {
        nextUrls.forEach((entry) => {
          if (entry) URL.revokeObjectURL(entry.url);
        });
        return;
      }

      const previewMap: Record<string, string> = {};
      nextUrls.forEach((entry) => {
        if (!entry) return;
        createdUrls.push(entry.url);
        previewMap[entry.id] = entry.url;
      });
      setPreviewUrls(previewMap);
    };

    void loadPreviews();

    return () => {
      active = false;
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [sessions]);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#ffffff_0%,#eef6ff_44%,#f8fbff_100%)]">
      <AppHeader primaryHref="/upload" primaryLabel="New Session" />

      <div className="px-6 py-10">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-bold text-slate-800">Sessions</h1>
          {sessions.length > 0 ? (
            <div className="rounded-full border border-slate-200 bg-white/90 px-4 py-2 text-sm font-medium text-slate-600 shadow-sm">
              {sessions.length} saved
            </div>
          ) : null}
        </div>

        {sessions.length > 0 ? (
          <div className="space-y-4">
            {sessions.map((session) => (
              <div
                key={session.id}
                className="rounded-[1.75rem] border border-slate-200/80 bg-white/90 p-4 shadow-[0_16px_40px_rgba(148,163,184,0.08)] transition-all hover:border-blue-300 hover:shadow-[0_20px_48px_rgba(56,189,248,0.12)] md:p-5"
              >
                <div className="flex flex-col gap-4 md:flex-row md:items-center">
                  <div className="relative aspect-video overflow-hidden rounded-2xl bg-slate-100 md:w-56 md:flex-none">
                    {previewUrls[session.id] ? (
                      <video
                        src={previewUrls[session.id]}
                        className="h-full w-full object-cover"
                        muted
                        playsInline
                        preload="metadata"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_top,#dbeafe_0%,#eff6ff_48%,#f8fafc_100%)]">
                        <svg className="h-10 w-10 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </div>
                    )}
                    <div className="absolute left-3 top-3 rounded-full bg-slate-950/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-100">
                      Preview
                    </div>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0">
                        <h3 className="truncate text-xl font-semibold text-gray-900">
                        {session.practiceName}
                        </h3>
                        <p className="text-sm text-gray-500">Ref: {session.referenceName}</p>
                        <p className="mt-1 text-xs text-gray-500">Updated {formatUpdatedAt(session.updatedAt)}</p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {session.ebsStatus === 'ready' && session.ebsMeta ? (
                          <>
                            <div className="rounded-full bg-sky-50 px-3 py-1 text-sm font-semibold text-sky-700">
                              {session.ebsMeta.segmentCount} segments
                            </div>
                            <div className="rounded-full bg-slate-100 px-3 py-1 text-sm font-semibold text-slate-700">
                              {session.ebsMeta.estimatedBpm ? `${Math.round(session.ebsMeta.estimatedBpm)} BPM` : 'EBS ready'}
                            </div>
                          </>
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

                    <div className="mt-4 flex flex-wrap gap-2">
                      <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600">
                        {session.storageMode}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600">
                        {session.analysisMode}
                      </span>
                      {session.ebsStatus === 'ready' && session.ebsMeta?.sharedDurationSec ? (
                        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600">
                          {session.ebsMeta.sharedDurationSec.toFixed(1)}s shared
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-[1.75rem] border border-slate-200 bg-white/90 py-16 text-center shadow-[0_16px_40px_rgba(148,163,184,0.08)]">
            <div className="mb-4 flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100">
                <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </div>
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
