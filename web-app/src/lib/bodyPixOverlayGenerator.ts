"use client";

type BodyPixModule = typeof import("@tensorflow-models/body-pix");
type BodyPixNet = Awaited<ReturnType<BodyPixModule["load"]>>;

const BODYPIX_PART_COLORS: Array<[number, number, number]> = [
  [110, 64, 170],
  [106, 72, 183],
  [100, 81, 196],
  [92, 91, 206],
  [84, 101, 214],
  [75, 113, 221],
  [66, 125, 224],
  [56, 138, 226],
  [48, 150, 224],
  [40, 163, 220],
  [33, 176, 214],
  [29, 188, 205],
  [26, 199, 194],
  [26, 210, 182],
  [28, 219, 169],
  [33, 227, 155],
  [41, 234, 141],
  [51, 240, 128],
  [64, 243, 116],
  [79, 246, 105],
  [96, 247, 97],
  [115, 246, 91],
  [134, 245, 88],
  [155, 243, 88],
];

let bodyPixPromise: Promise<BodyPixNet> | null = null;

async function getBodyPix() {
  if (!bodyPixPromise) {
    bodyPixPromise = (async () => {
      const tf = await import("@tensorflow/tfjs-core");
      await import("@tensorflow/tfjs-backend-webgl");
      await tf.setBackend("webgl");
      await tf.ready();

      const bodyPix = await import("@tensorflow-models/body-pix");
      return bodyPix.load({
        architecture: "MobileNetV1",
        outputStride: 16,
        multiplier: 0.75,
        quantBytes: 2,
      });
    })();
  }
  return bodyPixPromise;
}

function waitForEvent(target: EventTarget, eventName: string) {
  return new Promise<void>((resolve, reject) => {
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Failed while waiting for ${eventName}.`));
    };
    const cleanup = () => {
      target.removeEventListener(eventName, onSuccess);
      target.removeEventListener("error", onError);
    };
    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

async function seekVideo(video: HTMLVideoElement, timeSec: number) {
  if (Math.abs(video.currentTime - timeSec) < 0.001) return;
  const seekPromise = waitForEvent(video, "seeked");
  video.currentTime = timeSec;
  await seekPromise;
}

export async function generateBodyPixOverlayFrames(params: {
  videoUrl: string;
  fps?: number;
  opacity?: number;
  startSec?: number;
  endSec?: number;
  onProgress?: (completed: number, total: number) => void;
}): Promise<{ frames: Array<string | Blob>; fps: number; width: number; height: number }> {
  const {
    videoUrl,
    fps = 12,
    opacity = 0.68,
    onProgress,
  } = params;

  const net = await getBodyPix();
  const video = document.createElement("video");
  video.src = videoUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  await waitForEvent(video, "loadeddata");

  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Video duration is unavailable for BodyPix overlay generation.");
  }

  const segmentStartSec = Math.max(0, Math.min(duration, params.startSec ?? 0));
  const rawSegmentEndSec = params.endSec ?? duration;
  const segmentEndSec = Math.max(segmentStartSec, Math.min(duration, rawSegmentEndSec));
  const segmentDurationSec = segmentEndSec - segmentStartSec;
  if (segmentDurationSec <= 0) {
    throw new Error("BodyPix overlay segment duration must be greater than 0.");
  }

  const width = video.videoWidth || 640;
  const height = video.videoHeight || 480;
  const totalFrames = Math.max(1, Math.ceil(segmentDurationSec * fps));

  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = width;
  outputCanvas.height = height;
  const outputCtx = outputCanvas.getContext("2d");
  if (!outputCtx) throw new Error("Failed to create output canvas.");

  const maskCanvas = document.createElement("canvas");
  const frames: Array<string | Blob> = [];

  for (let i = 0; i < totalFrames; i += 1) {
    const t = Math.min(segmentEndSec - 0.001, segmentStartSec + i / fps);
    // eslint-disable-next-line no-await-in-loop
    await seekVideo(video, Math.max(0, t));

    // eslint-disable-next-line no-await-in-loop
    const seg = (await net.segmentPersonParts(video, {
      flipHorizontal: false,
      internalResolution: "medium",
      segmentationThreshold: 0.5,
      maxDetections: 1,
      scoreThreshold: 0.2,
      nmsRadius: 20,
    })) as { data: Int32Array; width: number; height: number };

    maskCanvas.width = seg.width;
    maskCanvas.height = seg.height;
    const maskCtx = maskCanvas.getContext("2d");
    if (!maskCtx) throw new Error("Failed to create mask canvas.");

    const image = maskCtx.createImageData(seg.width, seg.height);
    const data = image.data;
    const parts = seg.data;

    for (let p = 0; p < parts.length; p += 1) {
      const part = parts[p];
      if (part < 0) continue;
      const px = p * 4;
      const c = BODYPIX_PART_COLORS[part] ?? [56, 189, 248];
      data[px] = c[0];
      data[px + 1] = c[1];
      data[px + 2] = c[2];
      data[px + 3] = Math.round(255 * opacity);
    }

    maskCtx.putImageData(image, 0, 0);
    outputCtx.clearRect(0, 0, width, height);
    outputCtx.imageSmoothingEnabled = true;
    outputCtx.imageSmoothingQuality = "high";
    outputCtx.drawImage(maskCanvas, 0, 0, width, height);

    // eslint-disable-next-line no-await-in-loop
    const blob = await new Promise<Blob>((resolve, reject) => {
      outputCanvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Failed to encode BodyPix frame."))),
        "image/webp",
        0.85,
      );
    });
    frames.push(blob);
    onProgress?.(i + 1, totalFrames);
  }

  return { frames, fps, width, height };
}
