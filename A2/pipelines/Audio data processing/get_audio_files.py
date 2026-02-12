#!/usr/bin/env python3
"""
Extract audio datasets from locally downloaded archives and/or manage them in AWS S3.

Supports three execution modes:
  - local      : Extract from local zip archives (default, original behaviour)
  - local-upload: Extract locally then upload to S3
  - aws        : Check S3 for datasets, download/extract/upload if missing
"""

import os
import sys
import argparse
import zipfile
import tempfile
from tqdm import tqdm

# ---------------------------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------------------------
BASE_DIR = "dataset"
DANCE_DIR = os.path.join(BASE_DIR, "dance")
BG_DIR = os.path.join(BASE_DIR, "background")

GTZAN_ARCHIVE = "archive.zip"
DEMAND_ARCHIVE = "archive(1).zip"

# S3 prefixes (meaningful names instead of archive/archive(1))
S3_GTZAN_PREFIX = "datasets/gtzan/"
S3_DEMAND_PREFIX = "datasets/demand/"


# ---------------------------------------------------------------------------
# AWS helpers
# ---------------------------------------------------------------------------
def get_s3_client(args):
    """
    Create a boto3 S3 client.

    Credential resolution order:
      1. Explicit CLI flags (--aws-access-key / --aws-secret-key)
      2. Environment variables (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)
      3. IAM role / instance profile (automatic in AWS environments)
    """
    try:
        import boto3
    except ImportError:
        print("Error: boto3 is required for AWS modes. Install it with:")
        print("  pip install boto3")
        sys.exit(1)

    kwargs = {}
    if args.aws_region:
        kwargs["region_name"] = args.aws_region

    access_key = args.aws_access_key or os.environ.get("AWS_ACCESS_KEY_ID")
    secret_key = args.aws_secret_key or os.environ.get("AWS_SECRET_ACCESS_KEY")

    if access_key and secret_key:
        kwargs["aws_access_key_id"] = access_key
        kwargs["aws_secret_access_key"] = secret_key

    try:
        client = boto3.client("s3", **kwargs)
        # Quick connectivity check
        client.list_buckets()
        return client
    except Exception as e:
        print(f"Error: Could not connect to AWS S3: {e}")
        print("Ensure your credentials are valid (CLI flags, env vars, or IAM role).")
        sys.exit(1)


def ensure_bucket_exists(s3, bucket_name):
    """Check if the S3 bucket exists; create it if it does not."""
    try:
        s3.head_bucket(Bucket=bucket_name)
        print(f"S3 bucket '{bucket_name}' exists.")
    except s3.exceptions.ClientError as e:
        error_code = int(e.response["Error"]["Code"])
        if error_code == 404:
            print(f"S3 bucket '{bucket_name}' not found — creating it...")
            try:
                region = s3.meta.region_name or "us-east-1"
                if region == "us-east-1":
                    s3.create_bucket(Bucket=bucket_name)
                else:
                    s3.create_bucket(
                        Bucket=bucket_name,
                        CreateBucketConfiguration={"LocationConstraint": region},
                    )
                print(f"Created bucket '{bucket_name}'.")
            except Exception as create_err:
                print(f"Error: Failed to create bucket '{bucket_name}': {create_err}")
                sys.exit(1)
        elif error_code == 403:
            print(f"Error: Access denied for bucket '{bucket_name}'. Check permissions.")
            sys.exit(1)
        else:
            print(f"Error checking bucket '{bucket_name}': {e}")
            sys.exit(1)
    except Exception as e:
        print(f"Error checking bucket '{bucket_name}': {e}")
        sys.exit(1)


def s3_prefix_has_objects(s3, bucket, prefix):
    """Return True if at least one object exists under *prefix*."""
    try:
        resp = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=1)
        return resp.get("KeyCount", 0) > 0
    except Exception as e:
        print(f"Warning: Could not list objects under s3://{bucket}/{prefix}: {e}")
        return False


def upload_directory_to_s3(s3, local_dir, bucket, s3_prefix):
    """Recursively upload a local directory to S3."""
    files = []
    for root, _dirs, filenames in os.walk(local_dir):
        for fname in filenames:
            files.append(os.path.join(root, fname))

    print(f"Uploading {len(files)} files to s3://{bucket}/{s3_prefix} ...")
    for fpath in tqdm(files, desc="Uploading"):
        rel = os.path.relpath(fpath, local_dir).replace("\\", "/")
        key = f"{s3_prefix}{rel}"
        try:
            s3.upload_file(fpath, bucket, key)
        except Exception as e:
            print(f"Warning: Failed to upload {fpath} -> {key}: {e}")


def download_s3_prefix(s3, bucket, prefix, local_dir):
    """Download all objects under *prefix* into *local_dir*."""
    paginator = s3.get_paginator("list_objects_v2")
    keys = []
    try:
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                keys.append(obj["Key"])
    except Exception as e:
        print(f"Error listing s3://{bucket}/{prefix}: {e}")
        return False

    if not keys:
        print(f"No objects found under s3://{bucket}/{prefix}")
        return False

    print(f"Downloading {len(keys)} files from s3://{bucket}/{prefix} ...")
    for key in tqdm(keys, desc="Downloading"):
        rel = key[len(prefix):]
        dest = os.path.join(local_dir, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        try:
            s3.download_file(bucket, key, dest)
        except Exception as e:
            print(f"Warning: Failed to download {key}: {e}")

    return True


# ---------------------------------------------------------------------------
# Local extraction (unchanged logic)
# ---------------------------------------------------------------------------
def create_dirs(base_dir=None):
    """Create the necessary directory structure."""
    dance = os.path.join(base_dir or BASE_DIR, "dance")
    bg = os.path.join(base_dir or BASE_DIR, "background")
    os.makedirs(dance, exist_ok=True)
    os.makedirs(bg, exist_ok=True)
    print(f"Created directories: {dance}, {bg}")
    return dance, bg


def extract_gtzan(dance_dir, archive_path=GTZAN_ARCHIVE):
    """Extract GTZAN music files from local archive."""
    if not os.path.exists(archive_path):
        print(f"Error: {archive_path} not found!")
        print("Please download the GTZAN dataset and place it as 'archive.zip' in this directory.")
        return False

    print(f"Extracting GTZAN from {archive_path}...")
    with zipfile.ZipFile(archive_path, "r") as zf:
        wav_files = [f for f in zf.namelist() if f.endswith(".wav")]
        for file in tqdm(wav_files, desc="Extracting Music"):
            data = zf.read(file)
            filename = os.path.basename(file)
            if filename:
                with open(os.path.join(dance_dir, filename), "wb") as out:
                    out.write(data)

    print(f"GTZAN extraction complete. Files are in {dance_dir}")
    return True


def extract_demand(bg_dir, archive_path=DEMAND_ARCHIVE):
    """Extract DEMAND background noise files from local archive (mono ch01 only)."""
    if not os.path.exists(archive_path):
        print(f"Error: {archive_path} not found!")
        print("Please download the DEMAND dataset and place it as 'archive(1).zip' in this directory.")
        return False

    print(f"\nExtracting DEMAND from {archive_path}...")
    with zipfile.ZipFile(archive_path, "r") as zf:
        ch01_files = [f for f in zf.namelist() if f.endswith("ch01.wav")]
        for file in tqdm(ch01_files, desc="Extracting Background Noise"):
            data = zf.read(file)
            folder_name = os.path.basename(os.path.dirname(file))
            new_name = f"{folder_name}_ch01.wav"
            with open(os.path.join(bg_dir, new_name), "wb") as out:
                out.write(data)

    print(f"DEMAND extraction complete. Files are in {bg_dir}")
    return True


def count_wavs(directory):
    """Count .wav files in a directory."""
    if not os.path.exists(directory):
        return 0
    return len([f for f in os.listdir(directory) if f.endswith(".wav")])


# ---------------------------------------------------------------------------
# Mode runners
# ---------------------------------------------------------------------------
def run_local(args):
    """Mode: local — extract from local zips (original behaviour)."""
    dance_dir, bg_dir = create_dirs()
    extract_gtzan(dance_dir)
    extract_demand(bg_dir)

    print()
    print("=" * 40)
    print(f"Done! Extracted {count_wavs(dance_dir)} music files, {count_wavs(bg_dir)} background noise files.")


def run_local_upload(args):
    """Mode: local-upload — extract locally then upload to S3."""
    if not args.s3_bucket:
        print("Error: --s3-bucket is required for local-upload mode.")
        sys.exit(1)

    # Step 1: Extract locally
    dance_dir, bg_dir = create_dirs()
    extract_gtzan(dance_dir)
    extract_demand(bg_dir)

    print(f"\nExtracted {count_wavs(dance_dir)} music, {count_wavs(bg_dir)} background files.")

    # Step 2: Upload to S3
    print("\nConnecting to AWS S3...")
    s3 = get_s3_client(args)
    ensure_bucket_exists(s3, args.s3_bucket)

    upload_directory_to_s3(s3, DANCE_DIR, args.s3_bucket, S3_GTZAN_PREFIX)
    upload_directory_to_s3(s3, BG_DIR, args.s3_bucket, S3_DEMAND_PREFIX)

    print("\n" + "=" * 40)
    print("Done! Datasets extracted locally and uploaded to S3.")
    print(f"  s3://{args.s3_bucket}/{S3_GTZAN_PREFIX}")
    print(f"  s3://{args.s3_bucket}/{S3_DEMAND_PREFIX}")


def run_aws(args):
    """Mode: aws — verify datasets exist in S3, report status.

    If datasets are missing, directs the user to run the separate
    dataset helper to download and populate the bucket.
    """
    if not args.s3_bucket:
        print("Error: --s3-bucket is required for aws mode.")
        sys.exit(1)

    print("Connecting to AWS S3...")
    s3 = get_s3_client(args)
    ensure_bucket_exists(s3, args.s3_bucket)

    gtzan_exists = s3_prefix_has_objects(s3, args.s3_bucket, S3_GTZAN_PREFIX)
    demand_exists = s3_prefix_has_objects(s3, args.s3_bucket, S3_DEMAND_PREFIX)

    if gtzan_exists and demand_exists:
        print("Both datasets already exist in S3 — ready to go.")
        print(f"  s3://{args.s3_bucket}/{S3_GTZAN_PREFIX}")
        print(f"  s3://{args.s3_bucket}/{S3_DEMAND_PREFIX}")
        return

    if not gtzan_exists:
        print(f"GTZAN dataset NOT found at s3://{args.s3_bucket}/{S3_GTZAN_PREFIX}")
    if not demand_exists:
        print(f"DEMAND dataset NOT found at s3://{args.s3_bucket}/{S3_DEMAND_PREFIX}")

    print("\nTo populate the bucket, either:")
    print("  1. Run the dataset download helper to fetch and upload datasets")
    print("  2. Use --mode local-upload to extract local archives and push to S3")
    sys.exit(1)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args():
    parser = argparse.ArgumentParser(
        description="Extract audio datasets (local, local+S3 upload, or pure AWS)"
    )
    parser.add_argument(
        "--mode",
        choices=["local", "local-upload", "aws"],
        default="local",
        help="Execution mode (default: local)",
    )
    parser.add_argument("--s3-bucket", type=str, default=None, help="S3 bucket name (required for S3 modes)")
    parser.add_argument("--aws-access-key", type=str, default=None, help="AWS access key ID (or set AWS_ACCESS_KEY_ID)")
    parser.add_argument("--aws-secret-key", type=str, default=None, help="AWS secret access key (or set AWS_SECRET_ACCESS_KEY)")
    parser.add_argument("--aws-region", type=str, default=None, help="AWS region (or set AWS_DEFAULT_REGION)")
    return parser.parse_args()


if __name__ == "__main__":
    print("Audio Dataset Extractor")
    print("=" * 40)

    args = parse_args()
    print(f"Mode: {args.mode}\n")

    MODE_RUNNERS = {
        "local": run_local,
        "local-upload": run_local_upload,
        "aws": run_aws,
    }

    try:
        MODE_RUNNERS[args.mode](args)
    except KeyboardInterrupt:
        print("\nAborted.")
        sys.exit(1)
    except Exception as e:
        print(f"\nUnexpected error: {e}")
        sys.exit(1)