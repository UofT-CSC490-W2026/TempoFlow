"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EbsSegment } from "./types";
import {
  compareWithBodyPix,
  generateSampleTimestamps,
  type BodyRegion,
  type ComparisonProgress,
  type DanceFeedback,
  type FeedbackSeverity,
} from "../../lib/bodyPixComparison";

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

const REGION_ICON: Record<BodyRegion, string> = {
  head: "Head",
  arms: "Arms",
  torso: "Torso",
  legs: "Legs",
  full_body: "Full Body",
};

function fmtTime(sec: number) {
  const safe = Math.max(0, sec);
  const m = Math.floor(safe / 60);
  return `${m}:${(safe % 60).toFixed(1).padStart(4, "0")}`;
}

function BodyDiagram({ feedback }: { feedback: DanceFeedback[] }) {
  const regionSeverity = useMemo(() => {
    const severity: Record<BodyRegion, FeedbackSeverity> = {
      head: "good", arms: "good", torso: "good", legs: "good", full_body: "good",
    };
    const order: FeedbackSeverity[] = ["good", "minor", "moderate", "major"];
    for (const fb of feedback) {
      if (order.indexOf(fb.severity) > order.indexOf(severity[fb.bodyRegion])) {
        severity[fb.bodyRegion] = fb.severity;
      }
    }
    return severity;
  }, [feedback]);

  const colorFor = (region: BodyRegion) => {
    const s = regionSeverity[region];
    if (s === "good") return "#34d399";
    if (s === "minor") return "#fbbf24";
    if (s === "moderate") return "#fb923c";
    return "#f87171";
  };

  return (
    <svg viewBox="0 0 100 200" className="w-20 h-40 mx-auto" aria-label="Body diagram">
      {/* Head */}
      <circle cx="50" cy="22" r="14" fill={colorFor("head")} opacity="0.7" />
      {/* Torso */}
      <rect x="32" y="40" width="36" height="50" rx="6" fill={colorFor("torso")} opacity="0.7" />
      {/* Left arm */}
      <rect x="10" y="42" width="18" height="44" rx="6" fill={colorFor("arms")} opacity="0.7" />
      {/* Right arm */}
      <rect x="72" y="42" width="18" height="44" rx="6" fill={colorFor("arms")} opacity="0.7" />
      {/* Left leg */}
      <rect x="32" y="94" width="16" height="56" rx="6" fill={colorFor("legs")} opacity="0.7" />
      {/* Right leg */}
      <rect x="52" y="94" width="16" height="56" rx="6" fill={colorFor("legs")} opacity="0.7" />
      {/* Left foot */}
      <ellipse cx="40" cy="155" rx="10" ry="5" fill={colorFor("legs")} opacity="0.7" />
      {/* Right foot */}
      <ellipse cx="60" cy="155" rx="10" ry="5" fill={colorFor("legs")} opacity="0.7" />
    </svg>
  );
}

export function FeedbackPanel(props: FeedbackPanelProps) {
  const { referenceVideoUrl, userVideoUrl, segments, sharedTime, onSeek, onFeedbackReady } = props;
  const [feedback, setFeedback] = useState<DanceFeedback[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ComparisonProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterRegion, setFilterRegion] = useState<BodyRegion | "all">("all");
  const [filterSeverity, setFilterSeverity] = useState<FeedbackSeverity | "all">("all");
  const feedbackListRef = useRef<HTMLDivElement>(null);
  const userHovering = useRef(false);
  const hasRun = useRef(false);

  const runComparison = useCallback(async () => {
    if (running || segments.length === 0) return;
    setRunning(true);
    setError(null);
    setFeedback([]);
    hasRun.current = true;

    try {
      const timestamps = generateSampleTimestamps(segments, 1.5);
      const result = await compareWithBodyPix({
        referenceVideoUrl,
        userVideoUrl,
        timestamps,
        onProgress: setProgress,
      });
      setFeedback(result);
      onFeedbackReady?.(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Comparison failed.");
    } finally {
      setRunning(false);
    }
  }, [referenceVideoUrl, running, segments, userVideoUrl, onFeedbackReady]);

  const filtered = useMemo(() => {
    return feedback.filter((fb) => {
      if (filterRegion !== "all" && fb.bodyRegion !== filterRegion) return false;
      if (filterSeverity !== "all" && fb.severity !== filterSeverity) return false;
      return true;
    });
  }, [feedback, filterRegion, filterSeverity]);

  const summaryByRegion = useMemo(() => {
    const regions: BodyRegion[] = ["head", "arms", "torso", "legs"];
    return regions.map((region) => {
      const items = feedback.filter((fb) => fb.bodyRegion === region);
      const avgDev = items.length
        ? items.reduce((s, fb) => s + fb.deviation, 0) / items.length
        : 0;
      const worstSeverity = items.reduce<FeedbackSeverity>(
        (worst, fb) => {
          const order: FeedbackSeverity[] = ["good", "minor", "moderate", "major"];
          return order.indexOf(fb.severity) > order.indexOf(worst) ? fb.severity : worst;
        },
        "good",
      );
      return { region, count: items.length, avgDeviation: avgDev, worstSeverity };
    });
  }, [feedback]);

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
              BodyPix part segmentation + keypoint analysis
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
          {/* Body diagram + summary */}
          <div className="px-5 py-4 border-b border-sky-50">
            <div className="flex items-start gap-6">
              <BodyDiagram feedback={feedback} />
              <div className="flex-1 grid grid-cols-2 gap-2">
                {summaryByRegion.map(({ region, count, worstSeverity }) => {
                  const cfg = SEVERITY_CONFIG[worstSeverity];
                  return (
                    <button
                      key={region}
                      onClick={() => setFilterRegion(filterRegion === region ? "all" : region)}
                      className={`rounded-xl px-3 py-2 text-left transition-all border ${
                        filterRegion === region
                          ? `${cfg.bg} ${cfg.border} ring-1 ring-offset-1 ring-sky-300`
                          : `bg-slate-50 border-slate-100 hover:bg-slate-100`
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-full ${cfg.dot}`} />
                        <span className="text-xs font-semibold text-slate-700 capitalize">
                          {REGION_ICON[region]}
                        </span>
                      </div>
                      <div className={`text-xs mt-0.5 ${cfg.color}`}>
                        {count === 0 ? "Looking good" : `${count} note${count > 1 ? "s" : ""}`}
                      </div>
                    </button>
                  );
                })}
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
              return (
                <button
                  key={`${fb.timestamp}-${fb.bodyRegion}-${i}`}
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
                      <div className="flex items-center gap-2">
                        <span className={`text-[11px] font-semibold uppercase tracking-wide ${cfg.color}`}>
                          {REGION_ICON[fb.bodyRegion]}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${cfg.bg} ${cfg.color} font-medium`}>
                          {cfg.label}
                        </span>
                        <span className="text-[10px] text-slate-400 ml-auto">
                          Seg {fb.segmentIndex}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                        {fb.message}
                      </p>
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
