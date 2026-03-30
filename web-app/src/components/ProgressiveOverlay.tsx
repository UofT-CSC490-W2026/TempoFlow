"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";

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
  className?: string;
  style?: CSSProperties;
  getSegmentStyle?: (segment: OverlaySegmentArtifact | null) => CSSProperties | undefined;
}) {
  const { videoRef, segments, className, style, getSegmentStyle } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const urlCacheRef = useRef<Map<string, string>>(new Map());
  const lastKeyRef = useRef<string>("");
  const [segmentStyle, setSegmentStyle] = useState<CSSProperties | undefined>(undefined);

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
      setSegmentStyle(getSegmentStyle?.(segment));
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
      className={`pointer-events-none absolute inset-0 h-full w-full ${className ?? ""}`}
      style={{ mixBlendMode: "screen", transformOrigin: "50% 100%", ...(style ?? {}), ...(segmentStyle ?? {}) }}
    />
  );
}

function SegmentedVideoOverlay(props: {
  videoRef: RefObject<HTMLVideoElement | null>;
  segments: OverlaySegmentArtifact[];
  className?: string;
  style?: CSSProperties;
  getSegmentStyle?: (segment: OverlaySegmentArtifact | null) => CSSProperties | undefined;
}) {
  const { videoRef, segments, className, style, getSegmentStyle } = props;
  const overlayVideoRef = useRef<HTMLVideoElement | null>(null);
  const urlCacheRef = useRef<Map<string, string>>(new Map());
  const currentSegmentKeyRef = useRef<string>("");
  const pendingTimeRef = useRef<number>(0);
  const activeSegmentRef = useRef<OverlaySegmentArtifact | null>(null);
  const [segmentStyle, setSegmentStyle] = useState<CSSProperties | undefined>(undefined);

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
    let raf = 0;
    let rvfcHandle = 0;
    const rvfc = (base as HTMLVideoElement & {
      requestVideoFrameCallback?: (
        callback: (now: number, metadata: { mediaTime?: number }) => void,
      ) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    }).requestVideoFrameCallback;
    const cancelRvfc = (base as HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void })
      .cancelVideoFrameCallback;

    const sync = (forcedBaseTime?: number) => {
      if (cancelled) return;
      const baseTime = forcedBaseTime ?? (base.currentTime || 0);
      const segment = findActiveSegment(segments, baseTime);

      if (!segment?.video) {
        activeSegmentRef.current = null;
        currentSegmentKeyRef.current = "";
        ov.pause();
        ov.style.visibility = "hidden";
        setSegmentStyle(getSegmentStyle?.(null));
        return;
      }

      ov.style.visibility = "visible";
      activeSegmentRef.current = segment;
      setSegmentStyle(getSegmentStyle?.(segment));
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

      if (!ov.paused) {
        ov.pause();
      }
    };

    const onLoadedMetadata = () => {
      if (cancelled) return;
      try {
        ov.currentTime = pendingTimeRef.current;
      } catch {
        return;
      }
      ov.pause();
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
      ov.pause();
    };
    const onBasePauseLike = () => {
      ov.pause();
    };

    const onVideoFrame = (_now: number, metadata: { mediaTime?: number }) => {
      if (cancelled) return;
      sync(metadata.mediaTime ?? base.currentTime ?? 0);
      rvfcHandle = rvfc ? rvfc.call(base, onVideoFrame) : 0;
    };

    const onRaf = () => {
      if (cancelled) return;
      sync();
      raf = window.requestAnimationFrame(onRaf);
    };

    ov.addEventListener("loadedmetadata", onLoadedMetadata);
    base.addEventListener("seeked", onSeeked);
    base.addEventListener("seeking", onSeeked);
    base.addEventListener("pause", onBasePauseLike);
    base.addEventListener("waiting", onBasePauseLike);
    base.addEventListener("stalled", onBasePauseLike);

    if (rvfc) {
      rvfcHandle = rvfc.call(base, onVideoFrame);
    } else {
      raf = window.requestAnimationFrame(onRaf);
    }

    return () => {
      cancelled = true;
      if (cancelRvfc && rvfcHandle) cancelRvfc.call(base, rvfcHandle);
      if (raf) window.cancelAnimationFrame(raf);
      ov.pause();
      ov.removeEventListener("loadedmetadata", onLoadedMetadata);
      base.removeEventListener("seeked", onSeeked);
      base.removeEventListener("seeking", onSeeked);
      base.removeEventListener("pause", onBasePauseLike);
      base.removeEventListener("waiting", onBasePauseLike);
      base.removeEventListener("stalled", onBasePauseLike);
    };
  }, [segments, videoRef]);

  return (
    <video
      ref={overlayVideoRef}
      className={`pointer-events-none absolute inset-0 h-full w-full object-contain ${className ?? ""}`}
      style={{
        mixBlendMode: "screen",
        visibility: "hidden",
        background: "transparent",
        transformOrigin: "50% 100%",
        ...(style ?? {}),
        ...(segmentStyle ?? {}),
      }}
    />
  );
}

export function ProgressiveOverlay(props: {
  videoRef: RefObject<HTMLVideoElement | null>;
  artifact: OverlayArtifact | null;
  className?: string;
  style?: CSSProperties;
  getSegmentStyle?: (segment: OverlaySegmentArtifact | null) => CSSProperties | undefined;
}) {
  const { videoRef, artifact, className, style, getSegmentStyle } = props;

  const segments = useMemo(() => (artifact ? getRenderableSegments(artifact) : []), [artifact]);

  if (!artifact) return null;

  if (segments.length > 0) {
    if (segments.some((segment) => segment.video)) {
      return (
        <SegmentedVideoOverlay
          videoRef={videoRef}
          segments={segments}
          className={className}
          style={style}
          getSegmentStyle={getSegmentStyle}
        />
      );
    }
    if (segments.some((segment) => segment.frames && segment.frames.length > 0)) {
      return (
        <SegmentedFrameOverlay
          videoRef={videoRef}
          segments={segments}
          className={className}
          style={style}
          getSegmentStyle={getSegmentStyle}
        />
      );
    }
  }

  if (artifact.video) {
    return (
      <PrecomputedVideoOverlay
        videoRef={videoRef}
        overlayBlob={artifact.video}
        mimeType={artifact.videoMime}
        className={className}
        style={style}
      />
    );
  }

  if (artifact.frames?.length) {
    return (
      <PrecomputedFrameOverlay
        videoRef={videoRef}
        frames={artifact.frames}
        fps={artifact.fps}
        className={className}
        style={style}
      />
    );
  }

  return null;
}
