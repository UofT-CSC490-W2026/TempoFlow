import { describe, expect, it } from "vitest";

import { computeDisplayedMediaBox, computeOverlayCardPlacement } from "./OverlayVisualFeedback";

describe("OverlayVisualFeedback", () => {
  it("returns the full media box when there is no contain letterboxing", () => {
    expect(
      computeDisplayedMediaBox({
        stageWidth: 640,
        stageHeight: 360,
        mediaLeft: 0,
        mediaTop: 0,
        mediaWidth: 640,
        mediaHeight: 360,
        intrinsicWidth: 640,
        intrinsicHeight: 360,
        objectFit: "fill",
      }),
    ).toEqual({
      left: 0,
      top: 0,
      width: 1,
      height: 1,
    });
  });

  it("shrinks to the displayed content box for object-contain video", () => {
    const result = computeDisplayedMediaBox({
      stageWidth: 1000,
      stageHeight: 1000,
      mediaLeft: 0,
      mediaTop: 0,
      mediaWidth: 1000,
      mediaHeight: 1000,
      intrinsicWidth: 720,
      intrinsicHeight: 1280,
      objectFit: "contain",
    });

    expect(result.left).toBeCloseTo(0.21875, 5);
    expect(result.top).toBe(0);
    expect(result.width).toBeCloseTo(0.5625, 5);
    expect(result.height).toBe(1);
  });

  it("keeps the card on-screen while leaving the pointer near the true anchor", () => {
    const result = computeOverlayCardPlacement({
      stageWidth: 600,
      stageHeight: 400,
      anchorXPx: 140,
      anchorYPx: 180,
      cardWidth: 280,
      cardHeight: 140,
    });

    expect(result.cardLeftPx).toBe(16);
    expect(result.caretLeftPx).toBe(124);
  });

  it("clamps a below-aligned card inside the displayed media box", () => {
    const result = computeOverlayCardPlacement({
      stageWidth: 700,
      stageHeight: 900,
      anchorXPx: 350,
      anchorYPx: 760,
      cardWidth: 312,
      cardHeight: 220,
      mediaTopPx: 0,
      mediaHeightPx: 820,
      verticalAlign: "below",
      cardGapPx: 14,
    });

    expect(result.cardTopPx).toBeLessThanOrEqual(584);
    expect(result.cardTopPx).toBeGreaterThanOrEqual(16);
  });
});
