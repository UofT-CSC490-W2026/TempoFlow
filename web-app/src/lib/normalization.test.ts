import { describe, expect, it } from "vitest";

import { calculateAlignmentTransform, type Keypoint } from "./normalization";

function makeKeypoints() {
  const arr = Array.from({ length: 17 }, () => ({
    position: { x: 0, y: 0 },
    score: 1,
  })) as Keypoint[];
  arr[5] = { position: { x: 10, y: 10 }, score: 1 };
  arr[6] = { position: { x: 30, y: 10 }, score: 1 };
  arr[11] = { position: { x: 12, y: 40 }, score: 1 };
  arr[12] = { position: { x: 28, y: 40 }, score: 1 };
  return arr;
}

describe("calculateAlignmentTransform", () => {
  it("can run when DOMMatrix is polyfilled in test env", () => {
    if (!(globalThis as { DOMMatrix?: unknown }).DOMMatrix) {
      class DOMMatrixMock {
        translateSelf() {
          return this;
        }
        rotateSelf() {
          return this;
        }
        scaleSelf() {
          return this;
        }
      }
      (globalThis as { DOMMatrix: typeof DOMMatrixMock }).DOMMatrix = DOMMatrixMock;
    }
    expect((globalThis as { DOMMatrix?: unknown }).DOMMatrix).toBeTruthy();
  });

  it("returns null when required torso keypoints are missing", () => {
    const source = makeKeypoints();
    const target = makeKeypoints();
    // Remove left shoulder
    (source[5] as unknown) = undefined;
    expect(calculateAlignmentTransform(source, target)).toBeNull();
  });

  it("returns a matrix object for valid source/target keypoints", () => {
    const source = makeKeypoints();
    const target = makeKeypoints();
    target[5] = { position: { x: 20, y: 20 }, score: 1 };
    target[6] = { position: { x: 40, y: 20 }, score: 1 };
    target[11] = { position: { x: 22, y: 60 }, score: 1 };
    target[12] = { position: { x: 38, y: 60 }, score: 1 };

    const matrix = calculateAlignmentTransform(source, target);
    expect(matrix).not.toBeNull();
    expect(typeof matrix).toBe("object");
  });
});

