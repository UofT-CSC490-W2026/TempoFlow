import type { EbsData } from "../components/ebs/types";
import type { EbsSessionMeta, TempoFlowSession } from "./sessionStorage";

export function getGeminiProcessableSegmentCount(ebsData: EbsData | null | undefined) {
  return (ebsData?.segments ?? []).filter((segment) => {
    const range = segment.beat_idx_range;
    return range != null && range[1] > range[0];
  }).length;
}

export function mergePostProcessMeta(
  meta: EbsSessionMeta | undefined,
  updates: Partial<EbsSessionMeta>,
): EbsSessionMeta {
  return {
    segmentCount: meta?.segmentCount ?? 0,
    sharedDurationSec: meta?.sharedDurationSec ?? 0,
    generatedAt: meta?.generatedAt ?? new Date().toISOString(),
    ...meta,
    ...updates,
  };
}

export function isSessionPostProcessComplete(session: TempoFlowSession | null | undefined) {
  const meta = session?.ebsMeta;
  if (!meta) return false;
  if (meta.postProcessStatus === "ready") return true;

  const totalSegments = Math.max(0, meta.segmentCount ?? 0);
  const geminiTotalSegments = Math.max(0, meta.geminiTotalSegments ?? totalSegments);
  const yoloReady = meta.yoloReadySegments ?? 0;
  const visualReady = meta.visualReadySegments ?? 0;
  const geminiReady = meta.geminiReadySegments ?? 0;

  if (totalSegments > 0 && yoloReady >= totalSegments && visualReady >= totalSegments && geminiReady >= geminiTotalSegments) {
    return true;
  }

  return meta.finalScore != null && totalSegments > 0;
}

export function shouldTreatSessionAsInProcess(session: TempoFlowSession | null | undefined) {
  if (!session) return false;
  if (session.ebsStatus === "paused" || session.ebsStatus === "error") return false;
  if (session.ebsStatus === "processing") return true;
  if (session.status === "analyzing") return true;
  if (session.ebsMeta?.postProcessStatus === "processing") return true;
  if (session.ebsMeta && !isSessionPostProcessComplete(session) && (session.ebsStatus === "ready" || session.status === "analyzed")) {
    return true;
  }
  return false;
}
