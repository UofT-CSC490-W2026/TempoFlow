"use client";

import { useEffect, useMemo, useRef } from "react";
import type { CSSProperties, RefObject } from "react";

export function PrecomputedVideoOverlay(props: {
  videoRef: RefObject<HTMLVideoElement | null>;
  overlayBlob: Blob;
  mimeType?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const { videoRef, overlayBlob, className, style } = props;
  const overlayVideoRef = useRef<HTMLVideoElement | null>(null);

  const overlayUrl = useMemo(() => URL.createObjectURL(overlayBlob), [overlayBlob]);

  useEffect(() => {
    return () => {
      URL.revokeObjectURL(overlayUrl);
    };
  }, [overlayUrl]);

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

    const syncOnce = () => {
      if (cancelled) return;
      const baseT = base.currentTime || 0;
      const ovT = ov.currentTime;

      // Keep playback speed matched.
      if (Math.abs((ov.playbackRate || 1) - (base.playbackRate || 1)) > 0.001) {
        ov.playbackRate = base.playbackRate || 1;
      }

      const diff = Number.isFinite(ovT) ? Math.abs(ovT - baseT) : Infinity;
      // If overlay time is NaN/invalid early, force-sync immediately.
      // Otherwise keep a very tight delta to prevent “couple seconds behind” feelings.
      if (!Number.isFinite(ovT) || diff > 0.01) {
        ov.currentTime = baseT;
      }

      if (!ov.paused) {
        ov.pause();
      }
    };

    const sync = () => {
      if (cancelled) return;
      syncOnce();
    };

    const onVideoFrame = (_now: number, metadata: { mediaTime?: number }) => {
      if (cancelled) return;
      if (!ov.paused) ov.pause();
      const mediaTime = metadata.mediaTime ?? base.currentTime ?? 0;
      if (!Number.isFinite(ov.currentTime) || Math.abs((ov.currentTime || 0) - mediaTime) > 0.008) {
        ov.currentTime = mediaTime;
      }
      rvfcHandle = rvfc ? rvfc.call(base, onVideoFrame) : 0;
    };

    const onRaf = () => {
      if (cancelled) return;
      sync();
      raf = window.requestAnimationFrame(onRaf);
    };

    const onSeeked = () => {
      if (!cancelled) {
        ov.currentTime = base.currentTime || 0;
        ov.pause();
      }
    };
    const onLoadedMetadata = () => {
      if (!cancelled) {
        ov.currentTime = base.currentTime || 0;
        ov.pause();
      }
    };

    const onPause = () => {
      if (!cancelled) ov.pause();
    };
    const onPlay = () => {
      if (!cancelled) sync();
    };
    base.addEventListener("seeked", onSeeked);
    base.addEventListener("seeking", onSeeked);
    ov.addEventListener("loadedmetadata", onLoadedMetadata);
    base.addEventListener("pause", onPause);
    base.addEventListener("play", onPlay);
    base.addEventListener("ratechange", sync);
    base.addEventListener("waiting", onPause);
    base.addEventListener("stalled", onPause);

    if (rvfc) {
      rvfcHandle = rvfc.call(base, onVideoFrame);
    } else {
      raf = window.requestAnimationFrame(onRaf);
    }
    return () => {
      cancelled = true;
      if (cancelRvfc && rvfcHandle) cancelRvfc.call(base, rvfcHandle);
      if (raf) window.cancelAnimationFrame(raf);
      base.removeEventListener("seeked", onSeeked);
      base.removeEventListener("seeking", onSeeked);
      ov.removeEventListener("loadedmetadata", onLoadedMetadata);
      base.removeEventListener("pause", onPause);
      base.removeEventListener("play", onPlay);
      base.removeEventListener("ratechange", sync);
      base.removeEventListener("waiting", onPause);
      base.removeEventListener("stalled", onPause);
    };
  }, [videoRef]);

  return (
    <video
      ref={overlayVideoRef}
      src={overlayUrl}
      className={`pointer-events-none absolute inset-0 h-full w-full object-contain ${className ?? ""}`}
      style={{ mixBlendMode: "screen", background: "transparent", ...(style ?? {}) }}
    />
  );
}
