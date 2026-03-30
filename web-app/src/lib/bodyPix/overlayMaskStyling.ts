import { BODYPIX_PART_COLORS } from "./palette";

export type RgbColor = {
  r: number;
  g: number;
  b: number;
};

type ImageDataLike = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

type OverlayMaskStyleOptions = {
  color: RgbColor;
  borderColor?: RgbColor;
  fillOpacity?: number;
  contourOpacity?: number;
  contourRadius?: number;
  seamOpacity?: number;
  seamRadius?: number;
  glowOpacity?: number;
  glowRadius?: number;
};

const TRANSPARENT_ALPHA_THRESHOLD = 8;
const BODYPIX_SEMANTIC_PART_MAP = [
  0, // left face -> head
  0, // right face -> head
  1, // left upper arm front
  1, // left upper arm back
  2, // right upper arm front
  2, // right upper arm back
  3, // left forearm front
  3, // left forearm back
  4, // right forearm front
  4, // right forearm back
  5, // left hand
  6, // right hand
  7, // torso front
  7, // torso back
  8, // left thigh front
  8, // left thigh back
  9, // right thigh front
  9, // right thigh back
  10, // left calf front
  10, // left calf back
  11, // right calf front
  11, // right calf back
  12, // left foot
  13, // right foot
] as const;

function findNearestPartIndex(
  r: number,
  g: number,
  b: number,
  cache: Map<number, number>,
) {
  const key = (r << 16) | (g << 8) | b;
  const cached = cache.get(key);
  if (cached != null) return cached;

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < BODYPIX_PART_COLORS.length; index += 1) {
    const [pr, pg, pb] = BODYPIX_PART_COLORS[index]!;
    const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  cache.set(key, bestIndex);
  return bestIndex;
}

function mapPixelsToPartIndices(source: ImageDataLike) {
  const partIndices = new Int16Array(source.width * source.height);
  partIndices.fill(-1);
  const cache = new Map<number, number>();

  for (let index = 0; index < partIndices.length; index += 1) {
    const px = index * 4;
    if (source.data[px + 3] <= TRANSPARENT_ALPHA_THRESHOLD) continue;

    const rawPart = findNearestPartIndex(
      source.data[px] ?? 0,
      source.data[px + 1] ?? 0,
      source.data[px + 2] ?? 0,
      cache,
    );
    partIndices[index] = BODYPIX_SEMANTIC_PART_MAP[rawPart] ?? rawPart;
  }

  return partIndices;
}

function mapBodyPixPartsToPartIndices(
  parts: ArrayLike<number>,
  width: number,
  height: number,
) {
  const totalPixels = width * height;
  const partIndices = new Int16Array(totalPixels);
  partIndices.fill(-1);

  const limit = Math.min(totalPixels, parts.length);
  for (let index = 0; index < limit; index += 1) {
    const rawPart = Number(parts[index] ?? -1);
    if (rawPart < 0) continue;
    partIndices[index] = BODYPIX_SEMANTIC_PART_MAP[rawPart] ?? rawPart;
  }

  return partIndices;
}

function buildBoundarySeedMask(partIndices: Int16Array, width: number, height: number) {
  const contourSeedMask = new Uint8Array(partIndices.length);
  const seamSeedMask = new Uint8Array(partIndices.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const part = partIndices[idx];
      if (part < 0) continue;

      let isContour = false;
      let isSeam = false;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) {
          isContour = true;
          break;
        }
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (dx === 0 && dy === 0) continue;
          if (nx < 0 || nx >= width) {
            isContour = true;
            break;
          }
          const neighbor = partIndices[ny * width + nx];
          if (neighbor < 0) {
            isContour = true;
            continue;
          }
          if (neighbor !== part) {
            isSeam = true;
          }
        }
        if (isContour) break;
      }

      if (isContour) contourSeedMask[idx] = 1;
      if (isSeam) seamSeedMask[idx] = 1;
    }
  }

  return { contourSeedMask, seamSeedMask };
}

function dilateMask(seedMask: Uint8Array, width: number, height: number, radius: number) {
  if (radius <= 0) return seedMask;

  const expanded = new Uint8Array(seedMask.length);
  const maxDistanceSquared = radius * radius;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (!seedMask[idx]) continue;

      for (let dy = -radius; dy <= radius; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (dx * dx + dy * dy > maxDistanceSquared) continue;
          expanded[ny * width + nx] = 1;
        }
      }
    }
  }

  return expanded;
}

function renderStyledMask(
  partIndices: Int16Array,
  width: number,
  height: number,
  options: OverlayMaskStyleOptions,
) {
  const {
    color,
    borderColor = { r: 10, g: 10, b: 10 },
    fillOpacity = 0.12,
    contourOpacity = 0.95,
    contourRadius = 3,
    seamOpacity = 0.62,
    seamRadius = 1,
    glowOpacity = 0.22,
    glowRadius = 4,
  } = options;

  const { contourSeedMask, seamSeedMask } = buildBoundarySeedMask(
    partIndices,
    width,
    height,
  );
  const contourMask = dilateMask(contourSeedMask, width, height, contourRadius);
  const seamMask = dilateMask(seamSeedMask, width, height, seamRadius);
  const glowMask = dilateMask(contourSeedMask, width, height, glowRadius);
  const output = new Uint8ClampedArray(width * height * 4);
  const fillAlpha = Math.round(fillOpacity * 255);
  const contourAlpha = Math.round(contourOpacity * 255);
  const seamAlpha = Math.round(seamOpacity * 255);
  const glowAlpha = Math.round(glowOpacity * 255);

  for (let index = 0; index < partIndices.length; index += 1) {
    const hasBody = partIndices[index] >= 0;
    const hasContour = contourMask[index] === 1;
    const hasSeam = seamMask[index] === 1;
    const hasGlow = glowMask[index] === 1;
    if (!hasBody && !hasContour && !hasGlow) continue;

    const px = index * 4;

    let alpha = 0;
    let rgb = color;

    if (hasGlow) alpha = Math.max(alpha, glowAlpha);
    if (hasBody) alpha = Math.max(alpha, fillAlpha);
    if (hasBody && hasSeam) {
      alpha = Math.max(alpha, seamAlpha);
      rgb = borderColor;
    }
    if (hasContour) {
      alpha = Math.max(alpha, contourAlpha);
      rgb = borderColor;
    }

    output[px] = rgb.r;
    output[px + 1] = rgb.g;
    output[px + 2] = rgb.b;

    output[px + 3] = alpha;
  }

  return {
    data: output,
    width,
    height,
  };
}

export function styleOverlayMask(
  source: ImageDataLike,
  options: OverlayMaskStyleOptions,
) {
  return renderStyledMask(
    mapPixelsToPartIndices(source),
    source.width,
    source.height,
    options,
  );
}

export function styleBodyPixMask(
  parts: ArrayLike<number>,
  width: number,
  height: number,
  options: OverlayMaskStyleOptions,
) {
  return renderStyledMask(
    mapBodyPixPartsToPartIndices(parts, width, height),
    width,
    height,
    options,
  );
}
