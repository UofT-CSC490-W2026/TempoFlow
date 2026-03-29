"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GeminiLiveSession,
  type LiveCoachStatus,
} from "../../lib/liveCoachSession";
import { PoseExtractor } from "../../lib/poseExtractor";
import type { EbsData } from "./types";

// ── Props ──────────────────────────────────────────────────────────────

interface LiveCoachPanelProps {
  sessionId: string;
  ebsData: EbsData;
  referenceName?: string;
}

// ── System Prompt ──────────────────────────────────────────────────────

const COACH_PERSONA = `Persona: You are a professional Dance Mentor. Your tone is energetic, encouraging, and casual, but you maintain a clear, instructional authority. You are an expert at taking complex data (skeletal coordinates and timing) and translating it into simple, physical cues that a beginner can follow instantly.

The Goal: Provide real-time verbal coaching that helps the user stay on the beat and improve their form through actionable "visual cues."

Instructional Standards:

Visual Cues: Instead of technical degrees or coordinates, use directions and common objects. (e.g., "Reach toward the ceiling" instead of "Extend your arm 180 degrees").

Rhythmic Timing: Use the live audio to anchor your feedback. If the user is off-beat, use words like "Early," "Late," or "Right there!" to help them find the pocket.

The "Lock": Beginners often lack sharp finishes. Focus on the "Stop." Use words like "Freeze," "Hold," or "Land it" to encourage precision.

Feedback Guidelines:

Keep it Brief: While they are dancing, limit feedback to 3–5 words. "Stronger arms," "Great timing," or "Reach higher."

Positive Reinforcement: When the YOLO data shows a high-velocity "stop" that matches an audio transient, give immediate verbal validation: "Yes, exactly like that."

Simplify the Struggle: If the user misses a complex sequence, give one simple tip: "Focus on your feet for this part; let the arms follow naturally."

Prohibited: Do not use heavy slang, technical jargon (e.g., "axis," "coordinates," "velocity"), or overly formal academic language.`;

function buildSystemPrompt(
  ebsData: EbsData,
  referenceName?: string,
): string {
  const bpm = ebsData.beat_tracking?.estimated_bpm;
  const beats = ebsData.beats_shared_sec?.slice(0, 32);
  const segments = ebsData.segments.map(
    (s, i) =>
      `Segment ${i + 1}: ${s.shared_start_sec.toFixed(2)}s – ${s.shared_end_sec.toFixed(2)}s`,
  );

  return `${COACH_PERSONA}

---

DATA FORMAT CONTEXT:

You receive three real-time data streams while the user dances:

1. AUDIO (continuous): Live microphone capturing room audio including music. Use beat detection from what you hear to assess timing.
2. VIDEO (1 frame/sec): Webcam JPEG showing the dancer. Use for visual form assessment.
3. POSE (5 updates/sec): Skeletal JSON prefixed with "POSE:". Format:
   {"t":<seconds>,"joints":{"nose":{"x":0.5,"y":0.3,"c":0.95},...},"velocity":{"left_wrist":{"vx":0.12,"vy":-0.05},...}}

   x,y are normalized [0,1] (0,0 = top-left of frame). c = confidence (0–1).
   vx,vy are velocity in normalized units/second. High magnitude = fast movement. Near-zero after high = sharp stop ("lock").

   Joint names: nose, left_shoulder, right_shoulder, left_elbow, right_elbow, left_wrist, right_wrist, left_hip, right_hip, left_knee, right_knee, left_ankle, right_ankle.

REFERENCE CHOREOGRAPHY${referenceName ? ` (${referenceName})` : ""}:
${bpm ? `BPM: ~${Math.round(bpm)}` : "BPM: unknown"}
${beats?.length ? `First ${beats.length} beat times (sec): [${beats.map((b) => b.toFixed(2)).join(", ")}]` : ""}
${segments.length ? `Segments:\n${segments.join("\n")}` : ""}

A high-velocity stop near a beat time indicates good timing.
Consistent lag behind beats = "Late". Anticipating beats = "Early".

IMPORTANT: Respond ONLY with brief spoken coaching. During active dancing, keep to 3–5 words.`;
}

// ── Status labels ──────────────────────────────────────────────────────

const STATUS_LABEL: Record<LiveCoachStatus, string> = {
  idle: "Ready",
  connecting: "Connecting…",
  setup: "Setting up…",
  active: "Coaching",
  error: "Error",
  closed: "Session ended",
};

const STATUS_DOT: Record<LiveCoachStatus, string> = {
  idle: "bg-slate-400",
  connecting: "bg-amber-400 animate-pulse",
  setup: "bg-amber-400 animate-pulse",
  active: "bg-emerald-500 animate-pulse",
  error: "bg-red-500",
  closed: "bg-slate-400",
};

// ── Component ──────────────────────────────────────────────────────────

export function LiveCoachPanel({
  ebsData,
  referenceName,
}: LiveCoachPanelProps) {
  const [status, setStatus] = useState<LiveCoachStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<string[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);
  const [streamingText, setStreamingText] = useState("");

  const sessionRef = useRef<GeminiLiveSession | null>(null);
  const poseRef = useRef<PoseExtractor | null>(null);
  const videoBoxRef = useRef<HTMLDivElement>(null);
  const poseRafRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamBufRef = useRef("");

  // Auto-scroll transcript
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcripts, streamingText]);

  // ── Start ──────────────────────────────────────────────────────────

  const startCoach = useCallback(async () => {
    setError(null);
    setTranscripts([]);
    setStreamingText("");
    streamBufRef.current = "";

    try {
      const res = await fetch("/api/live-coach/session", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          body.error ?? "Failed to initialise live coach session.",
        );
      }
      const body = (await res.json()) as {
        wsUrl?: string;
        wsPath?: string;
        model: string;
      };

      let wsUrl = body.wsUrl;
      if (!wsUrl && body.wsPath) {
        const u = new URL(body.wsPath, window.location.origin);
        u.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        wsUrl = u.toString();
      }
      if (!wsUrl) {
        throw new Error(
          "Live coach WebSocket URL missing. Set NEXT_PUBLIC_LIVE_COACH_WS_URL or a valid NEXT_PUBLIC_EBS_PROCESSOR_URL.",
        );
      }

      const systemInstruction = buildSystemPrompt(ebsData, referenceName);

      const session = new GeminiLiveSession({
        wsUrl,
        model: body.model,
        systemInstruction,
        events: {
          onStatus: setStatus,
          onTranscript: (text, isFinal) => {
            if (isFinal) {
              const full = streamBufRef.current.trim();
              if (full) {
                setTranscripts((prev) => [...prev.slice(-29), full]);
              }
              streamBufRef.current = "";
              setStreamingText("");
            } else {
              streamBufRef.current += text;
              setStreamingText(streamBufRef.current);
            }
          },
          onError: (msg) => setError(msg),
          onAudioLevel: setAudioLevel,
        },
      });

      sessionRef.current = session;
      const videoEl = await session.start();

      if (videoBoxRef.current) {
        videoEl.style.cssText =
          "width:100%;height:100%;object-fit:cover;border-radius:16px;transform:scaleX(-1);";
        videoBoxRef.current.replaceChildren(videoEl);
      }

      // Pose extraction loop (~30 FPS, self-throttled by inference time)
      const extractor = new PoseExtractor();
      poseRef.current = extractor;
      await extractor.init();

      const t0 = performance.now() / 1000;
      const loop = async () => {
        if (session.getStatus() !== "active") return;
        const t = performance.now() / 1000 - t0;
        const pose = await extractor.extract(videoEl, t);
        if (pose) session.setPoseData(JSON.stringify(pose));
        poseRafRef.current = requestAnimationFrame(loop);
      };
      poseRafRef.current = requestAnimationFrame(loop);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to start live coach.",
      );
      setStatus("error");
    }
  }, [ebsData, referenceName]);

  // ── Stop ───────────────────────────────────────────────────────────

  const stopCoach = useCallback(() => {
    if (poseRafRef.current != null) cancelAnimationFrame(poseRafRef.current);
    poseRef.current?.dispose();
    poseRef.current = null;
    sessionRef.current?.stop();
    sessionRef.current = null;
    if (videoBoxRef.current) videoBoxRef.current.replaceChildren();
  }, []);

  // Cleanup on unmount
  useEffect(() => () => stopCoach(), [stopCoach]);

  const isActive = status === "active";
  const isBusy = status === "connecting" || status === "setup";

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="max-w-4xl mx-auto">
      <div className="rounded-[32px] border border-sky-100 bg-white shadow-sm overflow-hidden">
        {/* Header */}
        <div className="px-8 pt-6 pb-4 flex items-center justify-between border-b border-sky-50">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-sky-600">
              Live Coach
            </p>
            <p className="text-sm text-slate-500 mt-0.5">
              Real-time AI dance coaching powered by Gemini
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2.5 h-2.5 rounded-full ${STATUS_DOT[status]}`} />
            <span className="text-sm font-medium text-slate-600">
              {STATUS_LABEL[status]}
            </span>
          </div>
        </div>

        {/* Webcam */}
        <div className="px-8 pt-6">
          <div className="relative w-full aspect-video bg-slate-900 rounded-2xl overflow-hidden flex items-center justify-center">
            {/* Imperative-only container: React never renders children here */}
            <div ref={videoBoxRef} className="absolute inset-0 z-0" />

            {/* React-managed overlays sit above */}
            {!isActive && !isBusy && (
              <div className="relative z-10 text-center px-6">
                <div className="w-16 h-16 mx-auto rounded-full bg-slate-800 flex items-center justify-center mb-3">
                  <svg
                    className="w-8 h-8 text-slate-500"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                    />
                  </svg>
                </div>
                <p className="text-slate-400 text-sm">
                  Camera and microphone activate when you start coaching
                </p>
              </div>
            )}
            {isBusy && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80 z-10">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-sky-300 border-t-sky-500" />
              </div>
            )}
          </div>
        </div>

        {/* Audio level meter */}
        {isActive && (
          <div className="px-8 pt-4">
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-slate-500 w-8 shrink-0">
                MIC
              </span>
              <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-500 transition-all duration-75"
                  style={{ width: `${Math.round(audioLevel * 100)}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Transcript */}
        <div className="px-8 pt-4 pb-2">
          <div className="rounded-2xl border border-sky-50 bg-sky-50/50 p-4 min-h-[100px] max-h-[200px] overflow-y-auto">
            {transcripts.length === 0 && !streamingText && (
              <p className="text-sm text-slate-400 italic">
                {isActive
                  ? "Listening… start dancing!"
                  : "Coach feedback will appear here"}
              </p>
            )}
            {transcripts.map((t, i) => (
              <p key={i} className="text-sm text-slate-700 mb-1">
                {t}
              </p>
            ))}
            {streamingText && (
              <p className="text-sm text-sky-600 animate-pulse">
                {streamingText}
              </p>
            )}
            <div ref={scrollRef} />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="px-8 pt-2">
            <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="px-8 py-6 flex items-center justify-center gap-4">
          {!isActive && !isBusy ? (
            <button
              onClick={startCoach}
              className="px-8 py-3 bg-gradient-to-r from-sky-500 to-blue-600 text-white rounded-full text-sm font-semibold shadow-lg shadow-sky-200 hover:shadow-xl hover:shadow-sky-300 transition-all active:scale-95"
            >
              Start Live Coach
            </button>
          ) : (
            <button
              onClick={stopCoach}
              disabled={isBusy}
              className="px-8 py-3 bg-slate-900 text-white rounded-full text-sm font-semibold shadow-lg hover:bg-slate-800 transition-all active:scale-95 disabled:opacity-50"
            >
              {isBusy ? "Connecting…" : "Stop Coach"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
