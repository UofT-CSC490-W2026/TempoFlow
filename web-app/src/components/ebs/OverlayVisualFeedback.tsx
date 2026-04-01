"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type { OverlayVisualCue } from "./overlayFeedbackCue";

type RelativeBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type CardPlacement = {
  cardLeftPx: number;
  caretLeftPx: number;
  cardTopPx: number;
};

export function computeDisplayedMediaBox(params: {
  stageWidth: number;
  stageHeight: number;
  mediaLeft: number;
  mediaTop: number;
  mediaWidth: number;
  mediaHeight: number;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  objectFit?: string;
}): RelativeBox {
  const {
    stageWidth,
    stageHeight,
    mediaLeft,
    mediaTop,
    mediaWidth,
    mediaHeight,
    intrinsicWidth,
    intrinsicHeight,
    objectFit,
  } = params;

  if (stageWidth <= 0 || stageHeight <= 0 || mediaWidth <= 0 || mediaHeight <= 0) {
    return { left: 0, top: 0, width: 1, height: 1 };
  }

  const normalized = {
    left: mediaLeft / stageWidth,
    top: mediaTop / stageHeight,
    width: mediaWidth / stageWidth,
    height: mediaHeight / stageHeight,
  };

  if (
    objectFit !== "contain" ||
    !intrinsicWidth ||
    !intrinsicHeight ||
    intrinsicWidth <= 0 ||
    intrinsicHeight <= 0
  ) {
    return normalized;
  }

  const mediaAspect = mediaWidth / mediaHeight;
  const intrinsicAspect = intrinsicWidth / intrinsicHeight;
  let contentWidth = mediaWidth;
  let contentHeight = mediaHeight;
  let offsetX = 0;
  let offsetY = 0;

  if (mediaAspect > intrinsicAspect) {
    contentHeight = mediaHeight;
    contentWidth = contentHeight * intrinsicAspect;
    offsetX = (mediaWidth - contentWidth) / 2;
  } else if (mediaAspect < intrinsicAspect) {
    contentWidth = mediaWidth;
    contentHeight = contentWidth / intrinsicAspect;
    offsetY = (mediaHeight - contentHeight) / 2;
  }

  return {
    left: (mediaLeft + offsetX) / stageWidth,
    top: (mediaTop + offsetY) / stageHeight,
    width: contentWidth / stageWidth,
    height: contentHeight / stageHeight,
  };
}

export function computeOverlayCardPlacement(params: {
  stageWidth: number;
  stageHeight: number;
  anchorXPx: number;
  anchorYPx: number;
  cardWidth: number;
  cardHeight: number;
  mediaTopPx?: number;
  mediaHeightPx?: number;
  verticalAlign?: "above" | "below";
  cardGapPx?: number;
  edgePadding?: number;
  caretPadding?: number;
}): CardPlacement {
  const {
    stageWidth,
    stageHeight,
    anchorXPx,
    anchorYPx,
    cardWidth,
    cardHeight,
    mediaTopPx = 0,
    mediaHeightPx = stageHeight,
    verticalAlign = "above",
    cardGapPx = 28,
    edgePadding = 16,
    caretPadding = 24,
  } = params;

  if (stageWidth <= 0 || stageHeight <= 0 || cardWidth <= 0 || cardHeight <= 0) {
    return {
      cardLeftPx: 0,
      caretLeftPx: 0,
      cardTopPx: 0,
    };
  }

  const minLeft = edgePadding;
  const maxLeft = Math.max(edgePadding, stageWidth - edgePadding - cardWidth);
  const idealLeft = anchorXPx - cardWidth / 2;
  const cardLeftPx = Math.min(maxLeft, Math.max(minLeft, idealLeft));
  const caretLeftPx = Math.min(
    cardWidth - caretPadding,
    Math.max(caretPadding, anchorXPx - cardLeftPx),
  );
  const minTop = mediaTopPx + edgePadding;
  const maxTop = Math.max(minTop, mediaTopPx + mediaHeightPx - edgePadding - cardHeight);
  const idealTopPx =
    verticalAlign === "above"
      ? anchorYPx - cardHeight - cardGapPx
      : anchorYPx + cardGapPx;
  const cardTopPx = Math.min(maxTop, Math.max(minTop, idealTopPx));

  return {
    cardLeftPx,
    caretLeftPx,
    cardTopPx,
  };
}

export function OverlayVisualFeedback(props: {
  cue: OverlayVisualCue;
  mediaRef?: RefObject<HTMLVideoElement | null>;
  showFocus?: boolean;
  variant?: "visual" | "gemini";
  intrinsicWidth?: number;
  intrinsicHeight?: number;
}) {
  const { cue, mediaRef, showFocus = true, variant = "visual", intrinsicWidth, intrinsicHeight } = props;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [mediaBox, setMediaBox] = useState<RelativeBox>({
    left: 0,
    top: 0,
    width: 1,
    height: 1,
  });
  const [cardPlacement, setCardPlacement] = useState<CardPlacement>({
    cardLeftPx: 0,
    caretLeftPx: 0,
    cardTopPx: 0,
  });

  useEffect(() => {
    const stage = stageRef.current;
    const media = mediaRef?.current ?? null;
    if (!stage || !media) {
      setMediaBox({ left: 0, top: 0, width: 1, height: 1 });
      return;
    }

    const update = () => {
      const stageRect = stage.getBoundingClientRect();
      const mediaRect = media.getBoundingClientRect();
      const objectFit = window.getComputedStyle(media).objectFit;
      setMediaBox(
        computeDisplayedMediaBox({
          stageWidth: stageRect.width,
          stageHeight: stageRect.height,
          mediaLeft: mediaRect.left - stageRect.left,
          mediaTop: mediaRect.top - stageRect.top,
          mediaWidth: mediaRect.width,
          mediaHeight: mediaRect.height,
          intrinsicWidth: media.videoWidth || intrinsicWidth,
          intrinsicHeight: media.videoHeight || intrinsicHeight,
          objectFit,
        }),
      );
    };

    update();
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    resizeObserver?.observe(stage);
    resizeObserver?.observe(media);
    media.addEventListener("loadedmetadata", update);
    window.addEventListener("resize", update);

    return () => {
      resizeObserver?.disconnect();
      media.removeEventListener("loadedmetadata", update);
      window.removeEventListener("resize", update);
    };
  }, [cue.id, intrinsicHeight, intrinsicWidth, mediaRef]);

  const styleVars = {
    ["--overlay-feedback-tone" as string]: cue.color,
  } as CSSProperties;

  const focusLeft = mediaBox.left + cue.xPct * mediaBox.width;
  const focusTop = mediaBox.top + cue.yPct * mediaBox.height;
  const focusWidth = cue.focusSizePct * mediaBox.width;
  const focusRadius = focusWidth / 2;
  const toFocusStyle = (params: { xPct: number; yPct: number; focusSizePct: number }) =>
    ({
      left: `${((mediaBox.left + params.xPct * mediaBox.width) * 100).toFixed(2)}%`,
      top: `${((mediaBox.top + params.yPct * mediaBox.height) * 100).toFixed(2)}%`,
      width: `${(params.focusSizePct * mediaBox.width * 100).toFixed(2)}%`,
      ...styleVars,
    }) as CSSProperties;
  const focusStyle = toFocusStyle(cue);

  const cardStyle = {
    left: `${cardPlacement.cardLeftPx.toFixed(2)}px`,
    top: `${cardPlacement.cardTopPx.toFixed(2)}px`,
    transform: "translateY(0)",
    ["--overlay-feedback-caret-left" as string]: `${cardPlacement.caretLeftPx.toFixed(2)}px`,
    ...styleVars,
  } as CSSProperties;

  useEffect(() => {
    const stage = stageRef.current;
    const card = cardRef.current;
    if (!stage || !card) {
      return;
    }

    const update = () => {
      const stageRect = stage.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const anchorX = focusLeft * stageRect.width;
      const anchorY =
        (cue.verticalAlign === "above" ? focusTop - focusRadius : focusTop + focusRadius) *
        stageRect.height;
      const nextPlacement = computeOverlayCardPlacement({
        stageWidth: stageRect.width,
        stageHeight: stageRect.height,
        anchorXPx: anchorX,
        anchorYPx: anchorY,
        cardWidth: cardRect.width,
        cardHeight: cardRect.height,
        mediaTopPx: mediaBox.top * stageRect.height,
        mediaHeightPx: mediaBox.height * stageRect.height,
        verticalAlign: cue.verticalAlign,
        cardGapPx: variant === "gemini" ? 14 : 28,
      });
      setCardPlacement((current) =>
        current.cardLeftPx === nextPlacement.cardLeftPx &&
        current.caretLeftPx === nextPlacement.caretLeftPx &&
        current.cardTopPx === nextPlacement.cardTopPx
          ? current
          : nextPlacement,
      );
    };

    update();
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    resizeObserver?.observe(stage);
    resizeObserver?.observe(card);
    window.addEventListener("resize", update);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [cue.horizontalAlign, cue.id, cue.verticalAlign, focusLeft, focusRadius, focusTop, mediaBox.height, mediaBox.top, variant]);

  return (
    <div
      ref={stageRef}
      className={[
        "overlay-feedback-stage",
        variant === "gemini" ? "overlay-feedback-stage-gemini" : "",
      ].join(" ")}
      data-testid="overlay-feedback-stage"
    >
      {showFocus ? (
        <div className="overlay-feedback-focus" style={focusStyle}>
          <div className="overlay-feedback-focus-core" />
        </div>
      ) : null}
      {showFocus
        ? cue.hotspots?.map((hotspot) => (
            <div
              key={hotspot.id}
              className="overlay-feedback-focus overlay-feedback-focus-secondary"
              style={toFocusStyle(hotspot)}
            >
              <div className="overlay-feedback-focus-core" />
            </div>
          ))
        : null}
      <div
        ref={cardRef}
        className={[
          "overlay-feedback-card",
          `overlay-feedback-card-${cue.verticalAlign}`,
          variant === "gemini" ? "overlay-feedback-card-gemini" : "",
        ].join(" ")}
        style={cardStyle}
        data-testid="overlay-feedback-card"
      >
        <div className="overlay-feedback-card-row">
          <span
            className={[
              "overlay-feedback-chip",
              variant === "gemini" ? "overlay-feedback-chip-gemini" : "",
            ].join(" ")}
          >
            {cue.title}
          </span>
          <span className="overlay-feedback-severity">{cue.severityLabel}</span>
        </div>
        <div className="overlay-feedback-copy">{cue.message}</div>
      </div>
    </div>
  );
}
