'use client';

import { useEffect, useState } from 'react';
import { signOut, useSession } from 'next-auth/react';
import Link from 'next/link';
import Image from 'next/image';

const vibeTags = ['Pose trail', 'Beat check', 'Flow notes'];
const motionBadges = ['8-count', 'On beat', 'Replay mode'];
const beatBars = [30, 58, 38, 72, 44, 62, 34];

export default function Home() {
  const { data: session } = useSession();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  return (
    <div
      className="relative min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top,#ffffff_0%,#eef7ff_42%,#f9fcff_100%)] text-slate-950"
      suppressHydrationWarning
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="home-float-slow absolute left-[-8rem] top-[10rem] h-72 w-72 rounded-full bg-[radial-gradient(circle,#42d6ff_0%,rgba(66,214,255,0.12)_45%,transparent_72%)] blur-2xl" />
        <div className="home-float-fast absolute right-[-6rem] top-24 h-80 w-80 rounded-full bg-[radial-gradient(circle,#3b82f6_0%,rgba(59,130,246,0.1)_48%,transparent_75%)] blur-2xl" />
        <div className="home-float-slow absolute bottom-[-8rem] left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-[radial-gradient(circle,#7dd3fc_0%,rgba(125,211,252,0.14)_36%,transparent_72%)] blur-3xl" />

        <svg
          className="absolute inset-x-0 top-[18%] mx-auto hidden max-w-5xl text-sky-400/30 md:block"
          viewBox="0 0 1200 420"
          fill="none"
        >
          <path
            d="M60 290C170 180 260 180 355 245C448 310 530 318 655 205C788 85 885 100 1140 275"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray="8 14"
          />
          <path
            d="M90 330C190 265 295 255 380 292C475 334 570 340 702 246C832 154 947 163 1108 308"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>

        <div className="home-float-fast absolute left-[8%] top-[18%] hidden rounded-full border border-white/80 bg-white/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.28em] text-sky-700 shadow-[0_16px_40px_rgba(56,189,248,0.18)] backdrop-blur md:block">
          {motionBadges[0]}
        </div>
        <div className="home-float-slow absolute right-[10%] top-[32%] hidden rounded-full border border-white/80 bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.28em] text-cyan-200 shadow-[0_18px_40px_rgba(15,23,42,0.24)] md:block">
          {motionBadges[1]}
        </div>
        <div className="home-float-fast absolute bottom-[17%] left-[12%] hidden rounded-full border border-sky-200/80 bg-sky-50/90 px-4 py-2 text-xs font-semibold uppercase tracking-[0.28em] text-sky-700 shadow-[0_16px_36px_rgba(56,189,248,0.16)] md:block">
          {motionBadges[2]}
        </div>
      </div>

      <header className="relative z-10 flex items-center justify-between px-6 py-6 md:px-10">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/70 bg-white/80 shadow-[0_14px_30px_rgba(14,165,233,0.12)] backdrop-blur">
            <span className="text-sm font-black uppercase tracking-[0.2em] text-sky-700">TF</span>
          </div>
          <div className="hidden md:block">
            <p className="text-sm font-semibold tracking-[0.24em] text-slate-500 uppercase">TempoFlow</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {session ? (
            <>
              <Link
                href="/dashboard"
                className="rounded-full px-5 py-2 text-sm font-medium text-slate-600 transition-colors hover:text-slate-950"
              >
                Dashboard
              </Link>
              <button
                type="button"
                onClick={() => void signOut({ callbackUrl: '/' })}
                className="rounded-full border border-slate-200/80 bg-white/75 px-5 py-2 text-sm font-medium text-slate-700 shadow-sm backdrop-blur transition-all hover:border-slate-300 hover:text-slate-950"
              >
                Sign Out
              </button>
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="rounded-full px-5 py-2 text-sm font-medium text-slate-600 transition-colors hover:text-slate-950"
              >
                Log In
              </Link>
              <Link
                href="/upload"
                className="rounded-full bg-gradient-to-r from-blue-500 via-sky-500 to-cyan-400 px-6 py-2.5 text-sm font-semibold text-white shadow-[0_16px_34px_rgba(14,165,233,0.28)] transition-all hover:scale-[1.02] hover:from-blue-600 hover:via-sky-500 hover:to-cyan-500"
              >
                Start
              </Link>
            </>
          )}
        </div>
      </header>

      <main className="relative z-10 flex min-h-[calc(100vh-88px)] items-center px-6 pb-10 pt-4 md:px-10 md:pb-14">
        <section className="mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="relative">
            <div className="home-float-slow absolute -left-6 top-6 hidden h-24 w-24 rounded-[2rem] border border-white/80 bg-white/70 shadow-[0_20px_40px_rgba(56,189,248,0.14)] backdrop-blur lg:flex lg:items-center lg:justify-center">
              <svg className="h-10 w-10 text-sky-500" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <path d="M12 44C21 39 26 27 26 17" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                <path d="M29 16C31 13 37 11 41 15C46 20 44 29 36 34L27 39" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                <path d="M25 34L36 49" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                <circle cx="28" cy="10" r="5" fill="currentColor" />
              </svg>
            </div>

            <div className="overflow-hidden rounded-[2rem] border border-white/70 bg-white/60 p-6 shadow-[0_30px_90px_rgba(56,189,248,0.16)] backdrop-blur-xl md:p-8">
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-slate-950 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-cyan-200">
                  AI dance coaching
                </span>
                <div className="flex items-center gap-2 rounded-full border border-sky-100 bg-white/70 px-3 py-2 text-xs font-medium text-slate-500">
                  {beatBars.map((height, index) => (
                    <span
                      key={height + index}
                      className="inline-block w-1.5 rounded-full bg-gradient-to-t from-sky-400 to-blue-600"
                      style={{ height: `${height / 3}px` }}
                    />
                  ))}
                </div>
              </div>

              <div className="relative mt-8 rounded-[2rem] border border-white/60 bg-[linear-gradient(145deg,rgba(255,255,255,0.95),rgba(227,244,255,0.82))] px-6 py-10 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] md:px-10 md:py-14">
                <div className="pointer-events-none absolute inset-x-8 top-0 h-24 rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.22)_0%,transparent_70%)] blur-2xl" />
                <div className="pointer-events-none absolute -right-10 top-8 h-24 w-24 rounded-full border border-sky-200/70" />
                <div className="pointer-events-none absolute -left-6 bottom-10 h-16 w-16 rounded-full bg-slate-950/5" />

                <h1 className="sr-only">TempoFlow</h1>

                <div className="relative mx-auto w-fit">
                  <Image
                    src="/logo.png"
                    alt="TempoFlow"
                    width={360}
                    height={110}
                    className="mx-auto w-[240px] drop-shadow-[0_20px_38px_rgba(56,189,248,0.26)] md:w-[360px]"
                    priority
                  />
                </div>

                <p className="mt-8 text-3xl font-black tracking-[-0.04em] text-slate-950 md:text-5xl">
                  Catch the groove.
                </p>
                <p className="mt-3 text-sm font-medium uppercase tracking-[0.32em] text-sky-700/80">
                  Clean takes. Sharp feedback.
                </p>

                <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                  <Link
                    href="/upload"
                    className="inline-flex min-w-[220px] items-center justify-center rounded-full bg-gradient-to-r from-blue-500 via-sky-500 to-cyan-400 px-8 py-4 text-lg font-semibold text-white shadow-[0_20px_40px_rgba(14,165,233,0.28)] transition-all hover:scale-[1.02] hover:from-blue-600 hover:via-sky-500 hover:to-cyan-500"
                  >
                    Start Session
                  </Link>
                  <Link
                    href={session ? '/dashboard' : '/login'}
                    className="inline-flex min-w-[220px] items-center justify-center rounded-full border border-white/80 bg-white/70 px-8 py-4 text-lg font-semibold text-slate-700 shadow-[0_14px_30px_rgba(15,23,42,0.08)] backdrop-blur transition-all hover:border-sky-200 hover:text-slate-950"
                  >
                    {session ? 'Open Dashboard' : 'Log In'}
                  </Link>
                </div>

                <div className="mt-8 flex flex-wrap justify-center gap-2">
                  {vibeTags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-sky-100 bg-white/80 px-4 py-2 text-sm font-medium text-slate-600 shadow-sm"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-1">
            <div className="home-float-fast rounded-[1.75rem] border border-slate-950/8 bg-slate-950 px-5 py-5 text-white shadow-[0_24px_50px_rgba(15,23,42,0.2)]">
              <div className="mb-4 flex items-center justify-between">
                <span className="rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-200">
                  Cue
                </span>
                <span className="text-xs uppercase tracking-[0.28em] text-white/45">Live</span>
              </div>
              <p className="text-2xl font-black tracking-[-0.04em]">Move cleaner</p>
              <div className="mt-5 flex items-end gap-2">
                {beatBars.map((height, index) => (
                  <span
                    key={`dark-${height + index}`}
                    className="inline-block w-3 rounded-full bg-gradient-to-t from-cyan-300 to-blue-500"
                    style={{ height: `${height}px` }}
                  />
                ))}
              </div>
            </div>

            <div className="rounded-[1.75rem] border border-sky-100 bg-white/70 p-5 shadow-[0_20px_45px_rgba(56,189,248,0.1)] backdrop-blur">
              <div className="flex items-center justify-between">
                <span className="rounded-full bg-sky-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-sky-700">
                  Replay
                </span>
                <svg className="h-6 w-6 text-sky-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 5V2L7 7L12 12V9C15.3 9 18 11.7 18 15C18 18.3 15.3 21 12 21C8.7 21 6 18.3 6 15H4C4 19.4 7.6 23 12 23C16.4 23 20 19.4 20 15C20 10.6 16.4 7 12 7V5Z" fill="currentColor" />
                </svg>
              </div>
              <p className="mt-5 text-2xl font-black tracking-[-0.04em] text-slate-950">See the beat land</p>
              <div className="mt-5 rounded-[1.5rem] bg-[linear-gradient(135deg,#e0f2fe,#ffffff)] p-4">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-sky-500" />
                  <span className="text-sm font-medium text-slate-600">Pose trace locked</span>
                </div>
                <div className="mt-4 h-20 rounded-[1.2rem] bg-[radial-gradient(circle_at_top,#bae6fd_0%,#eff6ff_58%,#ffffff_100%)]" />
              </div>
            </div>

            <div className="rounded-[1.75rem] border border-white/70 bg-[linear-gradient(135deg,rgba(255,255,255,0.95),rgba(240,249,255,0.78))] p-5 shadow-[0_22px_48px_rgba(125,211,252,0.14)] backdrop-blur">
              <div className="flex items-center justify-between">
                <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
                  Energy
                </span>
                <svg className="home-spin-slow h-8 w-8 text-sky-400" viewBox="0 0 48 48" fill="none" aria-hidden="true">
                  <path d="M24 4C18 12 18 18 24 24C30 30 30 36 24 44" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
                  <path d="M8 24C16 18 22 18 28 24C34 30 40 30 40 24" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
                </svg>
              </div>
              <div className="mt-5 space-y-3">
                <p className="text-2xl font-black tracking-[-0.04em] text-slate-950">Stay in pocket</p>
                <div className="flex gap-2">
                  {['L', 'R', 'Spin'].map((cue) => (
                    <span
                      key={cue}
                      className="rounded-full bg-slate-950 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-100"
                    >
                      {cue}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
