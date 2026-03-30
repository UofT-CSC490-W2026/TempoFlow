import type { EbsData } from "../components/ebs/types";
import type { EbsSessionMeta } from "./sessionStorage";

export function buildEbsMeta(data: EbsData, previousMeta?: EbsSessionMeta): EbsSessionMeta {
  return {
    segmentCount: data.segments.length,
    estimatedBpm: data.beat_tracking?.estimated_bpm,
    segmentationMode: data.segmentation_mode,
    sharedDurationSec: data.alignment.shared_len_sec,
    generatedAt: new Date().toISOString(),
    processingStartedAt: previousMeta?.processingStartedAt,
    finalScore: previousMeta?.finalScore,
    postProcessStatus: previousMeta?.postProcessStatus,
    yoloReadySegments: previousMeta?.yoloReadySegments,
    visualReadySegments: previousMeta?.visualReadySegments,
    geminiReadySegments: previousMeta?.geminiReadySegments,
    geminiTotalSegments: previousMeta?.geminiTotalSegments,
  };
}
