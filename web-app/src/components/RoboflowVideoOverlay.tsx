"use client";

import React, { useRef, useEffect } from 'react';

interface RoboflowVideoOverlayProps {
  /**
   * Ordered array of base64 data-URI frames (e.g. "data:image/jpeg;base64,...")
   * returned by Roboflow's onData callback.  May still be growing while the
   * video is playing — we clamp the index to what's available.
   */
  frames: string[];
  /**
   * The <video> element whose currentTime / duration drives which frame to show.
   */
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

/**
 * Renders pre-processed Roboflow SAM 3 frames in sync with a video element.
 *
 * The component runs a requestAnimationFrame loop that reads video.currentTime
 * and picks the proportionally correct frame from the cache, drawing it on a
 * canvas positioned directly over the video.
 *
 * Because the frames are full composited JPEGs (original video + SAM 3 mask
 * rendered by Roboflow), the canvas replaces the visible video content while
 * the underlying <video> still drives timing/playback state.
 */
const RoboflowVideoOverlay: React.FC<RoboflowVideoOverlayProps> = ({
  frames,
  videoRef,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef    = useRef<HTMLImageElement | null>(null);
  const animRef   = useRef<number>(0);
  const lastIdxRef = useRef<number>(-1);

  useEffect(() => {
    if (frames.length === 0) return;

    // Preload a single reusable Image element — avoids allocating one per frame
    if (!imgRef.current) {
      imgRef.current = new Image();
    }

    const loop = () => {
      const video  = videoRef.current;
      const canvas = canvasRef.current;
      const img    = imgRef.current;
      if (!video || !canvas || !img) {
        animRef.current = requestAnimationFrame(loop);
        return;
      }

      // Size canvas to match the video's actual pixel dimensions once available
      if (video.videoWidth > 0 && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
      }

      // Map currentTime → frame index (clamp to what's actually cached so far)
      const total    = frames.length;
      const dur      = video.duration;
      const rawIdx   = dur > 0
        ? Math.min(total - 1, Math.round((video.currentTime / dur) * (total - 1)))
        : 0;
      const idx = Math.max(0, rawIdx);

      if (idx !== lastIdxRef.current) {
        lastIdxRef.current = idx;
        const src = frames[idx];
        if (src) {
          img.onload = () => {
            const ctx = canvas.getContext('2d');
            ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
          };
          img.src = src;
        }
      }

      animRef.current = requestAnimationFrame(loop);
    };

    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [frames, videoRef]);

  if (frames.length === 0) return null;

  return (
    <canvas
      ref={canvasRef}
      className="absolute top-0 left-0 h-full w-full object-cover pointer-events-none"
    />
  );
};

export default RoboflowVideoOverlay;
