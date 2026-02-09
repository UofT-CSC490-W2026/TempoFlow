"""
2D Affine transformation functions for the dancer alignment validation pipeline.
Implements scale, rotation, translation, aspect ratio, and combined transformations
with bounding box validation to ensure the dancer stays on screen.
"""

import cv2
import numpy as np
from typing import List, Tuple, Optional
import random

from .body_detection import calculate_safe_transform, get_aggregate_bounding_box
from .video_utils import read_video_frames, write_video_frames, encode_video_to_bytes


def apply_scale(frames: List[np.ndarray], scale_factor: float) -> List[np.ndarray]:
    """
    Apply uniform scaling to video frames.
    
    The scaling is applied around the center of the frame, so the dancer
    appears closer (scale > 1) or farther (scale < 1) from the camera.
    
    Args:
        frames: List of video frames
        scale_factor: Scale factor (0.8 to 1.2 typical range)
        
    Returns:
        List of scaled frames
    """
    if not frames:
        return frames
    
    h, w = frames[0].shape[:2]
    center = (w // 2, h // 2)
    
    scaled_frames = []
    for frame in frames:
        # Create scaling matrix centered on frame center
        M = cv2.getRotationMatrix2D(center, 0, scale_factor)
        scaled = cv2.warpAffine(frame, M, (w, h), borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
        scaled_frames.append(scaled)
    
    return scaled_frames


def apply_rotation(frames: List[np.ndarray], angle: float, 
                   clamp_to_body: bool = True) -> Tuple[List[np.ndarray], float]:
    """
    Apply rotation to video frames around the center.
    
    Args:
        frames: List of video frames
        angle: Rotation angle in degrees (positive = counter-clockwise)
        clamp_to_body: If True, reduce angle to keep body on screen
        
    Returns:
        Tuple of (rotated frames, actual angle applied)
    """
    if not frames:
        return frames, 0.0
    
    actual_angle = angle
    if clamp_to_body:
        _, actual_angle = calculate_safe_transform(frames, (0, 0), angle)
    
    h, w = frames[0].shape[:2]
    center = (w // 2, h // 2)
    
    rotated_frames = []
    for frame in frames:
        M = cv2.getRotationMatrix2D(center, actual_angle, 1.0)
        rotated = cv2.warpAffine(frame, M, (w, h), borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
        rotated_frames.append(rotated)
    
    return rotated_frames, actual_angle


def apply_translation(frames: List[np.ndarray], tx: float, ty: float,
                      clamp_to_body: bool = True) -> Tuple[List[np.ndarray], Tuple[float, float]]:
    """
    Apply translation to video frames.
    
    Args:
        frames: List of video frames
        tx: Horizontal translation as fraction of frame width (-0.1 to 0.1 typical)
        ty: Vertical translation as fraction of frame height
        clamp_to_body: If True, reduce translation to keep body on screen
        
    Returns:
        Tuple of (translated frames, actual (tx, ty) applied)
    """
    if not frames:
        return frames, (0.0, 0.0)
    
    actual_tx, actual_ty = tx, ty
    if clamp_to_body:
        (actual_tx, actual_ty), _ = calculate_safe_transform(frames, (tx, ty), 0)
    
    h, w = frames[0].shape[:2]
    tx_px = int(actual_tx * w)
    ty_px = int(actual_ty * h)
    
    translated_frames = []
    for frame in frames:
        M = np.float32([[1, 0, tx_px], [0, 1, ty_px]])
        translated = cv2.warpAffine(frame, M, (w, h), borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
        translated_frames.append(translated)
    
    return translated_frames, (actual_tx, actual_ty)


def apply_aspect_ratio(frames: List[np.ndarray], stretch_factor: float) -> List[np.ndarray]:
    """
    Apply aspect ratio distortion (horizontal stretch/squash).
    
    This simulates different body types or camera distortions.
    
    Args:
        frames: List of video frames
        stretch_factor: Horizontal stretch factor (0.9 to 1.1 typical)
        
    Returns:
        List of stretched frames
    """
    if not frames:
        return frames
    
    h, w = frames[0].shape[:2]
    
    # Calculate new width, keeping frame size the same
    new_content_w = int(w / stretch_factor)
    
    stretched_frames = []
    for frame in frames:
        # Resize content horizontally
        if stretch_factor != 1.0:
            # Crop or pad to maintain original dimensions
            if stretch_factor > 1.0:
                # Stretch: resize smaller then pad
                resized = cv2.resize(frame, (new_content_w, h))
                result = np.zeros_like(frame)
                x_offset = (w - new_content_w) // 2
                result[:, x_offset:x_offset + new_content_w] = resized
            else:
                # Compress: resize larger then crop
                resized = cv2.resize(frame, (new_content_w, h))
                x_offset = (new_content_w - w) // 2
                result = resized[:, x_offset:x_offset + w]
        else:
            result = frame.copy()
        
        stretched_frames.append(result)
    
    return stretched_frames


def apply_combined(frames: List[np.ndarray], 
                   scale: float = 1.0,
                   rotation: float = 0.0,
                   translation: Tuple[float, float] = (0, 0),
                   aspect_ratio: float = 1.0,
                   clamp_to_body: bool = True) -> Tuple[List[np.ndarray], dict]:
    """
    Apply all transformations in sequence.
    
    Transformation order: aspect ratio -> scale -> rotation -> translation
    
    Args:
        frames: List of video frames
        scale: Scale factor
        rotation: Rotation angle in degrees
        translation: (tx, ty) as fractions
        aspect_ratio: Horizontal stretch factor
        clamp_to_body: If True, clamp rotation/translation to keep body on screen
        
    Returns:
        Tuple of (transformed frames, dict of actual params applied)
    """
    if not frames:
        return frames, {}
    
    result = frames
    actual_params = {
        "scale": scale,
        "rotation": rotation,
        "translation": translation,
        "aspect_ratio": aspect_ratio
    }
    
    # Apply aspect ratio first (doesn't need clamping)
    if aspect_ratio != 1.0:
        result = apply_aspect_ratio(result, aspect_ratio)
    
    # Apply scale (doesn't need clamping for typical range)
    if scale != 1.0:
        result = apply_scale(result, scale)
    
    # Apply rotation with clamping
    if rotation != 0:
        result, actual_rotation = apply_rotation(result, rotation, clamp_to_body)
        actual_params["rotation"] = actual_rotation
    
    # Apply translation with clamping
    if translation != (0, 0):
        result, actual_trans = apply_translation(result, translation[0], translation[1], clamp_to_body)
        actual_params["translation"] = actual_trans
    
    return result, actual_params


def generate_random_transform_params() -> dict:
    """
    Generate random transformation parameters within valid ranges.
    
    Returns:
        Dictionary of transformation parameters
    """
    return {
        "scale": random.uniform(0.8, 1.2),
        "rotation": random.uniform(-15, 15),
        "translation": (random.uniform(-0.1, 0.1), random.uniform(-0.1, 0.1)),
        "aspect_ratio": random.uniform(0.9, 1.1)
    }


# Transformation type handlers for isolated testing
TRANSFORM_HANDLERS = {
    "spatial_scale": lambda frames, value: (apply_scale(frames, value), {"scale": value}),
    "spatial_rotation": lambda frames, value: apply_rotation(frames, value, clamp_to_body=True),
    "spatial_translation_x": lambda frames, value: apply_translation(frames, value, 0, clamp_to_body=True),
    "spatial_translation_y": lambda frames, value: apply_translation(frames, 0, value, clamp_to_body=True),
    "morphological_aspect": lambda frames, value: (apply_aspect_ratio(frames, value), {"aspect_ratio": value}),
}


def apply_transform_by_type(frames: List[np.ndarray], 
                            transform_type: str, 
                            param_value: float) -> Tuple[List[np.ndarray], dict]:
    """
    Apply a specific transformation by type name.
    
    Args:
        frames: List of video frames
        transform_type: Type of transformation (e.g., "spatial_scale")
        param_value: Parameter value for the transformation
        
    Returns:
        Tuple of (transformed frames, actual params dict)
    """
    if transform_type not in TRANSFORM_HANDLERS:
        raise ValueError(f"Unknown transform type: {transform_type}")
    
    return TRANSFORM_HANDLERS[transform_type](frames, param_value)
