/* Core state and behavior for the EBS viewer. */

"use client";
/* eslint-disable react-hooks/immutability */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { EbsData, EbsSegment, PracticeMove } from "./types";

export type EbsViewerRefs = {
  refVideo: RefObject<HTMLVideoElement | null>;
  userVideo: RefObject<HTMLVideoElement | null>;
};

type PauseOverlayState = {
  visible: boolean;
  label: string;
  completionLabel: string;
};

export type PracticeState = {
  enabled: boolean;
  segmentIndex: number;
  moves: PracticeMove[];
  currentMoveIndex: number;
  doneMoveIndexes: number[];
  loopSegment: boolean;
  pauseAtMoveEnd: boolean;
  playbackRate: number;
};

export type EbsViewerState = {
  ebs: EbsData | null;
  segments: EbsSegment[];
  beats: number[];
  sharedLen: number;
  isPlaying: boolean;
  mainPlaybackRate: number;
  pauseAtSegmentEnd: boolean;
  currentSegmentIndex: number;
  sharedTime: number;
  refTime: number;
  userTime: number;
  lastBeatIndex: number;
  beatFlashOn: boolean;
  doneSegmentIndexes: number[];
  pauseOverlay: PauseOverlayState;
  practice: PracticeState;
};

export type EbsViewerApi = {
  state: EbsViewerState;
  loadFromJson: (data: EbsData) => void;
  resetViewer: () => void;
  hidePauseOverlay: () => void;
  seekToShared: (sec: number) => void;
  seekToSegment: (idx: number) => void;
  seekToPrevSegment: () => void;
  seekToNextSegment: () => void;
  togglePlay: () => void;
  pausePlayback: () => void;
  playSegment: (idx: number) => void;
  setPauseAtSegmentEnd: (value: boolean) => void;
  toggleMainSpeed: () => void;
  markSegmentDone: (idx: number) => void;
  openPracticeMode: (segmentIndex: number) => void;
  closePracticeMode: () => void;
  seekToMove: (idx: number) => void;
  seekToPrevMove: () => void;
  seekToNextMove: () => void;
  setPracticeLoop: (value: boolean) => void;
  setPauseAtMoveEnd: (value: boolean) => void;
  togglePracticeSpeed: () => void;
};

const SEGMENT_BOUNDARY_TOLERANCE = 0.02;
const BEAT_FLASH_TOLERANCE = 0.06;

export function useEbsViewer({ refVideo, userVideo }: EbsViewerRefs): EbsViewerApi {
  const [ebs, setEbs] = useState<EbsData | null>(null);
  const [segments, setSegments] = useState<EbsSegment[]>([]);
  const [beats, setBeats] = useState<number[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [mainPlaybackRate, setMainPlaybackRate] = useState(1);
  const [pauseAtSegmentEnd, setPauseAtSegmentEnd] = useState(true);
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(-1);
  const [lastBeatIndex, setLastBeatIndex] = useState(-1);
  const [beatFlashOn, setBeatFlashOn] = useState(false);
  const [doneSegmentIndexes, setDoneSegmentIndexes] = useState<number[]>([]);
  const [sharedTime, setSharedTime] = useState(0);
  const [refTime, setRefTime] = useState(0);
  const [userTime, setUserTime] = useState(0);
  const [pauseOverlay, setPauseOverlay] = useState<PauseOverlayState>({
    visible: false,
    label: "Seg 0",
    completionLabel: "Segment complete",
  });
  const [practice, setPractice] = useState<PracticeState>({
    enabled: false,
    segmentIndex: -1,
    moves: [],
    currentMoveIndex: -1,
    doneMoveIndexes: [],
    loopSegment: true,
    pauseAtMoveEnd: true,
    playbackRate: 0.5,
  });

  const animIdRef = useRef<number | null>(null);
  const playingRef = useRef(false);
  const beatFlashTimeoutRef = useRef<number | null>(null);

  const alignment = ebs?.alignment;
  const sharedLen = alignment?.shared_len_sec ?? 0;

  const hidePauseOverlay = useCallback(() => {
    setPauseOverlay((prev) => ({ ...prev, visible: false }));
  }, []);

  const showPauseOverlay = useCallback((label: string, completionLabel: string) => {
    setPauseOverlay({
      visible: true,
      label,
      completionLabel,
    });
  }, []);

  const updateTimesFromDom = useCallback(() => {
    if (!refVideo.current || !userVideo.current || !alignment) return;
    setRefTime(refVideo.current.currentTime);
    setUserTime(userVideo.current.currentTime);
    setSharedTime(refVideo.current.currentTime - alignment.clip_1_start_sec);
  }, [alignment, refVideo, userVideo]);

  const syncUserToRef = useCallback(() => {
    if (!refVideo.current || !userVideo.current || !alignment) return;
    const refElement = refVideo.current;
    const userElement = userVideo.current;
    const refShared = refElement.currentTime - alignment.clip_1_start_sec;
    const userShared = userElement.currentTime - alignment.clip_2_start_sec;
    if (Math.abs(refShared - userShared) > 0.05) {
      userElement.currentTime = alignment.clip_2_start_sec + refShared;
    }
  }, [alignment, refVideo, userVideo]);

  const seekToSharedInternal = useCallback(
    (sec: number, keepPauseOverlay: boolean) => {
      if (!refVideo.current || !userVideo.current || !alignment) return;
      const refElement = refVideo.current;
      const userElement = userVideo.current;
      const clamped = Math.max(0, Math.min(sec, sharedLen));
      refElement.currentTime = alignment.clip_1_start_sec + clamped;
      userElement.currentTime = alignment.clip_2_start_sec + clamped;
      if (!keepPauseOverlay) {
        hidePauseOverlay();
      }
      updateTimesFromDom();
    },
    [alignment, hidePauseOverlay, refVideo, sharedLen, updateTimesFromDom, userVideo],
  );

  const seekToShared = useCallback(
    (sec: number) => {
      seekToSharedInternal(sec, false);
    },
    [seekToSharedInternal],
  );

  const markSegmentDone = useCallback((idx: number) => {
    setDoneSegmentIndexes((prev) => (prev.includes(idx) ? prev : [...prev, idx]));
  }, []);

  const buildMoves = useCallback(
    (segmentIndex: number): PracticeMove[] => {
      const segment = segments[segmentIndex];
      if (!segment?.beat_idx_range) return [];
      const [beatStart, beatEnd] = segment.beat_idx_range;
      if (beatEnd <= beatStart) return [];

      const moves: PracticeMove[] = [];
      const total = beatEnd - beatStart;
      for (let i = beatStart; i < beatEnd; i++) {
        if (beats[i] == null || beats[i + 1] == null) break;
        const num = i - beatStart + 1;
        moves.push({
          idx: num - 1,
          num,
          startSec: beats[i],
          endSec: beats[i + 1],
          isTransition: num === total,
        });
      }
      return moves;
    },
    [beats, segments],
  );

  const pausePlayback = useCallback(() => {
    playingRef.current = false;
    refVideo.current?.pause();
    userVideo.current?.pause();
    setIsPlaying(false);
    if (animIdRef.current != null) {
      window.cancelAnimationFrame(animIdRef.current);
      animIdRef.current = null;
    }
  }, [refVideo, userVideo]);

  const startPlayback = useCallback(() => {
    if (!refVideo.current || !userVideo.current) return;
    hidePauseOverlay();
    playingRef.current = true;
    void refVideo.current.play().catch(() => undefined);
    void userVideo.current.play().catch(() => undefined);
    setIsPlaying(true);

    const tick = () => {
      updateTimesFromDom();
      syncUserToRef();
      if (playingRef.current) {
        animIdRef.current = window.requestAnimationFrame(tick);
      }
    };

    if (animIdRef.current != null) {
      window.cancelAnimationFrame(animIdRef.current);
    }
    animIdRef.current = window.requestAnimationFrame(tick);
  }, [hidePauseOverlay, refVideo, syncUserToRef, updateTimesFromDom, userVideo]);

  const togglePlay = useCallback(() => {
    if (playingRef.current) {
      pausePlayback();
    } else {
      startPlayback();
    }
  }, [pausePlayback, startPlayback]);

  const playSegment = useCallback(
    (idx: number) => {
      if (!segments.length) return;
      const clampedIndex = Math.max(0, Math.min(idx, segments.length - 1));
      seekToShared(segments[clampedIndex].shared_start_sec);
      startPlayback();
    },
    [seekToShared, segments, startPlayback],
  );

  const seekToSegment = useCallback(
    (idx: number) => {
      if (!segments.length) return;
      const clampedIndex = Math.max(0, Math.min(idx, segments.length - 1));
      seekToShared(segments[clampedIndex].shared_start_sec);
    },
    [seekToShared, segments],
  );

  const seekToPrevSegment = useCallback(() => {
    const idx = currentSegmentIndex > 0 ? currentSegmentIndex - 1 : 0;
    seekToSegment(idx);
  }, [currentSegmentIndex, seekToSegment]);

  const seekToNextSegment = useCallback(() => {
    if (!segments.length) return;
    if (currentSegmentIndex + 1 < segments.length) {
      seekToSegment(currentSegmentIndex + 1);
    } else if (currentSegmentIndex < 0) {
      seekToSegment(0);
    }
  }, [currentSegmentIndex, seekToSegment, segments.length]);

  const toggleMainSpeed = useCallback(() => {
    const nextRate = mainPlaybackRate === 1 ? 0.5 : 1;
    setMainPlaybackRate(nextRate);
    if (!practice.enabled) {
      const refElement = refVideo.current;
      const userElement = userVideo.current;
      if (refElement) refElement.playbackRate = nextRate;
      if (userElement) userElement.playbackRate = nextRate;
    }
  }, [mainPlaybackRate, practice.enabled, refVideo, userVideo]);

  const loadFromJson = useCallback((data: EbsData) => {
    pausePlayback();
    setEbs(data);
    setSegments(data.segments ?? []);
    setBeats(data.beats_shared_sec ?? []);
    setCurrentSegmentIndex(-1);
    setLastBeatIndex(-1);
    setDoneSegmentIndexes([]);
    setPractice({
      enabled: false,
      segmentIndex: -1,
      moves: [],
      currentMoveIndex: -1,
      doneMoveIndexes: [],
      loopSegment: true,
      pauseAtMoveEnd: true,
      playbackRate: 0.5,
    });
    setPauseOverlay({
      visible: false,
      label: "Seg 0",
      completionLabel: "Segment complete",
    });
    setBeatFlashOn(false);
    setSharedTime(0);
    setRefTime(0);
    setUserTime(0);
  }, [pausePlayback]);

  const resetViewer = useCallback(() => {
    pausePlayback();
    hidePauseOverlay();
    setCurrentSegmentIndex(-1);
    setLastBeatIndex(-1);
    setDoneSegmentIndexes([]);
    setPractice((prev) => ({
      ...prev,
      enabled: false,
      segmentIndex: -1,
      moves: [],
      currentMoveIndex: -1,
      doneMoveIndexes: [],
    }));
    setSharedTime(0);
  }, [hidePauseOverlay, pausePlayback]);

  const openPracticeMode = useCallback(
    (segmentIndex: number) => {
      if (segmentIndex < 0 || segmentIndex >= segments.length) return;
      const moves = buildMoves(segmentIndex);
      if (!moves.length) return;

      pausePlayback();
      hidePauseOverlay();
      setPractice({
        enabled: true,
        segmentIndex,
        moves,
        currentMoveIndex: -1,
        doneMoveIndexes: [],
        loopSegment: true,
        pauseAtMoveEnd: true,
        playbackRate: 0.5,
      });
      const refElement = refVideo.current;
      const userElement = userVideo.current;
      if (refElement) refElement.playbackRate = 0.5;
      if (userElement) userElement.playbackRate = 0.5;
      seekToShared(moves[0].startSec);
    },
    [buildMoves, hidePauseOverlay, pausePlayback, refVideo, seekToShared, segments.length, userVideo],
  );

  const closePracticeMode = useCallback(() => {
    pausePlayback();
    hidePauseOverlay();
    setPractice((prev) => ({
      ...prev,
      enabled: false,
      segmentIndex: -1,
      moves: [],
      currentMoveIndex: -1,
      doneMoveIndexes: [],
    }));
    const refElement = refVideo.current;
    const userElement = userVideo.current;
    if (refElement) refElement.playbackRate = mainPlaybackRate;
    if (userElement) userElement.playbackRate = mainPlaybackRate;
  }, [hidePauseOverlay, mainPlaybackRate, pausePlayback, refVideo, userVideo]);

  const seekToMove = useCallback(
    (idx: number) => {
      if (!practice.moves.length) return;
      const clampedIndex = Math.max(0, Math.min(idx, practice.moves.length - 1));
      setPractice((prev) => ({ ...prev, currentMoveIndex: clampedIndex }));
      seekToShared(practice.moves[clampedIndex].startSec);
    },
    [practice.moves, seekToShared],
  );

  const seekToPrevMove = useCallback(() => {
    const idx = practice.currentMoveIndex > 0 ? practice.currentMoveIndex - 1 : 0;
    seekToMove(idx);
  }, [practice.currentMoveIndex, seekToMove]);

  const seekToNextMove = useCallback(() => {
    if (!practice.moves.length) return;
    if (practice.currentMoveIndex + 1 < practice.moves.length) {
      seekToMove(practice.currentMoveIndex + 1);
    } else if (practice.currentMoveIndex < 0) {
      seekToMove(0);
    }
  }, [practice.currentMoveIndex, practice.moves.length, seekToMove]);

  const setPracticeLoop = useCallback((value: boolean) => {
    setPractice((prev) => ({ ...prev, loopSegment: value }));
  }, []);

  const setPauseAtMoveEnd = useCallback((value: boolean) => {
    setPractice((prev) => ({ ...prev, pauseAtMoveEnd: value }));
  }, []);

  const togglePracticeSpeed = useCallback(() => {
    setPractice((prev) => {
      const nextRate = prev.playbackRate === 0.5 ? 0.25 : 0.5;
      if (refVideo.current) refVideo.current.playbackRate = nextRate;
      if (userVideo.current) userVideo.current.playbackRate = nextRate;
      return { ...prev, playbackRate: nextRate };
    });
  }, [refVideo, userVideo]);

  useEffect(() => {
    if (beatFlashTimeoutRef.current != null) {
      window.clearTimeout(beatFlashTimeoutRef.current);
    }
    if (lastBeatIndex < 0) {
      setBeatFlashOn(false);
      return;
    }
    setBeatFlashOn(true);
    beatFlashTimeoutRef.current = window.setTimeout(() => {
      setBeatFlashOn(false);
    }, 80);
  }, [lastBeatIndex]);

  useEffect(() => {
    if (!segments.length || !alignment) return;

    if (practice.enabled) {
      const segment = segments[practice.segmentIndex];
      if (!segment) return;

      let newMoveIndex = -1;
      for (let i = 0; i < practice.moves.length; i++) {
        if (
          sharedTime >= practice.moves[i].startSec - 0.01 &&
          sharedTime < practice.moves[i].endSec
        ) {
          newMoveIndex = i;
          break;
        }
      }

      if (newMoveIndex !== practice.currentMoveIndex) {
        if (practice.pauseAtMoveEnd && playingRef.current && practice.currentMoveIndex >= 0) {
          const completedMove = practice.moves[practice.currentMoveIndex];
          setPractice((prev) => ({
            ...prev,
            currentMoveIndex: newMoveIndex,
            doneMoveIndexes: prev.doneMoveIndexes.includes(prev.currentMoveIndex)
              ? prev.doneMoveIndexes
              : [...prev.doneMoveIndexes, prev.currentMoveIndex],
          }));
          showPauseOverlay(
            completedMove.isTransition
              ? `Move ${completedMove.num} (Transition)`
              : `Move ${completedMove.num}`,
            "Move complete",
          );
          pausePlayback();
          seekToSharedInternal(completedMove.endSec, true);
          return;
        }

        setPractice((prev) => ({ ...prev, currentMoveIndex: newMoveIndex }));
      }

      if (playingRef.current && sharedTime >= segment.shared_end_sec - SEGMENT_BOUNDARY_TOLERANCE) {
        if (practice.loopSegment) {
          seekToSharedInternal(segment.shared_start_sec, true);
          setPractice((prev) => ({ ...prev, currentMoveIndex: -1 }));
        } else {
          pausePlayback();
        }
      }
    } else {
      let newSegmentIndex = -1;
      for (let i = 0; i < segments.length; i++) {
        if (
          sharedTime >= segments[i].shared_start_sec &&
          sharedTime < segments[i].shared_end_sec
        ) {
          newSegmentIndex = i;
          break;
        }
      }

      if (newSegmentIndex !== currentSegmentIndex) {
        if (pauseAtSegmentEnd && playingRef.current && currentSegmentIndex >= 0) {
          const completedIndex = currentSegmentIndex;
          markSegmentDone(completedIndex);
          showPauseOverlay(`Seg ${completedIndex}`, "Segment complete");
          pausePlayback();
          seekToSharedInternal(segments[completedIndex].shared_end_sec, true);
          setCurrentSegmentIndex(newSegmentIndex);
          return;
        }
        setCurrentSegmentIndex(newSegmentIndex);
      }
    }

    let closestBeat = -1;
    for (let i = 0; i < beats.length; i++) {
      if (Math.abs(sharedTime - beats[i]) < BEAT_FLASH_TOLERANCE) {
        closestBeat = i;
        break;
      }
    }

    if (closestBeat >= 0 && closestBeat !== lastBeatIndex) {
      if (
        currentSegmentIndex < 0 ||
        beats[closestBeat] < (segments[Math.max(currentSegmentIndex, 0)]?.shared_end_sec ?? Infinity)
      ) {
        setLastBeatIndex(closestBeat);
      }
    }
  }, [
    alignment,
    beats,
    currentSegmentIndex,
    lastBeatIndex,
    markSegmentDone,
    pauseAtSegmentEnd,
    pausePlayback,
    practice.currentMoveIndex,
    practice.enabled,
    practice.loopSegment,
    practice.moves,
    practice.pauseAtMoveEnd,
    practice.segmentIndex,
    segments,
    seekToSharedInternal,
    sharedTime,
    showPauseOverlay,
  ]);

  useEffect(() => {
    return () => {
      playingRef.current = false;
      if (animIdRef.current != null) {
        window.cancelAnimationFrame(animIdRef.current);
      }
      if (beatFlashTimeoutRef.current != null) {
        window.clearTimeout(beatFlashTimeoutRef.current);
      }
    };
  }, []);

  const state = useMemo<EbsViewerState>(
    () => ({
      ebs,
      segments,
      beats,
      sharedLen,
      isPlaying,
      mainPlaybackRate,
      pauseAtSegmentEnd,
      currentSegmentIndex,
      sharedTime,
      refTime,
      userTime,
      lastBeatIndex,
      beatFlashOn,
      doneSegmentIndexes,
      pauseOverlay,
      practice,
    }),
    [
      beats,
      beatFlashOn,
      currentSegmentIndex,
      doneSegmentIndexes,
      ebs,
      isPlaying,
      lastBeatIndex,
      mainPlaybackRate,
      pauseAtSegmentEnd,
      pauseOverlay,
      practice,
      refTime,
      segments,
      sharedLen,
      sharedTime,
      userTime,
    ],
  );

  return {
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
    markSegmentDone,
    openPracticeMode,
    closePracticeMode,
    seekToMove,
    seekToPrevMove,
    seekToNextMove,
    setPracticeLoop,
    setPauseAtMoveEnd,
    togglePracticeSpeed,
  };
}

