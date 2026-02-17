"""
S3 streaming functionality for the dancer alignment validation pipeline.
Provides presigned URL generation and video streaming for model consumption.
"""

import cv2
import numpy as np
import tempfile
import os
from typing import List, Generator, Optional, Tuple


def generate_presigned_url(s3_client, bucket: str, key: str, 
                           expiry_seconds: int = 3600) -> str:
    """
    Generate a presigned URL for an S3 object.
    
    Args:
        s3_client: boto3 S3 client
        bucket: S3 bucket name
        key: S3 object key
        expiry_seconds: URL expiration time in seconds (default: 1 hour)
        
    Returns:
        Presigned URL string
    """
    url = s3_client.generate_presigned_url(
        'get_object',
        Params={'Bucket': bucket, 'Key': key},
        ExpiresIn=expiry_seconds
    )
    return url


def stream_video_frames(presigned_url: str) -> Generator[np.ndarray, None, None]:
    """
    Stream video frames from a presigned URL.
    
    Note: OpenCV can read from URLs directly, but connection stability
    may vary. This implementation uses blocking reads to ensure frame
    integrity despite network jitter.
    
    Args:
        presigned_url: Presigned S3 URL for the video
        
    Yields:
        Video frames as numpy arrays
    """
    cap = cv2.VideoCapture(presigned_url)
    
    if not cap.isOpened():
        raise ValueError(f"Could not open video stream: {presigned_url[:50]}...")
    
    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            yield frame
    finally:
        cap.release()


def download_video_to_temp(s3_client, bucket: str, key: str) -> str:
    """
    Download a video from S3 to a temporary file.
    Useful when streaming is unreliable.
    
    Args:
        s3_client: boto3 S3 client
        bucket: S3 bucket name
        key: S3 object key
        
    Returns:
        Path to temporary file (caller is responsible for cleanup)
    """
    suffix = os.path.splitext(key)[1] or '.mp4'
    temp_file = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    
    s3_client.download_file(bucket, key, temp_file.name)
    temp_file.close()
    
    return temp_file.name


def list_videos_in_bucket(s3_client, bucket: str, prefix: str = "",
                          extensions: Tuple[str, ...] = ('.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v')) -> List[str]:
    """
    List all video files in an S3 bucket/prefix.
    
    Args:
        s3_client: boto3 S3 client
        bucket: S3 bucket name
        prefix: S3 key prefix to filter by
        extensions: Video file extensions to include
        
    Returns:
        List of S3 keys for video files
    """
    video_keys = []
    paginator = s3_client.get_paginator('list_objects_v2')
    
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get('Contents', []):
            key = obj['Key']
            if any(key.lower().endswith(ext) for ext in extensions):
                video_keys.append(key)
    
    return video_keys


def get_video_pairs_for_validation(s3_client, bucket: str,
                                   ref_prefix: str = "references",
                                   transformed_video_prefix: str = "transformed_videos") -> List[Tuple[str, str]]:
    """
    Get pairs of reference and transformed videos for validation.
    
    Args:
        s3_client: boto3 S3 client
        bucket: S3 bucket name
        ref_prefix: Prefix for reference videos
        transformed_video_prefix: Prefix for transformed videos
        
    Returns:
        List of (ref_key, transformed_video_key) tuples
    """
    ref_videos = list_videos_in_bucket(s3_client, bucket, ref_prefix)
    transformed_videos = list_videos_in_bucket(s3_client, bucket, transformed_video_prefix)
    
    # Match by base filename (without transform suffix)
    pairs = []
    for ref_key in ref_videos:
        ref_name = os.path.splitext(os.path.basename(ref_key))[0]
        for transformed_video_key in transformed_videos:
            if ref_name in transformed_video_key:
                pairs.append((ref_key, transformed_video_key))
    
    return pairs
