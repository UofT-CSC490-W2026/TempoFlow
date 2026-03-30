"use client";

import { useEffect, useRef, useState } from "react";
import type { RgbColor } from "../../lib/bodyPix/overlayMaskStyling";
import { styleOverlayMask } from "../../lib/bodyPix/overlayMaskStyling";

type OverlayMaskLayerProps = {
  frame: string | Blob | null;
  color: RgbColor;
  fillOpacity?: number;
  contourOpacity?: number;
  contourRadius?: number;
  seamOpacity?: number;
  seamRadius?: number;
  glowOpacity?: number;
  glowRadius?: number;
  className?: string;
};

export function OverlayMaskLayer(props: OverlayMaskLayerProps) {
  const {
    frame,
    color,
    fillOpacity,
    contourOpacity,
    contourRadius,
    seamOpacity,
    seamRadius,
    glowOpacity,
    glowRadius,
    className = "",
  } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!frame) {
      setFrameUrl(null);
      return;
    }

    if (typeof frame === "string") {
      setFrameUrl(frame);
      return;
    }

    const url = URL.createObjectURL(frame);
    setFrameUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [frame]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (!frameUrl) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    let cancelled = false;
    const image = new Image();

    image.onload = () => {
      if (cancelled) return;

      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (width <= 0 || height <= 0) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      canvas.width = width;
      canvas.height = height;

      const sourceCanvas = document.createElement("canvas");
      sourceCanvas.width = width;
      sourceCanvas.height = height;
      const sourceCtx = sourceCanvas.getContext("2d");
      if (!sourceCtx) return;

      sourceCtx.clearRect(0, 0, width, height);
      sourceCtx.drawImage(image, 0, 0, width, height);
      const sourceImage = sourceCtx.getImageData(0, 0, width, height);
      const styled = styleOverlayMask(sourceImage, {
        color,
        fillOpacity,
        contourOpacity,
        contourRadius,
        seamOpacity,
        seamRadius,
        glowOpacity,
        glowRadius,
      });
      const output = ctx.createImageData(width, height);
      output.data.set(styled.data);
      ctx.clearRect(0, 0, width, height);
      ctx.putImageData(output, 0, 0);
    };

    image.onerror = () => {
      if (!cancelled) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };

    image.src = frameUrl;
    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [
    color,
    contourOpacity,
    contourRadius,
    fillOpacity,
    frameUrl,
    glowOpacity,
    glowRadius,
    seamOpacity,
    seamRadius,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 h-full w-full object-contain pointer-events-none ${className}`}
    />
  );
}
