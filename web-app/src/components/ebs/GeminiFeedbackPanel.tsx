"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { EbsData, EbsSegment } from "./types";
import { getSessionVideo } from "../../lib/videoStorage";
import { getPublicEbsProcessorUrl } from "../../lib/ebsProcessorUrl";
import { buildGeminiSegmentDebugRows } from "../../lib/geminiDebugInfo";
import { computePosePriorsForSegment } from "../../lib/geminiPosePriors";
import { buildGeminiYoloSegmentContext } from "../../lib/geminiYoloContext";
import {
  buildFeedbackSegmentKey,
  getFeedbackSegment,
  hashEbsData,
  storeFeedbackSegment,
} from "../../lib/feedbackStorage";
import type { OverlayArtifact } from "../../lib/overlayStorage";
import type { GeminiFlatMove, GeminiSegmentResult } from "../../lib/geminiFeedbackTypes";
import { filterGeminiFeedbackByDifficulty, type FeedbackDifficulty } from "./feedbackDifficulty";

export type { GeminiFlatMove, GeminiMoveResult, GeminiSegmentResult } from "../../lib/geminiFeedbackTypes";

function getProcessorBaseUrl(): string {
  return getPublicEbsProcessorUrl().replace(/\/api\/process\/?$/, "");
}

export const TIMING_LABEL_COLORS: Record<string, string> = {
  "on-time": "#34d399",
  early: "#fbbf24",
  late: "#fbbf24",
  rushed: "#fb923c",
  dragged: "#fb923c",
  mixed: "#a78bfa",
  uncertain: "#94a3b8",
};

const TIMING_BADGES: Record<
  string,
  { label: string; color: string; bg: string; dot: string }
> = {
  "on-time": { label: "On-time", color: "text-emerald-700", bg: "bg-emerald-50", dot: "bg-emerald-400" },
  early: { label: "Early", color: "text-amber-700", bg: "bg-amber-50", dot: "bg-amber-400" },
  late: { label: "Late", color: "text-amber-700", bg: "bg-amber-50", dot: "bg-amber-400" },
  rushed: { label: "Rushed", color: "text-orange-700", bg: "bg-orange-50", dot: "bg-orange-400" },
  dragged: { label: "Dragged", color: "text-orange-700", bg: "bg-orange-50", dot: "bg-orange-400" },
  mixed: { label: "Mixed", color: "text-sky-700", bg: "bg-sky-50", dot: "bg-sky-400" },
  uncertain: { label: "Uncertain", color: "text-slate-500", bg: "bg-slate-100", dot: "bg-slate-400" },
};

const DEFAULT_BADGE = { label: "Unknown", color: "text-slate-500", bg: "bg-slate-100", dot: "bg-slate-400" };

/** Plain-language hints (plan: reduce early/late vs “fast/slow” confusion). */
const TIMING_LABEL_FRIENDLY: Record<string, string> = {
  "on-time": "Matches the reference accent timing in this window.",
  early: "Ahead of the reference motion or beat.",
  late: "Behind the reference motion or beat.",
  rushed: "Tight or sharp—often reads as quick or ahead.",
  dragged: "Extended finish—can feel slow or behind.",
  mixed: "Some parts early, some late in the same move.",
  uncertain: "Not enough clear motion to judge timing.",
};

function fmtTime(sec: number) {
  const safe = Math.max(0, sec);
  const m = Math.floor(safe / 60);
  return `${m}:${(safe % 60).toFixed(1).padStart(4, "0")}`;
}

type GeminiFeedbackPanelProps = {
  sessionId: string;
  ebsData: EbsData;
  segments: EbsSegment[];
  sharedTime: number;
  feedbackDifficulty?: FeedbackDifficulty;
  renderUi?: boolean;
  onSeek: (time: number) => void;
  onFeedbackReady?: (moves: GeminiFlatMove[]) => void;
  /** When set, pose-based timing priors are computed client-side and sent with each segment request. */
  referenceVideoUrl?: string | null;
  userVideoUrl?: string | null;
  referenceYoloArtifact?: OverlayArtifact | null;
  practiceYoloArtifact?: OverlayArtifact | null;
  referenceYoloPoseArtifact?: OverlayArtifact | null;
  practiceYoloPoseArtifact?: OverlayArtifact | null;
  onPipelineProgress?: (progress: { done: number; total: number }) => void;
};

export type GeminiFeedbackPanelHandle = {
  /** Queue Gemini move-feedback for this segment once YOLO context for it is ready. Runs one segment at a time. */
  enqueueSegmentForFeedback: (segmentIndex: number) => void;
};

const FETCH_RETRIES = 3;
const GEMINI_JOB_POLL_MS = 1500;
const GEMINI_JOB_TIMEOUT_MS = 20 * 60 * 1000;

type GeminiRateLimitInfo = {
  retryAfterMs: number;
  message: string;
};

function parseGeminiRateLimit(error: unknown): GeminiRateLimitInfo | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();
  if (
    !lower.includes("quota exceeded") &&
    !lower.includes("rate limit") &&
    !lower.includes("429") &&
    !lower.includes("retry in")
  ) {
    return null;
  }

  const secondsMatch =
    message.match(/retry(?:[^0-9]+)(\d+(?:\.\d+)?)s/i) ??
    message.match(/retry_delay[^0-9]*(\d+(?:\.\d+)?)/i) ??
    message.match(/please retry in\s+(\d+(?:\.\d+)?)s/i);
  const retryAfterSec = secondsMatch ? Number.parseFloat(secondsMatch[1]) : NaN;
  const retryAfterMs =
    Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? Math.ceil(retryAfterSec * 1000)
      : 60_000;

  return {
    retryAfterMs,
    message,
  };
}

export const GeminiFeedbackPanel = forwardRef<GeminiFeedbackPanelHandle, GeminiFeedbackPanelProps>(
  function GeminiFeedbackPanel(props, ref) {
  const {
    sessionId,
    ebsData,
    segments,
    sharedTime,
    feedbackDifficulty = "standard",
    renderUi = true,
    onSeek,
    onFeedbackReady,
    referenceVideoUrl,
    userVideoUrl,
    referenceYoloArtifact,
    practiceYoloArtifact,
    referenceYoloPoseArtifact,
    practiceYoloPoseArtifact,
    onPipelineProgress,
  } = props;

  const [running, setRunning] = useState(false);
  const [segmentsDone, setSegmentsDone] = useState(0);
  const [segmentsTotal, setSegmentsTotal] = useState(0);
  const [results, setResults] = useState<GeminiSegmentResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filterLabel, setFilterLabel] = useState<string>("all");
  const [currentMoveIndex, setCurrentMoveIndex] = useState<number>(0);
  const [showPipelineDebug, setShowPipelineDebug] = useState(false);
  const [burnInLabels, setBurnInLabels] = useState(true);
  const [includeAudio, setIncludeAudio] = useState(false);
  const [pipelineHint, setPipelineHint] = useState<string | null>(null);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const userHovering = useRef(false);

  const queueRef = useRef<number[]>([]);
  const drainingRef = useRef(false);
  const rateLimitResumeTimerRef = useRef<number | null>(null);
  const rateLimitResumeAtRef = useRef<number | null>(null);

  const processorBaseUrl = useMemo(getProcessorBaseUrl, []);

  useEffect(() => {
    queueRef.current = [];
    drainingRef.current = false;
    if (rateLimitResumeTimerRef.current != null) {
      window.clearTimeout(rateLimitResumeTimerRef.current);
      rateLimitResumeTimerRef.current = null;
    }
    rateLimitResumeAtRef.current = null;
    setResults([]);
    setSegmentsDone(0);
    setSegmentsTotal(0);
    setError(null);
    setPipelineHint(null);
  }, [sessionId]);

  useEffect(() => {
    return () => {
      queueRef.current = [];
      drainingRef.current = false;
      if (rateLimitResumeTimerRef.current != null) {
        window.clearTimeout(rateLimitResumeTimerRef.current);
        rateLimitResumeTimerRef.current = null;
      }
      rateLimitResumeAtRef.current = null;
    };
  }, []);

  const pipelineDebugRows = useMemo(
    () => buildGeminiSegmentDebugRows(ebsData, segments),
    [ebsData, segments],
  );

  const validIndices = useMemo(
    () =>
      segments
        .map((_, i) => i)
        .filter((i) => {
          const range = segments[i].beat_idx_range;
          return range != null && range[1] > range[0];
        }),
    [segments],
  );

  const ebsFingerprint = useMemo(() => hashEbsData(ebsData), [ebsData]);

  useEffect(() => {
    if (!sessionId || validIndices.length === 0) return;
    let cancelled = false;
    void (async () => {
      const rows: GeminiSegmentResult[] = [];
      for (const segIndex of validIndices) {
        const key = buildFeedbackSegmentKey({
          sessionId,
          segmentIndex: segIndex,
          burnInLabels,
          includeAudio,
          ebsFingerprint,
        });
        const c = await getFeedbackSegment(key);
        if (c) rows.push(c);
      }
      if (cancelled || rows.length === 0) return;
      setResults((prev) => {
        const bySeg = new Map<number, GeminiSegmentResult>();
        for (const r of prev) bySeg.set(r.segment_index, r);
        for (const r of rows) bySeg.set(r.segment_index, r);
        return [...bySeg.values()].sort((a, b) => a.segment_index - b.segment_index);
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, validIndices, burnInLabels, includeAudio, ebsFingerprint]);

  const flatMoves = useMemo<GeminiFlatMove[]>(
    () =>
      results.flatMap((r) =>
        (r.moves ?? []).map((m) => ({ ...m, segmentIndex: r.segment_index })),
      ),
    [results],
  );

  const difficultyFilteredMoves = useMemo(
    () => filterGeminiFeedbackByDifficulty(flatMoves, feedbackDifficulty),
    [flatMoves, feedbackDifficulty],
  );

  const filtered = useMemo(() => {
    if (filterLabel === "all") return difficultyFilteredMoves;
    return difficultyFilteredMoves.filter((m) => m.micro_timing_label === filterLabel);
  }, [difficultyFilteredMoves, filterLabel]);

  // Reset current index when filter changes
  useEffect(() => {
    setCurrentMoveIndex(0);
  }, [filterLabel]);

  // Auto-transition to current move based on sharedTime
  useEffect(() => {
    if (filtered.length === 0) return;
    
    // Find the move that contains the current time
    const activeIndex = filtered.findIndex((m) => {
      const start = m.shared_start_sec ?? 0;
      const end = m.shared_end_sec ?? start;
      return sharedTime >= start && sharedTime < end;
    });
    
    // If found and different from current, update
    if (activeIndex !== -1 && activeIndex !== currentMoveIndex) {
      setCurrentMoveIndex(activeIndex);
    }
  }, [sharedTime, filtered, currentMoveIndex]);

  useEffect(() => {
    const container = listRef.current;
    if (!container || difficultyFilteredMoves.length === 0 || userHovering.current) return;

    const closest = filtered.reduce<GeminiFlatMove | null>((best, m) => {
      const mid = ((m.shared_start_sec ?? 0) + (m.shared_end_sec ?? 0)) / 2;
      const bestMid = best ? ((best.shared_start_sec ?? 0) + (best.shared_end_sec ?? 0)) / 2 : Infinity;
      return !best || Math.abs(mid - sharedTime) < Math.abs(bestMid - sharedTime) ? m : best;
    }, null);
    if (!closest) return;

    const idx = filtered.indexOf(closest);
    const el = container.children[idx] as HTMLElement | undefined;
    if (!el) return;

    const elTop = el.offsetTop;
    const elH = el.offsetHeight;
    const cTop = container.scrollTop;
    const cH = container.clientHeight;
    if (elTop < cTop || elTop + elH > cTop + cH) {
      container.scrollTo({ top: elTop - cH / 2 + elH / 2, behavior: "smooth" });
    }
  }, [sharedTime, filtered, difficultyFilteredMoves]);

  const fetchSegmentWithRetries = useCallback(
    async (segIndex: number): Promise<GeminiSegmentResult> => {
      const cacheKey = buildFeedbackSegmentKey({
        sessionId,
        segmentIndex: segIndex,
        burnInLabels,
        includeAudio,
        ebsFingerprint,
      });
      const cached = await getFeedbackSegment(cacheKey);
      if (cached) return cached;

      const [refFile, userFile] = await Promise.all([
        getSessionVideo(sessionId, "reference"),
        getSessionVideo(sessionId, "practice"),
      ]);
      if (!refFile || !userFile) {
        throw new Error("Could not load video files from local storage.");
      }

      let priorsJson: string | undefined;
      if (referenceVideoUrl && userVideoUrl) {
        const priors = await computePosePriorsForSegment({
          referenceVideoUrl,
          userVideoUrl,
          ebsData,
          segments,
          segmentIndex: segIndex,
        });
        priorsJson = JSON.stringify(priors);
      }
      const yoloContext = buildGeminiYoloSegmentContext({
        referenceSegArtifact: referenceYoloArtifact ?? null,
        practiceSegArtifact: practiceYoloArtifact ?? null,
        referencePoseArtifact: referenceYoloPoseArtifact ?? null,
        practicePoseArtifact: practiceYoloPoseArtifact ?? null,
        segmentIndex: segIndex,
      });
      const yoloContextJson = yoloContext ? JSON.stringify(yoloContext) : undefined;

      const ebsJson = JSON.stringify(ebsData);
      let lastErr: Error | null = null;

      for (let attempt = 1; attempt <= FETCH_RETRIES; attempt += 1) {
        const form = new FormData();
        form.append("ref_video", refFile, refFile.name || "ref.mp4");
        form.append("user_video", userFile, userFile.name || "user.mp4");
        form.append("segment_index", String(segIndex));
        form.append("session_id", sessionId);
        form.append("ebs_data_json", ebsJson);
        if (priorsJson) {
          form.append("pose_priors_json", priorsJson);
        }
        if (yoloContextJson) {
          form.append("yolo_context_json", yoloContextJson);
        }
        form.append("burn_in_labels", burnInLabels ? "true" : "false");
        form.append("include_audio", includeAudio ? "true" : "false");

        try {
          const startRes = await fetch(`${processorBaseUrl}/api/move-feedback/start`, {
            method: "POST",
            body: form,
          });
          if (!startRes.ok) {
            const body = await startRes.json().catch(() => ({}));
            throw new Error((body as { error?: string }).error ?? `Segment ${segIndex} failed (${startRes.status})`);
          }

          const startBody = (await startRes.json()) as { job_id?: string; error?: string };
          if (!startBody.job_id) {
            throw new Error(startBody.error || `Missing Gemini job id for segment ${segIndex}`);
          }

          const deadline = Date.now() + GEMINI_JOB_TIMEOUT_MS;
          while (Date.now() < deadline) {
            await new Promise((resolve) => window.setTimeout(resolve, GEMINI_JOB_POLL_MS));
            const statusRes = await fetch(
              `${processorBaseUrl}/api/move-feedback/status?job_id=${encodeURIComponent(startBody.job_id)}`,
            );
            if (!statusRes.ok) {
              const body = await statusRes.json().catch(() => ({}));
              throw new Error((body as { error?: string }).error ?? `Gemini status failed (${statusRes.status})`);
            }
            const status = (await statusRes.json()) as { status?: string; error?: string };
            if (status.status === "done") {
              const resultRes = await fetch(
                `${processorBaseUrl}/api/move-feedback/result?job_id=${encodeURIComponent(startBody.job_id)}`,
              );
              if (!resultRes.ok) {
                const body = await resultRes.json().catch(() => ({}));
                throw new Error((body as { error?: string }).error ?? `Gemini result failed (${resultRes.status})`);
              }
              const data = (await resultRes.json()) as GeminiSegmentResult;
              await storeFeedbackSegment(cacheKey, data);
              return data;
            }
            if (status.status === "error") {
              throw new Error(status.error || `Gemini job failed for segment ${segIndex}`);
            }
          }

          throw new Error(`Gemini job timed out for segment ${segIndex}`);
        } catch (e) {
          lastErr = e instanceof Error ? e : new Error(String(e));
          const msg = lastErr.message.toLowerCase();
          const retryable =
            msg.includes("timeout") ||
            msg.includes("network") ||
            msg.includes("failed to fetch") ||
            msg.includes("load failed");
          if (attempt < FETCH_RETRIES && retryable) {
            await new Promise((r) => window.setTimeout(r, 1000 * attempt));
            continue;
          }
          throw lastErr;
        }
      }
      throw lastErr ?? new Error("Unknown fetch error");
    },
    [
      sessionId,
      ebsData,
      segments,
      processorBaseUrl,
      referenceVideoUrl,
      userVideoUrl,
      referenceYoloArtifact,
      practiceYoloArtifact,
      referenceYoloPoseArtifact,
      practiceYoloPoseArtifact,
      burnInLabels,
      includeAudio,
      ebsFingerprint,
    ],
  );

  const drainQueue = useCallback(async () => {
    if (drainingRef.current) return;
    if (validIndices.length === 0) return;
    drainingRef.current = true;
    setRunning(true);
    setError(null);
    setSegmentsTotal(validIndices.length);

    try {
      while (queueRef.current.length > 0) {
        if (rateLimitResumeAtRef.current && Date.now() < rateLimitResumeAtRef.current) {
          break;
        }
        const segIndex = queueRef.current.shift()!;
        const ord = validIndices.indexOf(segIndex) + 1;
        setPipelineHint(
          ord > 0
            ? `Gemini: segment ${segIndex + 1} (${ord}/${validIndices.length})`
            : `Gemini: segment ${segIndex + 1}`,
        );
        try {
          const data = await fetchSegmentWithRetries(segIndex);
          setError(null);
          setResults((prev) => {
            const rest = prev.filter((r) => r.segment_index !== segIndex);
            return [...rest, data].sort((a, b) => a.segment_index - b.segment_index);
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const rateLimit = parseGeminiRateLimit(e);
          if (rateLimit) {
            queueRef.current.unshift(segIndex);
            rateLimitResumeAtRef.current = Date.now() + rateLimit.retryAfterMs;
            if (rateLimitResumeTimerRef.current != null) {
              window.clearTimeout(rateLimitResumeTimerRef.current);
            }
            rateLimitResumeTimerRef.current = window.setTimeout(() => {
              rateLimitResumeTimerRef.current = null;
              rateLimitResumeAtRef.current = null;
              void drainQueue();
            }, rateLimit.retryAfterMs);
            setError(`Gemini rate limited. Retrying in ${Math.ceil(rateLimit.retryAfterMs / 1000)}s.`);
            setPipelineHint(`Gemini paused after rate limit. YOLO can keep processing while feedback waits.`);
            break;
          }
          setResults((prev) => {
            const rest = prev.filter((r) => r.segment_index !== segIndex);
            return [
              ...rest,
              { segment_index: segIndex, moves: [], error: msg },
            ].sort((a, b) => a.segment_index - b.segment_index);
          });
        }
        setSegmentsDone((n) => n + 1);
      }
    } finally {
      drainingRef.current = false;
      setRunning(false);
      if (!rateLimitResumeAtRef.current) {
        setPipelineHint(null);
      }
      if (queueRef.current.length > 0 && !rateLimitResumeAtRef.current) {
        void drainQueue();
      }
    }
  }, [validIndices, fetchSegmentWithRetries]);

  const enqueueSegmentForFeedback = useCallback(
    (segmentIndex: number) => {
      if (!sessionId || validIndices.length === 0) return;
      if (!validIndices.includes(segmentIndex)) return;
      if (queueRef.current.includes(segmentIndex)) return;
      queueRef.current.push(segmentIndex);
      if (rateLimitResumeAtRef.current && Date.now() < rateLimitResumeAtRef.current) {
        setPipelineHint(`Queued segment ${segmentIndex + 1} for Gemini after rate limit backoff…`);
        return;
      }
      setPipelineHint(`Queued segment ${segmentIndex + 1} for Gemini…`);
      void drainQueue();
    },
    [sessionId, validIndices],
  );

  useImperativeHandle(ref, () => ({ enqueueSegmentForFeedback }), [enqueueSegmentForFeedback]);

  useEffect(() => {
    onFeedbackReady?.(difficultyFilteredMoves);
  }, [difficultyFilteredMoves, onFeedbackReady]);

  const progressPercent =
    segmentsTotal > 0 ? Math.round((segmentsDone / segmentsTotal) * 100) : 0;

  useEffect(() => {
    onPipelineProgress?.({ done: segmentsDone, total: segmentsTotal });
  }, [onPipelineProgress, segmentsDone, segmentsTotal]);

  const labelCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of difficultyFilteredMoves) {
      const l = m.micro_timing_label || "uncertain";
      counts[l] = (counts[l] || 0) + 1;
    }
    return counts;
  }, [difficultyFilteredMoves]);

  const activeFilterBadge =
    filterLabel === "all"
      ? `All moves (${difficultyFilteredMoves.length})`
      : `${TIMING_BADGES[filterLabel]?.label ?? filterLabel} (${labelCounts[filterLabel] ?? 0})`;
  if (!renderUi) {
    return null;
  }
  return (
    <div className="overflow-hidden rounded-[24px] border border-sky-100 bg-white shadow-sm">
      {/* Progress */}
      {running && (
        <div className="border-b border-sky-100 bg-sky-50/70 px-4 py-2.5">
          <div className="flex items-center justify-between text-xs text-slate-600 mb-1.5">
            <span>
              {segmentsDone < segmentsTotal
                ? `Completed ${segmentsDone} of ${segmentsTotal} segments (sequential)…`
                : "Finishing up…"}
            </span>
            <span>{progressPercent}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-sky-100">
            <div
              className="h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-600 transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-5 py-3 bg-red-50 border-b border-red-100 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Results */}
      {difficultyFilteredMoves.length > 0 && (
        <>
          <div className="border-b border-sky-100 bg-gradient-to-r from-sky-50/90 via-white to-blue-50/70 px-4 py-2.5">
            <div className="flex items-center justify-end gap-3">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setFilterMenuOpen((open) => !open)}
                  className="rounded-full border border-sky-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-700 shadow-sm transition-colors hover:bg-sky-50"
                >
                  {activeFilterBadge}
                </button>
                {filterMenuOpen && (
                  <div className="absolute right-0 top-[calc(100%+8px)] z-20 min-w-[180px] rounded-2xl border border-sky-100 bg-white p-1.5 shadow-xl">
                    {["all", "on-time", "early", "late", "rushed", "dragged", "mixed", "uncertain"].map((lbl) => (
                      <button
                        key={lbl}
                        type="button"
                        onClick={() => {
                          setFilterLabel(lbl);
                          setFilterMenuOpen(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[11px] font-medium transition-colors ${
                          filterLabel === lbl
                            ? "bg-gradient-to-r from-sky-500 to-blue-600 text-white"
                            : "text-slate-600 hover:bg-sky-50"
                        }`}
                      >
                        <span>{lbl === "all" ? "All moves" : (TIMING_BADGES[lbl]?.label ?? lbl)}</span>
                        <span className={filterLabel === lbl ? "text-slate-200" : "text-slate-400"}>
                          {lbl === "all" ? difficultyFilteredMoves.length : (labelCounts[lbl] ?? 0)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Move list - single item view with navigation */}
          <div>
            {filtered.length > 0 && (
              <>
                {/* Single move display - clickable card */}
                {(() => {
                  const m = filtered[currentMoveIndex];
                  if (!m) return null;
                  const badge = TIMING_BADGES[m.micro_timing_label] ?? DEFAULT_BADGE;
                  const mid = ((m.shared_start_sec ?? 0) + (m.shared_end_sec ?? 0)) / 2;

                  return (
                    <div 
                      onClick={() => onSeek(m.shared_start_sec ?? mid)}
                      className="cursor-pointer px-4 py-3.5 transition-colors hover:bg-sky-50/40"
                    >
                      <div className="mb-2 flex items-center gap-2">
                        <div className={`w-2.5 h-2.5 rounded-full ${badge.dot}`} />
                        <span className="text-sm font-semibold text-slate-800">
                          Move {m.move_index}
                        </span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide ${badge.bg} ${badge.color}`}>
                          {badge.label}
                        </span>
                        {TIMING_LABEL_FRIENDLY[m.micro_timing_label] && (
                          <span
                            className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-sky-100 bg-white text-[11px] font-semibold text-sky-400"
                            title={TIMING_LABEL_FRIENDLY[m.micro_timing_label]}
                            aria-label={TIMING_LABEL_FRIENDLY[m.micro_timing_label]}
                          >
                            i
                          </span>
                        )}
                        <span className="text-[11px] text-slate-400 font-mono ml-auto">
                          {fmtTime(m.shared_start_sec ?? 0)}–{fmtTime(m.shared_end_sec ?? 0)}
                        </span>
                      </div>

                      {m.micro_timing_evidence && (
                        <p className="mb-2 text-sm leading-relaxed text-slate-700">
                          {m.micro_timing_evidence}
                        </p>
                      )}

                      <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                        <span>{TIMING_LABEL_FRIENDLY[m.micro_timing_label] ?? "Timing note"}</span>
                        {m.user_relative_to_reference && <span>vs ref: {m.user_relative_to_reference}</span>}
                        {m.confidence && <span>{m.confidence} confidence</span>}
                      </div>

                      {/* Guardrail note */}
                      {m.guardrail_note && (
                        <p className="mb-2 rounded-lg bg-amber-50/80 px-3 py-2 text-xs text-amber-800">
                          {m.guardrail_note}
                        </p>
                      )}

                      {/* Coaching note */}
                      {m.coaching_note && (
                        <div className="rounded-xl border border-sky-100 bg-gradient-to-r from-sky-50 to-blue-50 px-3 py-2.5">
                          <p className="text-sm text-sky-900 leading-relaxed font-medium">
                            {m.coaching_note}
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </>
            )}

            {filtered.length === 0 && (
              <div className="px-5 py-8 text-center text-sm text-slate-500">
                No moves match the current filter.
              </div>
            )}
          </div>
        </>
      )}

      {/* Per-segment errors */}
      {results.some((r) => r.error) && (
        <div className="px-5 py-3 border-t border-red-100 bg-red-50/50">
          <p className="text-xs font-medium text-red-700 mb-1">Some segments had errors:</p>
          {results
            .filter((r) => r.error)
            .map((r) => (
              <p key={r.segment_index} className="text-[11px] text-red-600">
                Segment {r.segment_index}: {r.error}
              </p>
            ))}
        </div>
      )}

      {/* Empty state */}
      {!running && flatMoves.length === 0 && !error && (
        <div className="px-5 py-8 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-50">
            <svg className="h-7 w-7 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          </div>
          <p className="text-sm font-medium text-slate-700">Waiting for motion feedback</p>
          <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
            Feedback starts automatically when each segment&apos;s YOLO segment data is ready. Gemini runs one segment at
            a time on the server and receives the segment videos plus YOLO pose and segmentation summaries as context.
            Results are cached in the browser (IndexedDB) per session and analysis, so revisits skip duplicate calls.
          </p>
          <p className="text-[10px] text-slate-400 mt-3">
            Requires GEMINI_API_KEY on the Python backend
          </p>
        </div>
      )}

      {!running && flatMoves.length > 0 && difficultyFilteredMoves.length === 0 && !error && (
        <div className="px-5 py-8 text-center text-sm text-slate-500">
          No Gemini moves are severe enough for the current difficulty setting.
        </div>
      )}
    </div>
  );
});

GeminiFeedbackPanel.displayName = "GeminiFeedbackPanel";
