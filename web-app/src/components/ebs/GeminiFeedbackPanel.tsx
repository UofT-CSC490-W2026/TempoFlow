"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { EbsData, EbsSegment } from "./types";
import { getSessionVideo } from "../../lib/videoStorage";
import { getPublicEbsProcessorUrl } from "../../lib/ebsProcessorUrl";
import { buildGeminiSegmentDebugRows } from "../../lib/geminiDebugInfo";
import { computePosePriorsForSegment } from "../../lib/geminiPosePriors";
import {
  buildFeedbackSegmentKey,
  getFeedbackSegment,
  hashEbsData,
  storeFeedbackSegment,
} from "../../lib/feedbackStorage";
import type { GeminiFlatMove, GeminiSegmentResult } from "../../lib/geminiFeedbackTypes";

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
  mixed: { label: "Mixed", color: "text-violet-700", bg: "bg-violet-50", dot: "bg-violet-400" },
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
  onSeek: (time: number) => void;
  onFeedbackReady?: (moves: GeminiFlatMove[]) => void;
  /** When set, pose-based timing priors are computed client-side and sent with each segment request. */
  referenceVideoUrl?: string | null;
  userVideoUrl?: string | null;
};

export type GeminiFeedbackPanelHandle = {
  /** Queue Gemini move-feedback for this segment (call when BodyPix for that segment is ready). Runs one segment at a time. */
  enqueueSegmentAfterBodyPix: (segmentIndex: number) => void;
};

const FETCH_RETRIES = 3;

export const GeminiFeedbackPanel = forwardRef<GeminiFeedbackPanelHandle, GeminiFeedbackPanelProps>(
  function GeminiFeedbackPanel(props, ref) {
  const {
    sessionId,
    ebsData,
    segments,
    sharedTime,
    onSeek,
    onFeedbackReady,
    referenceVideoUrl,
    userVideoUrl,
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
  const listRef = useRef<HTMLDivElement>(null);
  const userHovering = useRef(false);

  const queueRef = useRef<number[]>([]);
  const drainingRef = useRef(false);

  const processorBaseUrl = useMemo(getProcessorBaseUrl, []);

  useEffect(() => {
    queueRef.current = [];
    drainingRef.current = false;
    setResults([]);
    setSegmentsDone(0);
    setSegmentsTotal(0);
    setError(null);
    setPipelineHint(null);
  }, [sessionId]);

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

  const filtered = useMemo(() => {
    if (filterLabel === "all") return flatMoves;
    return flatMoves.filter((m) => m.micro_timing_label === filterLabel);
  }, [flatMoves, filterLabel]);

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
    if (!container || flatMoves.length === 0 || userHovering.current) return;

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
  }, [sharedTime, filtered, flatMoves]);

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
        form.append("burn_in_labels", burnInLabels ? "true" : "false");
        form.append("include_audio", includeAudio ? "true" : "false");

        try {
          const res = await fetch(`${processorBaseUrl}/api/move-feedback`, {
            method: "POST",
            body: form,
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error((body as { error?: string }).error ?? `Segment ${segIndex} failed (${res.status})`);
          }
          const data = (await res.json()) as GeminiSegmentResult;
          await storeFeedbackSegment(cacheKey, data);
          return data;
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
        const segIndex = queueRef.current.shift()!;
        const ord = validIndices.indexOf(segIndex) + 1;
        setPipelineHint(
          ord > 0
            ? `Gemini: segment ${segIndex + 1} (${ord}/${validIndices.length})`
            : `Gemini: segment ${segIndex + 1}`,
        );
        try {
          const data = await fetchSegmentWithRetries(segIndex);
          setResults((prev) => {
            const rest = prev.filter((r) => r.segment_index !== segIndex);
            return [...rest, data].sort((a, b) => a.segment_index - b.segment_index);
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
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
      setPipelineHint(null);
      if (queueRef.current.length > 0) {
        void drainQueue();
      }
    }
  }, [validIndices, fetchSegmentWithRetries]);

  const enqueueSegmentAfterBodyPix = useCallback(
    (segmentIndex: number) => {
      if (!sessionId || validIndices.length === 0) return;
      if (!validIndices.includes(segmentIndex)) return;
      if (queueRef.current.includes(segmentIndex)) return;
      queueRef.current.push(segmentIndex);
      setPipelineHint(`Queued segment ${segmentIndex + 1} for Gemini…`);
      void drainQueue();
    },
    [sessionId, validIndices],
  );

  useImperativeHandle(ref, () => ({ enqueueSegmentAfterBodyPix }), [enqueueSegmentAfterBodyPix]);

  useEffect(() => {
    const flat: GeminiFlatMove[] = results.flatMap((r) =>
      (r.moves ?? []).map((m) => ({ ...m, segmentIndex: r.segment_index })),
    );
    onFeedbackReady?.(flat);
  }, [results, onFeedbackReady]);

  const progressPercent =
    segmentsTotal > 0 ? Math.round((segmentsDone / segmentsTotal) * 100) : 0;

  const labelCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of flatMoves) {
      const l = m.micro_timing_label || "uncertain";
      counts[l] = (counts[l] || 0) + 1;
    }
    return counts;
  }, [flatMoves]);

  const onTimeCount = labelCounts["on-time"] ?? 0;
  const issueCount = flatMoves.length - onTimeCount;

  return (
    <div className="rounded-[24px] border border-indigo-100 bg-white shadow-sm overflow-hidden">
      {/* Progress */}
      {running && (
        <div className="px-5 py-3 bg-indigo-50/60 border-b border-indigo-100">
          <div className="flex items-center justify-between text-xs text-slate-600 mb-1.5">
            <span>
              {segmentsDone < segmentsTotal
                ? `Completed ${segmentsDone} of ${segmentsTotal} segments (sequential)…`
                : "Finishing up…"}
            </span>
            <span>{progressPercent}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-indigo-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-violet-500 transition-all duration-300"
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
      {flatMoves.length > 0 && (
        <>
          {/* Summary */}
          <div className="px-5 py-4 border-b border-indigo-50">
            <div className="flex items-center gap-4 flex-wrap">
              <p className="text-sm font-medium text-slate-800">
                {flatMoves.length} move{flatMoves.length === 1 ? "" : "s"} across{" "}
                {results.filter((r) => r.moves?.length).length} segment
                {results.filter((r) => r.moves?.length).length === 1 ? "" : "s"}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                {onTimeCount > 0 && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-medium">
                    {onTimeCount} on-time
                  </span>
                )}
                {issueCount > 0 && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-medium">
                    {issueCount} timing issue{issueCount === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-slate-400 ml-auto">
                Model: {results[0]?.model ?? "gemini-2.5-flash-lite"}
              </p>
            </div>
          </div>

          {/* Filters */}
          <div className="px-5 py-2.5 border-b border-indigo-50 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-slate-500">Filter:</span>
            {["all", "on-time", "early", "late", "rushed", "dragged", "mixed", "uncertain"].map(
              (lbl) => (
                <button
                  key={lbl}
                  onClick={() => setFilterLabel(filterLabel === lbl ? "all" : lbl)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium border transition-all ${
                    filterLabel === lbl
                      ? "bg-slate-900 text-white border-slate-900"
                      : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  {lbl === "all" ? "All" : (TIMING_BADGES[lbl]?.label ?? lbl)}
                  {lbl !== "all" && labelCounts[lbl] ? ` (${labelCounts[lbl]})` : ""}
                </button>
              ),
            )}
            <span className="text-[11px] text-slate-400 ml-auto">
              {filtered.length} of {flatMoves.length}
            </span>
          </div>

          {/* Move list - single item view with navigation */}
          <div className="border-t border-indigo-50">
            {filtered.length > 0 && (
              <>
                {/* Navigation header */}
                <div className="px-5 py-2 border-b border-indigo-50 flex items-center justify-between bg-slate-50/50">
                  <button
                    onClick={() => setCurrentMoveIndex((i) => Math.max(0, i - 1))}
                    disabled={currentMoveIndex === 0}
                    className="px-3 py-1 text-xs font-medium rounded-lg bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    ◀ Prev
                  </button>
                  <span className="text-xs font-medium text-slate-600">
                    {currentMoveIndex + 1} / {filtered.length}
                  </span>
                  <button
                    onClick={() => setCurrentMoveIndex((i) => Math.min(filtered.length - 1, i + 1))}
                    disabled={currentMoveIndex >= filtered.length - 1}
                    className="px-3 py-1 text-xs font-medium rounded-lg bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Next ▶
                  </button>
                </div>

                {/* Single move display - clickable card */}
                {(() => {
                  const m = filtered[currentMoveIndex];
                  if (!m) return null;
                  const badge = TIMING_BADGES[m.micro_timing_label] ?? DEFAULT_BADGE;
                  const mid = ((m.shared_start_sec ?? 0) + (m.shared_end_sec ?? 0)) / 2;

                  return (
                    <div 
                      onClick={() => onSeek(m.shared_start_sec ?? mid)}
                      className="px-5 py-4 cursor-pointer hover:bg-slate-50/50 transition-colors"
                    >
                      {/* Header row */}
                      <div className="flex items-center gap-2 mb-3">
                        <div className={`w-2.5 h-2.5 rounded-full ${badge.dot}`} />
                        <span className="text-sm font-mono font-medium text-slate-700">
                          Move {m.move_index}
                        </span>
                        <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide ${badge.bg} ${badge.color}`}>
                          {badge.label}
                        </span>
                        <span className="text-[11px] text-slate-400 font-mono ml-auto">
                          {fmtTime(m.shared_start_sec ?? 0)}–{fmtTime(m.shared_end_sec ?? 0)}
                        </span>
                      </div>

                      {/* Timing explanation */}
                      {TIMING_LABEL_FRIENDLY[m.micro_timing_label] && (
                        <p className="text-xs text-slate-500 mb-2 leading-snug">
                          {TIMING_LABEL_FRIENDLY[m.micro_timing_label]}
                        </p>
                      )}

                      {/* Evidence */}
                      {m.micro_timing_evidence && (
                        <p className="text-sm text-slate-700 mb-3 leading-relaxed">
                          {m.micro_timing_evidence}
                        </p>
                      )}

                      {/* Meta info row */}
                      <div className="flex items-center gap-2 flex-wrap mb-3">
                        {m.confidence && (
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                            m.confidence === "high"
                              ? "bg-emerald-50 text-emerald-600"
                              : m.confidence === "medium"
                                ? "bg-amber-50 text-amber-600"
                                : "bg-slate-100 text-slate-500"
                          }`}>
                            {m.confidence} confidence
                          </span>
                        )}
                        {m.user_relative_to_reference && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-medium">
                            vs ref: {m.user_relative_to_reference}
                          </span>
                        )}
                        <span className="text-[10px] text-slate-400">Seg {m.segmentIndex}</span>
                      </div>

                      {/* Body parts */}
                      {m.body_parts_involved?.length > 0 && (
                        <div className="flex gap-1.5 mb-3 flex-wrap">
                          {m.body_parts_involved.map((bp) => (
                            <span
                              key={bp}
                              className="text-[11px] px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 font-medium"
                            >
                              {bp}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Guardrail note */}
                      {m.guardrail_note && (
                        <p className="text-xs text-amber-800 bg-amber-50/80 rounded-lg px-3 py-2 mb-3">
                          {m.guardrail_note}
                        </p>
                      )}

                      {/* Coaching note */}
                      {m.coaching_note && (
                        <div className="bg-indigo-50/70 rounded-lg px-3 py-3">
                          <p className="text-sm text-indigo-800 leading-relaxed font-medium">
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
          <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-indigo-50 flex items-center justify-center">
            <svg className="w-7 h-7 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          </div>
          <p className="text-sm font-medium text-slate-700">Waiting for BodyPix / Gemini</p>
          <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
            Feedback starts automatically when each segment&apos;s BodyPix overlay finishes. Gemini runs one segment at a
            time on the server (retries on transient network errors). Results are cached in the browser (IndexedDB) per
            session and analysis, like BodyPix overlays—revisits skip duplicate API calls.
          </p>
          <p className="text-[10px] text-slate-400 mt-3">
            Requires GEMINI_API_KEY on the Python backend
          </p>
        </div>
      )}
    </div>
  );
});

GeminiFeedbackPanel.displayName = "GeminiFeedbackPanel";
