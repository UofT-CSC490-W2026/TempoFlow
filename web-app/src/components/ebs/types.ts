export type EbsAlignment = {
  clip_1_start_sec: number;
  clip_1_end_sec?: number;
  clip_2_start_sec: number;
  clip_2_end_sec?: number;
  shared_len_sec: number;
  /** Present when alignment was computed by auto_align (chroma_sw vs onset_xcorr). */
  auto_align_mode?: "chroma_sw" | "onset_xcorr";
};

export type EbsSegment = {
  seg_id?: number | string;
  shared_start_sec: number;
  shared_end_sec: number;
  beat_idx_range?: [number, number];
  clip_1_seg_start_sec?: number;
  clip_1_seg_end_sec?: number;
  clip_2_seg_start_sec?: number;
  clip_2_seg_end_sec?: number;
};

export type EbsBeatTracking = {
  estimated_bpm?: number;
  num_beats?: number;
  num_beats_detected?: number;
  source?: string;
};

export type EbsVideoMeta = {
  fps?: number;
  duration_sec?: number;
  frame_count?: number;
};

export type EbsData = {
  alignment: EbsAlignment;
  segments: EbsSegment[];
  beats_shared_sec?: number[];
  beat_tracking?: EbsBeatTracking;
  segmentation_mode?: string;
  video_meta?: {
    clip_1?: EbsVideoMeta;
    clip_2?: EbsVideoMeta;
  };
};

export type PracticeMove = {
  idx: number;
  num: number;
  startSec: number;
  endSec: number;
  isTransition: boolean;
};

