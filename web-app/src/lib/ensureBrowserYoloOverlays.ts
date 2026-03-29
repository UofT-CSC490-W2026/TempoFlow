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
export const BROWSER_YOLO_VARIANT = "yolo26n-python-hybrid-v11";

type VideoSide = "reference" | "practice";
type PoseLayer = "arms" | "legs";

type VideoResult = {
  blob: Blob;
  mime: string;
};

type PosePersonSummary = {
  anchor_x: number;
  anchor_y: number;
  center_x: number;
  center_y: number;
  width: number;
  height: number;
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;
};

type PoseSummary = {
  person_count: number;
  persons: PosePersonSummary[];
};

type PoseResult = {
  arms: VideoResult;
  legs: VideoResult;
  summary: PoseSummary | null;
};

type SegmentedYoloArtifacts = {
  referenceSeg: OverlayArtifact;
  practiceSeg: OverlayArtifact;
  referenceArms: OverlayArtifact;
  referenceLegs: OverlayArtifact;
  practiceArms: OverlayArtifact;
  practiceLegs: OverlayArtifact;
};

const YOLO_SEG_COLORS: Record<VideoSide, string> = {
  reference: "#6ec6f5",
  practice: "#f2b37b",
};

const YOLO_POSE_COLORS: Record<VideoSide, { arms: string; legs: string }> = {
  reference: { arms: "#91d5fa", legs: "#78bef2" },
  practice: { arms: "#f6c699", legs: "#e7a975" },
};

function getOverlayBaseUrl() {
  return getPublicEbsProcessorUrl().replace(/\/api\/process\/?$/, "");
}

export function buildYoloOverlaySegmentPlans(ebsData: EbsData | null): OverlaySegmentPlan[] {
  return buildOverlaySegmentPlans(ebsData);
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function decodePoseSummaryHeader(value: string | null): PoseSummary | null {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const json = atob(padded);
    return JSON.parse(json) as PoseSummary;
  } catch {
    return null;
  }
}

function buildNormalizationMeta(
  referenceSummary: PoseSummary | null,
  practiceSummary: PoseSummary | null,
) {
  const refPeople = [...(referenceSummary?.persons ?? [])].sort((a, b) => a.anchor_x - b.anchor_x);
  const practicePeople = [...(practiceSummary?.persons ?? [])].sort((a, b) => a.anchor_x - b.anchor_x);
  if (!refPeople.length || !practicePeople.length) return null;

  const practicePool = [...practicePeople];
  const pairs = refPeople
    .map((referencePerson) => {
      if (!practicePool.length) return null;
      let bestIndex = 0;
      let bestDistance = Infinity;
      practicePool.forEach((practicePerson, index) => {
        const distance =
          Math.abs(practicePerson.anchor_x - referencePerson.anchor_x) +
          Math.abs(practicePerson.anchor_y - referencePerson.anchor_y) * 0.35;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      const [practicePerson] = practicePool.splice(bestIndex, 1);
      return practicePerson ? { referencePerson, practicePerson } : null;
    })
    .filter((pair): pair is { referencePerson: PosePersonSummary; practicePerson: PosePersonSummary } => pair != null);

  if (!pairs.length) return null;

  const buildUnionBounds = (people: PosePersonSummary[]) => ({
    minX: Math.min(...people.map((person) => person.min_x)),
    maxX: Math.max(...people.map((person) => person.max_x)),
    minY: Math.min(...people.map((person) => person.min_y)),
    maxY: Math.max(...people.map((person) => person.max_y)),
  });

  const referenceGroup = pairs.map((pair) => pair.referencePerson);
  const practiceGroup = pairs.map((pair) => pair.practicePerson);
  const referenceBounds = buildUnionBounds(referenceGroup);
  const practiceBounds = buildUnionBounds(practiceGroup);

  const referenceWidth = Math.max(0.05, referenceBounds.maxX - referenceBounds.minX);
  const referenceHeight = Math.max(0.08, referenceBounds.maxY - referenceBounds.minY);
  const practiceWidth = Math.max(0.05, practiceBounds.maxX - practiceBounds.minX);
  const practiceHeight = Math.max(0.08, practiceBounds.maxY - practiceBounds.minY);

  // For overlay diff we want the reference ghost to literally fit the practice layout,
  // so use independent width/height scaling instead of a uniform scale.
  const scaleX = Math.max(0.2, Math.min(2.8, practiceWidth / referenceWidth));
  const scaleY = Math.max(0.2, Math.min(2.8, practiceHeight / referenceHeight));

  const pivotX = (referenceBounds.minX + referenceBounds.maxX) / 2;
  const targetX = (practiceBounds.minX + practiceBounds.maxX) / 2;
  const pivotY = referenceBounds.maxY;
  const targetY = practiceBounds.maxY;

  return {
    scaleX,
    scaleY,
    translateX: targetX - pivotX,
    translateY: targetY - pivotY,
    pivotX,
    pivotY,
    referenceBounds,
    practiceBounds,
    matchedPersonCount: pairs.length,
    referencePersonCount: refPeople.length,
    practicePersonCount: practicePeople.length,
  };
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
          summary: decodePoseSummaryHeader(outRes.headers.get("x-tempoflow-pose-summary")),
        };
      };

      const [arms, legs] = await Promise.all([loadLayer("arms"), loadLayer("legs")]);
      return {
        arms: { blob: arms.blob, mime: arms.mime },
        legs: { blob: legs.blob, mime: legs.mime },
        summary: arms.summary ?? legs.summary ?? null,
      } satisfies PoseResult;
    }

    if (st.status === "error") {
      throw new Error(st.error || "YOLO pose job failed");
    }

    await sleep(400);
  }
}

function buildSegmentVideoResult(params: {
  plan: OverlaySegmentPlan["reference"] | OverlaySegmentPlan["practice"];
  index: number;
  sharedStartSec: number;
  sharedEndSec: number;
  side: VideoSide;
  size: { width: number; height: number };
  video: VideoResult;
  meta?: Record<string, unknown>;
}) {
  const { plan, index, sharedStartSec, sharedEndSec, side, size, video, meta } = params;
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
  overlaySegmentPlans: OverlaySegmentPlan[];
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
    overlaySegmentPlans,
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

  if (!overlaySegmentPlans.length) {
    return false;
  }

  const total = overlaySegmentPlans.length;
  if (
    isOverlayArtifactComplete(existingReference, total) &&
    isOverlayArtifactComplete(existingPractice, total) &&
    isOverlayArtifactComplete(existingReferenceArms, total) &&
    isOverlayArtifactComplete(existingReferenceLegs, total) &&
    isOverlayArtifactComplete(existingPracticeArms, total) &&
    isOverlayArtifactComplete(existingPracticeLegs, total)
  ) {
    onStatus("YOLO hybrid overlays already ready.");
    for (const plan of overlaySegmentPlans) {
      onSegmentProgress?.(plan.index, 1);
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

  for (let idx = 0; idx < overlaySegmentPlans.length; idx += 1) {
    const plan = overlaySegmentPlans[idx];
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
      onSegmentProgress?.(plan.index, avg);
      onStatus(
        `YOLO hybrid segment ${ordinal}/${total} processing… ${pct}% (segment ${plan.index + 1})`,
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

      return { side, clipRange, size, segResult, poseResult };
    };

    const referenceResult = await processSide("reference");
    const practiceResult = await processSide("practice");
    const normalizationMeta = buildNormalizationMeta(
      referenceResult.poseResult?.summary ?? null,
      practiceResult.poseResult?.summary ?? null,
    );

    if (referenceResult.segResult) {
      artifacts = {
        ...artifacts,
        referenceSeg: upsertOverlaySegment(
          artifacts.referenceSeg,
          buildSegmentVideoResult({
            plan: referenceResult.clipRange,
            index: plan.index,
            sharedStartSec: plan.sharedStartSec,
            sharedEndSec: plan.sharedEndSec,
            side: "reference",
            size: referenceResult.size,
            video: referenceResult.segResult,
            meta: { layer: "seg", normalization: normalizationMeta, poseSummary: referenceResult.poseResult?.summary ?? null },
          }),
        ),
      };
    }
    if (referenceResult.poseResult) {
      artifacts = {
        ...artifacts,
        referenceArms: upsertOverlaySegment(
          artifacts.referenceArms,
          buildSegmentVideoResult({
            plan: referenceResult.clipRange,
            index: plan.index,
            sharedStartSec: plan.sharedStartSec,
            sharedEndSec: plan.sharedEndSec,
            side: "reference",
            size: referenceResult.size,
            video: referenceResult.poseResult.arms,
            meta: { layer: "arms", normalization: normalizationMeta, poseSummary: referenceResult.poseResult.summary },
          }),
        ),
        referenceLegs: upsertOverlaySegment(
          artifacts.referenceLegs,
          buildSegmentVideoResult({
            plan: referenceResult.clipRange,
            index: plan.index,
            sharedStartSec: plan.sharedStartSec,
            sharedEndSec: plan.sharedEndSec,
            side: "reference",
            size: referenceResult.size,
            video: referenceResult.poseResult.legs,
            meta: { layer: "legs", normalization: normalizationMeta, poseSummary: referenceResult.poseResult.summary },
          }),
        ),
      };
    }
    if (practiceResult.segResult) {
      artifacts = {
        ...artifacts,
        practiceSeg: upsertOverlaySegment(
          artifacts.practiceSeg,
          buildSegmentVideoResult({
            plan: practiceResult.clipRange,
            index: plan.index,
            sharedStartSec: plan.sharedStartSec,
            sharedEndSec: plan.sharedEndSec,
            side: "practice",
            size: practiceResult.size,
            video: practiceResult.segResult,
            meta: { layer: "seg", poseSummary: practiceResult.poseResult?.summary ?? null },
          }),
        ),
      };
    }
    if (practiceResult.poseResult) {
      artifacts = {
        ...artifacts,
        practiceArms: upsertOverlaySegment(
          artifacts.practiceArms,
          buildSegmentVideoResult({
            plan: practiceResult.clipRange,
            index: plan.index,
            sharedStartSec: plan.sharedStartSec,
            sharedEndSec: plan.sharedEndSec,
            side: "practice",
            size: practiceResult.size,
            video: practiceResult.poseResult.arms,
            meta: { layer: "arms", poseSummary: practiceResult.poseResult.summary },
          }),
        ),
        practiceLegs: upsertOverlaySegment(
          artifacts.practiceLegs,
          buildSegmentVideoResult({
            plan: practiceResult.clipRange,
            index: plan.index,
            sharedStartSec: plan.sharedStartSec,
            sharedEndSec: plan.sharedEndSec,
            side: "practice",
            size: practiceResult.size,
            video: practiceResult.poseResult.legs,
            meta: { layer: "legs", poseSummary: practiceResult.poseResult.summary },
          }),
        ),
      };
    }

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
    onSegmentProgress?.(plan.index, 1);

    const nextPendingIndex = overlaySegmentPlans.findIndex((candidate) => {
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
        `YOLO hybrid segment ${plan.index + 1} ready. ` +
          `${overlaySegmentPlans[nextPendingIndex] ? `Segment ${nextPendingIndex + 1}/${total} is processing in the background…` : ""}`,
      );
    }
  }

  onStatus(`YOLO hybrid overlays ready. ${total}/${total} segments processed.`);
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

  const overlaySegmentPlans = buildYoloOverlaySegmentPlans(ebsData);
  const usedSegmented = await runSegmentedBrowserYoloPipeline({
    sessionId,
    overlaySegmentPlans,
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
