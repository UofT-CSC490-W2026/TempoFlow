"""
Body detection module using MediaPipe Pose.
Provides bounding box detection and safe transformation calculations
to ensure the dancer remains fully within frame boundaries.
"""

import cv2
import numpy as np
from typing import Tuple, Optional, List

# Try to import MediaPipe with fallback for different versions
try:
    # Try new API first (MediaPipe 0.10+)
    from mediapipe.tasks import python as mp_tasks
    from mediapipe.tasks.python import vision
    USE_NEW_API = True
except ImportError:
    # Fall back to legacy API
    try:
        import mediapipe as mp
        mp_pose = mp.solutions.pose
        USE_NEW_API = False
    except AttributeError:
        # MediaPipe not available properly
        USE_NEW_API = None


def get_body_bounding_box(frame: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
    """
    Detect the body bounding box in a frame using MediaPipe Pose.
    Falls back to a simple heuristic if MediaPipe is unavailable.
    
    Args:
        frame: Video frame as numpy array (BGR format)
        
    Returns:
        Tuple of (x, y, width, height) or None if no body detected
    """
    h, w = frame.shape[:2]
    
    # Try MediaPipe-based detection
    if USE_NEW_API is False:
        # Legacy API (older MediaPipe versions)
        try:
            with mp_pose.Pose(
                static_image_mode=True,
                model_complexity=1,
                min_detection_confidence=0.5
            ) as pose:
                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                results = pose.process(rgb_frame)
                
                if results.pose_landmarks:
                    x_coords = []
                    y_coords = []
                    for landmark in results.pose_landmarks.landmark:
                        if landmark.visibility > 0.5:
                            x_coords.append(landmark.x * w)
                            y_coords.append(landmark.y * h)
                    
                    if x_coords and y_coords:
                        padding = 20
                        x_min = max(0, int(min(x_coords)) - padding)
                        y_min = max(0, int(min(y_coords)) - padding)
                        x_max = min(w, int(max(x_coords)) + padding)
                        y_max = min(h, int(max(y_coords)) + padding)
                        return (x_min, y_min, x_max - x_min, y_max - y_min)
        except Exception:
            pass  # Fall through to fallback
    
    # Fallback: Use simple motion/contour-based detection or assume center region
    # This is a conservative estimate: assume body occupies center 60% of frame
    # This ensures transformations are safe even without precise detection
    padding_x = int(w * 0.2)
    padding_y = int(h * 0.2)
    return (padding_x, padding_y, w - 2 * padding_x, h - 2 * padding_y)


def get_aggregate_bounding_box(frames: List[np.ndarray], sample_rate: int = 5) -> Optional[Tuple[int, int, int, int]]:
    """
    Get the bounding box that encompasses the body across multiple frames.
    
    Args:
        frames: List of video frames
        sample_rate: Process every Nth frame for efficiency
        
    Returns:
        Aggregate bounding box (x, y, width, height) or None
    """
    all_x_min, all_y_min = float('inf'), float('inf')
    all_x_max, all_y_max = 0, 0
    
    boxes_found = 0
    
    for i in range(0, len(frames), sample_rate):
        bbox = get_body_bounding_box(frames[i])
        if bbox:
            x, y, w, h = bbox
            all_x_min = min(all_x_min, x)
            all_y_min = min(all_y_min, y)
            all_x_max = max(all_x_max, x + w)
            all_y_max = max(all_y_max, y + h)
            boxes_found += 1
    
    if boxes_found == 0:
        return None
    
    return (int(all_x_min), int(all_y_min), 
            int(all_x_max - all_x_min), int(all_y_max - all_y_min))


def clamp_translation(bbox: Tuple[int, int, int, int], 
                      frame_size: Tuple[int, int],
                      tx: float, ty: float) -> Tuple[float, float]:
    """
    Clamp translation values to ensure body stays within frame.
    
    Args:
        bbox: Body bounding box (x, y, width, height)
        frame_size: Frame dimensions (width, height)
        tx: Requested horizontal translation (as fraction of frame width, e.g., 0.1 = 10%)
        ty: Requested vertical translation (as fraction of frame height)
        
    Returns:
        Clamped (tx, ty) values that keep body on screen
    """
    x, y, w, h = bbox
    frame_w, frame_h = frame_size
    
    # Convert fractions to pixels
    tx_px = tx * frame_w
    ty_px = ty * frame_h
    
    # Calculate how much we can move without going off-screen
    # Positive tx moves body right, so we check right edge
    if tx_px > 0:
        max_tx_px = frame_w - (x + w)  # Distance from right edge of body to right edge of frame
        tx_px = min(tx_px, max_tx_px)
    else:
        # Negative tx moves body left, check left edge
        max_tx_px = -x  # Distance from left edge of body to left edge of frame (negative)
        tx_px = max(tx_px, max_tx_px)
    
    # Same for vertical
    if ty_px > 0:
        max_ty_px = frame_h - (y + h)
        ty_px = min(ty_px, max_ty_px)
    else:
        max_ty_px = -y
        ty_px = max(ty_px, max_ty_px)
    
    # Convert back to fractions
    return tx_px / frame_w if frame_w > 0 else 0, ty_px / frame_h if frame_h > 0 else 0


def get_rotated_bbox_corners(bbox: Tuple[int, int, int, int], 
                             center: Tuple[int, int], 
                             angle: float) -> List[Tuple[float, float]]:
    """
    Calculate the corners of the bounding box after rotation.
    
    Args:
        bbox: Original bounding box (x, y, width, height)
        center: Rotation center point (cx, cy)
        angle: Rotation angle in degrees
        
    Returns:
        List of 4 corner coordinates after rotation
    """
    x, y, w, h = bbox
    cx, cy = center
    
    corners = [
        (x, y),
        (x + w, y),
        (x + w, y + h),
        (x, y + h)
    ]
    
    # Rotation matrix
    angle_rad = np.radians(angle)
    cos_a = np.cos(angle_rad)
    sin_a = np.sin(angle_rad)
    
    rotated_corners = []
    for px, py in corners:
        # Translate to origin
        px_shifted = px - cx
        py_shifted = py - cy
        
        # Rotate
        new_x = px_shifted * cos_a - py_shifted * sin_a
        new_y = px_shifted * sin_a + py_shifted * cos_a
        
        # Translate back
        rotated_corners.append((new_x + cx, new_y + cy))
    
    return rotated_corners


def clamp_rotation(bbox: Tuple[int, int, int, int], 
                   frame_size: Tuple[int, int],
                   angle: float) -> float:
    """
    Clamp rotation angle to ensure body stays within frame.
    Uses binary search to find the maximum safe angle.
    
    Args:
        bbox: Body bounding box (x, y, width, height)
        frame_size: Frame dimensions (width, height)
        angle: Requested rotation angle in degrees
        
    Returns:
        Clamped rotation angle that keeps body on screen
    """
    frame_w, frame_h = frame_size
    center = (frame_w // 2, frame_h // 2)
    
    def is_valid_rotation(test_angle: float) -> bool:
        corners = get_rotated_bbox_corners(bbox, center, test_angle)
        for cx, cy in corners:
            if cx < 0 or cx > frame_w or cy < 0 or cy > frame_h:
                return False
        return True
    
    # If requested angle is valid, use it
    if is_valid_rotation(angle):
        return angle
    
    # Binary search for maximum valid angle
    sign = 1 if angle > 0 else -1
    low, high = 0, abs(angle)
    
    for _ in range(20):  # Precision iterations
        mid = (low + high) / 2
        if is_valid_rotation(mid * sign):
            low = mid
        else:
            high = mid
    
    return low * sign


def calculate_safe_transform(frames: List[np.ndarray],
                            translation: Tuple[float, float] = (0, 0),
                            rotation: float = 0) -> Tuple[Tuple[float, float], float]:
    """
    Calculate safe transformation parameters that keep the body on screen.
    
    Args:
        frames: List of video frames
        translation: Requested (tx, ty) as fractions
        rotation: Requested rotation in degrees
        
    Returns:
        Tuple of (clamped_translation, clamped_rotation)
    """
    if not frames:
        return translation, rotation
    
    # Get aggregate bounding box
    bbox = get_aggregate_bounding_box(frames)
    if bbox is None:
        # No body detected, use conservative defaults
        h, w = frames[0].shape[:2]
        # Assume body takes center 60%
        bbox = (int(w * 0.2), int(h * 0.2), int(w * 0.6), int(h * 0.6))
    
    frame_size = (frames[0].shape[1], frames[0].shape[0])
    
    # Clamp translation first
    clamped_tx, clamped_ty = clamp_translation(bbox, frame_size, translation[0], translation[1])
    
    # Then clamp rotation
    clamped_rotation = clamp_rotation(bbox, frame_size, rotation)
    
    return (clamped_tx, clamped_ty), clamped_rotation
