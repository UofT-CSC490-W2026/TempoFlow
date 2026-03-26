"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useEbsViewer } from "./useEbsViewer";
import type { EbsData } from "./types";
import { BodyPixOverlay } from "../BodyPixOverlay";
import { ProgressiveOverlay } from "../ProgressiveOverlay";
import { generateMoveNetOverlayFrames } from "../../lib/movenetOverlayGenerator";
import { generateYoloOverlayFrames, type YoloExecutionProvider } from "../../lib/yoloOverlayGenerator";
import { generateFastSamOverlayFrames } from "../../lib/fastSamOverlayGenerator";
import { generateBodyPixOverlayFrames } from "../../lib/bodyPixOverlayGenerator";
import { buildOverlayKey, getSessionOverlay, storeSessionOverlay, type OverlayArtifact } from "../../lib/overlayStorage";
import { getSessionVideo } from "../../lib/videoStorage";
import { FeedbackPanel } from "./FeedbackPanel";
import { FeedbackOverlay } from "./FeedbackOverlay";
import type { DanceFeedback } from "../../lib/bodyPixComparison";

type ManualViewerProps = {
  mode?: "manual";
  title?: string;
};

type SessionViewerProps = {
  mode: "session";
  sessionId?: string;
  referenceVideoUrl: string;
  userVideoUrl: string;
  ebsData: EbsData;
  referenceName?: string;
  practiceName?: string;
  title?: string;
  footerSlot?: ReactNode;
};

type EbsViewerProps = ManualViewerProps | SessionViewerProps;

export function FeedbackViewer(props: EbsViewerProps) {
  const sessionMode = props.mode === "session";
  const sessionProps = sessionMode ? props : null;
  const refVideo = useRef<HTMLVideoElement | null>(null);
  const userVideo = useRef<HTMLVideoElement | null>(null);
  const timelineTrackRef = useRef<HTMLDivElement | null>(null);
  const moveTimelineTrackRef = useRef<HTMLDivElement | null>(null);

  const [refLoaded, setRefLoaded] = useState(false);
  const [userLoaded, setUserLoaded] = useState(false);
  const [jsonLoaded, setJsonLoaded] = useState(false);
  const [showViewer, setShowViewer] = useState(false);
  const [refVideoUrl, setRefVideoUrl] = useState<string | null>(null);
  const [userVideoUrl, setUserVideoUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<{ message: string; type?: "error" | "success" } | null>(null);
  
  const {
    state,
    loadFromJson,
    resetViewer,
    hidePauseOverlay,
    seekToShared,
    seekToSegment,
    seekToPrevSegment,
    seekToNextSegment,
    togglePlay,
    pausePlayback,
    playSegment,
    setPauseAtSegmentEnd,
    toggleMainSpeed,
    openPracticeMode,
    closePracticeMode,
    seekToMove,
    seekToPrevMove,
    seekToNextMove,
    setPracticeLoop,
    setPauseAtMoveEnd,
    togglePracticeSpeed,
  } = useEbsViewer({ refVideo, userVideo });

  const viewerVisible = sessionMode || showViewer;
  const canLaunch = (sessionMode || refLoaded) && (sessionMode || userLoaded) && (sessionMode || jsonLoaded);
  const activeReferenceVideoUrl = sessionProps?.referenceVideoUrl ?? refVideoUrl;
  const activeUserVideoUrl = sessionProps?.userVideoUrl ?? userVideoUrl;
  const sessionEbsData = sessionProps?.ebsData ?? null;
  const sessionReferenceName = sessionProps?.referenceName ?? null;
  const sessionPracticeName = sessionProps?.practiceName ?? null;
  const sessionFooterSlot = sessionProps?.footerSlot ?? null;
  const sessionId = sessionProps?.sessionId ?? null;
  const [overlayMode, setOverlayMode] = useState<"precomputed" | "live">("precomputed");
  const [showMoveNet, setShowMoveNet] = useState(false);
  const [showYolo, setShowYolo] = useState(false);
  const [showYoloPose, setShowYoloPose] = useState(false);
  const [showBodyPix, setShowBodyPix] = useState(false);
  const [showFastSam, setShowFastSam] = useState(false);
  const [showFeedback, setShowFeedback] = useState(true);
  const [danceFeedback, setDanceFeedback] = useState<DanceFeedback[]>([]);
  const [overlayMethod, setOverlayMethod] = useState<"pose-fill" | "sam3-experimental" | "sam3-roboflow">("pose-fill");
  const [overlayBusy, setOverlayBusy] = useState(false);
  const [overlayStatus, setOverlayStatus] = useState<string | null>(null);
  const [segProvider, setSegProvider] = useState<YoloExecutionProvider>("wasm");
  const [segGenerator, setSegGenerator] = useState<"python" | "browser">("python");
  const [refPoseArtifact, setRefPoseArtifact] = useState<OverlayArtifact | null>(null);
  const [refYoloArtifact, setRefYoloArtifact] = useState<OverlayArtifact | null>(null);
  const [userPoseArtifact, setUserPoseArtifact] = useState<OverlayArtifact | null>(null);
  const [userYoloArtifact, setUserYoloArtifact] = useState<OverlayArtifact | null>(null);
  const [refYoloPoseArmsArtifact, setRefYoloPoseArmsArtifact] = useState<OverlayArtifact | null>(null);
  const [refYoloPoseLegsArtifact, setRefYoloPoseLegsArtifact] = useState<OverlayArtifact | null>(null);
  const [userYoloPoseArmsArtifact, setUserYoloPoseArmsArtifact] = useState<OverlayArtifact | null>(null);
  const [userYoloPoseLegsArtifact, setUserYoloPoseLegsArtifact] = useState<OverlayArtifact | null>(null);
  const [refFastSamArtifact, setRefFastSamArtifact] = useState<OverlayArtifact | null>(null);
  const [userFastSamArtifact, setUserFastSamArtifact] = useState<OverlayArtifact | null>(null);
  const [refBodyPixArtifact, setRefBodyPixArtifact] = useState<OverlayArtifact | null>(null);
  const [userBodyPixArtifact, setUserBodyPixArtifact] = useState<OverlayArtifact | null>(null);
  // Lower FPS dramatically reduces precompute time (model + WebP encode).
  const OVERLAY_FPS = 12;
  const yoloVariant = `${segGenerator}-${segProvider}`;
  const bodyPixVariant = "bodypix24-browser";
  const loadCachedOverlays = useCallback(async () => {
    if (!sessionId) return;
    const variant = overlayMethod;
    const [rp, ry, rpa, rpl, rbp, up, uy, upa, upl, ubp, rf, uf] = await Promise.all([
      getSessionOverlay(buildOverlayKey({ sessionId, type: "movenet", side: "reference", fps: OVERLAY_FPS, variant })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo", side: "reference", fps: OVERLAY_FPS, variant: yoloVariant })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo-pose-arms", side: "reference", fps: OVERLAY_FPS, variant: "python" })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo-pose-legs", side: "reference", fps: OVERLAY_FPS, variant: "python" })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "bodypix", side: "reference", fps: OVERLAY_FPS, variant: bodyPixVariant })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "movenet", side: "practice", fps: OVERLAY_FPS, variant })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo", side: "practice", fps: OVERLAY_FPS, variant: yoloVariant })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo-pose-arms", side: "practice", fps: OVERLAY_FPS, variant: "python" })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "yolo-pose-legs", side: "practice", fps: OVERLAY_FPS, variant: "python" })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "bodypix", side: "practice", fps: OVERLAY_FPS, variant: bodyPixVariant })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "fastsam", side: "reference", fps: OVERLAY_FPS, variant: "wasm" })),
      getSessionOverlay(buildOverlayKey({ sessionId, type: "fastsam", side: "practice", fps: OVERLAY_FPS, variant: "wasm" })),
    ]);
    setRefPoseArtifact(rp);
    setRefYoloArtifact(ry);
    setRefYoloPoseArmsArtifact(rpa);
    setRefYoloPoseLegsArtifact(rpl);
    setRefBodyPixArtifact(rbp);
    setUserPoseArtifact(up);
    setUserYoloArtifact(uy);
    setUserYoloPoseArmsArtifact(upa);
    setUserYoloPoseLegsArtifact(upl);
    setUserBodyPixArtifact(ubp);
    setRefFastSamArtifact(rf);
    setUserFastSamArtifact(uf);
  }, [bodyPixVariant, overlayMethod, sessionId, yoloVariant]);
  
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCachedOverlays();
  }, [loadCachedOverlays]);

  useEffect(() => {
    if (sessionMode) return;
    return () => {
      if (refVideoUrl) URL.revokeObjectURL(refVideoUrl);
      if (userVideoUrl) URL.revokeObjectURL(userVideoUrl);
    };
  }, [refVideoUrl, sessionMode, userVideoUrl]);

  useEffect(() => {
    if (!sessionEbsData) return;
    loadFromJson(sessionEbsData);
  }, [loadFromJson, sessionEbsData]);

  useEffect(() => {
    if (!viewerVisible) return;
    if (userVideo.current) {
      userVideo.current.muted = true;
    }
    if (refVideo.current) {
      refVideo.current.playbackRate = state.mainPlaybackRate;
    }
    if (userVideo.current) {
      userVideo.current.playbackRate = state.mainPlaybackRate;
    }
    const id = window.requestAnimationFrame(() => {
      if (state.segments.length) {
        seekToSegment(0);
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [seekToSegment, state.mainPlaybackRate, state.segments.length, viewerVisible]);

  useEffect(() => {
    if (!viewerVisible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT") return;

      if (event.code === "Space") {
        event.preventDefault();
        togglePlay();
        return;
      }

      if (event.code === "Escape" && state.practice.enabled) {
        event.preventDefault();
        closePracticeMode();
        return;
      }

      if (state.practice.enabled) {
        if (event.code === "ArrowLeft") {
          event.preventDefault();
          seekToPrevMove();
        }
        if (event.code === "ArrowRight") {
          event.preventDefault();
          seekToNextMove();
        }
      } else {
        if (event.code === "ArrowLeft") {
          event.preventDefault();
          seekToPrevSegment();
        }
        if (event.code === "ArrowRight") {
          event.preventDefault();
          seekToNextSegment();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    closePracticeMode,
    seekToNextMove,
    seekToNextSegment,
    seekToPrevMove,
    seekToPrevSegment,
    state.practice.enabled,
    togglePlay,
    viewerVisible,
  ]);

  const fmtTime = (sec: number) => {
    const safe = Math.max(0, sec);
    const min = Math.floor(safe / 60);
    return `${min}:${(safe % 60).toFixed(1).padStart(4, "0")}`;
  };

  const fmtTimeFull = (sec: number) => {
    const safe = Math.max(0, sec);
    const min = Math.floor(safe / 60);
    return `${min}:${(safe % 60).toFixed(3).padStart(6, "0")}`;
  };

  const setVideoObjectUrl = (
    file: File,
    currentUrl: string | null,
    setter: (value: string) => void,
  ) => {
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    setter(URL.createObjectURL(file));
  };

  const handleLoadJsonFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as EbsData;
        loadFromJson(parsed);
        setJsonLoaded(true);
        setStatus({
          message: `Loaded ${file.name} with ${parsed.segments.length} segments.`,
          type: "success",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown JSON error";
        setStatus({ message: `Invalid JSON: ${message}`, type: "error" });
      }
    };
    reader.readAsText(file);
  };

  const handleLaunch = () => {
    if (!canLaunch) return;
    setShowViewer(true);
    setStatus(null);
  };

  const bpm = state.ebs?.beat_tracking?.estimated_bpm ?? "?";
  const nb = state.ebs?.beat_tracking?.num_beats ?? state.beats.length;
  const mode = state.ebs?.segmentation_mode ?? "?";
  const sharedLen = state.sharedLen;
  const currentSegment = state.currentSegmentIndex >= 0 ? state.segments[state.currentSegmentIndex] : null;
  const currentPracticeSegment =
    state.practice.segmentIndex >= 0 ? state.segments[state.practice.segmentIndex] : null;
  const practiceSpeedText = `${state.practice.playbackRate.toFixed(2).replace(/\.00$/, "")}x`;
  const segmentDoneSet = new Set(state.doneSegmentIndexes);
  const moveDoneSet = new Set(state.practice.doneMoveIndexes);
  const hasSegments = state.segments.length > 0;

  const handleTimelineClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineTrackRef.current || sharedLen <= 0) return;
    const rect = timelineTrackRef.current.getBoundingClientRect();
    const pct = (event.clientX - rect.left) / rect.width;
    seekToShared(pct * sharedLen);
  };

  const handleMoveTimelineClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!moveTimelineTrackRef.current || !currentPracticeSegment) return;
    const rect = moveTimelineTrackRef.current.getBoundingClientRect();
    const segmentDuration = currentPracticeSegment.shared_end_sec - currentPracticeSegment.shared_start_sec;
    if (segmentDuration <= 0) return;
    const pct = (event.clientX - rect.left) / rect.width;
    seekToShared(currentPracticeSegment.shared_start_sec + pct * segmentDuration);
  };

  const downloadJson = () => {
    if (!state.ebs) return;
    const blob = new Blob([JSON.stringify(state.ebs, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "ebs_segments.json";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const bpmInfo = state.ebs?.alignment
    ? `${bpm} BPM · 8 beats/seg · offset ${state.ebs.alignment.clip_2_start_sec.toFixed(3)}s · shared ${sharedLen.toFixed(3)}s`
    : "";

  const practiceInfo =
    currentPracticeSegment && state.practice.moves.length
      ? `${state.practice.moves.length} moves · ${(currentPracticeSegment.shared_end_sec - currentPracticeSegment.shared_start_sec).toFixed(1)}s segment · plays ${((currentPracticeSegment.shared_end_sec - currentPracticeSegment.shared_start_sec) / state.practice.playbackRate).toFixed(1)}s at ${practiceSpeedText}`
      : "";
  const sessionNameTags = useMemo(() => {
      if (!sessionMode) return null;
      return (
        <>
          {sessionReferenceName ? <span className="ebs-tag">{sessionReferenceName}</span> : null}
          {sessionPracticeName ? <span className="ebs-tag">{sessionPracticeName}</span> : null}
        </>
      );
    }, [sessionMode, sessionPracticeName, sessionReferenceName]);
  const SEVERITY_COLORS: Record<string, string> = {
    good: "#34d399",     // emerald-400
    minor: "#fbbf24",    // amber-400
    moderate: "#fb923c", // orange-400
    major: "#f87171",    // red-400
  };
  const getSegmentAnalysisColor = useCallback((start: number, end: number) => {
    const relevant = danceFeedback.filter(
      (fb) => fb.timestamp >= start && fb.timestamp <= end
    );

    if (relevant.some((fb) => fb.severity === "major")) return "#f87171";    // Red
    if (relevant.some((fb) => fb.severity === "moderate")) return "#fb923c"; // Orange
    if (relevant.some((fb) => fb.severity === "minor")) return "#fbbf24";    // Amber
    return null; // No errors
  }, [danceFeedback]);
  return (
    <div className="ebs-viewer-root">
      {viewerVisible && (
        <div className="ebs-viewer visible">
          <div className="ebs-top-bar">
          {hasSegments ? (
            <div className="ebs-toggle flex items-center w-full">
              <label htmlFor="chk-pause">Pause at segment end</label>
              <input
                id="chk-pause"
                type="checkbox"
                className="ebs-toggle-switch"
                checked={state.pauseAtSegmentEnd}
                onChange={(e) => setPauseAtSegmentEnd(e.target.checked)}
              />
              <>
                {sessionNameTags}
                <span className="ebs-tag green">{bpm} BPM</span>
                <span className="ebs-tag">{nb} beats</span>
                <span className="ebs-tag">{state.segments.length} segments</span>
                <span className="ebs-tag orange">{mode}</span>
              </>
              <div className="flex-1" />
              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                currently using BodyPix
              </p>
            </div>
          ) : (
            <div className="ebs-inline-note">Aligned videos loaded...</div>
          )}
        </div>
          <div className="videos">
            <div className="video-panel">
              <div className="video-label">
                Reference (Clip 1)
                <span className="time-display">{fmtTimeFull(state.refTime)}</span>
              </div>
              <div className="relative">
                <video ref={refVideo} src={activeReferenceVideoUrl ?? undefined} playsInline />
                {sessionMode && showBodyPix ? (
                  overlayMode === "precomputed" ? (
                    <ProgressiveOverlay videoRef={refVideo} artifact={refBodyPixArtifact} />
                  ) : (
                    <BodyPixOverlay videoRef={refVideo} opacity={0.68} />
                  )
                ) : null}
                
              </div>
              <div className={`beat-flash${state.beatFlashOn ? " on" : ""}`} />
              <div className={`seg-pause-overlay${state.pauseOverlay.visible ? " visible" : ""}`}>
                <div className="seg-pause-card">
                  <div className="seg-done-num">{state.pauseOverlay.label}</div>
                  <div className="seg-done-label">{state.pauseOverlay.completionLabel}</div>
                  <div className="seg-done-hint">Space to continue · → next section</div>
                </div>
              </div>
            </div>
            <div className="video-panel">
              <div className="video-label">
                User (Clip 2)
                <span className="time-display">{fmtTimeFull(state.userTime)}</span>
              </div>
              <div className="relative">
                <video ref={userVideo} src={activeUserVideoUrl ?? undefined} playsInline />
                {sessionMode && showBodyPix ? (
                  overlayMode === "precomputed" ? (
                    <ProgressiveOverlay videoRef={userVideo} artifact={userBodyPixArtifact} />
                  ) : (
                    <BodyPixOverlay videoRef={userVideo} opacity={0.68} />
                  )
                ) : null}
                {sessionMode && showFeedback && danceFeedback.length > 0 ? (
                  <FeedbackOverlay
                    refVideoRef={refVideo}
                    videoRef={userVideo}
                    feedback={danceFeedback}
                    sharedTime={state.sharedTime}
                  />
                ) : null}
              </div>
              <div className={`beat-flash${state.beatFlashOn ? " on" : ""}`} />
              <div className={`seg-pause-overlay${state.pauseOverlay.visible ? " visible" : ""}`}>
                <div className="seg-pause-card">
                  <div className="seg-done-num">{state.pauseOverlay.label}</div>
                  <div className="seg-done-label">{state.pauseOverlay.completionLabel}</div>
                  <div className="seg-done-hint">Space to continue · → next section</div>
                </div>
              </div>
            </div>
          </div>
          {sessionMode && showFeedback && activeReferenceVideoUrl && activeUserVideoUrl && state.segments.length > 0 && (
            <div className="mt-4 mb-2">
              <FeedbackPanel
                referenceVideoUrl={activeReferenceVideoUrl}
                userVideoUrl={activeUserVideoUrl}
                segments={state.segments}
                sharedTime={state.sharedTime}
                onSeek={seekToShared}
                onFeedbackReady={setDanceFeedback}
              />
            </div>
          )} 

          {!state.practice.enabled && hasSegments && (
            <>
              <div className="transport">
                <div className="transport-row">
                  <button className="transport-btn" onClick={seekToPrevSegment} title="Previous segment">
                    ◀◀
                  </button>
                  <button className="transport-btn play-btn" onClick={togglePlay} title="Play / Pause">
                    {state.isPlaying ? "▮▮" : "▶"}
                  </button>
                  <button className="transport-btn" onClick={seekToNextSegment} title="Next segment">
                    ▶▶
                  </button>
                  <button className="transport-btn" onClick={toggleMainSpeed} title="Toggle 0.5x speed">
                    {state.mainPlaybackRate === 1 ? "1x" : "0.5x"}
                  </button>
                  <button
                    className="transport-btn practice-btn"
                    onClick={() => {
                      if (state.currentSegmentIndex >= 0) {
                        openPracticeMode(state.currentSegmentIndex);
                      } else if (state.segments.length) {
                        openPracticeMode(0);
                      }
                    }}
                    title="Practice current segment"
                  >
                    Practice
                  </button>
                  <div className="transport-info">
                    <div className="current-segment">
                      {currentSegment ? (
                        <>
                          Segment <span>{state.currentSegmentIndex}</span> / {state.segments.length - 1}
                        </>
                      ) : (
                        "Between segments"
                      )}
                    </div>
                    <div className="bpm-info">{bpmInfo}</div>
                  </div>
                  <div className="time-code">{fmtTime(state.sharedTime)}</div>
                </div>
              </div>

              <div className="timeline">
                <div className="timeline-track relative overflow-hidden" ref={timelineTrackRef} onClick={handleTimelineClick}>
                    {/* 1. HEATMAP LAYER (Bottom Layer) */}
                    {showFeedback && danceFeedback.map((fb, i) => (
                      <div
                        key={`heat-${i}`}
                        className="absolute top-0 bottom-0 w-[3px] z-[1]"
                        style={{
                          left: `${(fb.timestamp / sharedLen) * 100}%`,
                          backgroundColor: SEVERITY_COLORS[fb.severity] || "#cbd5e1",
                          boxShadow: fb.severity === 'major' ? `0 0 8px ${SEVERITY_COLORS.major}` : 'none',
                        }}
                      />
                    ))}

                    {/* 2. SEGMENTS LAYER (Middle Layer - Make these transparent!) */}
                    {state.segments.map((segment, index) => {
                      const analysisColor = getSegmentAnalysisColor(
                        segment.shared_start_sec, 
                        segment.shared_end_sec
                      );
                      const isActive = index === state.currentSegmentIndex;

                      return (
                        <div
                          key={`seg-track-${index}`}
                          className={[
                            "timeline-segment transition-colors duration-500",
                            isActive ? "active" : "",
                            segmentDoneSet.has(index) ? "done" : "",
                          ].filter(Boolean).join(" ")}
                          style={{
                            left: `${(segment.shared_start_sec / sharedLen) * 100}%`,
                            width: `${((segment.shared_end_sec - segment.shared_start_sec) / sharedLen) * 100}%`,
                            // OVERRIDE: If there's an error color, use it. 
                            // We use a slight transparency so the "Active" blue still shows through if needed.
                            backgroundColor: analysisColor ? `${analysisColor}${isActive ? 'CC' : '66'}` : undefined,
                            borderColor: analysisColor || undefined,
                            borderWidth: analysisColor ? '1px' : '0px',
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            seekToSegment(index);
                          }}
                        >
                          {index}
                        </div>
                      );
                    })}

                    {/* 3. PLAYHEAD (Top Layer) */}
                    <div
                      className="timeline-playhead z-[10] shadow-md"
                      style={{ left: `${sharedLen > 0 ? (state.sharedTime / sharedLen) * 100 : 0}%` }}
                    />
                  </div>
                <div className="beat-markers">
                  {state.beats.map((beat, index) => (
                    <div
                      key={`beat-${index}`}
                      className={`beat-dot${index % 8 === 0 ? " downbeat" : ""}`}
                      style={{ left: `${sharedLen > 0 ? (beat / sharedLen) * 100 : 0}%` }}
                    />
                  ))}
                </div>
              </div>

              <div className="segment-list">
                {state.segments.map((segment, index) => (
                  <div
                    key={`seg-chip-${index}`}
                    className={[
                      "seg-chip",
                      index === state.currentSegmentIndex ? "active" : "",
                      segmentDoneSet.has(index) ? "done" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => {
                      hidePauseOverlay();
                      seekToSegment(index);
                    }}
                  >
                    <div className="seg-num">Seg {index}</div>
                    <div className="seg-time">
                      {fmtTime(segment.shared_start_sec)} - {fmtTime(segment.shared_end_sec)}
                    </div>
                    <button
                      className="seg-practice-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        openPracticeMode(index);
                      }}
                    >
                      ▶ Practice
                    </button>
                  </div>
                ))}
              </div>

              <div className="download-row">
                <button className="dl-btn" onClick={downloadJson}>
                  Download EBS JSON
                </button>
                <button
                  className="dl-btn"
                  onClick={() => {
                    if (state.currentSegmentIndex >= 0) {
                      playSegment(state.currentSegmentIndex);
                    }
                  }}
                >
                  Replay Current Segment
                </button>
                {sessionMode ? sessionFooterSlot : null}
              </div>
            </>
          )}

          {!state.practice.enabled && !hasSegments && (
            <>
              <div className="ebs-empty-state">
                <div className="ebs-empty-state-title">No beat-synced segments were detected</div>
                <p className="ebs-empty-state-copy">
                  TempoFlow successfully aligned the videos and loaded the EBS result, but this clip did not produce
                  any playable sections. This usually happens when the shared audio is too short or the beat tracker
                  cannot find a stable pulse.
                </p>
                <div className="ebs-empty-state-meta">
                  <span className="ebs-tag">{sharedLen.toFixed(3)}s shared audio</span>
                  <span className="ebs-tag">{nb} beats detected</span>
                  <span className="ebs-tag orange">{mode}</span>
                </div>
              </div>

              <div className="download-row">
                <button className="dl-btn" onClick={downloadJson}>
                  Download EBS JSON
                </button>
                {sessionMode ? sessionFooterSlot : null}
              </div>
            </>
          )}

          {state.practice.enabled && (
            <div className="practice-panel visible">
              <div className="practice-header">
                <div>
                  <span className="practice-title">
                    Practice: Segment <span className="pnum">{state.practice.segmentIndex}</span>
                    <span className="speed-badge">{practiceSpeedText}</span>
                  </span>
                  <div className="practice-note">Last move = transition to next segment</div>
                </div>
                <div className="practice-header-actions">
                  <div className="ebs-toggle">
                    <label htmlFor="chk-pause-move">Pause at move end</label>
                    <input
                      id="chk-pause-move"
                      type="checkbox"
                      className="ebs-toggle-switch"
                      checked={state.practice.pauseAtMoveEnd}
                      onChange={(event) => setPauseAtMoveEnd(event.target.checked)}
                    />
                  </div>
                  <button className="ebs-back-btn" onClick={closePracticeMode}>
                    ← Back to Overview
                  </button>
                </div>
              </div>

              <div className="transport">
                <div className="transport-row">
                  <button className="transport-btn" onClick={seekToPrevMove}>
                    ◀◀
                  </button>
                  <button className="transport-btn play-btn" onClick={togglePlay}>
                    {state.isPlaying ? "▮▮" : "▶"}
                  </button>
                  <button className="transport-btn" onClick={seekToNextMove}>
                    ▶▶
                  </button>
                  <button className="transport-btn practice-active" onClick={togglePracticeSpeed}>
                    {practiceSpeedText}
                  </button>
                  <button
                    className={`transport-btn${state.practice.loopSegment ? " practice-active" : ""}`}
                    onClick={() => setPracticeLoop(!state.practice.loopSegment)}
                  >
                    Loop
                  </button>
                  <div className="transport-info">
                    <div className="current-segment">
                      {state.practice.currentMoveIndex >= 0 ? (
                        <>
                          Move <span>{state.practice.moves[state.practice.currentMoveIndex]?.num}</span> /{" "}
                          {state.practice.moves.length}
                          {state.practice.moves[state.practice.currentMoveIndex]?.isTransition
                            ? " (Transition)"
                            : ""}
                        </>
                      ) : (
                        <>
                          Move <span>—</span>
                        </>
                      )}
                    </div>
                    <div className="bpm-info">{practiceInfo}</div>
                  </div>
                  <div className="time-code">{fmtTime(state.sharedTime)}</div>
                </div>
              </div>

              <div className="move-timeline">
                <div className="move-tl-label">Move Breakdown</div>
                <div
                  className="move-tl-track"
                  ref={moveTimelineTrackRef}
                  onClick={handleMoveTimelineClick}
                >
                  {currentPracticeSegment &&
                    state.practice.moves.map((move, index) => {
                      const segDuration =
                        currentPracticeSegment.shared_end_sec - currentPracticeSegment.shared_start_sec;
                      return (
                        <div
                          key={`move-track-${index}`}
                          className={[
                            "move-block",
                            move.isTransition ? "transition-move" : "",
                            index === state.practice.currentMoveIndex ? "active" : "",
                            moveDoneSet.has(index) ? "done" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          style={{
                            left: `${((move.startSec - currentPracticeSegment.shared_start_sec) / segDuration) * 100}%`,
                            width: `${((move.endSec - move.startSec) / segDuration) * 100}%`,
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            seekToMove(index);
                          }}
                        >
                          <div className="mv-n">Move {move.num}</div>
                          {move.isTransition && <div className="mv-s">Transition</div>}
                        </div>
                      );
                    })}
                  <div
                    className="move-playhead"
                    style={{
                      left:
                        currentPracticeSegment
                          ? `${((state.sharedTime - currentPracticeSegment.shared_start_sec) /
                              (currentPracticeSegment.shared_end_sec -
                                currentPracticeSegment.shared_start_sec)) *
                              100}%`
                          : "0%",
                    }}
                  />
                </div>
              </div>

              <div className="move-list">
                {state.practice.moves.map((move, index) => (
                  <div
                    key={`move-chip-${index}`}
                    className={[
                      "move-chip",
                      move.isTransition ? "transition-move" : "",
                      index === state.practice.currentMoveIndex ? "active" : "",
                      moveDoneSet.has(index) ? "done" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => seekToMove(index)}
                  >
                    <div className="mv-cn">Move {move.num}</div>
                    <div className="mv-ct">
                      {fmtTime(move.startSec)} - {fmtTime(move.endSec)}
                    </div>
                    {move.isTransition && <div className="mv-cl">Transition</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
