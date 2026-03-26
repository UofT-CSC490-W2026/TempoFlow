"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EbsSegment } from "./types";
import {
  compareWithBodyPix,
  DEFAULT_POSE_FPS,
  FEEDBACK_FEATURE_LABELS,
  type ComparisonProgress,
  type DanceFeedback,
  type FeedbackSeverity,
} from "../../lib/bodyPixComparison";
import { buildFallbackPerFrameOutputs, buildPerFrameCoachPayload } from "../../lib/ebsTemporalLlm";

type FeedbackPanelProps = {
  referenceVideoUrl: string;
  userVideoUrl: string;
  segments: EbsSegment[];
  sharedTime: number;
  onSeek: (time: number) => void;
  onFeedbackReady?: (feedback: DanceFeedback[]) => void;
};

const SEVERITY_CONFIG: Record<
  FeedbackSeverity,
  { label: string; color: string; bg: string; border: string; dot: string }
> = {
  good: { label: "Good", color: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200", dot: "bg-emerald-400" },
  minor: { label: "Minor", color: "text-amber-700", bg: "bg-amber-50", border: "border-amber-200", dot: "bg-amber-400" },
  moderate: { label: "Needs work", color: "text-orange-700", bg: "bg-orange-50", border: "border-orange-200", dot: "bg-orange-400" },
  major: { label: "Focus here", color: "text-red-700", bg: "bg-red-50", border: "border-red-200", dot: "bg-red-500" },
};

function fmtTime(sec: number) {
  const safe = Math.max(0, sec);
  const m = Math.floor(safe / 60);
  return `${m}:${(safe % 60).toFixed(1).padStart(4, "0")}`;
}

function BodyDiagram({ feedback }: { feedback: DanceFeedback[] }) {
  const worst = useMemo(() => {
    const order: FeedbackSeverity[] = ["good", "minor", "moderate", "major"];
    return feedback.reduce<FeedbackSeverity>((w, fb) => {
      return order.indexOf(fb.severity) > order.indexOf(w) ? fb.severity : w;
    }, "good");
  }, [feedback]);

  const color =
    worst === "good" ? "#34d399" :
    worst === "minor" ? "#fbbf24" :
    worst === "moderate" ? "#fb923c" : "#f87171";

  return (
    <svg viewBox="0 0 100 200" className="w-20 h-40 mx-auto" aria-label="Body diagram">
      <circle cx="50" cy="22" r="14" fill={color} opacity="0.7" />
      <rect x="32" y="40" width="36" height="50" rx="6" fill={color} opacity="0.7" />
      <rect x="10" y="42" width="18" height="44" rx="6" fill={color} opacity="0.7" />
      <rect x="72" y="42" width="18" height="44" rx="6" fill={color} opacity="0.7" />
      <rect x="32" y="94" width="16" height="56" rx="6" fill={color} opacity="0.7" />
      <rect x="52" y="94" width="16" height="56" rx="6" fill={color} opacity="0.7" />
      <ellipse cx="40" cy="155" rx="10" ry="5" fill={color} opacity="0.7" />
      <ellipse cx="60" cy="155" rx="10" ry="5" fill={color} opacity="0.7" />
    </svg>
  );
}

export function FeedbackPanel(props: FeedbackPanelProps) {
  const { referenceVideoUrl, userVideoUrl, segments, sharedTime, onSeek, onFeedbackReady } = props;
  const [feedback, setFeedback] = useState<DanceFeedback[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ComparisonProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterSeverity, setFilterSeverity] = useState<FeedbackSeverity | "all">("all");
  const [timingIssuesOnly, setTimingIssuesOnly] = useState(false);
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmSource, setLlmSource] = useState<string | null>(null);
  const feedbackListRef = useRef<HTMLDivElement>(null);
  const userHovering = useRef(false);
  const hasRun = useRef(false);

  const runComparison = useCallback(async () => {
    if (running || segments.length === 0) return;
    setRunning(true);
    setError(null);
    setFeedback([]);
    setLlmSource(null);
    hasRun.current = true;

    try {
      const result = await compareWithBodyPix({
        referenceVideoUrl,
        userVideoUrl,
        segments,
        poseFps: DEFAULT_POSE_FPS,
        onProgress: setProgress,
      });
      const perFramePayload = buildPerFrameCoachPayload(segments, result.refSamples, result.userSamples);
      const withTimingFlags = result.feedback.map((fb) => ({
        ...fb,
        microTimingOff:
          fb.featureFamily === "micro_timing"
            ? fb.deviation >= 0.12
            : perFramePayload.frames[fb.frameIndex ?? 0]?.microTimingOff ?? false,
      }));
      setFeedback(withTimingFlags);
      onFeedbackReady?.(withTimingFlags);

      const total = result.refSamples.length;
      setProgress({ currentFrame: total, totalFrames: total, phase: "llm" });
      setLlmLoading(true);

      const applyRows = (
        rows: Array<{
          frameIndex: number;
          microTimingOff: boolean;
          attackDecay: string;
          transitionToNext: string;
        }>,
      ) => {
        const byIdx = new Map(rows.map((r) => [r.frameIndex, r]));
        return withTimingFlags.map((fb) => {
          const row = fb.frameIndex != null ? byIdx.get(fb.frameIndex) : undefined;
          if (!row) return fb;
          const message = `${row.attackDecay}\n\n→ Next: ${row.transitionToNext}`;
          return {
            ...fb,
            microTimingOff: row.microTimingOff,
            attackDecay: row.attackDecay,
            transitionToNext: row.transitionToNext,
            message,
          };
        });
      };

      try {
        const res = await fetch("/api/ebs-pose-feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ perFramePayload }),
        });
        const data = (await res.json()) as {
          frames?: Array<{
            frameIndex: number;
            microTimingOff: boolean;
            attackDecay: string;
            transitionToNext: string;
          }>;
          source?: string;
        };

        if (res.ok && Array.isArray(data.frames) && data.frames.length > 0) {
          const merged = applyRows(data.frames);
          setFeedback(merged);
          onFeedbackReady?.(merged);
          setLlmSource(data.source ?? "groq");
        } else {
          const merged = applyRows(buildFallbackPerFrameOutputs(perFramePayload));
          setFeedback(merged);
          onFeedbackReady?.(merged);
          setLlmSource("local-fallback");
        }
      } catch {
        const merged = applyRows(buildFallbackPerFrameOutputs(perFramePayload));
        setFeedback(merged);
        onFeedbackReady?.(merged);
        setLlmSource("local-fallback");
      } finally {
        setLlmLoading(false);
        setProgress({ currentFrame: total, totalFrames: total, phase: "done" });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Comparison failed.");
    } finally {
      setRunning(false);
    }
  }, [referenceVideoUrl, running, segments, userVideoUrl, onFeedbackReady]);

  const filtered = useMemo(() => {
    return feedback.filter((fb) => {
      if (timingIssuesOnly && !fb.microTimingOff) return false;
      if (filterSeverity !== "all" && fb.severity !== filterSeverity) return false;
      return true;
    });
  }, [feedback, filterSeverity, timingIssuesOnly]);

  const timingOffCount = useMemo(
    () => feedback.filter((f) => f.microTimingOff).length,
    [feedback],
  );

  useEffect(() => {
    const container = feedbackListRef.current;
    if (!container || feedback.length === 0 || userHovering.current) return;

    const closest = filtered.reduce<DanceFeedback | null>((best, fb) => {
      if (!best) return fb;
      return Math.abs(fb.timestamp - sharedTime) < Math.abs(best.timestamp - sharedTime) ? fb : best;
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
      container.scrollTo({
        top: elTop - cH / 2 + elH / 2,
        behavior: "smooth",
      });
    }
  }, [sharedTime, feedback, filtered]);

  const progressPercent = progress
    ? Math.round((progress.currentFrame / Math.max(1, progress.totalFrames)) * 100)
    : 0;

  return (
    <div className="rounded-[24px] border border-sky-100 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-sky-50 bg-gradient-to-r from-sky-50 to-white">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Pose Comparison Feedback</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              6&nbsp;FPS poses per beat; four feature families vs reference (micro-timing, upper/lower body, attack &amp; transition). Items are ranked by importance (largest deviation first).
            </p>
          </div>
          <button
            onClick={runComparison}
            disabled={running || segments.length === 0}
            className="rounded-full bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running ? "Analyzing..." : hasRun.current ? "Re-analyze" : "Run Comparison"}
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {running && progress && (
        <div className="px-5 py-3 bg-sky-50 border-b border-sky-100">
          <div className="flex items-center justify-between text-xs text-slate-600 mb-1.5">
            <span className="capitalize">{progress.phase}...</span>
            <span>{progressPercent}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-sky-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-500 transition-all duration-300"
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
      {feedback.length > 0 && (
        <>
          {llmLoading && (
            <div className="px-5 py-2 border-b border-indigo-100 bg-indigo-50/60 text-xs text-indigo-900">
              Generating per-frame coaching (attack/decay &amp; transitions)…
            </div>
          )}

          {/* Body diagram + summary */}
          <div className="px-5 py-4 border-b border-sky-50">
            <div className="flex items-start gap-6">
              <BodyDiagram feedback={feedback} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-800">
                  {feedback.length} finding{feedback.length === 1 ? "" : "s"} (ranked)
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {timingOffCount} timestamp{timingOffCount === 1 ? "" : "s"} flagged for micro-timing vs reference motion
                </p>
                {llmSource && (
                  <p className="text-[10px] text-slate-400 mt-2">
                    Coach:{" "}
                    {llmSource === "groq"
                      ? "Groq"
                      : llmSource === "openai"
                        ? "OpenAI"
                        : "offline"}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Filters */}
          <div className="px-5 py-2.5 border-b border-sky-50 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-slate-500">Filter:</span>
            {(["all", "minor", "moderate", "major"] as const).map((sev) => (
              <button
                key={sev}
                onClick={() => setFilterSeverity(filterSeverity === sev ? "all" : sev)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium border transition-all ${
                  filterSeverity === sev
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                }`}
              >
                {sev === "all" ? "All" : SEVERITY_CONFIG[sev].label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setTimingIssuesOnly(!timingIssuesOnly)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium border transition-all ${
                timingIssuesOnly
                  ? "bg-amber-100 text-amber-900 border-amber-300"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
            >
              Timing flags only
            </button>
            <span className="text-[11px] text-slate-400 ml-auto">
              {filtered.length} of {feedback.length} items
            </span>
          </div>

          {/* Feedback list */}
          <div
            ref={feedbackListRef}
            onMouseEnter={() => { userHovering.current = true; }}
            onMouseLeave={() => { userHovering.current = false; }}
            className="max-h-[360px] overflow-y-auto divide-y divide-sky-50"
          >
            {filtered.map((fb, i) => {
              const cfg = SEVERITY_CONFIG[fb.severity];
              const isNearCurrent = Math.abs(fb.timestamp - sharedTime) < 0.8;
              const fam = fb.featureFamily ? FEEDBACK_FEATURE_LABELS[fb.featureFamily] : null;
              return (
                <button
                  key={`${fb.importanceRank ?? i}-${fb.segmentIndex}-${fb.featureFamily ?? "legacy"}-${fb.timestamp}`}
                  onClick={() => onSeek(fb.timestamp)}
                  className={`w-full text-left px-5 py-3 transition-all hover:bg-sky-50 ${
                    isNearCurrent ? "bg-sky-50/80 ring-inset ring-1 ring-sky-200" : ""
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0">
                      <div className={`w-2.5 h-2.5 rounded-full ${cfg.dot}`} />
                      <span className="text-[10px] text-slate-400 font-mono">
                        {fmtTime(fb.timestamp)}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {fb.importanceRank != null && (
                          <span className="text-[10px] font-mono text-slate-500 tabular-nums">
                            #{fb.importanceRank}
                          </span>
                        )}
                        <span className={`text-[11px] font-semibold uppercase tracking-wide ${cfg.color}`}>
                          {fam ?? "Beat"}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${cfg.bg} ${cfg.color} font-medium`}>
                          {cfg.label}
                        </span>
                        {fb.microTimingOff && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-800 font-medium">
                            Micro-timing
                          </span>
                        )}
                        <span className="text-[10px] text-slate-400 ml-auto">
                          Seg {fb.segmentIndex}
                        </span>
                      </div>
                      {fb.message && (
                        <p className="text-[11px] text-slate-600 mt-1.5 leading-snug">{fb.message}</p>
                      )}
                      {fb.attackDecay ? (
                        <>
                          <p className="text-[11px] font-semibold text-slate-700 mt-2">Attack &amp; decay</p>
                          <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">{fb.attackDecay}</p>
                          {fb.transitionToNext && (
                            <>
                              <p className="text-[11px] font-semibold text-slate-700 mt-2">Toward next pose</p>
                              <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">{fb.transitionToNext}</p>
                            </>
                          )}
                        </>
                      ) : (
                        !fb.message && (
                          <p className="text-xs text-slate-500 mt-1 italic">Coaching text loading or unavailable.</p>
                        )
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {filtered.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-slate-500">
              No items match the current filters.
            </div>
          )}
        </>
      )}

      {/* Empty state */}
      {!running && feedback.length === 0 && !error && (
        <div className="px-5 py-8 text-center">
          <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-sky-50 flex items-center justify-center">
            <svg className="w-7 h-7 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </div>
          <p className="text-sm font-medium text-slate-700">Ready to compare</p>
          <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
            Click &ldquo;Run Comparison&rdquo; to analyze your practice against the reference using BodyPix pose and part segmentation.
          </p>
        </div>
      )}
    </div>
  );
}
