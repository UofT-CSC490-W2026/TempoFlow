import { describe, expect, it } from "vitest";

import type { PoseKeypoint } from "../../lib/bodyPix";
import { buildOverlayPosePairs, transformReferencePoseToPractice } from "./overlayPoseMatching";

function makePose(centerX: number, centerY: number, height = 0.3): PoseKeypoint[] {
  const left = centerX - 0.04;
  const right = centerX + 0.04;
  const headY = centerY - height / 2;
  const hipY = centerY + height * 0.1;
  const footY = centerY + height / 2;
  return Array.from({ length: 17 }, (_, index) => ({
    name: `kp-${index}`,
    x:
      index === 5 || index === 7 || index === 9 || index === 11 || index === 13 || index === 15
        ? left
        : index === 6 || index === 8 || index === 10 || index === 12 || index === 14 || index === 16
          ? right
          : centerX,
    y:
      index === 0
        ? headY
        : index === 5 || index === 6
          ? centerY - height * 0.18
          : index === 11 || index === 12
            ? hipY
            : index === 15 || index === 16
              ? footY
              : centerY,
    score: 0.95,
  }));
}

describe("overlayPoseMatching", () => {
  it("duplicates reference dancers across more practice dancers", () => {
    const references = [makePose(0.25, 0.5), makePose(0.75, 0.5)];
    const practices = [makePose(0.1, 0.5), makePose(0.35, 0.5), makePose(0.65, 0.5), makePose(0.9, 0.5)];

    const pairs = buildOverlayPosePairs(references, practices);

    expect(pairs).toHaveLength(4);
    expect(pairs[0]?.reference[0]?.x).toBeCloseTo(references[0]![0]!.x);
    expect(pairs[1]?.reference[0]?.x).toBeCloseTo(references[0]![0]!.x);
    expect(pairs[2]?.reference[0]?.x).toBeCloseTo(references[1]![0]!.x);
    expect(pairs[3]?.reference[0]?.x).toBeCloseTo(references[1]![0]!.x);
  });

  it("selects a unique subset when there are more reference dancers than practice dancers", () => {
    const references = [makePose(0.1, 0.5), makePose(0.35, 0.5), makePose(0.65, 0.5), makePose(0.9, 0.5)];
    const practices = [makePose(0.25, 0.5), makePose(0.75, 0.5)];

    const pairs = buildOverlayPosePairs(references, practices);

    expect(pairs).toHaveLength(2);
    expect(pairs[0]?.reference[0]?.x).not.toBeCloseTo(pairs[1]?.reference[0]?.x ?? 0);
  });

  it("moves the reference pose directly onto the practice pose center", () => {
    const reference = makePose(0.2, 0.45, 0.2);
    const practice = makePose(0.72, 0.61, 0.4);

    const transformed = transformReferencePoseToPractice(reference, practice);
    const transformedHead = transformed[0]!;
    const practiceHead = practice[0]!;

    expect(transformedHead.x).toBeCloseTo(practiceHead.x, 1);
    expect(transformedHead.y).toBeCloseTo(practiceHead.y, 1);
  });
});
