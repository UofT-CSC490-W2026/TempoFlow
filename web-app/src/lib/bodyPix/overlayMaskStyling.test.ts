import { describe, expect, it } from "vitest";
import { BODYPIX_PART_COLORS } from "./palette";
import { styleOverlayMask } from "./overlayMaskStyling";

function makeSourceImageData() {
  const width = 6;
  const height = 4;
  const data = new Uint8ClampedArray(width * height * 4);
  const left = BODYPIX_PART_COLORS[1]!;
  const right = BODYPIX_PART_COLORS[2]!;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const px = (y * width + x) * 4;
      const color = x < 3 ? left : right;
      data[px] = color[0];
      data[px + 1] = color[1];
      data[px + 2] = color[2];
      data[px + 3] = 255;
    }
  }

  return { data, width, height };
}

describe("styleOverlayMask", () => {
  it("creates strong borders for outer edges and internal seams", () => {
    const result = styleOverlayMask(makeSourceImageData(), {
      color: { r: 249, g: 115, b: 22 },
      fillOpacity: 0.15,
      contourOpacity: 0.95,
      contourRadius: 0,
      seamOpacity: 0.6,
      seamRadius: 0,
      glowOpacity: 0,
      glowRadius: 0,
    });

    const alphaAt = (x: number, y: number) => result.data[(y * result.width + x) * 4 + 3];

    expect(alphaAt(0, 1)).toBe(Math.round(0.95 * 255));
    expect(alphaAt(2, 1)).toBe(Math.round(0.6 * 255));
    expect(alphaAt(3, 1)).toBe(Math.round(0.6 * 255));
    expect(alphaAt(1, 1)).toBe(Math.round(0.15 * 255));
    expect(alphaAt(4, 1)).toBe(Math.round(0.15 * 255));
  });

  it("merges raw head halves into a single semantic region", () => {
    const width = 2;
    const height = 1;
    const data = new Uint8ClampedArray(width * height * 4);
    const leftFace = BODYPIX_PART_COLORS[0]!;
    const rightFace = BODYPIX_PART_COLORS[1]!;

    data[0] = leftFace[0];
    data[1] = leftFace[1];
    data[2] = leftFace[2];
    data[3] = 255;

    data[4] = rightFace[0];
    data[5] = rightFace[1];
    data[6] = rightFace[2];
    data[7] = 255;

    const result = styleOverlayMask(
      { data, width, height },
      {
        color: { r: 14, g: 165, b: 233 },
        fillOpacity: 0.2,
        contourOpacity: 0.9,
        contourRadius: 0,
        seamOpacity: 0.5,
        seamRadius: 0,
        glowOpacity: 0,
        glowRadius: 0,
      },
    );

    const alphaAt = (x: number) => result.data[x * 4 + 3];

    expect(alphaAt(0)).toBe(Math.round(0.9 * 255));
    expect(alphaAt(1)).toBe(Math.round(0.9 * 255));
  });
});
