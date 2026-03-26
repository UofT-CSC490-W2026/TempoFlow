from pydantic import BaseModel
from typing import List, Optional

class TimeRange(BaseModel):
    start_time: float
    end_time: float

class Segment(BaseModel):
    start_time: float
    end_time: float
    beat_times: List[List[float]] = []

class AlignmentResult(BaseModel):
    file_a: TimeRange
    file_b: TimeRange

class AlignmentAndSegmentationResult(BaseModel):
    alignment: AlignmentResult
    clip_a_segments: List[Segment]
    clip_b_segments: List[Segment]
    confidence: Optional[dict] = None

