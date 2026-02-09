"""
Video utility functions for the dancer alignment validation pipeline.
Handles video information extraction, clip extraction, and motion analysis.
"""

import cv2
import numpy as np
import random
from pathlib import Path
from typing import Tuple, Optional, List


def get_video_info(video_path: str) -> dict:
    """
    Get video metadata including dimensions, duration, and fps.
    
    Args:
        video_path: Path to the video file
        
    Returns:
        Dictionary containing width, height, fps, frame_count, and duration
        
    Raises:
        ValueError: If video cannot be opened or read
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"Could not open video: {video_path}")
    
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    # Validate that we can actually read the video
    # fps of 0, 1000, or negative indicates metadata failure
    if fps <= 0 or fps >= 1000:
        # Try to read a frame to get actual fps estimate
        ret, _ = cap.read()
        if not ret:
            cap.release()
            raise ValueError(f"Cannot read video frames: {video_path}. The codec may not be supported.")
        # Use a reasonable default fps
        fps = 30.0
    
    if frame_count <= 0 or width <= 0 or height <= 0:
        cap.release()
        raise ValueError(f"Invalid video metadata: {video_path}. The codec may not be supported.")
    
    duration = frame_count / fps if fps > 0 else 0
    
    cap.release()
    
    return {
        "width": width,
        "height": height,
        "fps": fps,
        "frame_count": frame_count,
        "duration": duration
    }


def read_video_frames(video_path: str) -> Tuple[List[np.ndarray], dict]:
    """
    Read all frames from a video file.
    
    Args:
        video_path: Path to the video file
        
    Returns:
        Tuple of (list of frames as numpy arrays, video info dict)
    """
    info = get_video_info(video_path)
    cap = cv2.VideoCapture(video_path)
    
    frames = []
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frames.append(frame)
    
    cap.release()
    return frames, info


def write_video_frames(frames: List[np.ndarray], output_path: str, fps: float) -> None:
    """
    Write frames to a video file.
    
    Args:
        frames: List of frames as numpy arrays
        output_path: Path to save the video
        fps: Frames per second for the output video
    """
    if not frames:
        raise ValueError("No frames to write")
    
    height, width = frames[0].shape[:2]
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))
    
    for frame in frames:
        out.write(frame)
    
    out.release()


def encode_video_to_bytes(frames: List[np.ndarray], fps: float) -> bytes:
    """
    Encode frames to video bytes without saving to disk.
    
    Args:
        frames: List of frames as numpy arrays
        fps: Frames per second
        
    Returns:
        Video encoded as bytes
    """
    import tempfile
    import os
    
    # Use a temporary file since OpenCV doesn't support in-memory encoding
    with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as tmp:
        tmp_path = tmp.name
    
    try:
        write_video_frames(frames, tmp_path, fps)
        with open(tmp_path, 'rb') as f:
            return f.read()
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def extract_random_clip(video_path: str, duration: float = None) -> Tuple[List[np.ndarray], float, float]:
    """
    Extract a random 3-5 second clip from a video.
    
    Args:
        video_path: Path to the source video
        duration: Optional specific duration (otherwise random 3-5 seconds)
        
    Returns:
        Tuple of (list of frames, start_time, actual_duration)
    """
    info = get_video_info(video_path)
    
    if duration is None:
        duration = random.uniform(3.0, 5.0)
    
    # Ensure we don't exceed video length
    max_start = max(0, info["duration"] - duration)
    if max_start <= 0:
        # Video is shorter than desired duration, use whole video
        frames, _ = read_video_frames(video_path)
        return frames, 0.0, info["duration"]
    
    start_time = random.uniform(0, max_start)
    start_frame = int(start_time * info["fps"])
    end_frame = int((start_time + duration) * info["fps"])
    
    cap = cv2.VideoCapture(video_path)
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    
    frames = []
    for _ in range(end_frame - start_frame):
        ret, frame = cap.read()
        if not ret:
            break
        frames.append(frame)
    
    cap.release()
    
    actual_duration = len(frames) / info["fps"]
    return frames, start_time, actual_duration


def calculate_frame_variance(frame: np.ndarray) -> float:
    """
    Calculate the variance of a frame (used for motion detection).
    
    Args:
        frame: Video frame as numpy array
        
    Returns:
        Variance value
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return np.var(gray)


def has_high_variance_motion(frames: List[np.ndarray], threshold: float = 500.0) -> bool:
    """
    Check if a clip contains high-variance motion (not standing still).
    
    Uses frame-to-frame difference to detect motion.
    
    Args:
        frames: List of video frames
        threshold: Minimum average motion variance to consider as active
        
    Returns:
        True if the clip has high motion variance
    """
    if len(frames) < 2:
        return False
    
    motion_variances = []
    for i in range(1, len(frames)):
        prev_gray = cv2.cvtColor(frames[i-1], cv2.COLOR_BGR2GRAY)
        curr_gray = cv2.cvtColor(frames[i], cv2.COLOR_BGR2GRAY)
        
        diff = cv2.absdiff(prev_gray, curr_gray)
        motion_variances.append(np.mean(diff))
    
    avg_motion = np.mean(motion_variances)
    return avg_motion > threshold


def find_high_motion_clip(video_path: str, min_duration: float = 3.0, 
                          max_duration: float = 5.0, max_attempts: int = 10) -> Optional[Tuple[List[np.ndarray], float]]:
    """
    Find a clip with high motion variance from a video.
    
    Args:
        video_path: Path to the source video
        min_duration: Minimum clip duration
        max_duration: Maximum clip duration
        max_attempts: Maximum number of random samples to try
        
    Returns:
        Tuple of (frames, fps) if found, None otherwise
    """
    info = get_video_info(video_path)
    
    for _ in range(max_attempts):
        duration = random.uniform(min_duration, max_duration)
        frames, _, _ = extract_random_clip(video_path, duration)
        
        if has_high_variance_motion(frames):
            return frames, info["fps"]
    
    # If no high-motion clip found, return the last attempt anyway
    return frames, info["fps"]
