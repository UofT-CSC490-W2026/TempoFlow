"use client";

import { useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";

export function PrecomputedVideoOverlay(props: {
  videoRef: RefObject<HTMLVideoElement | null>;
  overlayBlob: Blob;
  mimeType?: string;
}) {
  const { videoRef, overlayBlob } = props;
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
    const syncOnce = async () => {
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

      if (base.paused) {
        if (!ov.paused) ov.pause();
      } else {
        if (ov.paused) {
          await ov.play().catch(() => undefined);
        }
      }
    };

    const sync = async () => {
      if (cancelled) return;
      try {
        await syncOnce();
      } finally {
        requestAnimationFrame(sync);
      }
    };

    const onSeeked = () => {
      if (!cancelled) ov.currentTime = base.currentTime || 0;
    };
    const onLoadedMetadata = () => {
      if (!cancelled) {
        ov.currentTime = base.currentTime || 0;
        if (!base.paused) void ov.play().catch(() => undefined);
      }
    };

    const onPause = () => {
      if (!cancelled) ov.pause();
    };
    const onPlay = () => {
      if (!cancelled) void ov.play().catch(() => undefined);
    };
    base.addEventListener("seeked", onSeeked);
    base.addEventListener("seeking", onSeeked);
    ov.addEventListener("loadedmetadata", onLoadedMetadata);
    base.addEventListener("pause", onPause);
    base.addEventListener("play", onPlay);

    requestAnimationFrame(sync);
    return () => {
      cancelled = true;
      base.removeEventListener("seeked", onSeeked);
      base.removeEventListener("seeking", onSeeked);
      ov.removeEventListener("loadedmetadata", onLoadedMetadata);
      base.removeEventListener("pause", onPause);
      base.removeEventListener("play", onPlay);
    };
  }, [videoRef]);

  return (
    <video
      ref={overlayVideoRef}
      src={overlayUrl}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ mixBlendMode: "screen" }}
    />
  );
}

