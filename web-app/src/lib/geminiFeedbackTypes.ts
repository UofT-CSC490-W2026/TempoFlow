export type GeminiMoveResult = {
  move_index: number;
  time_window: string;
  micro_timing_label: string;
  micro_timing_evidence: string;
  body_parts_involved: string[];
  coaching_note: string;
  confidence: string;
  shared_start_sec?: number;
  shared_end_sec?: number;
  /** Model output: user timing vs reference within the move window */
  user_relative_to_reference?: string;
  guardrail_note?: string;
};

export type GeminiSegmentResult = {
  segment_index: number;
  model?: string;
  moves: GeminiMoveResult[];
  error?: string;
};

export type GeminiFlatMove = GeminiMoveResult & { segmentIndex: number };
