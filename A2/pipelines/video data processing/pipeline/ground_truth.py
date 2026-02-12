"""
Ground truth export module for the dancer alignment validation pipeline.
Creates JSON artifacts with test case metadata and expected score ranges.
"""

import json
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime


def create_test_case(test_id: str,
                     ref_key: str,
                     transformed_video_key: str,
                     transformation_type: str,
                     param_value: float,
                     expected_score_range: Tuple[float, float],
                     metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Create a single test case entry for the ground truth file.
    
    Args:
        test_id: Unique identifier for this test case
        ref_key: S3 key or path for reference video
        transformed_video_key: S3 key or path for transformed video
        transformation_type: Type of transformation applied
        param_value: Value of the transformation parameter
        expected_score_range: (min, max) expected score
        metadata: Optional additional metadata
        
    Returns:
        Test case dictionary
    """
    test_case = {
        "test_id": test_id,
        "ref_s3_key": ref_key,
        "transformed_video_s3_key": transformed_video_key,
        "transformation_type": transformation_type,
        "param_value": param_value,
        "expected_score_min": expected_score_range[0],
        "expected_score_max": expected_score_range[1]
    }
    
    if metadata:
        test_case["metadata"] = metadata
    
    return test_case


def export_ground_truth(test_cases: List[Dict[str, Any]], 
                        output_path: str,
                        include_metadata: bool = True) -> str:
    """
    Export test cases to a JSON file.
    
    Args:
        test_cases: List of test case dictionaries
        output_path: Path for the output JSON file
        include_metadata: Whether to include generation metadata
        
    Returns:
        Path to the created file
    """
    output = {
        "test_cases": test_cases,
        "total_count": len(test_cases)
    }
    
    if include_metadata:
        output["generated_at"] = datetime.now().isoformat()
        output["version"] = "1.0.0"
        
        # Count by transformation type
        type_counts = {}
        for tc in test_cases:
            t_type = tc.get("transformation_type", "unknown")
            type_counts[t_type] = type_counts.get(t_type, 0) + 1
        output["counts_by_type"] = type_counts
    
    # Ensure output directory exists
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_path, 'w') as f:
        json.dump(output, f, indent=2)
    
    return output_path


# Expected score ranges for different transformation types
EXPECTED_SCORES = {
    # Spatial transformations should have high scores (invariant)
    "spatial_scale": (0.90, 1.0),
    "spatial_rotation": (0.85, 1.0),
    "spatial_translation_x": (0.90, 1.0),
    "spatial_translation_y": (0.90, 1.0),
    "morphological_aspect": (0.85, 1.0),
    
    # Combined transformation (slightly lower due to noise accumulation)
    "combined": (0.80, 1.0),
    
    # Temporal offset (varies with offset amount - see temporal.py)
    "temporal_offset": None,  # Depends on offset value
    
    # Negative pairs should score very low
    "negative": (0.0, 0.15),
}


def get_expected_score_range(transformation_type: str, 
                             param_value: float = None) -> Tuple[float, float]:
    """
    Get the expected score range for a transformation type.
    
    Args:
        transformation_type: Type of transformation
        param_value: Optional parameter value (needed for temporal_offset)
        
    Returns:
        (min_score, max_score) tuple
    """
    if transformation_type == "temporal_offset" and param_value is not None:
        # Import here to avoid circular dependency
        from .temporal import calculate_expected_score_for_offset
        return calculate_expected_score_for_offset(param_value)
    
    return EXPECTED_SCORES.get(transformation_type, (0.0, 1.0))
