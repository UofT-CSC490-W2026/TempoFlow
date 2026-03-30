import { KEYPOINT_NAMES, REGION_PARTS } from "./constants";
import type { BodyRegion, PoseKeypoint, SampledPoseFrame } from "./types";

type BodyPixModule = typeof import("@tensorflow-models/body-pix");
export type BodyPixNet = Awaited<ReturnType<BodyPixModule["load"]>>;

type Keypoint = PoseKeypoint;

let cachedNet: BodyPixNet | null = null;

export async function loadBodyPix(): Promise<BodyPixNet> {
  if (cachedNet) return cachedNet;
  const tf = await import("@tensorflow/tfjs-core");
  await import("@tensorflow/tfjs-backend-webgl");
  await tf.setBackend("webgl");
  await tf.ready();
  const bodyPix = await import("@tensorflow-models/body-pix");
  cachedNet = await bodyPix.load({
    architecture: "MobileNetV1",
    outputStride: 16,
    multiplier: 0.75,
    quantBytes: 2,
  });
  return cachedNet;
}

export function computePartCoverage(
  partData: Int32Array,
  totalPixels: number,
): Record<BodyRegion, number> {
  const counts: Record<number, number> = {};
  for (let i = 0; i < partData.length; i++) {
    const p = partData[i];
    if (p >= 0) counts[p] = (counts[p] ?? 0) + 1;
  }

  const result: Record<BodyRegion, number> = {
    head: 0,
    arms: 0,
    torso: 0,
    legs: 0,
    full_body: 0,
  };
  for (const region of Object.keys(REGION_PARTS) as BodyRegion[]) {
    let sum = 0;
    for (const part of REGION_PARTS[region]) {
      sum += counts[part] ?? 0;
    }
    result[region] = totalPixels > 0 ? sum / totalPixels : 0;
  }
  return result;
}

type FrameSample = SampledPoseFrame;

export async function sampleFrame(
  video: HTMLVideoElement,
  net: BodyPixNet,
  timestamp: number,
  segmentIndex: number,
): Promise<FrameSample> {
  video.currentTime = timestamp;
  await new Promise<void>((r) => {
    video.onseeked = () => r();
  });
  await new Promise((r) => setTimeout(r, 50));

  const seg = (await net.segmentPersonParts(video, {
    flipHorizontal: false,
    internalResolution: "medium",
    segmentationThreshold: 0.5,
    maxDetections: 1,
    scoreThreshold: 0.2,
    nmsRadius: 20,
  })) as {
    data: Int32Array;
    width: number;
    height: number;
    allPoses?: Array<{
      keypoints: Array<{ position: { x: number; y: number }; score: number; part: string }>;
    }>;
  };

  const keypoints: Keypoint[] = KEYPOINT_NAMES.map((name) => {
    const pose = seg.allPoses?.[0];
    const kp = pose?.keypoints?.find((k) => k.part === name);
    return kp
      ? { x: kp.position.x, y: kp.position.y, score: kp.score, name }
      : { x: 0, y: 0, score: 0, name };
  });

  const totalPixels = seg.width * seg.height;
  const partCoverage = computePartCoverage(seg.data, totalPixels);

  return {
    timestamp,
    segmentIndex,
    frameWidth: seg.width,
    frameHeight: seg.height,
    keypoints,
    partCoverage,
  };
}
