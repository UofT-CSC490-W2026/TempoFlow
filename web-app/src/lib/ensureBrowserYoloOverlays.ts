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
export const BROWSER_YOLO_VARIANT = "yolo26n-python-hybrid-v22";

type VideoSide = "reference" | "practice";
type PoseLayer = "arms" | "legs";

type VideoResult = {
  blob: Blob;
  mime: string;
  summary?: OverlaySummary | null;
};

type OverlayPersonSummary = {
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

type OverlaySummary = {
  person_count?: number;
  persons?: OverlayPersonSummary[];
  union?: OverlayPersonSummary | null;
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
  poseFrames?: Array<HybridPoseFrame | null>;
};

type HybridPoseFrame = {
  keypoints: Array<{
    name?: string;
    x: number;
    y: number;
    score: number;
  }>;
  part_coverage?: Record<string, number> | null;
  instances?: Array<{
    keypoints: Array<{
      name?: string;
      x: number;
      y: number;
      score: number;
    }>;
    part_coverage?: Record<string, number> | null;
  }> | null;
};

type HybridResult = {
  seg: VideoResult;
  arms: VideoResult;
  legs: VideoResult;
  segSummary: OverlaySummary | null;
  poseSummary: PoseSummary | null;
  poseFrames: Array<HybridPoseFrame | null>;
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

type PythonJobKind = "yolo" | "yolo-pose" | "yolo-hybrid";

type PythonJobRegistration = {
  kind: PythonJobKind;
  jobId: string;
};

function createAbortError() {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

async function sleepWithSignal(ms: number, signal?: AbortSignal) {
  if (!signal) {
    await sleep(ms);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function cancelPythonJob(job: PythonJobRegistration) {
  const endpoint = job.kind;
  const form = new FormData();
  form.append("job_id", job.jobId);
  try {
    await fetch(`${getOverlayBaseUrl()}/api/overlay/${endpoint}/cancel`, {
      method: "POST",
      body: form,
      keepalive: true,
    });
  } catch {
    // Best-effort cancellation on teardown.
  }
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

function decodeOverlayBoundsSummaryHeader(value: string | null): OverlaySummary | null {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const json = atob(padded);
    return JSON.parse(json) as OverlaySummary;
  } catch {
    return null;
  }
}

type NormalizationBounds = {
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
  source: "segmentation" | "pose";
};

type MatchedPosePair = {
  referencePerson: PosePersonSummary;
  practicePerson: PosePersonSummary;
};

type OverlayBodyMeasurement = {
  headY: number;
  footY: number;
  height: number;
  width: number;
  anchorX: number;
  anchorY: number;
  centerX: number;
  centerY: number;
  source: "segmentation" | "pose";
};

function buildBoundsFromPoseSummary(summary: PoseSummary | null): NormalizationBounds | null {
  const people = summary?.persons ?? [];
  if (!people.length) return null;

  const min_x = Math.min(...people.map((person) => person.min_x));
  const max_x = Math.max(...people.map((person) => person.max_x));
  const min_y = Math.min(...people.map((person) => person.min_y));
  const max_y = Math.max(...people.map((person) => person.max_y));
  const center_x = (min_x + max_x) / 2;
  const center_y = (min_y + max_y) / 2;

  return {
    min_x,
    max_x,
    min_y,
    max_y,
    center_x,
    center_y,
    width: Math.max(0.05, max_x - min_x),
    height: Math.max(0.08, max_y - min_y),
    anchor_x: center_x,
    anchor_y: max_y,
    source: "pose",
  };
}

function toNormalizationBounds(summary: OverlayPersonSummary | null | undefined): NormalizationBounds | null {
  if (!summary) return null;
  const min_x = Number(summary.min_x);
  const max_x = Number(summary.max_x);
  const min_y = Number(summary.min_y);
  const max_y = Number(summary.max_y);
  const center_x = Number(summary.center_x);
  const center_y = Number(summary.center_y);
  const anchor_x = Number(summary.anchor_x);
  const anchor_y = Number(summary.anchor_y);
  const width = Number(summary.width);
  const height = Number(summary.height);

  if (
    !Number.isFinite(min_x) ||
    !Number.isFinite(max_x) ||
    !Number.isFinite(min_y) ||
    !Number.isFinite(max_y) ||
    !Number.isFinite(center_x) ||
    !Number.isFinite(center_y) ||
    !Number.isFinite(anchor_x) ||
    !Number.isFinite(anchor_y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return {
    min_x,
    max_x,
    min_y,
    max_y,
    center_x,
    center_y,
    anchor_x,
    anchor_y,
    width: Math.max(0.05, width),
    height: Math.max(0.08, height),
    source: "segmentation",
  };
}

function matchPosePeople(
  referenceSummary: PoseSummary | null,
  practiceSummary: PoseSummary | null,
): MatchedPosePair[] {
  const refPeople = [...(referenceSummary?.persons ?? [])].sort((a, b) => a.anchor_x - b.anchor_x);
  const practicePeople = [...(practiceSummary?.persons ?? [])].sort((a, b) => a.anchor_x - b.anchor_x);
  if (!refPeople.length || !practicePeople.length) return [];

  const practicePool = [...practicePeople];
  return refPeople
    .map((referencePerson) => {
      if (!practicePool.length) return null;
      let bestIndex = 0;
      let bestDistance = Infinity;
      practicePool.forEach((practicePerson, index) => {
        const distance =
          Math.abs(practicePerson.anchor_x - referencePerson.anchor_x) +
          Math.abs(practicePerson.anchor_y - referencePerson.anchor_y) * 0.45;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      const [practicePerson] = practicePool.splice(bestIndex, 1);
      return practicePerson ? { referencePerson, practicePerson } : null;
    })
    .filter((pair): pair is MatchedPosePair => pair != null);
}

function choosePrimaryAnchorPair(pairs: MatchedPosePair[]): MatchedPosePair | null {
  if (!pairs.length) return null;
  return pairs.reduce((best, candidate) => {
    const bestArea = best.practicePerson.width * best.practicePerson.height;
    const candidateArea = candidate.practicePerson.width * candidate.practicePerson.height;
    if (candidateArea !== bestArea) {
      return candidateArea > bestArea ? candidate : best;
    }
    return candidate.practicePerson.anchor_y > best.practicePerson.anchor_y ? candidate : best;
  });
}

function buildNormalizationMeta(
  referenceSegSummary: OverlaySummary | null,
  practiceSegSummary: OverlaySummary | null,
  referencePoseSummary: PoseSummary | null,
  practicePoseSummary: PoseSummary | null,
) {
  const matchedPairs = matchPosePeople(referencePoseSummary, practicePoseSummary);
  const anchorPair = choosePrimaryAnchorPair(matchedPairs);
  const findClosestSegPerson = (
    summary: OverlaySummary | null,
    posePerson: PosePersonSummary | null | undefined,
  ) => {
    const people = summary?.persons ?? [];
    if (!people.length) return null;
    if (!posePerson) return people[0] ?? null;
    return people.reduce((best, candidate) => {
      const bestDistance =
        Math.abs(best.anchor_x - posePerson.anchor_x) + Math.abs(best.anchor_y - posePerson.anchor_y) * 0.45;
      const candidateDistance =
        Math.abs(candidate.anchor_x - posePerson.anchor_x) + Math.abs(candidate.anchor_y - posePerson.anchor_y) * 0.45;
      return candidateDistance < bestDistance ? candidate : best;
    });
  };
  const referenceScalePerson =
    findClosestSegPerson(referenceSegSummary, anchorPair?.referencePerson) ?? anchorPair?.referencePerson ?? null;
  const practiceScalePerson =
    findClosestSegPerson(practiceSegSummary, anchorPair?.practicePerson) ?? anchorPair?.practicePerson ?? null;
  const referenceBounds =
    toNormalizationBounds(referenceSegSummary?.union) ?? buildBoundsFromPoseSummary(referencePoseSummary);
  const practiceBounds =
    toNormalizationBounds(practiceSegSummary?.union) ?? buildBoundsFromPoseSummary(practicePoseSummary);
  if (!referenceBounds || !practiceBounds) return null;

  const referenceMeasurement = buildBodyMeasurement({
    segPerson: referenceScalePerson,
    segBounds: referenceBounds,
    posePerson: anchorPair?.referencePerson ?? null,
    poseBounds: buildBoundsFromPoseSummary(referencePoseSummary),
  });
  const practiceMeasurement = buildBodyMeasurement({
    segPerson: practiceScalePerson,
    segBounds: practiceBounds,
    posePerson: anchorPair?.practicePerson ?? null,
    poseBounds: buildBoundsFromPoseSummary(practicePoseSummary),
  });

  // Normalize the reference overlay to the user's body size:
  // height = head-to-feet span, width = visible body width.
  const scaleX = Math.max(0.08, Math.min(4.0, practiceMeasurement.width / Math.max(0.01, referenceMeasurement.width)));
  const scaleY = Math.max(0.08, Math.min(4.0, practiceMeasurement.height / Math.max(0.01, referenceMeasurement.height)));

  // Anchor the normalized reference overlay at the user's foot anchor.
  const pivotX = referenceMeasurement.anchorX;
  const targetX = practiceMeasurement.anchorX;
  const pivotY = referenceMeasurement.anchorY;
  const targetY = practiceMeasurement.anchorY;

  return {
    scaleX,
    scaleY,
    translateX: targetX - pivotX,
    translateY: targetY - pivotY,
    pivotX,
    pivotY,
    referenceBounds,
    practiceBounds,
    referenceBody: referenceMeasurement,
    practiceBody: practiceMeasurement,
    normalizationSource: {
      reference: referenceMeasurement.source,
      practice: practiceMeasurement.source,
    },
    matchedPersonCount: matchedPairs.length,
    anchorPair: anchorPair
      ? {
          reference: referencePersonSummaryToDebug(anchorPair.referencePerson),
          practice: referencePersonSummaryToDebug(anchorPair.practicePerson),
        }
      : null,
    anchorSegPair:
      referenceScalePerson && practiceScalePerson
        ? {
            reference: referenceScalePerson,
            practice: practiceScalePerson,
          }
        : null,
  };
}

function referencePersonSummaryToDebug(person: PosePersonSummary) {
  return {
    anchor_x: person.anchor_x,
    anchor_y: person.anchor_y,
    center_x: person.center_x,
    center_y: person.center_y,
    width: person.width,
    height: person.height,
  };
}

function clampNormalized(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function buildBodyMeasurement(params: {
  segPerson?: OverlayPersonSummary | null;
  segBounds?: NormalizationBounds | null;
  posePerson?: PosePersonSummary | null;
  poseBounds?: NormalizationBounds | null;
}) {
  const { segPerson = null, segBounds = null, posePerson = null, poseBounds = null } = params;
  const poseLike = posePerson ?? poseBounds;
  const segLike = segPerson ?? segBounds;
  const headY = clampNormalized(
    poseLike?.min_y ?? segLike?.min_y ?? 0.1,
    0.1,
  );
  const footY = clampNormalized(
    poseLike?.anchor_y ?? segLike?.anchor_y ?? segLike?.max_y ?? 0.88,
    0.88,
  );
  const width = Math.max(0.05, segPerson?.width ?? segBounds?.width ?? poseLike?.width ?? 0.28);
  return {
    headY,
    footY,
    height: Math.max(0.08, footY - headY),
    width,
    anchorX: clampNormalized(poseLike?.anchor_x ?? segLike?.anchor_x ?? 0.5, 0.5),
    anchorY: footY,
    centerX: clampNormalized(poseLike?.center_x ?? segLike?.center_x ?? 0.5, 0.5),
    centerY: clampNormalized(poseLike?.center_y ?? segLike?.center_y ?? (headY + footY) / 2, (headY + footY) / 2),
    source: posePerson || poseBounds ? "pose" : "segmentation",
  } satisfies OverlayBodyMeasurement;
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

async function waitForPythonYoloJob(
  jobId: string,
  reportProgress: (progress: number) => void,
  signal?: AbortSignal,
) {
  while (true) {
    throwIfAborted(signal);
    const stRes = await fetch(
      `${getOverlayBaseUrl()}/api/overlay/yolo/status?job_id=${encodeURIComponent(jobId)}`,
      { signal },
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
        { signal },
      );
      if (!outRes.ok) {
        const txt = await outRes.text().catch(() => "");
        throw new Error(`YOLO overlay result error (${outRes.status}): ${txt || outRes.statusText}`);
      }
      const blob = await outRes.blob();
      return {
        blob,
        mime: outRes.headers.get("content-type") || "video/webm",
        summary: decodeOverlayBoundsSummaryHeader(outRes.headers.get("x-tempoflow-overlay-summary")),
      } satisfies VideoResult;
    }

    if (st.status === "error") {
      throw new Error(st.error || "YOLO overlay job failed");
    }
    if (st.status === "cancelled") {
      throw createAbortError();
    }

    await sleepWithSignal(400, signal);
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

async function waitForPythonYoloPoseJob(
  jobId: string,
  reportProgress: (progress: number) => void,
  signal?: AbortSignal,
) {
  while (true) {
    throwIfAborted(signal);
    const stRes = await fetch(
      `${getOverlayBaseUrl()}/api/overlay/yolo-pose/status?job_id=${encodeURIComponent(jobId)}`,
      { signal },
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
          { signal },
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
    if (st.status === "cancelled") {
      throw createAbortError();
    }

    await sleepWithSignal(400, signal);
  }
}

async function startPythonYoloHybridJob(form: FormData) {
  const res = await fetch(`${getOverlayBaseUrl()}/api/overlay/yolo-hybrid/start`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`YOLO hybrid start error (${res.status}): ${txt || res.statusText}`);
  }
  const json = (await res.json()) as { job_id?: string };
  if (!json.job_id) {
    throw new Error("Missing job_id from YOLO hybrid start");
  }
  return json.job_id;
}

async function waitForPythonYoloHybridJob(
  jobId: string,
  reportProgress: (progress: number) => void,
  signal?: AbortSignal,
) {
  while (true) {
    throwIfAborted(signal);
    const stRes = await fetch(
      `${getOverlayBaseUrl()}/api/overlay/yolo-hybrid/status?job_id=${encodeURIComponent(jobId)}`,
      { signal },
    );
    if (!stRes.ok) {
      const txt = await stRes.text().catch(() => "");
      throw new Error(`YOLO hybrid status error (${stRes.status}): ${txt || stRes.statusText}`);
    }

    const st = (await stRes.json()) as {
      status: string;
      progress?: number;
      error?: string;
    };
    reportProgress(typeof st.progress === "number" ? st.progress : 0);

    if (st.status === "done") {
      const poseDataRes = await fetch(
        `${getOverlayBaseUrl()}/api/overlay/yolo-hybrid/pose-data?job_id=${encodeURIComponent(jobId)}`,
        { signal },
      );
      if (!poseDataRes.ok) {
        const txt = await poseDataRes.text().catch(() => "");
        throw new Error(`YOLO hybrid pose-data error (${poseDataRes.status}): ${txt || poseDataRes.statusText}`);
      }
      const poseData = (await poseDataRes.json()) as {
        frames?: Array<HybridPoseFrame | null>;
      };
      const loadLayer = async (layer: "seg" | PoseLayer) => {
        const outRes = await fetch(
          `${getOverlayBaseUrl()}/api/overlay/yolo-hybrid/result?job_id=${encodeURIComponent(jobId)}&layer=${layer}`,
          { signal },
        );
        if (!outRes.ok) {
          const txt = await outRes.text().catch(() => "");
          throw new Error(`YOLO hybrid result error (${outRes.status}): ${txt || outRes.statusText}`);
        }
        return {
          blob: await outRes.blob(),
          mime: outRes.headers.get("content-type") || "video/webm",
          segSummary: decodeOverlayBoundsSummaryHeader(outRes.headers.get("x-tempoflow-overlay-summary")),
          poseSummary: decodePoseSummaryHeader(outRes.headers.get("x-tempoflow-pose-summary")),
        };
      };

      const [seg, arms, legs] = await Promise.all([loadLayer("seg"), loadLayer("arms"), loadLayer("legs")]);
      return {
        seg: { blob: seg.blob, mime: seg.mime, summary: seg.segSummary },
        arms: { blob: arms.blob, mime: arms.mime },
        legs: { blob: legs.blob, mime: legs.mime },
        segSummary: seg.segSummary ?? null,
        poseSummary: arms.poseSummary ?? legs.poseSummary ?? seg.poseSummary ?? null,
        poseFrames: Array.isArray(poseData.frames) ? poseData.frames : [],
      } satisfies HybridResult;
    }

    if (st.status === "error") {
      throw new Error(st.error || "YOLO hybrid job failed");
    }
    if (st.status === "cancelled") {
      throw createAbortError();
    }

    await sleepWithSignal(400, signal);
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
  onSegmentComplete?: (segmentIndex: number) => void;
  signal?: AbortSignal;
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
    onSegmentComplete,
    signal,
  } = params;

  if (!overlaySegmentPlans.length) {
    return false;
  }

  const videoCache = new Map<VideoSide, File | null>();
  const startedJobs: PythonJobRegistration[] = [];
  let cancelRequested = false;
  const cancelStartedJobs = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    startedJobs.forEach((job) => {
      void cancelPythonJob(job);
    });
  };
  signal?.addEventListener("abort", cancelStartedJobs, { once: true });
  const uploadedSides = new Set<VideoSide>();
  const rememberJob = async (job: PythonJobRegistration) => {
    startedJobs.push(job);
    if (signal?.aborted) {
      await cancelPythonJob(job);
      throw createAbortError();
    }
  };

  try {
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
      throwIfAborted(signal);
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
        const visibleProgress = Math.max(0, Math.min(1, avg));
        const pct = Math.max(0, Math.min(100, Math.round(visibleProgress * 100)));
        onSegmentProgress?.(plan.index, visibleProgress);
        onStatus(
          `YOLO hybrid segment ${ordinal}/${total} processing… ${pct}% (segment ${plan.index + 1})`,
        );
      };

      updateStatus();

      const processSide = async (side: VideoSide) => {
        const clipRange = side === "reference" ? plan.reference : plan.practice;
        const size = getVideoSize(side);
        const file = await getVideoFile(side);
        const segExists = side === "reference" ? Boolean(refSeg) : Boolean(practiceSeg);
        const poseExists = side === "reference" ? Boolean(refArms && refLegs) : Boolean(practiceArms && practiceLegs);

        if (!segExists && !poseExists) {
          throwIfAborted(signal);
          const hybridForm = new FormData();
          if (!uploadedSides.has(side)) {
            hybridForm.append("video", file, file.name);
            uploadedSides.add(side);
          }
          hybridForm.append("color", YOLO_SEG_COLORS[side]);
          hybridForm.append("arms_color", YOLO_POSE_COLORS[side].arms);
          hybridForm.append("legs_color", YOLO_POSE_COLORS[side].legs);
          hybridForm.append("fps", String(BROWSER_YOLO_OVERLAY_FPS));
          hybridForm.append("session_id", sessionId);
          hybridForm.append("side", side);
          hybridForm.append("start_sec", String(clipRange.startSec));
          hybridForm.append("end_sec", String(clipRange.endSec));
          const hybridJobId = await startPythonYoloHybridJob(hybridForm);
          await rememberJob({ kind: "yolo-hybrid", jobId: hybridJobId });
          const hybridResult = await waitForPythonYoloHybridJob(
            hybridJobId,
            (progress) => {
              if (side === "reference") {
                refSegProgress = progress;
                refPoseProgress = progress;
              } else {
                practiceSegProgress = progress;
                practicePoseProgress = progress;
              }
              updateStatus();
            },
            signal,
          );
          return {
            side,
            clipRange,
            size,
            segResult: hybridResult.seg,
            poseResult: {
              arms: hybridResult.arms,
              legs: hybridResult.legs,
              summary: hybridResult.poseSummary,
              poseFrames: hybridResult.poseFrames,
            } satisfies PoseResult,
          };
        }

        const segPromise = segExists
          ? Promise.resolve<VideoResult | null>(null)
          : (async () => {
              throwIfAborted(signal);
              const segForm = new FormData();
              if (!uploadedSides.has(side)) {
                segForm.append("video", file, file.name);
                uploadedSides.add(side);
              }
              segForm.append("color", YOLO_SEG_COLORS[side]);
              segForm.append("fps", String(BROWSER_YOLO_OVERLAY_FPS));
              segForm.append("session_id", sessionId);
              segForm.append("side", side);
              segForm.append("start_sec", String(clipRange.startSec));
              segForm.append("end_sec", String(clipRange.endSec));
              const segJobId = await startPythonYoloJob(segForm);
              await rememberJob({ kind: "yolo", jobId: segJobId });
              return waitForPythonYoloJob(
                segJobId,
                (progress) => {
                  if (side === "reference") refSegProgress = progress;
                  else practiceSegProgress = progress;
                  updateStatus();
                },
                signal,
              );
            })();

        const posePromise = poseExists
          ? Promise.resolve<PoseResult | null>(null)
          : (async () => {
              throwIfAborted(signal);
              const poseForm = new FormData();
              if (!uploadedSides.has(side)) {
                poseForm.append("video", file, file.name);
                uploadedSides.add(side);
              }
              poseForm.append("arms_color", YOLO_POSE_COLORS[side].arms);
              poseForm.append("legs_color", YOLO_POSE_COLORS[side].legs);
              poseForm.append("fps", String(BROWSER_YOLO_OVERLAY_FPS));
              poseForm.append("session_id", sessionId);
              poseForm.append("side", side);
              poseForm.append("start_sec", String(clipRange.startSec));
              poseForm.append("end_sec", String(clipRange.endSec));
              const poseJobId = await startPythonYoloPoseJob(poseForm);
              await rememberJob({ kind: "yolo-pose", jobId: poseJobId });
              return waitForPythonYoloPoseJob(
                poseJobId,
                (progress) => {
                  if (side === "reference") refPoseProgress = progress;
                  else practicePoseProgress = progress;
                  updateStatus();
                },
                signal,
              );
            })();

        const [segResult, poseResult] = await Promise.all([segPromise, posePromise]);
        return { side, clipRange, size, segResult, poseResult };
      };

      const [referenceResult, practiceResult] = await Promise.all([
        processSide("reference"),
        processSide("practice"),
      ]);
      const normalizationMeta = buildNormalizationMeta(
        referenceResult.segResult?.summary ?? null,
        practiceResult.segResult?.summary ?? null,
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
              meta: {
                layer: "seg",
                normalization: normalizationMeta,
                segSummary: referenceResult.segResult.summary ?? null,
                poseSummary: referenceResult.poseResult?.summary ?? null,
                poseFrames:
                  referenceResult.poseResult && "poseFrames" in referenceResult.poseResult
                    ? referenceResult.poseResult.poseFrames ?? []
                    : [],
              },
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
              meta: {
                layer: "arms",
                normalization: normalizationMeta,
                poseSummary: referenceResult.poseResult.summary,
              },
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
              meta: {
                layer: "legs",
                normalization: normalizationMeta,
                poseSummary: referenceResult.poseResult.summary,
              },
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
              meta: {
                layer: "seg",
                segSummary: practiceResult.segResult.summary ?? null,
                poseSummary: practiceResult.poseResult?.summary ?? null,
                poseFrames:
                  practiceResult.poseResult && "poseFrames" in practiceResult.poseResult
                    ? practiceResult.poseResult.poseFrames ?? []
                    : [],
              },
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
      onSegmentComplete?.(plan.index);

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
  } catch (error) {
    cancelStartedJobs();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelStartedJobs);
  }
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
  onSegmentComplete?: (segmentIndex: number) => void;
  signal?: AbortSignal;
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
    onSegmentComplete,
    signal,
  } = params;

  const startedJobs: PythonJobRegistration[] = [];
  let cancelRequested = false;
  const cancelStartedJobs = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    startedJobs.forEach((job) => {
      void cancelPythonJob(job);
    });
  };
  signal?.addEventListener("abort", cancelStartedJobs, { once: true });
  const rememberJob = async (job: PythonJobRegistration) => {
    startedJobs.push(job);
    if (signal?.aborted) {
      await cancelPythonJob(job);
      throw createAbortError();
    }
  };

  const getVideoSize = (side: VideoSide) => {
    const video = side === "reference" ? refVideo.current : userVideo.current;
    return {
      width: video?.videoWidth || 640,
      height: video?.videoHeight || 480,
    };
  };

  try {
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
      onSegmentComplete,
      signal,
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

    const runFullVideoSide = async (side: VideoSide, file: File) => {
      const hybridForm = new FormData();
      hybridForm.append("video", file, file.name);
      hybridForm.append("color", YOLO_SEG_COLORS[side]);
      hybridForm.append("arms_color", YOLO_POSE_COLORS[side].arms);
      hybridForm.append("legs_color", YOLO_POSE_COLORS[side].legs);
      hybridForm.append("fps", String(BROWSER_YOLO_OVERLAY_FPS));
      hybridForm.append("session_id", sessionId);
      hybridForm.append("side", side);

      const label = side === "reference" ? "reference" : "user";
      throwIfAborted(signal);
      const hybridJobId = await startPythonYoloHybridJob(hybridForm);
      await rememberJob({ kind: "yolo-hybrid", jobId: hybridJobId });
      return waitForPythonYoloHybridJob(
        hybridJobId,
        (progress) => onStatus(`YOLO hybrid (${label}) ${Math.round(progress * 100)}%`),
        signal,
      );
    };

    const [referenceHybrid, practiceHybrid] = await Promise.all([
      runFullVideoSide("reference", referenceFile),
      runFullVideoSide("practice", practiceFile),
    ]);

    const refArtifact = buildFullVideoArtifact({
      type: "yolo",
      side: "reference",
      size: getVideoSize("reference"),
      video: referenceHybrid.seg,
      meta: { layer: "seg" },
    });
    const userArtifact = buildFullVideoArtifact({
      type: "yolo",
      side: "practice",
      size: getVideoSize("practice"),
      video: practiceHybrid.seg,
      meta: { layer: "seg" },
    });
    const refArmsArtifact = buildFullVideoArtifact({
      type: "yolo-pose-arms",
      side: "reference",
      size: getVideoSize("reference"),
      video: referenceHybrid.arms,
      meta: { layer: "arms" },
    });
    const refLegsArtifact = buildFullVideoArtifact({
      type: "yolo-pose-legs",
      side: "reference",
      size: getVideoSize("reference"),
      video: referenceHybrid.legs,
      meta: { layer: "legs" },
    });
    const userArmsArtifact = buildFullVideoArtifact({
      type: "yolo-pose-arms",
      side: "practice",
      size: getVideoSize("practice"),
      video: practiceHybrid.arms,
      meta: { layer: "arms" },
    });
    const userLegsArtifact = buildFullVideoArtifact({
      type: "yolo-pose-legs",
      side: "practice",
      size: getVideoSize("practice"),
      video: practiceHybrid.legs,
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
  } catch (error) {
    cancelStartedJobs();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelStartedJobs);
  }
}
