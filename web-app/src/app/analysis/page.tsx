"use client";

import { Suspense, useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';

import { buildAnalysisSummary } from '../../lib/analysis';
import { analyzeVideoPoses } from '../../lib/poseAnalysis';
import {
  getAnalysisMode,
  getCurrentSessionId,
  getSession,
  setCurrentSessionId,
  TempoFlowSession,
  updateSession,
} from '../../lib/sessionStorage';
import { getSessionVideo, storeSessionVideo } from '../../lib/videoStorage';

const PoseOverlay = dynamic(() => import('../../components/PoseOverlay'), { ssr: false });
const DEFAULT_SAM3_MAX_VIDEO_MB = 40;
const DEFAULT_SAM3_MAX_DURATION_SEC = 12;

function getSam3MaxVideoMb() {
  const value = Number.parseInt(process.env.NEXT_PUBLIC_SAM3_MAX_VIDEO_MB ?? `${DEFAULT_SAM3_MAX_VIDEO_MB}`, 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SAM3_MAX_VIDEO_MB;
}

function getSam3MaxDurationSec() {
  const value = Number.parseFloat(process.env.NEXT_PUBLIC_SAM3_MAX_DURATION_SEC ?? `${DEFAULT_SAM3_MAX_DURATION_SEC}`);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SAM3_MAX_DURATION_SEC;
}

async function readErrorMessage(response: Response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data = (await response.json()) as { error?: string };
    return data.error || 'SAM 3 processing failed.';
  }

  const text = await response.text();
  return text || 'SAM 3 processing failed.';
}

function AnalysisPageContent() {
  const searchParams = useSearchParams();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [referenceVideoUrl, setReferenceVideoUrl] = useState<string | null>(null);
  const [userVideoUrl, setUserVideoUrl] = useState<string | null>(null);
  const [sam3ReferenceUrl, setSam3ReferenceUrl] = useState<string | null>(null);
  const [sam3PracticeUrl, setSam3PracticeUrl] = useState<string | null>(null);
  const [session, setSession] = useState<TempoFlowSession | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [analysisStatus, setAnalysisStatus] = useState('Loading your local session...');
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [pageError, setPageError] = useState<string | null>(null);
  const [overlayMethod, setOverlayMethod] = useState<'pose-fill' | 'sam3-experimental'>('pose-fill');
  const [sam3Processing, setSam3Processing] = useState(false);
  const [sam3Status, setSam3Status] = useState('');
  const [sam3Error, setSam3Error] = useState<string | null>(null);

  const referenceVideoRef = useRef<HTMLVideoElement>(null);
  const userVideoRef = useRef<HTMLVideoElement>(null);
  const progressInterval = useRef<NodeJS.Timeout | null>(null);
  const analysisMode = getAnalysisMode();

  useEffect(() => {
    const sessionId = searchParams.get('session') ?? getCurrentSessionId();
    if (!sessionId) {
      setPageError('No local session was found. Upload a reference and practice clip first.');
      setLoadingSession(false);
      return;
    }

    let referenceUrlToCleanup: string | null = null;
    let practiceUrlToCleanup: string | null = null;
    let sam3ReferenceUrlToCleanup: string | null = null;
    let sam3PracticeUrlToCleanup: string | null = null;

    const loadSession = async () => {
      try {
        const nextSession = getSession(sessionId);
        if (!nextSession) {
          setPageError('That local session no longer exists. Please upload the videos again.');
          setLoadingSession(false);
          return;
        }

        const [referenceFile, practiceFile, sam3ReferenceFile, sam3PracticeFile] = await Promise.all([
          getSessionVideo(sessionId, 'reference'),
          getSessionVideo(sessionId, 'practice'),
          getSessionVideo(sessionId, 'reference-sam3'),
          getSessionVideo(sessionId, 'practice-sam3'),
        ]);

        if (!referenceFile || !practiceFile) {
          setPageError('The local video files for this session were not found.');
          setLoadingSession(false);
          return;
        }

        setCurrentSessionId(sessionId);
        setSession(nextSession);
        referenceUrlToCleanup = URL.createObjectURL(referenceFile);
        practiceUrlToCleanup = URL.createObjectURL(practiceFile);
        setReferenceVideoUrl(referenceUrlToCleanup);
        setUserVideoUrl(practiceUrlToCleanup);

        if (sam3ReferenceFile) {
          sam3ReferenceUrlToCleanup = URL.createObjectURL(sam3ReferenceFile);
          setSam3ReferenceUrl(sam3ReferenceUrlToCleanup);
        } else {
          setSam3ReferenceUrl(null);
        }

        if (sam3PracticeFile) {
          sam3PracticeUrlToCleanup = URL.createObjectURL(sam3PracticeFile);
          setSam3PracticeUrl(sam3PracticeUrlToCleanup);
        } else {
          setSam3PracticeUrl(null);
        }
      } catch (error) {
        console.error('Failed to load local session:', error);
        setPageError('Failed to load the saved session from this device.');
      } finally {
        setLoadingSession(false);
      }
    };

    loadSession();

    return () => {
      if (referenceUrlToCleanup?.startsWith('blob:')) URL.revokeObjectURL(referenceUrlToCleanup);
      if (practiceUrlToCleanup?.startsWith('blob:')) URL.revokeObjectURL(practiceUrlToCleanup);
      if (sam3ReferenceUrlToCleanup?.startsWith('blob:')) URL.revokeObjectURL(sam3ReferenceUrlToCleanup);
      if (sam3PracticeUrlToCleanup?.startsWith('blob:')) URL.revokeObjectURL(sam3PracticeUrlToCleanup);
    };
  }, [searchParams]);

  useEffect(() => {
    const shouldAnalyze =
      session &&
      referenceVideoUrl &&
      userVideoUrl &&
      !pageError &&
      (!session.analysis || session.status !== 'analyzed');

    if (!shouldAnalyze) {
      return;
    }

    let cancelled = false;

    const runAnalysis = async () => {
      try {
        updateSession(session.id, { status: 'analyzing', errorMessage: undefined });
        setAnalysisProgress(5);
        setAnalysisStatus('Analyzing reference performance...');

        const referenceResult = await analyzeVideoPoses(referenceVideoUrl, (progress, label) => {
          if (cancelled) return;
          setAnalysisProgress(Math.round(progress * 40));
          setAnalysisStatus(label);
        });

        if (cancelled) return;

        setAnalysisStatus('Analyzing your practice clip...');
        const practiceResult = await analyzeVideoPoses(userVideoUrl, (progress, label) => {
          if (cancelled) return;
          setAnalysisProgress(40 + Math.round(progress * 40));
          setAnalysisStatus(label);
        });

        if (referenceResult.samples.length < 6 || practiceResult.samples.length < 6) {
          throw new Error('Not enough pose frames were detected. Try clips with a clearer full-body view.');
        }

        setAnalysisStatus('Comparing timing and movement...');
        setAnalysisProgress(88);
        const summary = buildAnalysisSummary({
          reference: referenceResult.samples,
          practice: practiceResult.samples,
          referenceDurationSec: referenceResult.durationSec,
          practiceDurationSec: practiceResult.durationSec,
        });

        let nextSummary = summary;

        if (analysisMode === 'api') {
          setAnalysisStatus('Requesting AI coaching summary...');

          try {
            const response = await fetch('/api/coach', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: session.id, summary }),
            });

            if (response.ok) {
              const data = await response.json();
              if (Array.isArray(data.insights) && data.insights.length > 0) {
                nextSummary = {
                  ...summary,
                  insights: summary.insights.map((insight, index) => ({
                    ...insight,
                    body: data.insights[index] ?? insight.body,
                  })),
                };
              }
            }
          } catch (error) {
            console.warn('API coaching summary failed, using local coaching text.', error);
          }
        }

        if (cancelled) return;

        const updatedSession = updateSession(session.id, {
          status: 'analyzed',
          analysis: nextSummary,
          errorMessage: undefined,
        });

        setSession(updatedSession ?? { ...session, status: 'analyzed', analysis: nextSummary });
        setDuration(nextSummary.durationSec);
        setAnalysisProgress(100);
        setAnalysisStatus('Analysis ready.');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Analysis failed.';
        updateSession(session.id, { status: 'error', errorMessage: message });
        setSession((currentSession) =>
          currentSession ? { ...currentSession, status: 'error', errorMessage: message } : currentSession,
        );
        setPageError(message);
      }
    };

    runAnalysis();

    return () => {
      cancelled = true;
    };
  }, [analysisMode, pageError, referenceVideoUrl, session, userVideoUrl]);

  useEffect(() => {
    if (session?.analysis?.durationSec) {
      setDuration(session.analysis.durationSec);
    }
  }, [session]);

  const togglePlayPause = () => {
    const nextState = !isPlaying;
    setIsPlaying(nextState);

    if (referenceVideoRef.current && userVideoRef.current) {
      if (nextState) {
        referenceVideoRef.current.play().catch((error) => console.error('Play error:', error));
        userVideoRef.current.play().catch((error) => console.error('Play error:', error));
      } else {
        referenceVideoRef.current.pause();
        userVideoRef.current.pause();
      }
    }
  };

  useEffect(() => {
    if (isPlaying) {
      progressInterval.current = setInterval(() => {
        if (referenceVideoRef.current) {
          setCurrentTime(referenceVideoRef.current.currentTime);
          if (referenceVideoRef.current.ended) {
            setIsPlaying(false);
            setCurrentTime(0);
          }
        }
      }, 100);
    } else if (progressInterval.current) {
      clearInterval(progressInterval.current);
    }

    return () => {
      if (progressInterval.current) clearInterval(progressInterval.current);
    };
  }, [isPlaying]);

  const jumpToTime = (timeSec: number) => {
    if (!referenceVideoRef.current || !userVideoRef.current) return;
    referenceVideoRef.current.currentTime = timeSec;
    userVideoRef.current.currentTime = timeSec;
    setCurrentTime(timeSec);
  };

  const handleLoadedMetadata = () => {
    const nextDuration = Math.min(
      referenceVideoRef.current?.duration ?? Number.POSITIVE_INFINITY,
      userVideoRef.current?.duration ?? Number.POSITIVE_INFINITY,
    );

    if (Number.isFinite(nextDuration) && nextDuration > 0) {
      setDuration(nextDuration);
    }
  };

  const ScoreCircle = ({ value, label }: { value: number; label: string }) => {
    const strokeDasharray = 2 * Math.PI * 36;
    const strokeDashoffset = strokeDasharray - (strokeDasharray * value) / 100;

    return (
      <div className="flex flex-col items-center">
        <div className="relative w-24 h-24">
          <svg className="transform -rotate-90 w-24 h-24">
            <circle
              cx="48"
              cy="48"
              r="36"
              stroke="#e5e7eb"
              strokeWidth="8"
              fill="none"
            />
            <circle
              cx="48"
              cy="48"
              r="36"
              stroke="url(#gradient)"
              strokeWidth="8"
              fill="none"
              strokeDasharray={strokeDasharray}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              className="transition-all duration-1000"
            />
            <defs>
              <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#a855f7" />
                <stop offset="100%" stopColor="#ec4899" />
              </linearGradient>
            </defs>
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-2xl font-bold text-gray-900">{value}</span>
          </div>
        </div>
        <p className="mt-2 text-sm font-medium text-gray-600">{label}</p>
      </div>
    );
  };

  if (loadingSession) {
    return (
      <div className="min-h-screen bg-white">
        <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
          <div className="mb-6 h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-purple-600" />
          <h1 className="text-2xl font-semibold text-gray-900">Loading local session</h1>
          <p className="mt-2 max-w-md text-gray-600">Preparing your saved videos and analysis workspace.</p>
        </div>
      </div>
    );
  }

  if (pageError && !session?.analysis) {
    return (
      <div className="min-h-screen bg-white">
        <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
          <div className="max-w-lg rounded-3xl border border-red-100 bg-red-50 px-8 py-8">
            <h1 className="text-2xl font-semibold text-gray-900">Session unavailable</h1>
            <p className="mt-3 text-gray-700">{pageError}</p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link
                href="/upload"
                className="rounded-full bg-gray-900 px-5 py-3 text-sm font-medium text-white transition-all hover:bg-gray-800"
              >
                Start a new session
              </Link>
              <Link
                href="/dashboard"
                className="rounded-full bg-gray-100 px-5 py-3 text-sm font-medium text-gray-700 transition-all hover:bg-gray-200"
              >
                Open dashboard
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const summary = session?.analysis;
  const scores = summary?.scores;
  const worstSegment = summary?.segments.slice().sort((a, b) => a.score - b.score)[0];
  const sam3Result = session?.sam3Result;
  const sam3Ready = Boolean(sam3ReferenceUrl && sam3PracticeUrl && sam3Result);
  const sam3StateLabel = sam3Processing ? 'Processing on Modal GPU' : sam3Error ? 'Failed' : sam3Ready ? 'Ready' : 'Idle';
  const referenceDisplayUrl =
    overlayMethod === 'sam3-experimental' && sam3ReferenceUrl
      ? sam3ReferenceUrl
      : referenceVideoUrl;
  const practiceDisplayUrl =
    overlayMethod === 'sam3-experimental' && sam3PracticeUrl
      ? sam3PracticeUrl
      : userVideoUrl;

  const generateSam3Video = async (kind: 'reference' | 'practice', sourceUrl: string, fileName: string) => {
    const sourceResponse = await fetch(sourceUrl);
    const blob = await sourceResponse.blob();
    const maxVideoBytes = getSam3MaxVideoMb() * 1024 * 1024;

    if (blob.size > maxVideoBytes) {
      throw new Error(`Keep SAM 3 clips under ${getSam3MaxVideoMb()} MB for fast processing.`);
    }

    const body = new FormData();
    body.append('video', new File([blob], fileName, { type: blob.type || 'video/webm' }));
    body.append('kind', kind);

    const response = await fetch('/api/sam3/video', {
      method: 'POST',
      body,
    });

    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }

    const outputBlob = await response.blob();
    const prompt = response.headers.get('x-sam3-prompt') || 'person';

    return {
      provider: 'modal' as const,
      prompt,
      file: new File([outputBlob], `${kind}-sam3.mp4`, { type: outputBlob.type || 'video/mp4' }),
    };
  };

  const handleGenerateSam3 = async () => {
    if (!session || !referenceVideoUrl || !userVideoUrl) {
      return;
    }

    try {
      const maxDurationSec = getSam3MaxDurationSec();
      const referenceDuration = referenceVideoRef.current?.duration ?? 0;
      const practiceDuration = userVideoRef.current?.duration ?? 0;
      if (referenceDuration > maxDurationSec || practiceDuration > maxDurationSec) {
        throw new Error(`Keep each clip under ${maxDurationSec} seconds for fast SAM 3 mode.`);
      }

      setSam3Processing(true);
      setSam3Error(null);
      setSam3Status('Queued reference clip on Modal...');

      const referenceResult = await generateSam3Video(
        'reference',
        referenceVideoUrl,
        session.referenceName || 'reference.mp4',
      );

      setSam3Status('Queued practice clip on Modal...');
      const practiceResult = await generateSam3Video(
        'practice',
        userVideoUrl,
        session.practiceName || 'practice.mp4',
      );

      await Promise.all([
        storeSessionVideo(session.id, 'reference-sam3', referenceResult.file),
        storeSessionVideo(session.id, 'practice-sam3', practiceResult.file),
      ]);

      const nextReferenceUrl = URL.createObjectURL(referenceResult.file);
      const nextPracticeUrl = URL.createObjectURL(practiceResult.file);

      const updatedSession = updateSession(session.id, {
        sam3Result: {
          provider: 'modal',
          prompt: practiceResult.prompt || referenceResult.prompt,
          generatedAt: new Date().toISOString(),
        },
      });

      setSession(updatedSession ?? session);
      setSam3ReferenceUrl((currentUrl) => {
        if (currentUrl?.startsWith('blob:')) URL.revokeObjectURL(currentUrl);
        return nextReferenceUrl;
      });
      setSam3PracticeUrl((currentUrl) => {
        if (currentUrl?.startsWith('blob:')) URL.revokeObjectURL(currentUrl);
        return nextPracticeUrl;
      });
      setOverlayMethod('sam3-experimental');
      setSam3Status('Segmented videos are ready.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'SAM 3 overlay generation failed.';
      setSam3Error(message);
      setSam3Status('');
    } finally {
      setSam3Processing(false);
    }
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
            className="px-4 py-2 bg-gray-900 text-white rounded-full text-sm font-medium hover:bg-gray-800 transition-all"
          >
            New Session
          </Link>
        </div>
      </div>

      <div className="px-6 py-24 max-w-7xl mx-auto">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center w-32 h-32 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 mb-4">
            <span className="text-5xl font-bold text-white">{scores?.overall ?? '--'}</span>
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            {summary ? 'Your dance review is ready' : 'Analyzing your session'}
          </h1>
          <p className="text-gray-600">
            {summary
              ? `Strongest area: ${summary.strongestArea}. Main focus: ${summary.focusArea}.`
              : analysisStatus}
          </p>
        </div>

        <div className="mb-8 rounded-3xl border border-gray-200 bg-white p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Overlay method</h2>
              <p className="text-sm text-gray-600">
                Switch between the current local pose-fill overlay and a Modal-hosted SAM 3 segmentation pass.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setOverlayMethod('pose-fill')}
                className={`rounded-full px-4 py-2 text-sm font-medium transition-all ${
                  overlayMethod === 'pose-fill'
                    ? 'bg-gray-900 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Local Pose Fill
              </button>
              <button
                onClick={() => setOverlayMethod('sam3-experimental')}
                className={`rounded-full px-4 py-2 text-sm font-medium transition-all ${
                  overlayMethod === 'sam3-experimental'
                    ? 'bg-purple-600 text-white'
                    : 'bg-purple-50 text-purple-700 hover:bg-purple-100'
                }`}
              >
                SAM 3 Experimental
              </button>
            </div>
          </div>
          <p className="mt-3 text-xs text-gray-500">
            SAM 3 can detect, segment, and track objects in images and videos using prompts. TempoFlow sends short clips to a Modal GPU worker, then stores the segmented results back on this device so the app stays local-first after generation. See{' '}
            <a
              href="https://ai.meta.com/research/sam3/"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Meta SAM 3
            </a>
            {' '}and{' '}
            <a
              href="https://modal.com/"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Modal
            </a>
            .
          </p>
          {overlayMethod === 'sam3-experimental' && (
            <div className="mt-4 rounded-2xl border border-purple-100 bg-purple-50 px-4 py-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-sm font-semibold text-purple-700">SAM 3 experimental video segmentation</p>
                  <p className="text-sm text-gray-700">
                    {sam3Ready
                      ? `Ready. Prompt used: "${sam3Result?.prompt}".`
                      : `Generate segmented videos for both panels on Modal. Fast mode works best for clips under ${getSam3MaxDurationSec()} seconds and ${getSam3MaxVideoMb()} MB.`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-purple-700">
                    {sam3StateLabel}
                  </span>
                  <button
                    onClick={handleGenerateSam3}
                    disabled={sam3Processing || !referenceVideoUrl || !userVideoUrl}
                    className="rounded-full bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {sam3Processing ? 'Processing...' : sam3Ready ? 'Regenerate SAM 3 Videos' : 'Generate SAM 3 Videos'}
                  </button>
                  {sam3Error && !sam3Processing ? (
                    <button
                      onClick={handleGenerateSam3}
                      className="rounded-full bg-white px-4 py-2 text-sm font-medium text-purple-700 transition-all hover:bg-purple-100"
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
              </div>
              {(sam3Processing || sam3Status) && (
                <p className="mt-3 text-sm text-gray-700">{sam3Status}</p>
              )}
              {sam3Error && (
                <p className="mt-3 text-sm text-red-700">{sam3Error}</p>
              )}
            </div>
          )}
        </div>

        {!summary && (
          <div className="mb-10 rounded-3xl border border-purple-100 bg-purple-50 px-6 py-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-wide text-purple-600">Local analysis in progress</p>
                <p className="mt-1 text-gray-700">{analysisStatus}</p>
              </div>
              <p className="text-lg font-semibold text-gray-900">{analysisProgress}%</p>
            </div>
            <div className="mt-4 h-3 overflow-hidden rounded-full bg-purple-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all"
                style={{ width: `${analysisProgress}%` }}
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-12">
          <ScoreCircle value={scores?.timing ?? 0} label="Timing" />
          <ScoreCircle value={scores?.positioning ?? 0} label="Positioning" />
          <ScoreCircle value={scores?.smoothness ?? 0} label="Smoothness" />
          <ScoreCircle value={scores?.energy ?? 0} label="Energy" />
        </div>

        <div className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Movement Comparison</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-3">
              <p className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Reference</p>
              <div className="relative aspect-video bg-gray-900 rounded-3xl overflow-hidden group">
                {overlayMethod === 'sam3-experimental' && sam3Ready ? (
                  <div className="absolute left-3 top-3 z-10 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white">
                    Modal SAM 3 output
                  </div>
                ) : null}
                <video
                  ref={referenceVideoRef}
                  src={referenceDisplayUrl ?? undefined}
                  className="w-full h-full object-cover"
                  loop
                  muted
                  playsInline
                  crossOrigin="anonymous"
                  onLoadedMetadata={handleLoadedMetadata}
                  onError={(error) => console.error('Reference video error:', error)}
                />
                {overlayMethod !== 'sam3-experimental' || !sam3ReferenceUrl ? (
                  <PoseOverlay
                    videoRef={referenceVideoRef}
                    color="#00FF00"
                    method={overlayMethod}
                  />
                ) : null}
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Your Practice</p>
              <div className="relative aspect-video bg-gray-900 rounded-3xl overflow-hidden group">
                {overlayMethod === 'sam3-experimental' && sam3Ready ? (
                  <div className="absolute left-3 top-3 z-10 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white">
                    Modal SAM 3 output
                  </div>
                ) : null}
                <video
                  ref={userVideoRef}
                  src={practiceDisplayUrl ?? undefined}
                  className="w-full h-full object-cover grayscale opacity-80"
                  loop
                  muted
                  playsInline
                  crossOrigin="anonymous"
                  onLoadedMetadata={handleLoadedMetadata}
                  onError={(error) => console.error('User video error:', error)}
                />
                {overlayMethod !== 'sam3-experimental' || !sam3PracticeUrl ? (
                  <PoseOverlay
                    videoRef={userVideoRef}
                    color="#FF0000"
                    method={overlayMethod}
                  />
                ) : null}
              </div>
            </div>
          </div>

          <div className="mt-6 space-y-4">
            <div className="flex items-center gap-4">
              <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all"
                  style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
                />
              </div>
              <span className="text-sm text-gray-600 w-20 text-right">
                {Math.floor(currentTime)}s / {Math.floor(duration)}s
              </span>
            </div>

            <div className="flex items-center justify-center gap-4">
              <button
                onClick={togglePlayPause}
                className="w-14 h-14 flex items-center justify-center bg-gray-900 text-white rounded-full hover:bg-gray-800 transition-all active:scale-95 shadow-lg"
              >
                {isPlaying ? (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6 ml-1" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>
              {worstSegment && (
                <button
                  onClick={() => jumpToTime(worstSegment.startSec)}
                  className="rounded-full bg-purple-50 px-4 py-3 text-sm font-medium text-purple-700 transition-all hover:bg-purple-100"
                >
                  Jump to hardest section
                </button>
              )}
            </div>
          </div>
        </div>

        {summary?.segments && summary.segments.length > 0 && (
          <div className="mb-8 rounded-3xl border border-gray-200 bg-white p-8">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-xl font-bold text-gray-900">Practice targets</h3>
                <p className="text-sm text-gray-600">Replay the weakest sections first for faster iteration.</p>
              </div>
              <Link
                href="/dashboard"
                className="rounded-full bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition-all hover:bg-gray-200"
              >
                View all sessions
              </Link>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {summary.segments.map((segment) => (
                <button
                  key={segment.id}
                  onClick={() => jumpToTime(segment.startSec)}
                  className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-4 text-left transition-all hover:border-purple-200 hover:bg-purple-50"
                >
                  <p className="text-sm font-semibold text-gray-900">{segment.label}</p>
                  <p className="mt-1 text-sm text-gray-600">
                    {segment.startSec.toFixed(1)}s-{segment.endSec.toFixed(1)}s
                  </p>
                  <p className="mt-2 text-sm text-gray-700">Focus area: {segment.focusArea}</p>
                  <p className="mt-2 text-lg font-semibold text-gray-900">{segment.score}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="bg-purple-50 rounded-3xl p-8">
          <h3 className="text-xl font-bold text-gray-900 mb-4">Key insights</h3>
          <ul className="space-y-3">
            {summary?.insights.map((insight) => (
              <li key={insight.id} className="flex items-start gap-3">
                <span className="mt-1 text-sm font-semibold text-purple-600">
                  {insight.tone === 'positive' ? 'GOOD' : insight.tone === 'focus' ? 'FOCUS' : 'TIP'}
                </span>
                <div>
                  <p className="font-medium text-gray-900">{insight.title}</p>
                  <p className="text-gray-700">{insight.body}</p>
                </div>
              </li>
            ))}
            {pageError && (
              <li className="text-sm text-red-700">{pageError}</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default function AnalysisPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-white">
          <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
            <div className="mb-6 h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-purple-600" />
            <h1 className="text-2xl font-semibold text-gray-900">Loading local session</h1>
            <p className="mt-2 max-w-md text-gray-600">Preparing your saved videos and analysis workspace.</p>
          </div>
        </div>
      }
    >
      <AnalysisPageContent />
    </Suspense>
  );
}
