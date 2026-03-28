"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EbsData, EbsSegment } from "./types";
import { getSessionVideo } from "../../lib/videoStorage";

const DEFAULT_PROCESSOR_BASE = "http://127.0.0.1:8787";

function getProcessorBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_EBS_PROCESSOR_URL ?? `${DEFAULT_PROCESSOR_BASE}/api/process`;
  return url.replace(/\/api\/process\/?$/, "");
}

export type GeminiMoveResult = {
  move_index: number;
  time_window: string;
  micro_timing_label: string;
  micro_timing_evidence: string;
  body_parts_involved: string[];
  coaching_note: string;
  confidence: string;
  shared_start_sec?: number;
  shared_end_sec?: number;
};

export type GeminiSegmentResult = {
  segment_index: number;
  model?: string;
  moves: GeminiMoveResult[];
  error?: string;
};

export type GeminiFlatMove = GeminiMoveResult & { segmentIndex: number };

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
};

export function GeminiFeedbackPanel(props: GeminiFeedbackPanelProps) {
  const { sessionId, ebsData, segments, sharedTime, onSeek, onFeedbackReady } = props;

  const [running, setRunning] = useState(false);
  const [segmentsDone, setSegmentsDone] = useState(0);
  const [segmentsTotal, setSegmentsTotal] = useState(0);
  const [results, setResults] = useState<GeminiSegmentResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filterLabel, setFilterLabel] = useState<string>("all");
  const hasRun = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const userHovering = useRef(false);

  const processorBaseUrl = useMemo(getProcessorBaseUrl, []);

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

  const runAnalysis = useCallback(async () => {
    if (running || segments.length === 0 || !sessionId) return;
    setRunning(true);
    setError(null);
    setResults([]);
    hasRun.current = true;

    try {
      const [refFile, userFile] = await Promise.all([
        getSessionVideo(sessionId, "reference"),
        getSessionVideo(sessionId, "practice"),
      ]);
      if (!refFile || !userFile) {
        setError("Could not load video files from local storage.");
        setRunning(false);
        return;
      }

      const validIndices = segments
        .map((_, i) => i)
        .filter((i) => {
          const range = segments[i].beat_idx_range;
          return range && range[1] > range[0];
        });

      if (validIndices.length === 0) {
        setError("No segments with beat data to analyze.");
        setRunning(false);
        return;
      }

      setSegmentsTotal(validIndices.length);
      setSegmentsDone(0);

      const ebsJson = JSON.stringify(ebsData);

      const settled = await Promise.allSettled(
        validIndices.map(async (segIndex) => {
          const form = new FormData();
          form.append("ref_video", refFile, refFile.name || "ref.mp4");
          form.append("user_video", userFile, userFile.name || "user.mp4");
          form.append("segment_index", String(segIndex));
          form.append("session_id", sessionId);
          form.append("ebs_data_json", ebsJson);

          const res = await fetch(`${processorBaseUrl}/api/move-feedback`, {
            method: "POST",
            body: form,
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error((body as { error?: string }).error ?? `Segment ${segIndex} failed`);
          }
          const data = (await res.json()) as GeminiSegmentResult;
          setSegmentsDone((n) => n + 1);
          return data;
        }),
      );

      const allResults: GeminiSegmentResult[] = settled.map((s, i) => {
        if (s.status === "fulfilled") return s.value;
        return {
          segment_index: validIndices[i],
          moves: [],
          error: String((s as PromiseRejectedResult).reason),
        };
      });

      allResults.sort((a, b) => a.segment_index - b.segment_index);
      setResults(allResults);

      const flat: GeminiFlatMove[] = allResults.flatMap((r) =>
        (r.moves ?? []).map((m) => ({ ...m, segmentIndex: r.segment_index })),
      );
      onFeedbackReady?.(flat);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gemini analysis failed.");
    } finally {
      setRunning(false);
    }
  }, [running, segments, sessionId, ebsData, processorBaseUrl, onFeedbackReady]);

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
      {/* Header */}
      <div className="px-5 py-4 border-b border-indigo-50 bg-gradient-to-r from-indigo-50 to-white">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Gemini Micro-Timing Analysis
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Sends each segment as a low-res video pair to Gemini 2.5 Flash-Lite for move-level micro-timing comparison.
            </p>
          </div>
          <button
            onClick={runAnalysis}
            disabled={running || segments.length === 0}
            className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running ? "Analyzing..." : hasRun.current ? "Re-run" : "Run Analysis"}
          </button>
        </div>
      </div>

      {/* Progress */}
      {running && (
        <div className="px-5 py-3 bg-indigo-50/60 border-b border-indigo-100">
          <div className="flex items-center justify-between text-xs text-slate-600 mb-1.5">
            <span>
              {segmentsDone < segmentsTotal
                ? `Segment ${segmentsDone + 1} of ${segmentsTotal} (parallel)…`
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

          {/* Move list */}
          <div
            ref={listRef}
            onMouseEnter={() => { userHovering.current = true; }}
            onMouseLeave={() => { userHovering.current = false; }}
            className="max-h-[420px] overflow-y-auto divide-y divide-indigo-50"
          >
            {filtered.map((m, i) => {
              const badge = TIMING_BADGES[m.micro_timing_label] ?? DEFAULT_BADGE;
              const mid = ((m.shared_start_sec ?? 0) + (m.shared_end_sec ?? 0)) / 2;
              const isNear = Math.abs(mid - sharedTime) < 0.8;

              return (
                <button
                  key={`${m.segmentIndex}-${m.move_index}-${i}`}
                  onClick={() => onSeek(m.shared_start_sec ?? mid)}
                  className={`w-full text-left px-5 py-3.5 transition-all hover:bg-indigo-50/50 ${
                    isNear ? "bg-indigo-50/60 ring-inset ring-1 ring-indigo-200" : ""
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0">
                      <div className={`w-2.5 h-2.5 rounded-full ${badge.dot}`} />
                      <span className="text-[10px] text-slate-400 font-mono">
                        {fmtTime(m.shared_start_sec ?? 0)}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] font-mono text-slate-500">
                          Move {m.move_index}
                        </span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold uppercase tracking-wide ${badge.bg} ${badge.color}`}
                        >
                          {badge.label}
                        </span>
                        <span className="text-[10px] text-slate-400 font-mono">
                          {fmtTime(m.shared_start_sec ?? 0)}&ndash;{fmtTime(m.shared_end_sec ?? 0)}
                        </span>
                        {m.confidence && (
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                              m.confidence === "high"
                                ? "bg-emerald-50 text-emerald-600"
                                : m.confidence === "medium"
                                  ? "bg-amber-50 text-amber-600"
                                  : "bg-slate-100 text-slate-500"
                            }`}
                          >
                            {m.confidence}
                          </span>
                        )}
                        <span className="text-[10px] text-slate-400 ml-auto">Seg {m.segmentIndex}</span>
                      </div>
                      {m.micro_timing_evidence && (
                        <p className="text-[11px] text-slate-600 mt-1.5 leading-snug">
                          {m.micro_timing_evidence}
                        </p>
                      )}
                      {m.body_parts_involved?.length > 0 && (
                        <div className="flex gap-1 mt-1.5 flex-wrap">
                          {m.body_parts_involved.map((bp) => (
                            <span
                              key={bp}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-medium"
                            >
                              {bp}
                            </span>
                          ))}
                        </div>
                      )}
                      {m.coaching_note && (
                        <p className="text-xs text-indigo-700 mt-2 leading-relaxed font-medium">
                          {m.coaching_note}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {filtered.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-slate-500">
              No moves match the current filter.
            </div>
          )}
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
          <p className="text-sm font-medium text-slate-700">Ready for Gemini analysis</p>
          <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
            Click &ldquo;Run Analysis&rdquo; to send each segment&apos;s video clips to Gemini 2.5 Flash-Lite for per-move micro-timing comparison.
          </p>
          <p className="text-[10px] text-slate-400 mt-3">
            Requires GEMINI_API_KEY on the Python backend
          </p>
        </div>
      )}
    </div>
  );
}
