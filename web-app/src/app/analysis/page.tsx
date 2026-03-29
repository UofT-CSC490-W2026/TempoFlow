"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import "../../components/ebs/ebs-viewer.css";

import { FeedbackViewer } from "../../components/ebs/FeedbackViewer";
import type { EbsData } from "../../components/ebs/types";
import { getSessionEbs, storeSessionEbs } from "../../lib/ebsStorage";
import {
  getCurrentSessionId,
  getSession,
  setCurrentSessionId,
  type TempoFlowSession,
  updateSession,
} from "../../lib/sessionStorage";
import { getSessionVideo } from "../../lib/videoStorage";
import { getPublicEbsProcessorUrl } from "../../lib/ebsProcessorUrl";
const MAX_EBS_PROCESSING_SECONDS = 5 * 60;

function getProcessorBaseUrl(processorUrl: string) {
  return processorUrl.replace(/\/api\/process\/?$/, "");
}

function isLocalDevProcessorUrl(url: string): boolean {
  return url.includes("127.0.0.1") || url.includes("localhost:");
}

function buildEbsMeta(data: EbsData) {
  return {
    segmentCount: data.segments.length,
    estimatedBpm: data.beat_tracking?.estimated_bpm,
    segmentationMode: data.segmentation_mode,
    sharedDurationSec: data.alignment.shared_len_sec,
    generatedAt: new Date().toISOString(),
  };
}

function AnalysisPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [session, setSession] = useState<TempoFlowSession | null>(null);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [practiceFile, setPracticeFile] = useState<File | null>(null);
  const [referenceVideoUrl, setReferenceVideoUrl] = useState<string | null>(null);
  const [practiceVideoUrl, setPracticeVideoUrl] = useState<string | null>(null);
  const [ebsData, setEbsData] = useState<EbsData | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [processingEbs, setProcessingEbs] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Loading your session...");
  const [pageError, setPageError] = useState<string | null>(null);
  const [processingStartedAt, setProcessingStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const generationRequestRef = useRef<string | null>(null);
  const ebsViewerRef = useRef<{ seekTo: (time: number) => void } | null>(null);
  const [sharedTime, setSharedTime] = useState(0);
  const processorUrl = getPublicEbsProcessorUrl();

  const handleSeek = (time: number) => {
    setSharedTime(time);
    ebsViewerRef.current?.seekTo(time);
  };

  const processorBaseUrl = useMemo(() => getProcessorBaseUrl(processorUrl), [processorUrl]);
  
  useEffect(() => {
    let referenceUrlToCleanup: string | null = null;
    let practiceUrlToCleanup: string | null = null;
    let cancelled = false;

    const loadSession = async () => {
      const sessionId = searchParams.get("session") ?? getCurrentSessionId();
      if (!sessionId) {
        setPageError("No local session was found. Upload a reference and practice clip first.");
        setLoadingSession(false);
        return;
      }

      try {
        const nextSession = getSession(sessionId);
        if (!nextSession) {
          setPageError("That local session no longer exists. Please upload the videos again.");
          setLoadingSession(false);
          return;
        }

        const [referenceVideo, practiceVideo, cachedEbs] = await Promise.all([
          getSessionVideo(sessionId, "reference"),
          getSessionVideo(sessionId, "practice"),
          getSessionEbs(sessionId),
        ]);

        if (!referenceVideo || !practiceVideo) {
          setPageError("The saved source videos for this session were not found.");
          setLoadingSession(false);
          return;
        }

        if (cancelled) return;

        setCurrentSessionId(sessionId);
        setSession(nextSession);
        setReferenceFile(referenceVideo);
        setPracticeFile(practiceVideo);

        referenceUrlToCleanup = URL.createObjectURL(referenceVideo);
        practiceUrlToCleanup = URL.createObjectURL(practiceVideo);
        setReferenceVideoUrl(referenceUrlToCleanup);
        setPracticeVideoUrl(practiceUrlToCleanup);

        if (cachedEbs) {
          setEbsData(cachedEbs);
          setPageError(null);
          setProcessingEbs(false);
          setProcessingStartedAt(null);
          setElapsedSeconds(0);
          const updatedSession =
            updateSession(sessionId, {
              status: "analyzed",
              ebsStatus: "ready",
              ebsErrorMessage: undefined,
              errorMessage: undefined,
              ebsMeta: buildEbsMeta(cachedEbs),
            }) ?? nextSession;
          setSession(updatedSession);
          setStatusMessage(
            cachedEbs.segments.length
              ? "Cached EBS session ready."
              : "Cached EBS result loaded. This clip aligned successfully but did not produce any playable segments.",
          );
        } else {
          setStatusMessage("Generating EBS segments from your saved videos. This can take 30 to 180 seconds depending on clip length.");
        }
      } catch (error) {
        console.error("Failed to load local session:", error);
        setPageError("Failed to load the saved session from this device.");
      } finally {
        if (!cancelled) {
        setLoadingSession(false);
        }
      }
    };

    void loadSession();

    return () => {
      cancelled = true;
      if (referenceUrlToCleanup?.startsWith("blob:")) URL.revokeObjectURL(referenceUrlToCleanup);
      if (practiceUrlToCleanup?.startsWith("blob:")) URL.revokeObjectURL(practiceUrlToCleanup);
    };
  }, [searchParams]);

  useEffect(() => {
    if (!processingEbs || processingStartedAt == null) {
      setElapsedSeconds(0);
      return;
    }

    const updateElapsed = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - processingStartedAt) / 1000)));
    };

    updateElapsed();
    const intervalId = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(intervalId);
  }, [processingEbs, processingStartedAt]);

  useEffect(() => {
    if (!session || !referenceFile || !practiceFile || ebsData || loadingSession || processingEbs || pageError) {
      return;
    }

    const requestKey = `${session.id}:${referenceFile.name}:${referenceFile.size}:${practiceFile.name}:${practiceFile.size}`;
    if (generationRequestRef.current === requestKey) {
      return;
    }
    generationRequestRef.current = requestKey;

    let cancelled = false;

    const generateEbs = async () => {
      setProcessingEbs(true);
      setProcessingStartedAt(Date.now());
      setElapsedSeconds(0);
      setPageError(null);
      setStatusMessage("Sending videos to the EBS processor and running audio alignment. This may look idle for a while.");
      updateSession(session.id, {
        status: "analyzing",
        ebsStatus: "processing",
        ebsErrorMessage: undefined,
        errorMessage: undefined,
      });

      try {
        const runRequest = async () => {
          const controller = new AbortController();
          const timeoutId = window.setTimeout(() => {
            controller.abort();
          }, MAX_EBS_PROCESSING_SECONDS * 1000);

          const formData = new FormData();
          formData.append("ref_video", referenceFile, referenceFile.name);
          formData.append("user_video", practiceFile, practiceFile.name);
          formData.append("session_id", session.id);

          try {
            const response = await fetch(processorUrl, {
              method: "POST",
              body: formData,
              signal: controller.signal,
            });

            const payload = (await response.json()) as EbsData & { error?: string };
            return { response, payload };
          } finally {
            window.clearTimeout(timeoutId);
          }
        };

        let lastError: unknown = null;
        let response: Response | null = null;
        let payload: (EbsData & { error?: string }) | null = null;

        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            if (attempt > 0) {
              setStatusMessage("Network hiccup detected. Retrying EBS request...");
              await new Promise((resolve) => setTimeout(resolve, 800));
            }
            ({ response, payload } = await runRequest());
            break;
          } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            // Only retry on likely-transient Chrome suspend; "Failed to fetch" is often COEP/CORS (retry won't help).
            const isTransientSuspend = message.includes("ERR_NETWORK_IO_SUSPENDED");
            if (!isTransientSuspend || attempt === 1) {
              throw error;
            }
          }
        }

        if (!response || !payload) {
          throw (
            lastError ??
            new Error(
              isLocalDevProcessorUrl(processorUrl)
                ? `Failed to reach the local EBS processor at ${processorUrl}.`
                : `Failed to reach the EBS processor at ${processorUrl}.`,
            )
          );
        }

        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to generate EBS data for this session.");
        }

        if (cancelled) return;

        await storeSessionEbs(session.id, payload);

        const updatedSession =
          updateSession(session.id, {
            status: "analyzed",
            ebsStatus: "ready",
            ebsErrorMessage: undefined,
          errorMessage: undefined,
            ebsMeta: buildEbsMeta(payload),
          }) ?? session;

        setSession(updatedSession);
        setEbsData(payload);
        setStatusMessage(
          payload.segments.length
            ? `EBS session ready with ${payload.segments.length} segment${payload.segments.length === 1 ? "" : "s"}.`
            : "EBS finished successfully, but no beat-synced segments were detected for this clip.",
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to generate EBS data. Start the local Python service and try again.";
        const isChromeIoSuspended = message.includes("ERR_NETWORK_IO_SUSPENDED");
        const isFetchFailed =
          message.includes("Failed to fetch") || message.includes("NetworkError");
        const hostedHint = isLocalDevProcessorUrl(processorUrl)
          ? `Failed to reach ${processorUrl}. Start the A5 API locally: cd A5 && uvicorn src.main:app --host 127.0.0.1 --port 8787`
          : `Failed to reach ${processorUrl}. Confirm the hosted API (EB/CloudFront) is healthy and redeploy A5 if you updated CORS/COEP headers.`;
        const friendlyMessage = isChromeIoSuspended
          ? "Browser network I/O was suspended during upload (often caused by the tab going to background, laptop sleep, or aggressive throttling). Keep this tab active and retry."
          : isFetchFailed
            ? hostedHint
            : message;

        updateSession(session.id, {
          status: "error",
          ebsStatus: "error",
          ebsErrorMessage: friendlyMessage,
          errorMessage: friendlyMessage,
        });
        setSession((currentSession) =>
          currentSession
            ? {
                ...currentSession,
                status: "error",
                ebsStatus: "error",
                ebsErrorMessage: friendlyMessage,
                errorMessage: friendlyMessage,
              }
            : currentSession,
        );
        setPageError(friendlyMessage);
      } finally {
        // Always clear the processing flag when the async work finishes. Do not gate this on `cancelled`:
        // this effect must not list `processingEbs` in deps — if it did, `setProcessingEbs(true)` would
        // re-run the effect, cleanup would set `cancelled` true, and we'd skip this and stay stuck on "Generating…".
        setProcessingEbs(false);
        setProcessingStartedAt(null);
      }
    };

    void generateEbs();

    return () => {
      cancelled = true;
    };
    // Omit `processingEbs`: including it makes `setProcessingEbs(true)` re-subscribe the effect and run
    // cleanup, which sets `cancelled` and breaks the in-flight `generateEbs` (stuck spinner, no result).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [ebsData, loadingSession, pageError, practiceFile, processorUrl, referenceFile, session]);

  useEffect(() => {
    if (!processingEbs || !session) return;

    let cancelled = false;
    const sessionId = session.id;

    const adoptArtifact = async (cached: EbsData, sourceLabel: string) => {
      const updatedSession =
        updateSession(sessionId, {
          status: "analyzed",
          ebsStatus: "ready",
          ebsErrorMessage: undefined,
          errorMessage: undefined,
          ebsMeta: buildEbsMeta(cached),
        }) ?? session;

      setSession(updatedSession);
      setEbsData(cached);
      setProcessingEbs(false);
      setProcessingStartedAt(null);
      setElapsedSeconds(0);
      setStatusMessage(
        cached.segments.length
          ? `${sourceLabel} finished with ${cached.segments.length} segment${cached.segments.length === 1 ? "" : "s"}.`
          : `${sourceLabel} finished. The clip aligned successfully but did not produce any playable segments.`,
      );
    };

    const checkCachedEbs = async () => {
      try {
        const cached = await getSessionEbs(sessionId);
        if (!cached || cancelled) return;
        await adoptArtifact(cached, "Cached EBS");
      } catch (error) {
        console.warn("Background EBS cache check failed:", error);
      }
    };

    const pollProcessorStatus = async () => {
      try {
        const statusUrl = `${processorBaseUrl}/api/status?session=${encodeURIComponent(sessionId)}`;
        const response = await fetch(statusUrl, { method: "GET", cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as { status?: string; has_result?: boolean };
        if (cancelled) return;
        if (payload?.status === "done" && payload?.has_result) {
          const resultUrl = `${processorBaseUrl}/api/result?session=${encodeURIComponent(sessionId)}`;
          const resultResponse = await fetch(resultUrl, { method: "GET", cache: "no-store" });
          if (!resultResponse.ok) return;
          const result = (await resultResponse.json()) as EbsData;
          if (cancelled) return;
          await storeSessionEbs(sessionId, result);
          await adoptArtifact(result, "EBS processor");
        }
      } catch (error) {
        // Best-effort only; if this fails we still have the timeout + retry UI.
        console.warn("Processor status poll failed:", error);
      }
    };

    // Backup only: primary path is the in-flight POST (no poll delay for that).
    // Fast polls help pick up IndexedDB cache or /api/status if the POST fails or tab was backgrounded.
    const POLL_MS = 250;
    void checkCachedEbs();
    void pollProcessorStatus();
    const intervalId = window.setInterval(() => {
      void checkCachedEbs();
      void pollProcessorStatus();
    }, POLL_MS);

    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      setProcessingEbs(false);
      setProcessingStartedAt(null);
      setStatusMessage(
        "EBS processing is taking longer than expected. If the Python service has already finished, reload this page to load the cached result.",
      );
    }, MAX_EBS_PROCESSING_SECONDS * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    };
  }, [processingEbs, processorBaseUrl, session]);

  const retryGeneration = async () => {
    generationRequestRef.current = null;
    setEbsData(null);
    setPageError(null);
    setProcessingStartedAt(null);
    setElapsedSeconds(0);
    setStatusMessage("Retrying EBS generation...");
  };

  const header = (
    <header className="fixed top-0 left-0 right-0 bg-white/85 backdrop-blur-md border-b border-sky-100 z-50">
      <div className="flex items-center px-6 py-3">
        
        {/* 1. Left Section: Logo */}
        <div className="flex-1">
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
        </div>

        {/* 2. Right Section: Actions */}
        <div className="flex-1 flex justify-end items-center gap-3">
          <Link 
            href="/dashboard" 
            className="px-4 py-2 text-slate-600 hover:text-slate-900 text-sm font-medium transition-colors"
          >
            Dashboard
          </Link>
          <Link 
            href="/upload" 
            className="px-4 py-2 bg-gradient-to-r from-blue-500 to-cyan-400 text-white rounded-full text-sm font-medium hover:from-blue-600 hover:to-cyan-500 transition-all"
          >
            New Session
          </Link>
        </div>
      </div>
    </header>
  );

  const sessionSummary = useMemo(() => {
    if (!session) return null;
    return `${session.practiceName} vs ${session.referenceName}`;
  }, [session]);
  const elapsedLabel = useMemo(() => {
    if (!processingEbs) return null;
    if (elapsedSeconds < 60) return `${elapsedSeconds}s elapsed`;
    const min = Math.floor(elapsedSeconds / 60);
    const sec = elapsedSeconds % 60;
    return `${min}m ${sec}s elapsed`;
  }, [elapsedSeconds, processingEbs]);
  const loadingProgressWidth = processingEbs ? Math.min(92, 28 + elapsedSeconds * 0.8) : 18;

  if (loadingSession) {
    return (
      <div className="min-h-screen bg-sky-50">
        {header}
        <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
          <div className="mb-6 h-10 w-10 animate-spin rounded-full border-4 border-sky-100 border-t-sky-500" />
          <h1 className="text-2xl font-semibold text-slate-900">Loading session</h1>
          <p className="mt-2 max-w-md text-slate-600">Restoring your saved videos and preparing the EBS viewer.</p>
        </div>
      </div>
    );
  }

  if (pageError && !session) {
    return (
      <div className="min-h-screen bg-sky-50">
        {header}
        <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
          <div className="max-w-lg rounded-3xl border border-red-100 bg-white px-8 py-8 shadow-sm">
            <h1 className="text-2xl font-semibold text-slate-900">Session unavailable</h1>
            <p className="mt-3 text-slate-700">{pageError}</p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link
                href="/upload"
                className="rounded-full bg-slate-900 px-5 py-3 text-sm font-medium text-white transition-all hover:bg-slate-800"
              >
                Start a new session
              </Link>
              <Link
                href="/dashboard"
                className="rounded-full bg-sky-50 px-5 py-3 text-sm font-medium text-sky-700 transition-all hover:bg-sky-100"
              >
                Open dashboard
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!ebsData || !referenceVideoUrl || !practiceVideoUrl || !session) {
  return (
      <div className="min-h-screen bg-sky-50">
        {header}
        <div className="px-6 py-28 max-w-3xl mx-auto">
          <div className="rounded-[32px] border border-sky-100 bg-white p-8 shadow-sm">
            <div className="flex items-start justify-between gap-6">
            <div>
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-sky-600">
                  TempoFlow EBS Session
                </p>
                <h1 className="mt-3 text-3xl font-bold text-slate-900">
                  {processingEbs ? "Generating beat-synced segments" : "Preparing session"}
                </h1>
                <p className="mt-2 text-slate-600">{statusMessage}</p>
                {elapsedLabel ? <p className="mt-2 text-sm font-medium text-sky-700">{elapsedLabel}</p> : null}
                {sessionSummary ? <p className="mt-4 text-sm text-slate-500">{sessionSummary}</p> : null}
            </div>
              <div className="h-12 w-12 rounded-2xl border border-sky-100 bg-sky-50 flex items-center justify-center">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-200 border-t-sky-500" />
              </div>
                    </div>

            <div className="mt-8 h-2 overflow-hidden rounded-full bg-sky-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-600 transition-all duration-700"
                style={{ width: `${loadingProgressWidth}%` }}
              />
            </div>

            <div className="mt-5 rounded-2xl border border-sky-100 bg-sky-50 px-4 py-4 text-sm text-slate-600">
              <p className="font-medium text-slate-900">What is happening now</p>
              <p className="mt-2">
                {isLocalDevProcessorUrl(processorUrl) ? (
                  <>
                    TempoFlow is sending both videos to your local A5 EBS service (Python), extracting audio, aligning
                    the clips, then building beat-synced segments. Short clips are often a few seconds; larger files can
                    take longer.
                  </>
                ) : (
                  <>
                    TempoFlow is uploading both videos to the hosted alignment API, then extracting audio, aligning the
                    clips, and building beat-synced segments. Upload time depends on your network; processing time
                    depends on clip length (hosted runs can take longer than a local dev server).
                  </>
                )}
              </p>
              <p className="mt-2 text-slate-500">
                {isLocalDevProcessorUrl(processorUrl) ? (
                  <>
                    Keep this tab active while processing. If the browser suspends the request, retry after confirming{" "}
                    <code className="rounded bg-sky-100 px-1">uvicorn</code> is still running on port 8787.
                  </>
                ) : (
                  <>
                    Keep this tab active while processing. Very long clips may hit API timeouts — try shorter test
                    videos if uploads finish but the request fails.
                  </>
                )}
              </p>
            </div>

            {pageError ? (
              <div className="mt-6 rounded-2xl border border-red-100 bg-red-50 px-4 py-4">
                <p className="text-sm font-medium text-red-700">{pageError}</p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <button
                    onClick={retryGeneration}
                    className="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-slate-800"
                  >
                    Retry EBS generation
                  </button>
                  <Link
                    href="/upload"
                    className="rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50"
                  >
                    Start over
                  </Link>
                </div>
              </div>
            ) : isLocalDevProcessorUrl(processorUrl) ? (
              <p className="mt-6 text-sm text-slate-500">
                Point <code className="rounded bg-slate-100 px-1">NEXT_PUBLIC_EBS_PROCESSOR_URL</code> at your local A5
                server when developing offline.
              </p>
            ) : (
              <p className="mt-6 text-sm text-slate-500">
                Using hosted processor: <code className="rounded bg-slate-100 px-1 break-all">{processorUrl}</code>
              </p>
            )}
          </div>
        </div>
              </div>
    );
  }

return (
  <div className="min-h-screen bg-sky-50">
    {header}
    <div className="pt-20 px-6 pb-12">
      <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
        <FeedbackViewer
          mode="session"
          sessionId={session.id}
          title="TempoFlow EBS Session"
          referenceVideoUrl={referenceVideoUrl}
          userVideoUrl={practiceVideoUrl}
          ebsData={ebsData}
          referenceName={session.referenceName}
          practiceName={session.practiceName}
          footerSlot={
            <Link href="/upload" className="dl-btn">New Session</Link>
          }
        />
      </div>
    </div>
  </div>
);
}

export default function AnalysisPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-sky-50">
          <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
            <div className="mb-6 h-10 w-10 animate-spin rounded-full border-4 border-sky-100 border-t-sky-500" />
            <h1 className="text-2xl font-semibold text-slate-900">Loading session</h1>
            <p className="mt-2 max-w-md text-slate-600">Preparing your TempoFlow EBS workspace.</p>
          </div>
        </div>
      }
    >
      <AnalysisPageContent />
    </Suspense>
  );
}
