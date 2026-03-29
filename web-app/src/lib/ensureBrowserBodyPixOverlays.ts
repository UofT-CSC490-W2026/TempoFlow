"use client";

import type { EbsData } from "../components/ebs/types";
import { generateBodyPixOverlayFrames } from "./bodyPixOverlayGenerator";
import { buildOverlayKey, storeSessionOverlay, type OverlayArtifact } from "./overlayStorage";
import {
  buildOverlaySegmentPlans,
  createSegmentedOverlayArtifact,
  getOverlaySegmentByIndex,
  isOverlayArtifactComplete,
  upsertOverlaySegment,
  type OverlaySegmentPlan,
} from "./overlaySegments";

export const BROWSER_BODYPIX_OVERLAY_FPS = 12;
/** Must match keys written by the session viewer (browser TF.js path). */
export const BROWSER_BODYPIX_VARIANT = "bodypix24-browser";

async function runSegmentedBrowserBodyPixPipeline(params: {
  sessionId: string;
  overlaySegmentPlans: OverlaySegmentPlan[];
  OVERLAY_FPS: number;
  variant: string;
  referenceVideoUrl: string;
  userVideoUrl: string;
  getVideoSize: (side: "reference" | "practice") => { width: number; height: number };
  existingReference: OverlayArtifact | null;
  existingPractice: OverlayArtifact | null;
  setReferenceArtifact: (a: OverlayArtifact) => void;
  setPracticeArtifact: (a: OverlayArtifact) => void;
  onStatus: (msg: string) => void;
  /** Fires when ref+user BodyPix for this segment index is ready (cached or freshly built). */
  onSegmentComplete?: (segmentIndex: number) => void;
}): Promise<boolean> {
  const {
    sessionId,
    overlaySegmentPlans,
    OVERLAY_FPS,
    variant,
    referenceVideoUrl,
    userVideoUrl,
    getVideoSize,
    existingReference,
    existingPractice,
    setReferenceArtifact,
    setPracticeArtifact,
    onStatus,
    onSegmentComplete,
  } = params;

  if (!overlaySegmentPlans.length) {
    return false;
  }

  if (
    isOverlayArtifactComplete(existingReference, overlaySegmentPlans.length) &&
    isOverlayArtifactComplete(existingPractice, overlaySegmentPlans.length)
  ) {
    onStatus("BodyPix overlays already ready.");
    for (const plan of overlaySegmentPlans) {
      onSegmentComplete?.(plan.index);
    }
    return true;
  }

  let referenceArtifact = createSegmentedOverlayArtifact({
    existing: existingReference,
    type: "bodypix",
    side: "reference",
    fps: OVERLAY_FPS,
    ...getVideoSize("reference"),
    meta: { generator: "browser" },
  });
  let practiceArtifact = createSegmentedOverlayArtifact({
    existing: existingPractice,
    type: "bodypix",
    side: "practice",
    fps: OVERLAY_FPS,
    ...getVideoSize("practice"),
    meta: { generator: "browser" },
  });

  const referenceKey = buildOverlayKey({
    sessionId,
    type: "bodypix",
    side: "reference",
    fps: OVERLAY_FPS,
    variant,
  });
  const practiceKey = buildOverlayKey({
    sessionId,
    type: "bodypix",
    side: "practice",
    fps: OVERLAY_FPS,
    variant,
  });

  for (let idx = 0; idx < overlaySegmentPlans.length; idx += 1) {
    const plan = overlaySegmentPlans[idx];
    const ordinal = idx + 1;
    const existingReferenceSegment = getOverlaySegmentByIndex(referenceArtifact, plan.index);
    const existingPracticeSegment = getOverlaySegmentByIndex(practiceArtifact, plan.index);

    if (existingReferenceSegment && existingPracticeSegment) {
      onSegmentComplete?.(plan.index);
      continue;
    }

    let referenceProgress = existingReferenceSegment ? 1 : 0;
    let practiceProgress = existingPracticeSegment ? 1 : 0;

    const updateSegmentStatus = () => {
      const avgProgress = (referenceProgress + practiceProgress) / 2;
      const pct = Math.max(0, Math.min(100, Math.round(avgProgress * 100)));
      onStatus(`BodyPix segment ${ordinal}/${overlaySegmentPlans.length} processing… ${pct}%`);
    };

    updateSegmentStatus();

    const [nextReferenceSegment, nextPracticeSegment] = await Promise.all([
      existingReferenceSegment
        ? Promise.resolve(existingReferenceSegment)
        : (async () => {
            const result = await generateBodyPixOverlayFrames({
              videoUrl: referenceVideoUrl,
              fps: OVERLAY_FPS,
              opacity: 0.68,
              startSec: plan.reference.startSec,
              endSec: plan.reference.endSec,
              onProgress: (completed, total) => {
                referenceProgress = total > 0 ? completed / total : 0;
                updateSegmentStatus();
              },
            });
            return {
              index: plan.index,
              startSec: plan.reference.startSec,
              endSec: plan.reference.endSec,
              fps: result.fps,
              width: result.width,
              height: result.height,
              frameCount: result.frames.length,
              createdAt: new Date().toISOString(),
              frames: result.frames,
              meta: { generator: "browser", segmentIndex: plan.index },
            };
          })(),
      existingPracticeSegment
        ? Promise.resolve(existingPracticeSegment)
        : (async () => {
            const result = await generateBodyPixOverlayFrames({
              videoUrl: userVideoUrl,
              fps: OVERLAY_FPS,
              opacity: 0.68,
              startSec: plan.practice.startSec,
              endSec: plan.practice.endSec,
              onProgress: (completed, total) => {
                practiceProgress = total > 0 ? completed / total : 0;
                updateSegmentStatus();
              },
            });
            return {
              index: plan.index,
              startSec: plan.practice.startSec,
              endSec: plan.practice.endSec,
              fps: result.fps,
              width: result.width,
              height: result.height,
              frameCount: result.frames.length,
              createdAt: new Date().toISOString(),
              frames: result.frames,
              meta: { generator: "browser", segmentIndex: plan.index },
            };
          })(),
    ]);

    referenceArtifact = upsertOverlaySegment(referenceArtifact, nextReferenceSegment);
    practiceArtifact = upsertOverlaySegment(practiceArtifact, nextPracticeSegment);

    await Promise.all([
      storeSessionOverlay(referenceKey, referenceArtifact),
      storeSessionOverlay(practiceKey, practiceArtifact),
    ]);

    setReferenceArtifact(referenceArtifact);
    setPracticeArtifact(practiceArtifact);
    onSegmentComplete?.(plan.index);

    const nextPendingIndex = overlaySegmentPlans.findIndex(
      (candidate) =>
        !getOverlaySegmentByIndex(referenceArtifact, candidate.index) ||
        !getOverlaySegmentByIndex(practiceArtifact, candidate.index),
    );

    if (nextPendingIndex >= 0) {
      onStatus(
        `BodyPix segment ${ordinal}/${overlaySegmentPlans.length} ready. ` +
          `Segment ${nextPendingIndex + 1}/${overlaySegmentPlans.length} is processing in the background…`,
      );
    }
  }

  onStatus(
    `BodyPix overlays ready. ${overlaySegmentPlans.length}/${overlaySegmentPlans.length} segments processed.`,
  );
  return true;
}

export async function ensureBrowserBodyPixOverlays(params: {
  sessionId: string;
  referenceVideoUrl: string;
  userVideoUrl: string;
  ebsData: EbsData | null;
  refVideo: { current: HTMLVideoElement | null };
  userVideo: { current: HTMLVideoElement | null };
  existingRef: OverlayArtifact | null;
  existingUser: OverlayArtifact | null;
  setRefArtifact: (a: OverlayArtifact) => void;
  setUserArtifact: (a: OverlayArtifact) => void;
  onStatus: (msg: string | null) => void;
  onSegmentComplete?: (segmentIndex: number) => void;
}): Promise<void> {
  const OVERLAY_FPS = BROWSER_BODYPIX_OVERLAY_FPS;
  const variant = BROWSER_BODYPIX_VARIANT;

  const {
    sessionId,
    referenceVideoUrl,
    userVideoUrl,
    ebsData,
    refVideo,
    userVideo,
    existingRef,
    existingUser,
    setRefArtifact,
    setUserArtifact,
    onStatus,
    onSegmentComplete,
  } = params;

  const getVideoSize = (side: "reference" | "practice") => {
    const video = side === "reference" ? refVideo.current : userVideo.current;
    return {
      width: video?.videoWidth || 640,
      height: video?.videoHeight || 480,
    };
  };

  const overlaySegmentPlans = buildOverlaySegmentPlans(ebsData);

  const usedSegmented = await runSegmentedBrowserBodyPixPipeline({
    sessionId,
    overlaySegmentPlans,
    OVERLAY_FPS,
    variant,
    referenceVideoUrl,
    userVideoUrl,
    getVideoSize,
    existingReference: existingRef,
    existingPractice: existingUser,
    setReferenceArtifact: setRefArtifact,
    setPracticeArtifact: setUserArtifact,
    onStatus: (msg) => onStatus(msg),
    onSegmentComplete,
  });

  if (usedSegmented) {
    return;
  }

  onStatus("BodyPix (reference)…");
  const ref = await generateBodyPixOverlayFrames({
    videoUrl: referenceVideoUrl,
    fps: OVERLAY_FPS,
    opacity: 0.68,
    onProgress: (c, t) => onStatus(`BodyPix (reference) ${c}/${t}`),
  });
  const user = await generateBodyPixOverlayFrames({
    videoUrl: userVideoUrl,
    fps: OVERLAY_FPS,
    opacity: 0.68,
    onProgress: (c, t) => onStatus(`BodyPix (user) ${c}/${t}`),
  });

  const refArtifact: OverlayArtifact = {
    version: 1,
    type: "bodypix",
    side: "reference",
    fps: ref.fps,
    width: ref.width,
    height: ref.height,
    frameCount: ref.frames.length,
    createdAt: new Date().toISOString(),
    frames: ref.frames,
    meta: { generator: "browser" },
  };
  const userArtifact: OverlayArtifact = {
    version: 1,
    type: "bodypix",
    side: "practice",
    fps: user.fps,
    width: user.width,
    height: user.height,
    frameCount: user.frames.length,
    createdAt: new Date().toISOString(),
    frames: user.frames,
    meta: { generator: "browser" },
  };

  await Promise.all([
    storeSessionOverlay(
      buildOverlayKey({
        sessionId,
        type: "bodypix",
        side: "reference",
        fps: OVERLAY_FPS,
        variant,
      }),
      refArtifact,
    ),
    storeSessionOverlay(
      buildOverlayKey({
        sessionId,
        type: "bodypix",
        side: "practice",
        fps: OVERLAY_FPS,
        variant,
      }),
      userArtifact,
    ),
  ]);

  setRefArtifact(refArtifact);
  setUserArtifact(userArtifact);
  onStatus("BodyPix overlays ready.");
  const segs = ebsData?.segments ?? [];
  for (let i = 0; i < segs.length; i += 1) {
    const range = segs[i].beat_idx_range;
    if (range && range[1] > range[0]) {
      onSegmentComplete?.(i);
    }
  }
}
