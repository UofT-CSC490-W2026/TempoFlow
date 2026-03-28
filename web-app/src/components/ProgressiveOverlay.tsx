"use client";

import { useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";

import { PrecomputedFrameOverlay } from "./PrecomputedFrameOverlay";
import { PrecomputedVideoOverlay } from "./PrecomputedVideoOverlay";
import type { OverlayArtifact, OverlaySegmentArtifact } from "../lib/overlayStorage";

function getRenderableSegments(artifact: OverlayArtifact) {
  return [...(artifact.segments ?? [])]
    .filter((segment) => segment.video || (segment.frames && segment.frames.length > 0))
    .sort((a, b) => a.startSec - b.startSec || a.index - b.index);
}

function findActiveSegment(
  segments: OverlaySegmentArtifact[],
  timeSec: number,
) {
  return (
    segments.find((segment) => {
      const tolerance = 1 / Math.max(1, segment.fps || 1);
      return timeSec >= segment.startSec - tolerance && timeSec <= segment.endSec + tolerance;
    }) ?? null
  );
}

function getSegmentDuration(segment: OverlaySegmentArtifact) {
  return Math.max(0, segment.endSec - segment.startSec);
}

function getLocalSegmentTime(segment: OverlaySegmentArtifact, timeSec: number) {
  const duration = getSegmentDuration(segment);
  if (duration <= 0) return 0;
  return Math.max(0, Math.min(duration - 0.001, timeSec - segment.startSec));
}

function SegmentedFrameOverlay(props: {
  videoRef: RefObject<HTMLVideoElement | null>;
  segments: OverlaySegmentArtifact[];
}) {
  const { videoRef, segments } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const urlCacheRef = useRef<Map<string, string>>(new Map());
  const lastKeyRef = useRef<string>("");

  useEffect(() => {
    return () => {
      for (const url of urlCacheRef.current.values()) {
        URL.revokeObjectURL(url);
      }
      urlCacheRef.current.clear();
      imageCacheRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const syncCanvasSize = () => {
      const cssW = video.clientWidth || 0;
      const cssH = video.clientHeight || 0;
      if (cssW <= 0 || cssH <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(cssW * dpr));
      const h = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    const clearCanvas = () => {
      if (lastKeyRef.current) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        lastKeyRef.current = "";
      }
    };

    const drawAtTime = (timeSec: number) => {
      syncCanvasSize();
      const segment = findActiveSegment(segments, timeSec);
      const frames = segment?.frames;
      if (!segment || !frames?.length) {
        clearCanvas();
        return;
      }

      const localTime = getLocalSegmentTime(segment, timeSec);
      const frameIndex = Math.min(
        frames.length - 1,
        Math.max(0, Math.round(localTime * Math.max(1, segment.fps || 1))),
      );
      const key = `${segment.index}:${frameIndex}`;
      if (key === lastKeyRef.current) return;
      lastKeyRef.current = key;

      const frame = frames[frameIndex];
      if (frame == null) {
        clearCanvas();
        return;
      }

      const drawImage = (image: HTMLImageElement) => {
        if (lastKeyRef.current !== key) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      };

      const cached = imageCacheRef.current.get(key);
      if (cached && cached.complete && cached.naturalWidth > 0) {
        drawImage(cached);
        return;
      }

      const image = cached ?? new Image();
      image.onload = () => drawImage(image);

      if (!cached) {
        if (typeof frame === "string") {
          image.src = frame;
        } else {
          const existingUrl = urlCacheRef.current.get(key);
          if (existingUrl) {
            image.src = existingUrl;
          } else {
            const url = URL.createObjectURL(frame);
            urlCacheRef.current.set(key, url);
            image.src = url;
          }
        }
        imageCacheRef.current.set(key, image);
      }
    };

    let raf = 0;
    let cancelled = false;
    const rvfc = (video as HTMLVideoElement & {
      requestVideoFrameCallback?: (
        callback: (now: number, metadata: { mediaTime?: number }) => void,
      ) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    }).requestVideoFrameCallback;
    const cancelRvfc = (video as HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void })
      .cancelVideoFrameCallback;

    let rvfcHandle = 0;
    const onVideoFrame = (_now: number, metadata: { mediaTime?: number }) => {
      if (cancelled) return;
      drawAtTime(metadata.mediaTime ?? video.currentTime ?? 0);
      rvfcHandle = rvfc ? rvfc.call(video, onVideoFrame) : 0;
    };

    const onRaf = () => {
      if (cancelled) return;
      drawAtTime(video.currentTime || 0);
      raf = window.requestAnimationFrame(onRaf);
    };

    if (rvfc) {
      rvfcHandle = rvfc.call(video, onVideoFrame);
    } else {
      raf = window.requestAnimationFrame(onRaf);
    }

    return () => {
      cancelled = true;
      if (cancelRvfc && rvfcHandle) cancelRvfc.call(video, rvfcHandle);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [segments, videoRef]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ mixBlendMode: "screen" }}
    />
  );
}

function SegmentedVideoOverlay(props: {
  videoRef: RefObject<HTMLVideoElement | null>;
  segments: OverlaySegmentArtifact[];
}) {
  const { videoRef, segments } = props;
  const overlayVideoRef = useRef<HTMLVideoElement | null>(null);
  const urlCacheRef = useRef<Map<string, string>>(new Map());
  const currentSegmentKeyRef = useRef<string>("");
  const pendingTimeRef = useRef<number>(0);
  const activeSegmentRef = useRef<OverlaySegmentArtifact | null>(null);

  useEffect(() => {
    const nextKeys = new Set<string>();
    for (const segment of segments) {
      if (!segment.video) continue;
      const key = `${segment.index}:${segment.startSec}:${segment.endSec}`;
      nextKeys.add(key);
      if (!urlCacheRef.current.has(key)) {
        urlCacheRef.current.set(key, URL.createObjectURL(segment.video));
      }
    }

    for (const [key, url] of [...urlCacheRef.current.entries()]) {
      if (nextKeys.has(key)) continue;
      URL.revokeObjectURL(url);
      urlCacheRef.current.delete(key);
    }

    return () => {
      for (const url of urlCacheRef.current.values()) {
        URL.revokeObjectURL(url);
      }
      urlCacheRef.current.clear();
    };
  }, [segments]);

  useEffect(() => {
    const base = videoRef.current;
    const ov = overlayVideoRef.current;
    if (!base || !ov) return;

    ov.muted = true;
    ov.playsInline = true;
    ov.loop = false;

    let cancelled = false;

    const applyPlaybackState = async () => {
      if (cancelled) return;
      if (base.paused) {
        if (!ov.paused) ov.pause();
        return;
      }
      if (ov.paused) {
        await ov.play().catch(() => undefined);
      }
    };

    const sync = async () => {
      if (cancelled) return;
      const baseTime = base.currentTime || 0;
      const segment = findActiveSegment(segments, baseTime);

      if (!segment?.video) {
        activeSegmentRef.current = null;
        currentSegmentKeyRef.current = "";
        ov.pause();
        ov.style.visibility = "hidden";
        requestAnimationFrame(() => void sync());
        return;
      }

      ov.style.visibility = "visible";
      activeSegmentRef.current = segment;
      const localTime = getLocalSegmentTime(segment, baseTime);
      const key = `${segment.index}:${segment.startSec}:${segment.endSec}`;
      const nextUrl = urlCacheRef.current.get(key);

      if (nextUrl && currentSegmentKeyRef.current !== key) {
        currentSegmentKeyRef.current = key;
        pendingTimeRef.current = localTime;
        ov.src = nextUrl;
        ov.load();
      } else if (Math.abs((ov.currentTime || 0) - localTime) > 0.03) {
        try {
          ov.currentTime = localTime;
        } catch {
          pendingTimeRef.current = localTime;
        }
      }

      if (Math.abs((ov.playbackRate || 1) - (base.playbackRate || 1)) > 0.001) {
        ov.playbackRate = base.playbackRate || 1;
      }

      await applyPlaybackState();
      requestAnimationFrame(() => void sync());
    };

    const onLoadedMetadata = () => {
      if (cancelled) return;
      try {
        ov.currentTime = pendingTimeRef.current;
      } catch {
        return;
      }
      void applyPlaybackState();
    };

    const onSeeked = () => {
      const segment = activeSegmentRef.current;
      if (!segment) return;
      pendingTimeRef.current = getLocalSegmentTime(segment, base.currentTime || 0);
      try {
        ov.currentTime = pendingTimeRef.current;
      } catch {
        return;
      }
    };

    ov.addEventListener("loadedmetadata", onLoadedMetadata);
    base.addEventListener("seeked", onSeeked);
    base.addEventListener("seeking", onSeeked);

    requestAnimationFrame(() => void sync());

    return () => {
      cancelled = true;
      ov.pause();
      ov.removeEventListener("loadedmetadata", onLoadedMetadata);
      base.removeEventListener("seeked", onSeeked);
      base.removeEventListener("seeking", onSeeked);
    };
  }, [segments, videoRef]);

  return (
    <video
      ref={overlayVideoRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ mixBlendMode: "screen", visibility: "hidden" }}
    />
  );
}

export function ProgressiveOverlay(props: {
  videoRef: RefObject<HTMLVideoElement | null>;
  artifact: OverlayArtifact | null;
}) {
  const { videoRef, artifact } = props;

  const segments = useMemo(() => (artifact ? getRenderableSegments(artifact) : []), [artifact]);

  if (!artifact) return null;

  if (segments.length > 0) {
    if (segments.some((segment) => segment.video)) {
      return <SegmentedVideoOverlay videoRef={videoRef} segments={segments} />;
    }
    if (segments.some((segment) => segment.frames && segment.frames.length > 0)) {
      return <SegmentedFrameOverlay videoRef={videoRef} segments={segments} />;
    }
  }

  if (artifact.video) {
    return (
      <PrecomputedVideoOverlay
        videoRef={videoRef}
        overlayBlob={artifact.video}
        mimeType={artifact.videoMime}
      />
    );
  }

  if (artifact.frames?.length) {
    return (
      <PrecomputedFrameOverlay
        videoRef={videoRef}
        frames={artifact.frames}
        fps={artifact.fps}
      />
    );
  }

  return null;
}
