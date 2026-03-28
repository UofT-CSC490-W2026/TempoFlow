// src/components/ebs/__mocks__/ebsViewerLogic.ts
import { vi } from "vitest";

export const buildMovesForSegment = vi.fn(() => []);
export const findActiveMoveIndex = vi.fn(() => -1);
export const findActiveSegmentIndex = vi.fn(() => -1);
export const getClosestBeatIndex = vi.fn(() => -1);
export const shouldLoopPracticeSegment = vi.fn(() => false);