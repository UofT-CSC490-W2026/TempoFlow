export function meanOfSamples(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

export function medianOfSamples(nums: number[]): number {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Population std-dev of samples; used by attack metrics and tests. */
export function stdDeviation(nums: number[]): number {
  if (nums.length < 2) return 0;
  const m = meanOfSamples(nums);
  return Math.sqrt(meanOfSamples(nums.map((x) => (x - m) ** 2)));
}
