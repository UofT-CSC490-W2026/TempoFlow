"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import "../../components/ebs/ebs-viewer.css";

import { EbsViewer } from "../../components/ebs/EbsViewer";
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
import { DifferenceViewer } from "../../components/ebs/DifferenceViewer";
import { getSessionVideo } from "../../lib/videoStorage";
const DEFAULT_EBS_PROCESSOR_URL = "http://127.0.0.1:8787/api/process";
const MAX_EBS_PROCESSING_SECONDS = 5 * 60;

function getProcessorBaseUrl(processorUrl: string) {
  return processorUrl.replace(/\/api\/process\/?$/, "");
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
  const processorUrl = process.env.NEXT_PUBLIC_EBS_PROCESSOR_URL ?? DEFAULT_EBS_PROCESSOR_URL;

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
            const isSuspended =
              message.includes("ERR_NETWORK_IO_SUSPENDED") ||
              message.includes("Failed to fetch") ||
              message.includes("NetworkError");
            if (!isSuspended || attempt === 1) {
              throw error;
            }
          }
        }

        if (!response || !payload) {
          throw lastError ?? new Error(`Failed to reach the local EBS processor at ${processorUrl}.`);
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
        const isSuspended =
          message.includes("ERR_NETWORK_IO_SUSPENDED") ||
          message.includes("Failed to fetch") ||
          message.includes("NetworkError");
        const friendlyMessage = isSuspended
          ? "Browser network I/O was suspended during upload (often caused by the tab going to background, laptop sleep, or aggressive throttling). Keep this tab active and retry."
          : message.includes("Failed to fetch")
            ? `Failed to reach the local EBS processor at ${processorUrl}. Keep the local A5 EBS server running, then retry.`
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
        if (!cancelled) {
          setProcessingEbs(false);
          setProcessingStartedAt(null);
        }
      }
    };

    void generateEbs();

    return () => {
      cancelled = true;
    };
  }, [ebsData, loadingSession, pageError, practiceFile, processingEbs, processorUrl, referenceFile, session]);

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
        const response = await fetch(statusUrl, { method: "GET" });
        if (!response.ok) return;
        const payload = (await response.json()) as { status?: string; has_result?: boolean };
        if (cancelled) return;
        if (payload?.status === "done" && payload?.has_result) {
          const resultUrl = `${processorBaseUrl}/api/result?session=${encodeURIComponent(sessionId)}`;
          const resultResponse = await fetch(resultUrl, { method: "GET" });
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
  // 1. Create the state for the current time
  const [sharedTime, setSharedTime] = useState(0);
  // const sessionMode = props.mode === "session";
  // 2. Create a Ref to the EbsViewer (to trigger seeking)
  // Note: You'll need to make sure EbsViewer exposes a seek method via useImperativeHandle
  const ebsViewerRef = useRef<{ seekTo: (time: number) => void } | null>(null);

  // 3. Define the seek handler
  const handleSeek = (time: number) => {
    setSharedTime(time);
    // Tell the viewer to move the videos to this time
    ebsViewerRef.current?.seekTo(time);
  };
  type TabType = "ebs" | "feedback" | "diff";
  const [activeTab, setActiveTab] = useState<TabType>("ebs");

  const header = (
    <header className="fixed top-0 left-0 right-0 bg-white/85 backdrop-blur-md border-b border-sky-100 z-50">
      <div className="flex items-center px-6 py-3">
        
        {/* 1. Left Section: Logo (Flex-1 to push center) */}
        <div className="flex-1">
          <Link href="/" className="text-2xl font-bold text-slate-900 tracking-tight">
            TempoFlow
          </Link>
        </div>

        {/* 2. Middle Section: Centered Tabs */}
        <nav className="flex-none flex items-center bg-slate-100/80 p-1 rounded-xl border border-slate-200/60 shadow-inner">
          <button
            onClick={() => setActiveTab("ebs")}
            className={`px-6 py-1.5 text-xs font-bold rounded-lg transition-all duration-200 ${
              activeTab === "ebs"
                ? "bg-white text-sky-600 shadow-md ring-1 ring-black/5"
                : "text-slate-500 hover:text-slate-700 hover:bg-white/50"
            }`}
          >
            EBS VIEWER
          </button>
          <button
            onClick={() => setActiveTab("feedback")}
            className={`px-6 py-1.5 text-xs font-bold rounded-lg transition-all duration-200 ${
              activeTab === "feedback"
                ? "bg-white text-sky-600 shadow-md ring-1 ring-black/5"
                : "text-slate-500 hover:text-slate-700 hover:bg-white/50"
            }`}
          >
            FEEDBACK
          </button>
          <button
            onClick={() => setActiveTab("diff")}
            className={`px-6 py-1.5 text-xs font-bold rounded-lg transition-all duration-200 ${
              activeTab === "diff"
                ? "bg-white text-sky-600 shadow-md ring-1 ring-black/5"
                : "text-slate-500 hover:text-slate-700 hover:bg-white/50"
            }`}
          >
            OVERLAY DIFFERENCE
          </button>
        </nav>

        {/* 3. Right Section: Actions (Flex-1 + justify-end) */}
        <div className="flex-1 flex justify-end items-center gap-3">
          <Link 
            href="/dashboard" 
            className="px-4 py-2 bg-sky-50 text-sky-700 rounded-full text-sm font-medium hover:bg-sky-100 transition-colors"
          >
            Dashboard
          </Link>
          <Link 
            href="/upload" 
            className="px-4 py-2 bg-slate-900 text-white rounded-full text-sm font-medium hover:bg-slate-800 transition-colors shadow-lg shadow-slate-200"
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
                TempoFlow is sending both videos to the local Python EBS service, extracting audio, aligning the clips,
                then building beat-synced segments. Larger files can take a couple of minutes.
              </p>
              <p className="mt-2 text-slate-500">
                Keep this tab active while processing. If the browser suspends the request, retry once after confirming
                that the local A5 EBS server is still running.
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
            ) : (
              <p className="mt-6 text-sm text-slate-500">
                This test flow requires the local Python EBS service to be running.
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
      {/* --- EBS VIEWER TAB --- */}
      {activeTab === "ebs" && (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
          <EbsViewer
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
      )}

      {/* --- FEEDBACK TAB --- */}
      {activeTab === "feedback" && (
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
      )}

      {/* --- DIFFERENCE TAB --- */}
      {activeTab === "diff" && (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
          <DifferenceViewer 
          referenceVideoUrl={referenceVideoUrl}
          userVideoUrl={practiceVideoUrl}
          ebsData={ebsData}
        />
        </div>
      )}
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
