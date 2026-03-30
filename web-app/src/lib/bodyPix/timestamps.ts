/** Timestamps at ~`fps` within each segment [start, end). */
export function generateDenseTimestampsForSegments(
  segments: Array<{ shared_start_sec: number; shared_end_sec: number }>,
  fps: number,
): Array<{ time: number; segmentIndex: number }> {
  const dt = 1 / Math.max(0.5, fps);
  const out: Array<{ time: number; segmentIndex: number }> = [];
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const start = segments[segIdx].shared_start_sec;
    const end = segments[segIdx].shared_end_sec;
    if (!(end > start)) continue;
    let t = start;
    while (t < end - 1e-5) {
      out.push({ time: t, segmentIndex: segIdx });
      t += dt;
    }
  }
  return out;
}

export function generateSampleTimestamps(
  segments: Array<{ shared_start_sec: number; shared_end_sec: number }>,
  sampleInterval: number = 1.0,
): Array<{ time: number; segmentIndex: number }> {
  const timestamps: Array<{ time: number; segmentIndex: number }> = [];

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    const duration = seg.shared_end_sec - seg.shared_start_sec;
    const numSamples = Math.max(2, Math.ceil(duration / sampleInterval));
    const step = duration / numSamples;

    for (let j = 0; j < numSamples; j++) {
      timestamps.push({
        time: seg.shared_start_sec + j * step,
        segmentIndex: segIdx,
      });
    }
  }

  return timestamps;
}
