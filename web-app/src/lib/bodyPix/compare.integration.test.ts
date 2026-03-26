// @vitest-environment happy-dom

import { KEYPOINT_NAMES } from "./constants";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const { segmentPersonPartsMock, bodyPixLoadMock } = vi.hoisted(() => ({
  segmentPersonPartsMock: vi.fn(),
  bodyPixLoadMock: vi.fn(),
}));

vi.mock("@tensorflow/tfjs-core", () => ({
  setBackend: vi.fn(() => Promise.resolve()),
  ready: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tensorflow/tfjs-backend-webgl", () => ({}));

vi.mock("@tensorflow-models/body-pix", () => ({
  load: (...args: unknown[]) => bodyPixLoadMock(...args),
}));

function makePose(
  offset: number,
  opts?: { lowShoulders?: boolean; sparse?: boolean; lowKnees?: boolean },
) {
  const keypoints = KEYPOINT_NAMES.map((part, i) => {
    if (opts?.sparse && i > 0) {
      return { part, score: 0, position: { x: 0, y: 0 } };
    }
    const shoulderLow =
      opts?.lowShoulders && (part === "leftShoulder" || part === "rightShoulder");
    const kneeLow =
      opts?.lowKnees &&
      (part === "leftKnee" || part === "rightKnee" || part === "leftAnkle" || part === "rightAnkle");
    return {
      part,
      score: shoulderLow || kneeLow ? 0.1 : 0.95,
      position: { x: 100 + i * 4 + offset, y: 80 + i * 3 + offset * 0.5 },
    };
  });
  return { keypoints };
}

function makeSegResponse(
  offset: number,
  overrides?: Parameters<typeof makePose>[1],
) {
  const width = 10;
  const height = 10;
  const data = new Int32Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = i % 24;
  }
  data[0] = -1;
  return {
    data,
    width,
    height,
    allPoses: [makePose(offset, overrides)],
  };
}

function mockVideo() {
  let _currentTime = 0;
  let _onseeked: (() => void) | null = null;
  const el = {
    muted: false,
    playsInline: false,
    crossOrigin: "",
    src: "",
    get currentTime() {
      return _currentTime;
    },
    set currentTime(v: number) {
      _currentTime = v;
      queueMicrotask(() => _onseeked?.());
    },
    set onseeked(h: (() => void) | null) {
      _onseeked = h;
    },
    get onseeked() {
      return _onseeked;
    },
    set onloadedmetadata(h: (() => void) | null) {
      if (h) queueMicrotask(() => h());
    },
    get onloadedmetadata() {
      return null;
    },
  };
  return el as unknown as HTMLVideoElement;
}

let createElementSpy: MockInstance<typeof document.createElement>;

beforeEach(async () => {
  vi.resetModules();
  bodyPixLoadMock.mockClear();
  segmentPersonPartsMock.mockClear();
  vi.unstubAllGlobals();
  vi.stubGlobal("setTimeout", (fn: (...args: unknown[]) => void, _ms?: number) => {
    if (typeof fn === "function") fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });

  bodyPixLoadMock.mockResolvedValue({
    segmentPersonParts: (v: unknown, _o: unknown) => segmentPersonPartsMock(v, _o),
  });

  const original = document.createElement.bind(document) as typeof document.createElement;
  createElementSpy = vi.spyOn(document, "createElement").mockImplementation(
    (tagName: string, options?: ElementCreationOptions): HTMLElement => {
      if (tagName === "video") return mockVideo();
      return original(tagName, options);
    },
  );
});

afterEach(() => {
  createElementSpy?.mockRestore();
  vi.unstubAllGlobals();
});

async function importCompare() {
  const { compareWithBodyPix } = await import("./compare");
  return compareWithBodyPix;
}

describe("compareWithBodyPix (integration)", () => {
  it("handles zero-area segmentation mask (totalPixels === 0)", async () => {
    let call = 0;
    segmentPersonPartsMock.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return {
          data: new Int32Array(0),
          width: 0,
          height: 0,
          allPoses: [makePose(0)],
        };
      }
      return makeSegResponse(0);
    });
    const compareWithBodyPix = await importCompare();
    const res = await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.35 }],
      poseFps: 12,
    });
    expect(res.refSamples[0]!.partCoverage.full_body).toBe(0);
  });

  it("returns empty samples when no timestamps", async () => {
    segmentPersonPartsMock.mockImplementation(() => makeSegResponse(0));
    const compareWithBodyPix = await importCompare();
    const progress: { phase: string }[] = [];
    const res = await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0 }],
      onProgress: (p) => progress.push({ phase: p.phase }),
    });
    expect(res.feedback).toEqual([]);
    expect(res.refSamples).toEqual([]);
    expect(progress.some((p) => p.phase === "done")).toBe(true);
  });

  it("runs sampling, comparison, ranking, and reports progress", async () => {
    segmentPersonPartsMock.mockImplementation(() => makeSegResponse(0));
    const compareWithBodyPix = await importCompare();
    const phases: string[] = [];
    const res = await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.6 }],
      poseFps: 10,
      onProgress: (p) => phases.push(p.phase),
    });
    expect(res.refSamples.length).toBeGreaterThan(1);
    expect(res.userSamples.length).toBe(res.refSamples.length);
    expect(phases).toContain("loading");
    expect(phases).toContain("sampling");
    expect(phases).toContain("comparing");
    expect(phases[phases.length - 1]).toBe("done");
    expect(res.feedback.length).toBeGreaterThan(0);
    expect(res.feedback[0]!.importanceRank).toBe(1);
    expect(segmentPersonPartsMock).toHaveBeenCalled();
  });

  it("reuses cached BodyPix net on second run", async () => {
    segmentPersonPartsMock.mockImplementation(() => makeSegResponse(0));
    const compareWithBodyPix = await importCompare();
    await compareWithBodyPix({
      referenceVideoUrl: "a.mp4",
      userVideoUrl: "b.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.4 }],
      poseFps: 8,
    });
    await compareWithBodyPix({
      referenceVideoUrl: "a.mp4",
      userVideoUrl: "b.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.4 }],
      poseFps: 8,
    });
    expect(bodyPixLoadMock).toHaveBeenCalledTimes(1);
  });

  it("covers segmentPerson without allPoses (zero score keypoints)", async () => {
    segmentPersonPartsMock.mockImplementation(() => {
      const base = makeSegResponse(0);
      return { ...base, allPoses: undefined };
    });
    const compareWithBodyPix = await importCompare();
    const res = await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.5 }],
      poseFps: 12,
    });
    expect(res.refSamples[0]!.keypoints.every((k) => k.score === 0)).toBe(true);
  });

  it("covers sparse user pose keypoints vs full reference", async () => {
    let call = 0;
    segmentPersonPartsMock.mockImplementation(() => {
      call += 1;
      if (call % 2 === 1) return makeSegResponse(0);
      return makeSegResponse(0, { sparse: true });
    });
    const compareWithBodyPix = await importCompare();
    await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.5 }],
      poseFps: 15,
    });
    expect(call).toBeGreaterThan(0);
  });

  it("covers upperBodyFeat shoulder gate and lowerBody knee nulls", async () => {
    let call = 0;
    segmentPersonPartsMock.mockImplementation(() => {
      call += 1;
      if (call <= 4) return makeSegResponse(0, { lowShoulders: call % 2 === 1 });
      return makeSegResponse(0, { lowKnees: true });
    });
    const compareWithBodyPix = await importCompare();
    await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.55 }],
      poseFps: 14,
    });
  });

  it("covers micro-timing branches (flat motion + settle ratio clamp)", async () => {
    segmentPersonPartsMock.mockImplementation(() => makeSegResponse(0, { lowKnees: true }));
    const compareWithBodyPix = await importCompare();
    await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.45 }],
      poseFps: 20,
    });
  });

  it("assigns unique importance ranks under load", async () => {
    let call = 0;
    segmentPersonPartsMock.mockImplementation(() => {
      const isRef = call % 2 === 0;
      const frameIdx = Math.floor(call / 2);
      call += 1;
      const refOff = frameIdx % 2 === 0 ? 0 : 420;
      const userOff = frameIdx * 6 + 380;
      return makeSegResponse(isRef ? refOff : userOff);
    });
    const compareWithBodyPix = await importCompare();
    const res = await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.85 }],
      poseFps: 24,
    });
    const ranks = new Set(res.feedback.map((f) => f.importanceRank));
    expect(ranks.size).toBe(res.feedback.length);
  });

  it("covers wrapAngleDiffRad in lower body when step directions diverge", async () => {
    let t = 0;
    segmentPersonPartsMock.mockImplementation(() => {
      const base = makeSegResponse(0);
      const ankleBoost = t++ < 4 ? 0 : 500;
      const kps = base.allPoses![0]!.keypoints.map((k) =>
        k.part === "leftAnkle" || k.part === "rightAnkle"
          ? { ...k, position: { x: k.position.x + ankleBoost, y: k.position.y + ankleBoost } }
          : k,
      );
      return { ...base, allPoses: [{ keypoints: kps }] };
    });
    const compareWithBodyPix = await importCompare();
    await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.5 }],
      poseFps: 16,
    });
  });

  it("sort tie-break uses timestamp then feature order", async () => {
    segmentPersonPartsMock.mockImplementation(() => makeSegResponse(0));
    const compareWithBodyPix = await importCompare();
    const res = await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [
        { shared_start_sec: 0, shared_end_sec: 0.35 },
        { shared_start_sec: 0.5, shared_end_sec: 0.85 },
      ],
      poseFps: 14,
    });
    expect(res.feedback.length).toBeGreaterThan(4);
  });

  it("hits joint motion wrap when angles jump > 180° between frames", async () => {
    let frame = 0;
    segmentPersonPartsMock.mockImplementation(() => {
      const base = makeSegResponse(0);
      const kps = base.allPoses![0]!.keypoints.map((k) => {
        if (k.part !== "leftElbow") return k;
        const flip = frame > 2 ? 400 : 0;
        frame += 1;
        return { ...k, position: { x: k.position.x + flip, y: k.position.y } };
      });
      return { ...base, allPoses: [{ keypoints: kps }] };
    });
    const compareWithBodyPix = await importCompare();
    await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.55 }],
      poseFps: 22,
    });
  });

  it("hits normalizeKeypoints early return when fewer than 2 confident points", async () => {
    segmentPersonPartsMock.mockImplementation(() => makeSegResponse(0, { sparse: true }));
    const compareWithBodyPix = await importCompare();
    await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.4 }],
      poseFps: 12,
    });
  });

  it("hits familyMessage close-to-reference line for tiny deviations", async () => {
    segmentPersonPartsMock.mockImplementation(() => makeSegResponse(0));
    const compareWithBodyPix = await importCompare();
    const res = await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.25 }],
      poseFps: 30,
    });
    expect(res.feedback.some((f) => f.message.includes("Close to the reference"))).toBe(true);
  });

  it("uses attack tailEnergy single-sample path with only two dense timestamps", async () => {
    segmentPersonPartsMock.mockImplementation(() => makeSegResponse(0));
    const compareWithBodyPix = await importCompare();
    await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.2 }],
      poseFps: 6,
    });
  });

  it("hits upperBodyFeat fallback when every frame lacks confident shoulders", async () => {
    segmentPersonPartsMock.mockImplementation(() => makeSegResponse(0, { lowShoulders: true }));
    const compareWithBodyPix = await importCompare();
    await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.4 }],
      poseFps: 10,
    });
  });

  it("hits lowerBodyFeat with no valid knee angles but valid ankle spread", async () => {
    segmentPersonPartsMock.mockImplementation(() => makeSegResponse(0, { lowKnees: true }));
    const compareWithBodyPix = await importCompare();
    await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.45 }],
      poseFps: 12,
    });
  });

  it("hits jointMotionBetweenFrames with no valid joint deltas (all low confidence)", async () => {
    segmentPersonPartsMock.mockImplementation(() => {
      const base = makeSegResponse(0);
      const kps = base.allPoses![0]!.keypoints.map((k) => ({
        ...k,
        score: 0.05,
      }));
      return { ...base, allPoses: [{ keypoints: kps }] };
    });
    const compareWithBodyPix = await importCompare();
    await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.4 }],
      poseFps: 14,
    });
  });

  it("caps upperBodyDeviation at 1 under extreme offsets", async () => {
    let call = 0;
    segmentPersonPartsMock.mockImplementation(() => {
      const off = call % 2 === 0 ? 0 : 9000;
      call += 1;
      return makeSegResponse(off);
    });
    const compareWithBodyPix = await importCompare();
    await compareWithBodyPix({
      referenceVideoUrl: "ref.mp4",
      userVideoUrl: "user.mp4",
      segments: [{ shared_start_sec: 0, shared_end_sec: 0.5 }],
      poseFps: 10,
    });
  });
});
