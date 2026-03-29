"use client";

import type { EbsData } from "../components/ebs/types";
import { getPublicEbsProcessorUrl } from "./ebsProcessorUrl";
import { getSessionVideo } from "./videoStorage";
import { buildOverlayKey, storeSessionOverlay, type OverlayArtifact } from "./overlayStorage";
import {
  buildOverlaySegmentPlans,
  createSegmentedOverlayArtifact,
  getOverlaySegmentByIndex,
  isOverlayArtifactComplete,
  upsertOverlaySegment,
  type OverlaySegmentPlan,
} from "./overlaySegments";

export const BROWSER_YOLO_OVERLAY_FPS = 12;
export const BROWSER_YOLO_VARIANT = "yolo26n-python-hybrid-v4";

type VideoSide = "reference" | "practice";
type PoseLayer = "arms" | "legs";

type VideoResult = {
  blob: Blob;
  mime: string;
};

type PoseResult = {
  arms: VideoResult;
  legs: VideoResult;
};

type SegmentedYoloArtifacts = {
  referenceSeg: OverlayArtifact;
  practiceSeg: OverlayArtifact;
  referenceArms: OverlayArtifact;
  referenceLegs: OverlayArtifact;
  practiceArms: OverlayArtifact;
  practiceLegs: OverlayArtifact;
};

export type YoloOverlayChunkPlan = {
  index: number;
  segmentIndex: number;
  moveIndex: number | null;
  sharedStartSec: number;
  sharedEndSec: number;
  reference: {
    startSec: number;
    endSec: number;
  };
  practice: {
    startSec: number;
    endSec: number;
  };
};

const YOLO_SEG_COLORS: Record<VideoSide, string> = {
  reference: "#38bdf8",
  practice: "#fb923c",
};

const YOLO_POSE_COLORS: Record<VideoSide, { arms: string; legs: string }> = {
  reference: { arms: "#7dd3fc", legs: "#60a5fa" },
  practice: { arms: "#fdba74", legs: "#f97316" },
};

function getOverlayBaseUrl() {
  return getPublicEbsProcessorUrl().replace(/\/api\/process\/?$/, "");
}

export function buildYoloOverlayChunkPlans(ebsData: EbsData | null): YoloOverlayChunkPlan[] {
  const segmentPlans = buildOverlaySegmentPlans(ebsData);
  const beats = ebsData?.beats_shared_sec ?? [];
  const segments = ebsData?.segments ?? [];
  let nextIndex = 0;

  return segmentPlans.flatMap((plan) => {
    const segment = segments[plan.index];
    const beatRange = segment?.beat_idx_range;
    if (beatRange && beatRange[1] > beatRange[0]) {
      const chunkPlans: YoloOverlayChunkPlan[] = [];
      for (let beatIdx = beatRange[0]; beatIdx < beatRange[1]; beatIdx += 1) {
        const sharedStartSec = beats[beatIdx];
        const sharedEndSec = beats[beatIdx + 1];
        if (!Number.isFinite(sharedStartSec) || !Number.isFinite(sharedEndSec) || sharedEndSec <= sharedStartSec) {
          continue;
        }
        const refOffset = sharedStartSec - plan.sharedStartSec;
        const practiceOffset = sharedStartSec - plan.sharedStartSec;
        const duration = sharedEndSec - sharedStartSec;
        chunkPlans.push({
          index: nextIndex++,
          segmentIndex: plan.index,
          moveIndex: beatIdx - beatRange[0],
          sharedStartSec,
          sharedEndSec,
          reference: {
            startSec: plan.reference.startSec + refOffset,
            endSec: plan.reference.startSec + refOffset + duration,
          },
          practice: {
            startSec: plan.practice.startSec + practiceOffset,
            endSec: plan.practice.startSec + practiceOffset + duration,
          },
        });
      }
      if (chunkPlans.length) return chunkPlans;
    }

    return [
      {
        index: nextIndex++,
        segmentIndex: plan.index,
        moveIndex: null,
        sharedStartSec: plan.sharedStartSec,
        sharedEndSec: plan.sharedEndSec,
        reference: plan.reference,
        practice: plan.practice,
      } satisfies YoloOverlayChunkPlan,
    ];
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getSideVariantKey(params: {
  sessionId: string;
  side: VideoSide;
  type: "yolo" | "yolo-pose-arms" | "yolo-pose-legs";
}) {
  return buildOverlayKey({
    sessionId: params.sessionId,
    type: params.type,
    side: params.side,
    fps: BROWSER_YOLO_OVERLAY_FPS,
    variant: BROWSER_YOLO_VARIANT,
  });
}

async function startPythonYoloJob(form: FormData) {
  const res = await fetch(`${getOverlayBaseUrl()}/api/overlay/yolo/start`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`YOLO overlay start error (${res.status}): ${txt || res.statusText}`);
  }
  const json = (await res.json()) as { job_id?: string };
  if (!json.job_id) {
    throw new Error("Missing job_id from YOLO overlay start");
  }
  return json.job_id;
}

async function waitForPythonYoloJob(jobId: string, reportProgress: (progress: number) => void) {
  while (true) {
    const stRes = await fetch(
      `${getOverlayBaseUrl()}/api/overlay/yolo/status?job_id=${encodeURIComponent(jobId)}`,
    );
    if (!stRes.ok) {
      const txt = await stRes.text().catch(() => "");
      throw new Error(`YOLO overlay status error (${stRes.status}): ${txt || stRes.statusText}`);
    }

    const st = (await stRes.json()) as {
      status: string;
      progress?: number;
      error?: string;
    };
    reportProgress(typeof st.progress === "number" ? st.progress : 0);

    if (st.status === "done") {
      const outRes = await fetch(
        `${getOverlayBaseUrl()}/api/overlay/yolo/result?job_id=${encodeURIComponent(jobId)}`,
      );
      if (!outRes.ok) {
        const txt = await outRes.text().catch(() => "");
        throw new Error(`YOLO overlay result error (${outRes.status}): ${txt || outRes.statusText}`);
      }
      const blob = await outRes.blob();
      return {
        blob,
        mime: outRes.headers.get("content-type") || "video/webm",
      } satisfies VideoResult;
    }

    if (st.status === "error") {
      throw new Error(st.error || "YOLO overlay job failed");
    }

    await sleep(400);
  }
}

async function startPythonYoloPoseJob(form: FormData) {
  const res = await fetch(`${getOverlayBaseUrl()}/api/overlay/yolo-pose/start`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`YOLO pose start error (${res.status}): ${txt || res.statusText}`);
  }
  const json = (await res.json()) as { job_id?: string };
  if (!json.job_id) {
    throw new Error("Missing job_id from YOLO pose start");
  }
  return json.job_id;
}

async function waitForPythonYoloPoseJob(jobId: string, reportProgress: (progress: number) => void) {
  while (true) {
    const stRes = await fetch(
      `${getOverlayBaseUrl()}/api/overlay/yolo-pose/status?job_id=${encodeURIComponent(jobId)}`,
    );
    if (!stRes.ok) {
      const txt = await stRes.text().catch(() => "");
      throw new Error(`YOLO pose status error (${stRes.status}): ${txt || stRes.statusText}`);
    }

    const st = (await stRes.json()) as {
      status: string;
      progress?: number;
      error?: string;
    };
    reportProgress(typeof st.progress === "number" ? st.progress : 0);

    if (st.status === "done") {
      const loadLayer = async (layer: PoseLayer) => {
        const outRes = await fetch(
          `${getOverlayBaseUrl()}/api/overlay/yolo-pose/result?job_id=${encodeURIComponent(jobId)}&layer=${layer}`,
        );
        if (!outRes.ok) {
          const txt = await outRes.text().catch(() => "");
          throw new Error(`YOLO pose result error (${outRes.status}): ${txt || outRes.statusText}`);
        }
        return {
          blob: await outRes.blob(),
          mime: outRes.headers.get("content-type") || "video/webm",
        } satisfies VideoResult;
      };

      const [arms, legs] = await Promise.all([loadLayer("arms"), loadLayer("legs")]);
      return { arms, legs } satisfies PoseResult;
    }

    if (st.status === "error") {
      throw new Error(st.error || "YOLO pose job failed");
    }

    await sleep(400);
  }
}

function buildSegmentVideoResult(params: {
  plan: YoloOverlayChunkPlan["reference"] | YoloOverlayChunkPlan["practice"];
  index: number;
  segmentIndex: number;
  moveIndex: number | null;
  sharedStartSec: number;
  sharedEndSec: number;
  side: VideoSide;
  size: { width: number; height: number };
  video: VideoResult;
  meta?: Record<string, unknown>;
}) {
  const { plan, index, segmentIndex, moveIndex, sharedStartSec, sharedEndSec, side, size, video, meta } = params;
  return {
    index,
    startSec: plan.startSec,
    endSec: plan.endSec,
    fps: BROWSER_YOLO_OVERLAY_FPS,
    width: size.width,
    height: size.height,
    frameCount: Math.max(1, Math.ceil((plan.endSec - plan.startSec) * BROWSER_YOLO_OVERLAY_FPS)),
    createdAt: new Date().toISOString(),
    video: video.blob,
    videoMime: video.mime,
    meta: {
      generator: "python",
      side,
      segmentIndex,
      moveIndex,
      sharedStartSec,
      sharedEndSec,
      ...(meta ?? {}),
    },
  };
}

function createHybridArtifacts(params: {
  existingRef: OverlayArtifact | null;
  existingUser: OverlayArtifact | null;
  existingRefArms: OverlayArtifact | null;
  existingRefLegs: OverlayArtifact | null;
  existingUserArms: OverlayArtifact | null;
  existingUserLegs: OverlayArtifact | null;
  getVideoSize: (side: VideoSide) => { width: number; height: number };
}) {
  const { existingRef, existingUser, existingRefArms, existingRefLegs, existingUserArms, existingUserLegs, getVideoSize } =
    params;

  return {
    referenceSeg: createSegmentedOverlayArtifact({
      existing: existingRef,
      type: "yolo",
      side: "reference",
      fps: BROWSER_YOLO_OVERLAY_FPS,
      ...getVideoSize("reference"),
      meta: { generator: "python", mode: "hybrid", layer: "seg" },
    }),
    practiceSeg: createSegmentedOverlayArtifact({
      existing: existingUser,
      type: "yolo",
      side: "practice",
      fps: BROWSER_YOLO_OVERLAY_FPS,
      ...getVideoSize("practice"),
      meta: { generator: "python", mode: "hybrid", layer: "seg" },
    }),
    referenceArms: createSegmentedOverlayArtifact({
      existing: existingRefArms,
      type: "yolo-pose-arms",
      side: "reference",
      fps: BROWSER_YOLO_OVERLAY_FPS,
      ...getVideoSize("reference"),
      meta: { generator: "python", mode: "hybrid", layer: "arms" },
    }),
    referenceLegs: createSegmentedOverlayArtifact({
      existing: existingRefLegs,
      type: "yolo-pose-legs",
      side: "reference",
      fps: BROWSER_YOLO_OVERLAY_FPS,
      ...getVideoSize("reference"),
      meta: { generator: "python", mode: "hybrid", layer: "legs" },
    }),
    practiceArms: createSegmentedOverlayArtifact({
      existing: existingUserArms,
      type: "yolo-pose-arms",
      side: "practice",
      fps: BROWSER_YOLO_OVERLAY_FPS,
      ...getVideoSize("practice"),
      meta: { generator: "python", mode: "hybrid", layer: "arms" },
    }),
    practiceLegs: createSegmentedOverlayArtifact({
      existing: existingUserLegs,
      type: "yolo-pose-legs",
      side: "practice",
      fps: BROWSER_YOLO_OVERLAY_FPS,
      ...getVideoSize("practice"),
      meta: { generator: "python", mode: "hybrid", layer: "legs" },
    }),
  } satisfies SegmentedYoloArtifacts;
}

async function persistHybridArtifacts(params: { sessionId: string; artifacts: SegmentedYoloArtifacts }) {
  const { sessionId, artifacts } = params;
  await Promise.all([
    storeSessionOverlay(
      getSideVariantKey({ sessionId, type: "yolo", side: "reference" }),
      artifacts.referenceSeg,
    ),
    storeSessionOverlay(
      getSideVariantKey({ sessionId, type: "yolo", side: "practice" }),
      artifacts.practiceSeg,
    ),
    storeSessionOverlay(
      getSideVariantKey({ sessionId, type: "yolo-pose-arms", side: "reference" }),
      artifacts.referenceArms,
    ),
    storeSessionOverlay(
      getSideVariantKey({ sessionId, type: "yolo-pose-legs", side: "reference" }),
      artifacts.referenceLegs,
    ),
    storeSessionOverlay(
      getSideVariantKey({ sessionId, type: "yolo-pose-arms", side: "practice" }),
      artifacts.practiceArms,
    ),
    storeSessionOverlay(
      getSideVariantKey({ sessionId, type: "yolo-pose-legs", side: "practice" }),
      artifacts.practiceLegs,
    ),
  ]);
}

function syncHybridArtifacts(params: {
  artifacts: SegmentedYoloArtifacts;
  setRefArtifact: (artifact: OverlayArtifact) => void;
  setUserArtifact: (artifact: OverlayArtifact) => void;
  setRefArmsArtifact?: (artifact: OverlayArtifact) => void;
  setRefLegsArtifact?: (artifact: OverlayArtifact) => void;
  setUserArmsArtifact?: (artifact: OverlayArtifact) => void;
  setUserLegsArtifact?: (artifact: OverlayArtifact) => void;
}) {
  const {
    artifacts,
    setRefArtifact,
    setUserArtifact,
    setRefArmsArtifact,
    setRefLegsArtifact,
    setUserArmsArtifact,
    setUserLegsArtifact,
  } = params;
  setRefArtifact(artifacts.referenceSeg);
  setUserArtifact(artifacts.practiceSeg);
  setRefArmsArtifact?.(artifacts.referenceArms);
  setRefLegsArtifact?.(artifacts.referenceLegs);
  setUserArmsArtifact?.(artifacts.practiceArms);
  setUserLegsArtifact?.(artifacts.practiceLegs);
}

async function runSegmentedBrowserYoloPipeline(params: {
  sessionId: string;
  chunkPlans: YoloOverlayChunkPlan[];
  getVideoSize: (side: VideoSide) => { width: number; height: number };
  existingReference: OverlayArtifact | null;
  existingPractice: OverlayArtifact | null;
  existingReferenceArms?: OverlayArtifact | null;
  existingReferenceLegs?: OverlayArtifact | null;
  existingPracticeArms?: OverlayArtifact | null;
  existingPracticeLegs?: OverlayArtifact | null;
  setReferenceArtifact: (artifact: OverlayArtifact) => void;
  setPracticeArtifact: (artifact: OverlayArtifact) => void;
  setReferenceArmsArtifact?: (artifact: OverlayArtifact) => void;
  setReferenceLegsArtifact?: (artifact: OverlayArtifact) => void;
  setPracticeArmsArtifact?: (artifact: OverlayArtifact) => void;
  setPracticeLegsArtifact?: (artifact: OverlayArtifact) => void;
  onStatus: (msg: string) => void;
  onSegmentProgress?: (segmentIndex: number, progress: number) => void;
}) {
  const {
    sessionId,
    chunkPlans,
    getVideoSize,
    existingReference,
    existingPractice,
    existingReferenceArms = null,
    existingReferenceLegs = null,
    existingPracticeArms = null,
    existingPracticeLegs = null,
    setReferenceArtifact,
    setPracticeArtifact,
    setReferenceArmsArtifact,
    setReferenceLegsArtifact,
    setPracticeArmsArtifact,
    setPracticeLegsArtifact,
    onStatus,
    onSegmentProgress,
  } = params;

  if (!chunkPlans.length) {
    return false;
  }

  const total = chunkPlans.length;
  if (
    isOverlayArtifactComplete(existingReference, total) &&
    isOverlayArtifactComplete(existingPractice, total) &&
    isOverlayArtifactComplete(existingReferenceArms, total) &&
    isOverlayArtifactComplete(existingReferenceLegs, total) &&
    isOverlayArtifactComplete(existingPracticeArms, total) &&
    isOverlayArtifactComplete(existingPracticeLegs, total)
  ) {
    onStatus("YOLO hybrid overlays already ready.");
    for (const plan of chunkPlans) {
      onSegmentProgress?.(plan.segmentIndex, 1);
    }
    return true;
  }

  let artifacts = createHybridArtifacts({
    existingRef: existingReference,
    existingUser: existingPractice,
    existingRefArms: existingReferenceArms,
    existingRefLegs: existingReferenceLegs,
    existingUserArms: existingPracticeArms,
    existingUserLegs: existingPracticeLegs,
    getVideoSize,
  });

  const videoCache = new Map<VideoSide, File | null>();
  const getVideoFile = async (side: VideoSide) => {
    if (!videoCache.has(side)) {
      videoCache.set(side, await getSessionVideo(sessionId, side));
    }
    const file = videoCache.get(side);
    if (!file) {
      throw new Error(`Missing ${side} video for this session`);
    }
    return file;
  };

  const chunkCountsBySegment = new Map<number, number>();
  for (const chunk of chunkPlans) {
    chunkCountsBySegment.set(chunk.segmentIndex, (chunkCountsBySegment.get(chunk.segmentIndex) ?? 0) + 1);
  }

  for (let idx = 0; idx < chunkPlans.length; idx += 1) {
    const plan = chunkPlans[idx];
    const ordinal = idx + 1;
    const refSeg = getOverlaySegmentByIndex(artifacts.referenceSeg, plan.index);
    const refArms = getOverlaySegmentByIndex(artifacts.referenceArms, plan.index);
    const refLegs = getOverlaySegmentByIndex(artifacts.referenceLegs, plan.index);
    const practiceSeg = getOverlaySegmentByIndex(artifacts.practiceSeg, plan.index);
    const practiceArms = getOverlaySegmentByIndex(artifacts.practiceArms, plan.index);
    const practiceLegs = getOverlaySegmentByIndex(artifacts.practiceLegs, plan.index);

    if (refSeg && refArms && refLegs && practiceSeg && practiceArms && practiceLegs) {
      continue;
    }

    let refSegProgress = refSeg ? 1 : 0;
    let refPoseProgress = refArms && refLegs ? 1 : 0;
    let practiceSegProgress = practiceSeg ? 1 : 0;
    let practicePoseProgress = practiceArms && practiceLegs ? 1 : 0;

    const updateStatus = () => {
      const avg = (refSegProgress + refPoseProgress + practiceSegProgress + practicePoseProgress) / 4;
      const pct = Math.max(0, Math.min(100, Math.round(avg * 100)));
      const readyChunkCount = (artifacts.referenceSeg.segments ?? []).filter(
        (segment) => Number(segment.meta?.segmentIndex) === plan.segmentIndex,
      ).length;
      const segmentChunkCount = chunkCountsBySegment.get(plan.segmentIndex) ?? 1;
      const segmentProgress = Math.max(0, Math.min(1, (readyChunkCount + avg) / segmentChunkCount));
      onSegmentProgress?.(plan.segmentIndex, segmentProgress);
      onStatus(
        `YOLO hybrid chunk ${ordinal}/${total} processing… ${pct}% ` +
          `(segment ${plan.segmentIndex + 1}${plan.moveIndex != null ? `, move ${plan.moveIndex + 1}` : ""})`,
      );
    };

    updateStatus();

    const processSide = async (side: VideoSide) => {
      const clipRange = side === "reference" ? plan.reference : plan.practice;
      const size = getVideoSize(side);
      const file = await getVideoFile(side);
      const segExists = side === "reference"
        ? Boolean(refSeg)
        : Boolean(practiceSeg);
      const poseExists = side === "reference"
        ? Boolean(refArms && refLegs)
        : Boolean(practiceArms && practiceLegs);

      let segResult: VideoResult | null = null;
      let poseResult: PoseResult | null = null;

      if (!segExists) {
        const segForm = new FormData();
        segForm.append("video", file, file.name);
        segForm.append("color", YOLO_SEG_COLORS[side]);
        segForm.append("fps", String(BROWSER_YOLO_OVERLAY_FPS));
        segForm.append("session_id", sessionId);
        segForm.append("side", side);
        segForm.append("start_sec", String(clipRange.startSec));
        segForm.append("end_sec", String(clipRange.endSec));
        const segJobId = await startPythonYoloJob(segForm);
        segResult = await waitForPythonYoloJob(segJobId, (progress) => {
          if (side === "reference") refSegProgress = progress;
          else practiceSegProgress = progress;
          updateStatus();
        });
      }

      if (!poseExists) {
        const poseForm = new FormData();
        poseForm.append("video", file, file.name);
        poseForm.append("arms_color", YOLO_POSE_COLORS[side].arms);
        poseForm.append("legs_color", YOLO_POSE_COLORS[side].legs);
        poseForm.append("fps", String(BROWSER_YOLO_OVERLAY_FPS));
        poseForm.append("session_id", sessionId);
        poseForm.append("side", side);
        poseForm.append("start_sec", String(clipRange.startSec));
        poseForm.append("end_sec", String(clipRange.endSec));
        const poseJobId = await startPythonYoloPoseJob(poseForm);
        poseResult = await waitForPythonYoloPoseJob(poseJobId, (progress) => {
          if (side === "reference") refPoseProgress = progress;
          else practicePoseProgress = progress;
          updateStatus();
        });
      }

      if (side === "reference") {
        if (segResult) {
          artifacts = {
            ...artifacts,
            referenceSeg: upsertOverlaySegment(
              artifacts.referenceSeg,
              buildSegmentVideoResult({
                plan: clipRange,
                index: plan.index,
                segmentIndex: plan.segmentIndex,
                moveIndex: plan.moveIndex,
                sharedStartSec: plan.sharedStartSec,
                sharedEndSec: plan.sharedEndSec,
                side,
                size,
                video: segResult,
                meta: { layer: "seg" },
              }),
            ),
          };
        }
        if (poseResult) {
          artifacts = {
            ...artifacts,
            referenceArms: upsertOverlaySegment(
              artifacts.referenceArms,
              buildSegmentVideoResult({
                plan: clipRange,
                index: plan.index,
                segmentIndex: plan.segmentIndex,
                moveIndex: plan.moveIndex,
                sharedStartSec: plan.sharedStartSec,
                sharedEndSec: plan.sharedEndSec,
                side,
                size,
                video: poseResult.arms,
                meta: { layer: "arms" },
              }),
            ),
            referenceLegs: upsertOverlaySegment(
              artifacts.referenceLegs,
              buildSegmentVideoResult({
                plan: clipRange,
                index: plan.index,
                segmentIndex: plan.segmentIndex,
                moveIndex: plan.moveIndex,
                sharedStartSec: plan.sharedStartSec,
                sharedEndSec: plan.sharedEndSec,
                side,
                size,
                video: poseResult.legs,
                meta: { layer: "legs" },
              }),
            ),
          };
        }
      } else {
        if (segResult) {
          artifacts = {
            ...artifacts,
            practiceSeg: upsertOverlaySegment(
              artifacts.practiceSeg,
              buildSegmentVideoResult({
                plan: clipRange,
                index: plan.index,
                segmentIndex: plan.segmentIndex,
                moveIndex: plan.moveIndex,
                sharedStartSec: plan.sharedStartSec,
                sharedEndSec: plan.sharedEndSec,
                side,
                size,
                video: segResult,
                meta: { layer: "seg" },
              }),
            ),
          };
        }
        if (poseResult) {
          artifacts = {
            ...artifacts,
            practiceArms: upsertOverlaySegment(
              artifacts.practiceArms,
              buildSegmentVideoResult({
                plan: clipRange,
                index: plan.index,
                segmentIndex: plan.segmentIndex,
                moveIndex: plan.moveIndex,
                sharedStartSec: plan.sharedStartSec,
                sharedEndSec: plan.sharedEndSec,
                side,
                size,
                video: poseResult.arms,
                meta: { layer: "arms" },
              }),
            ),
            practiceLegs: upsertOverlaySegment(
              artifacts.practiceLegs,
              buildSegmentVideoResult({
                plan: clipRange,
                index: plan.index,
                segmentIndex: plan.segmentIndex,
                moveIndex: plan.moveIndex,
                sharedStartSec: plan.sharedStartSec,
                sharedEndSec: plan.sharedEndSec,
                side,
                size,
                video: poseResult.legs,
                meta: { layer: "legs" },
              }),
            ),
          };
        }
      }
    };

    await processSide("reference");
    await processSide("practice");

    await persistHybridArtifacts({ sessionId, artifacts });
    syncHybridArtifacts({
      artifacts,
      setRefArtifact: setReferenceArtifact,
      setUserArtifact: setPracticeArtifact,
      setRefArmsArtifact: setReferenceArmsArtifact,
      setRefLegsArtifact: setReferenceLegsArtifact,
      setUserArmsArtifact: setPracticeArmsArtifact,
      setUserLegsArtifact: setPracticeLegsArtifact,
    });
    const readyChunkCount = (artifacts.referenceSeg.segments ?? []).filter(
      (segment) => Number(segment.meta?.segmentIndex) === plan.segmentIndex,
    ).length;
    const segmentChunkCount = chunkCountsBySegment.get(plan.segmentIndex) ?? 1;
    onSegmentProgress?.(plan.segmentIndex, Math.max(0, Math.min(1, readyChunkCount / segmentChunkCount)));

    const nextPendingIndex = chunkPlans.findIndex((candidate) => {
      const index = candidate.index;
      return !(
        getOverlaySegmentByIndex(artifacts.referenceSeg, index) &&
        getOverlaySegmentByIndex(artifacts.referenceArms, index) &&
        getOverlaySegmentByIndex(artifacts.referenceLegs, index) &&
        getOverlaySegmentByIndex(artifacts.practiceSeg, index) &&
        getOverlaySegmentByIndex(artifacts.practiceArms, index) &&
        getOverlaySegmentByIndex(artifacts.practiceLegs, index)
      );
    });

    if (nextPendingIndex >= 0) {
      onStatus(
        `YOLO hybrid ${plan.moveIndex != null ? `move ${plan.moveIndex + 1}` : "chunk"} ready for segment ${plan.segmentIndex + 1}. ` +
          `${chunkPlans[nextPendingIndex] ? `Chunk ${nextPendingIndex + 1}/${total} is processing in the background…` : ""}`,
      );
    }
  }

  onStatus(`YOLO hybrid overlays ready. ${total}/${total} chunks processed.`);
  return true;
}

function buildFullVideoArtifact(params: {
  type: "yolo" | "yolo-pose-arms" | "yolo-pose-legs";
  side: VideoSide;
  size: { width: number; height: number };
  video: VideoResult;
  meta?: Record<string, unknown>;
}) {
  const { type, side, size, video, meta } = params;
  return {
    version: 1 as const,
    type,
    side,
    fps: BROWSER_YOLO_OVERLAY_FPS,
    width: size.width,
    height: size.height,
    frameCount: 0,
    createdAt: new Date().toISOString(),
    video: video.blob,
    videoMime: video.mime,
    meta: { generator: "python", mode: "hybrid", ...(meta ?? {}) },
  } satisfies OverlayArtifact;
}

export async function ensureBrowserYoloOverlays(params: {
  sessionId: string;
  referenceVideoUrl: string;
  userVideoUrl: string;
  ebsData: EbsData | null;
  refVideo: { current: HTMLVideoElement | null };
  userVideo: { current: HTMLVideoElement | null };
  existingRef: OverlayArtifact | null;
  existingUser: OverlayArtifact | null;
  existingRefArms?: OverlayArtifact | null;
  existingRefLegs?: OverlayArtifact | null;
  existingUserArms?: OverlayArtifact | null;
  existingUserLegs?: OverlayArtifact | null;
  setRefArtifact: (artifact: OverlayArtifact) => void;
  setUserArtifact: (artifact: OverlayArtifact) => void;
  setRefArmsArtifact?: (artifact: OverlayArtifact) => void;
  setRefLegsArtifact?: (artifact: OverlayArtifact) => void;
  setUserArmsArtifact?: (artifact: OverlayArtifact) => void;
  setUserLegsArtifact?: (artifact: OverlayArtifact) => void;
  onStatus: (msg: string | null) => void;
  onSegmentProgress?: (segmentIndex: number, progress: number) => void;
}) {
  const {
    sessionId,
    ebsData,
    refVideo,
    userVideo,
    existingRef,
    existingUser,
    existingRefArms = null,
    existingRefLegs = null,
    existingUserArms = null,
    existingUserLegs = null,
    setRefArtifact,
    setUserArtifact,
    setRefArmsArtifact,
    setRefLegsArtifact,
    setUserArmsArtifact,
    setUserLegsArtifact,
    onStatus,
    onSegmentProgress,
  } = params;

  const getVideoSize = (side: VideoSide) => {
    const video = side === "reference" ? refVideo.current : userVideo.current;
    return {
      width: video?.videoWidth || 640,
      height: video?.videoHeight || 480,
    };
  };

  const chunkPlans = buildYoloOverlayChunkPlans(ebsData);
  const usedSegmented = await runSegmentedBrowserYoloPipeline({
    sessionId,
    chunkPlans,
    getVideoSize,
    existingReference: existingRef,
    existingPractice: existingUser,
    existingReferenceArms: existingRefArms,
    existingReferenceLegs: existingRefLegs,
    existingPracticeArms: existingUserArms,
    existingPracticeLegs: existingUserLegs,
    setReferenceArtifact: setRefArtifact,
    setPracticeArtifact: setUserArtifact,
    setReferenceArmsArtifact: setRefArmsArtifact,
    setReferenceLegsArtifact: setRefLegsArtifact,
    setPracticeArmsArtifact: setUserArmsArtifact,
    setPracticeLegsArtifact: setUserLegsArtifact,
    onStatus: (msg) => onStatus(msg),
    onSegmentProgress,
  });

  if (usedSegmented) {
    return;
  }

  const [referenceFile, practiceFile] = await Promise.all([
    getSessionVideo(sessionId, "reference"),
    getSessionVideo(sessionId, "practice"),
  ]);
  if (!referenceFile || !practiceFile) {
    throw new Error("Missing session videos for YOLO overlay generation.");
  }

  onStatus("YOLO hybrid (reference segmentation)…");
  const referenceSegForm = new FormData();
  referenceSegForm.append("video", referenceFile, referenceFile.name);
  referenceSegForm.append("color", YOLO_SEG_COLORS.reference);
  referenceSegForm.append("fps", String(BROWSER_YOLO_OVERLAY_FPS));
  referenceSegForm.append("session_id", sessionId);
  referenceSegForm.append("side", "reference");
  const referenceSegJobId = await startPythonYoloJob(referenceSegForm);
  const referenceSeg = await waitForPythonYoloJob(referenceSegJobId, (progress) =>
    onStatus(`YOLO hybrid (reference segmentation) ${Math.round(progress * 100)}%`),
  );

  onStatus("YOLO hybrid (reference pose)…");
  const referencePoseForm = new FormData();
  referencePoseForm.append("video", referenceFile, referenceFile.name);
  referencePoseForm.append("arms_color", YOLO_POSE_COLORS.reference.arms);
  referencePoseForm.append("legs_color", YOLO_POSE_COLORS.reference.legs);
  referencePoseForm.append("fps", String(BROWSER_YOLO_OVERLAY_FPS));
  referencePoseForm.append("session_id", sessionId);
  referencePoseForm.append("side", "reference");
  const referencePoseJobId = await startPythonYoloPoseJob(referencePoseForm);
  const referencePose = await waitForPythonYoloPoseJob(referencePoseJobId, (progress) =>
    onStatus(`YOLO hybrid (reference pose) ${Math.round(progress * 100)}%`),
  );

  onStatus("YOLO hybrid (user segmentation)…");
  const practiceSegForm = new FormData();
  practiceSegForm.append("video", practiceFile, practiceFile.name);
  practiceSegForm.append("color", YOLO_SEG_COLORS.practice);
  practiceSegForm.append("fps", String(BROWSER_YOLO_OVERLAY_FPS));
  practiceSegForm.append("session_id", sessionId);
  practiceSegForm.append("side", "practice");
  const practiceSegJobId = await startPythonYoloJob(practiceSegForm);
  const practiceSeg = await waitForPythonYoloJob(practiceSegJobId, (progress) =>
    onStatus(`YOLO hybrid (user segmentation) ${Math.round(progress * 100)}%`),
  );

  onStatus("YOLO hybrid (user pose)…");
  const practicePoseForm = new FormData();
  practicePoseForm.append("video", practiceFile, practiceFile.name);
  practicePoseForm.append("arms_color", YOLO_POSE_COLORS.practice.arms);
  practicePoseForm.append("legs_color", YOLO_POSE_COLORS.practice.legs);
  practicePoseForm.append("fps", String(BROWSER_YOLO_OVERLAY_FPS));
  practicePoseForm.append("session_id", sessionId);
  practicePoseForm.append("side", "practice");
  const practicePoseJobId = await startPythonYoloPoseJob(practicePoseForm);
  const practicePose = await waitForPythonYoloPoseJob(practicePoseJobId, (progress) =>
    onStatus(`YOLO hybrid (user pose) ${Math.round(progress * 100)}%`),
  );

  const refArtifact = buildFullVideoArtifact({
    type: "yolo",
    side: "reference",
    size: getVideoSize("reference"),
    video: referenceSeg,
    meta: { layer: "seg" },
  });
  const userArtifact = buildFullVideoArtifact({
    type: "yolo",
    side: "practice",
    size: getVideoSize("practice"),
    video: practiceSeg,
    meta: { layer: "seg" },
  });
  const refArmsArtifact = buildFullVideoArtifact({
    type: "yolo-pose-arms",
    side: "reference",
    size: getVideoSize("reference"),
    video: referencePose.arms,
    meta: { layer: "arms" },
  });
  const refLegsArtifact = buildFullVideoArtifact({
    type: "yolo-pose-legs",
    side: "reference",
    size: getVideoSize("reference"),
    video: referencePose.legs,
    meta: { layer: "legs" },
  });
  const userArmsArtifact = buildFullVideoArtifact({
    type: "yolo-pose-arms",
    side: "practice",
    size: getVideoSize("practice"),
    video: practicePose.arms,
    meta: { layer: "arms" },
  });
  const userLegsArtifact = buildFullVideoArtifact({
    type: "yolo-pose-legs",
    side: "practice",
    size: getVideoSize("practice"),
    video: practicePose.legs,
    meta: { layer: "legs" },
  });

  await Promise.all([
    storeSessionOverlay(getSideVariantKey({ sessionId, type: "yolo", side: "reference" }), refArtifact),
    storeSessionOverlay(getSideVariantKey({ sessionId, type: "yolo", side: "practice" }), userArtifact),
    storeSessionOverlay(
      getSideVariantKey({ sessionId, type: "yolo-pose-arms", side: "reference" }),
      refArmsArtifact,
    ),
    storeSessionOverlay(
      getSideVariantKey({ sessionId, type: "yolo-pose-legs", side: "reference" }),
      refLegsArtifact,
    ),
    storeSessionOverlay(
      getSideVariantKey({ sessionId, type: "yolo-pose-arms", side: "practice" }),
      userArmsArtifact,
    ),
    storeSessionOverlay(
      getSideVariantKey({ sessionId, type: "yolo-pose-legs", side: "practice" }),
      userLegsArtifact,
    ),
  ]);

  setRefArtifact(refArtifact);
  setUserArtifact(userArtifact);
  setRefArmsArtifact?.(refArmsArtifact);
  setRefLegsArtifact?.(refLegsArtifact);
  setUserArmsArtifact?.(userArmsArtifact);
  setUserLegsArtifact?.(userLegsArtifact);
  onStatus("YOLO hybrid overlays ready.");
}
