"""
Negative sampling module for the dancer alignment validation pipeline.
Selects distinct clips from different videos for negative matching tests.
"""

import os
import random
from pathlib import Path
from typing import List, Optional, Tuple
import numpy as np

from .video_utils import read_video_frames, get_video_info, find_high_motion_clip


def get_video_files(directory: str, extensions: Tuple[str, ...] = ('.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v')) -> List[str]:
    """
    Get all video files in a directory.
    
    Args:
        directory: Path to directory to search
        extensions: Valid video file extensions
        
    Returns:
        List of video file paths
    """
    video_files = []
    dir_path = Path(directory)
    
    if not dir_path.exists():
        return video_files
    
    for ext in extensions:
        video_files.extend([str(p) for p in dir_path.glob(f'*{ext}')])
        video_files.extend([str(p) for p in dir_path.glob(f'*{ext.upper()}')])
    
    return video_files


def select_distinct_clip(video_dir: str, 
                         exclude_path: str,
                         min_duration: float = 3.0,
                         max_duration: float = 5.0) -> Optional[Tuple[List[np.ndarray], str, float]]:
    """
    Select a completely different clip for negative pair matching.
    
    The algorithm must score pairs of (reference, distinct_clip) near 0%
    since they are different dances entirely.
    
    Args:
        video_dir: Directory containing source videos
        exclude_path: Path to video to exclude (the reference)
        min_duration: Minimum clip duration
        max_duration: Maximum clip duration
        
    Returns:
        Tuple of (frames, source_path, fps) or None if no distinct video available
    """
    video_files = get_video_files(video_dir)
    
    # Remove the excluded file
    exclude_path = str(Path(exclude_path).resolve())
    video_files = [v for v in video_files if str(Path(v).resolve()) != exclude_path]
    
    if not video_files:
        return None
    
    # Select a random different video
    selected_path = random.choice(video_files)
    
    # Extract a high-motion clip
    result = find_high_motion_clip(selected_path, min_duration, max_duration)
    if result is None:
        return None
    
    frames, fps = result
    return frames, selected_path, fps


def get_expected_score_for_negative() -> Tuple[float, float]:
    """
    Get the expected score range for negative (distinct) pairs.
    
    Pairs of completely different dances should score very low.
    
    Returns:
        Tuple of (min_expected_score, max_expected_score)
    """
    return (0.0, 0.15)  # Should be close to 0%
