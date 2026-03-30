import { buildFamilyFeedbackForSegment, representativeDenseFrameIndex } from "./beatFeedback";
import type { BodyPixNet } from "./segmentation";
import { loadBodyPix, sampleFrame } from "./segmentation";
import { generateDenseTimestampsForSegments } from "./timestamps";
import type {
  BodyPixComparisonResult,
  ComparisonOptions,
  DanceFeedback,
  FeedbackFeatureFamily,
  SampledPoseFrame,
} from "./types";
import { DEFAULT_POSE_FPS } from "./types";

type FrameSample = SampledPoseFrame;

export async function compareWithBodyPix(
  opts: ComparisonOptions,
): Promise<BodyPixComparisonResult> {
  const { referenceVideoUrl, userVideoUrl, segments, poseFps = DEFAULT_POSE_FPS, onProgress } = opts;
  const timestamps = generateDenseTimestampsForSegments(segments, poseFps);
  const totalFrames = timestamps.length;

  if (totalFrames === 0) {
    onProgress?.({ currentFrame: 0, totalFrames: 0, phase: "done" });
    return { feedback: [], refSamples: [], userSamples: [] };
  }

  onProgress?.({ currentFrame: 0, totalFrames, phase: "loading" });

  const net: BodyPixNet = await loadBodyPix();

  const refVideo = document.createElement("video");
  refVideo.src = referenceVideoUrl;
  refVideo.muted = true;
  refVideo.playsInline = true;
  refVideo.crossOrigin = "anonymous";

  const userVideoEl = document.createElement("video");
  userVideoEl.src = userVideoUrl;
  userVideoEl.muted = true;
  userVideoEl.playsInline = true;
  userVideoEl.crossOrigin = "anonymous";

  await Promise.all([
    new Promise<void>((r) => {
      refVideo.onloadedmetadata = () => r();
    }),
    new Promise<void>((r) => {
      userVideoEl.onloadedmetadata = () => r();
    }),
  ]);

  onProgress?.({ currentFrame: 0, totalFrames, phase: "sampling" });

  const refSamples: FrameSample[] = [];
  const userSamples: FrameSample[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const { time, segmentIndex } = timestamps[i];
    onProgress?.({ currentFrame: i + 1, totalFrames, phase: "sampling" });

    const refSample = await sampleFrame(refVideo, net, time, segmentIndex);
    const userSample = await sampleFrame(userVideoEl, net, time, segmentIndex);
    refSamples.push(refSample);
    userSamples.push(userSample);
  }

  onProgress?.({ currentFrame: totalFrames, totalFrames, phase: "comparing" });

  const feedback: DanceFeedback[] = [];
  const segmentIndices = [...new Set(timestamps.map((t) => t.segmentIndex))].sort((a, b) => a - b);

  for (const segIdx of segmentIndices) {
    const segMeta = segments[segIdx]!;
    const midT = (segMeta.shared_start_sec + segMeta.shared_end_sec) / 2;
    const refSeg = segmentFramesSorted(refSamples, segIdx);
    const userSeg = segmentFramesSorted(userSamples, segIdx);
    const frameIndex = representativeDenseFrameIndex(refSamples, segIdx);
    feedback.push(
      ...buildFamilyFeedbackForSegment(segIdx, midT, frameIndex, refSeg, userSeg),
    );
  }

  const orderFam: FeedbackFeatureFamily[] = [
    "micro_timing",
    "upper_body",
    "lower_body",
    "attack_transition",
  ];
  feedback.sort((a, b) => {
    if (Math.abs(b.deviation - a.deviation) > 1e-9) return b.deviation - a.deviation;
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    const ai = orderFam.indexOf(a.featureFamily!);
    const bi = orderFam.indexOf(b.featureFamily!);
    return ai - bi;
  });

  const ranked = feedback.map((fb, i) => ({ ...fb, importanceRank: i + 1 }));

  onProgress?.({ currentFrame: totalFrames, totalFrames, phase: "done" });
  return { feedback: ranked, refSamples, userSamples };
}

function segmentFramesSorted(frames: FrameSample[], segIdx: number): FrameSample[] {
  return frames.filter((f) => f.segmentIndex === segIdx).sort((a, b) => a.timestamp - b.timestamp);
}
