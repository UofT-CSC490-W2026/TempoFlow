"""
Model runner placeholder for the dance alignment scoring model.
This module will be implemented when the model is available.
"""

from typing import Union, List
import numpy as np


def run_model(reference_video: Union[str, List[np.ndarray]], 
              transformed_video: Union[str, List[np.ndarray]]) -> float:
    """
    Run the dance alignment scoring model.
    
    TODO: Implement when model is available.
    
    Args:
        reference_video: Path/URL to reference video, or list of frames
        transformed_video: Path/URL to transformed video, or list of frames
    
    Returns:
        float: Alignment score between 0.0 and 1.0
        
    Raises:
        NotImplementedError: Model is not yet implemented
    """
    # TODO: Implement the actual model inference
    # Expected steps:
    # 1. Load/process video frames
    # 2. Extract pose landmarks using MediaPipe
    # 3. Normalize poses (remove camera/position variance)
    # 4. Compare reference and transformed video poses
    # 5. Calculate alignment score
    
    raise NotImplementedError(
        "Dance alignment scoring model not yet implemented. "
        "This function will be updated when the model is available."
    )


def run_model_on_frames(reference_frames: List[np.ndarray],
                        transformed_video_frames: List[np.ndarray]) -> float:
    """
    Run the model directly on frame lists.
    
    TODO: Implement when model is available.
    
    Args:
        reference_frames: List of reference video frames
        transformed_video_frames: List of transformed video frames
        
    Returns:
        float: Alignment score between 0.0 and 1.0
    """
    # TODO: Implement frame-based model inference
    raise NotImplementedError("Model not yet implemented")


def run_model_batch(pairs: List[tuple]) -> List[float]:
    """
    Run the model on multiple video pairs.
    
    TODO: Implement when model is available.
    
    Args:
        pairs: List of (reference_video, transformed_video) tuples
        
    Returns:
        List of alignment scores
    """
    # TODO: Implement batch inference for efficiency
    raise NotImplementedError("Model not yet implemented")
