"""
Temporal transformation functions for the dancer alignment validation pipeline.
Implements drift/offset injection by trimming video starts.
"""

from typing import List, Tuple
import numpy as np


def apply_temporal_offset(frames: List[np.ndarray], 
                          offset_seconds: float, 
                          fps: float) -> Tuple[List[np.ndarray], float]:
    """
    Apply temporal offset by trimming the start of the video.
    
    This simulates synchronization drift between reference and transformed videos.
    
    Args:
        frames: List of video frames
        offset_seconds: Number of seconds to trim from the start (0.1 to 0.5 typical)
        fps: Frames per second of the video
        
    Returns:
        Tuple of (offset frames, actual offset in seconds)
    """
    if not frames or offset_seconds <= 0:
        return frames, 0.0
    
    frames_to_skip = int(offset_seconds * fps)
    
    # Ensure we don't skip all frames
    if frames_to_skip >= len(frames):
        frames_to_skip = max(0, len(frames) - 1)
    
    offset_frames = frames[frames_to_skip:]
    actual_offset = frames_to_skip / fps if fps > 0 else 0
    
    return offset_frames, actual_offset


def calculate_expected_score_for_offset(offset_seconds: float) -> Tuple[float, float]:
    """
    Calculate the expected score range for a given temporal offset.
    
    Larger offsets should result in lower scores as the movements
    become more desynchronized.
    
    Args:
        offset_seconds: The temporal offset applied
        
    Returns:
        Tuple of (min_expected_score, max_expected_score)
    """
    # Linear scoring model: 
    # 0s offset -> 95-100% score
    # 0.5s offset -> 40-60% score
    # Interpolate linearly between these
    
    if offset_seconds <= 0:
        return (0.95, 1.0)
    elif offset_seconds >= 0.5:
        return (0.40, 0.60)
    else:
        # Linear interpolation
        t = offset_seconds / 0.5  # 0 to 1
        min_score = 0.95 - (0.55 * t)  # 0.95 -> 0.40
        max_score = 1.0 - (0.40 * t)   # 1.0 -> 0.60
        return (min_score, max_score)
