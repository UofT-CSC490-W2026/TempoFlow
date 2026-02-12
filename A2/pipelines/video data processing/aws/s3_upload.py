"""
S3 upload functionality for the dancer alignment validation pipeline.
Supports both file uploads and in-memory byte uploads.
"""

import os
from pathlib import Path
from typing import Optional
from tqdm import tqdm


def upload_file(s3_client, local_path: str, bucket: str, s3_key: str) -> str:
    """
    Upload a file to S3.
    
    Args:
        s3_client: boto3 S3 client
        local_path: Path to local file
        bucket: S3 bucket name
        s3_key: S3 object key (path in bucket)
        
    Returns:
        S3 URI of uploaded file
    """
    s3_client.upload_file(local_path, bucket, s3_key)
    return f"s3://{bucket}/{s3_key}"


def upload_video_bytes(s3_client, video_bytes: bytes, bucket: str, s3_key: str) -> str:
    """
    Upload video bytes directly to S3 without saving locally.
    
    Args:
        s3_client: boto3 S3 client
        video_bytes: Video content as bytes
        bucket: S3 bucket name
        s3_key: S3 object key
        
    Returns:
        S3 URI of uploaded file
    """
    s3_client.put_object(Body=video_bytes, Bucket=bucket, Key=s3_key)
    return f"s3://{bucket}/{s3_key}"


def upload_directory(s3_client, local_dir: str, bucket: str, 
                     prefix: str = "", show_progress: bool = True) -> int:
    """
    Upload all files in a directory to S3.
    
    Args:
        s3_client: boto3 S3 client
        local_dir: Local directory path
        bucket: S3 bucket name
        prefix: S3 key prefix (folder path in bucket)
        show_progress: Whether to show progress bar
        
    Returns:
        Number of files uploaded
    """
    local_path = Path(local_dir)
    files = list(local_path.rglob('*'))
    files = [f for f in files if f.is_file()]
    
    if show_progress:
        files = tqdm(files, desc="Uploading to S3")
    
    count = 0
    for file_path in files:
        relative_path = file_path.relative_to(local_path)
        s3_key = f"{prefix}/{relative_path}".replace('\\', '/').lstrip('/')
        upload_file(s3_client, str(file_path), bucket, s3_key)
        count += 1
    
    return count


def generate_s3_key(prefix: str, filename: str, transform_type: str = None) -> str:
    """
    Generate a consistent S3 key for uploaded files.
    
    Args:
        prefix: Base prefix (e.g., 'references' or 'transformed_videos')
        filename: Original filename
        transform_type: Optional transformation type for categorization
        
    Returns:
        S3 key string
    """
    if transform_type:
        return f"{prefix}/{transform_type}/{filename}"
    return f"{prefix}/{filename}"
