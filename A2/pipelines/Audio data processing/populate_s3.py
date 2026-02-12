#!/usr/bin/env python3
"""
Dataset Download Helper — fetch GTZAN & DEMAND from Kaggle and upload to S3.

This is a standalone helper that populates an S3 bucket with the audio
datasets required by the pipeline.  It downloads:
  - GTZAN: full dataset (~1.2 GB) — all .wav files
  - DEMAND: mono channel only (ch01.wav files, ~1 GB)

Prerequisites:
  pip install kagglehub boto3

Kaggle credentials (one of):
  - KAGGLE_USERNAME + KAGGLE_KEY environment variables
  - ~/.kaggle/kaggle.json

AWS credentials (one of):
  - CLI flags --aws-access-key / --aws-secret-key
  - AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY environment variables
  - IAM role (automatic in AWS environments)
"""

import os
import sys
import argparse
from tqdm import tqdm

# S3 prefixes — must match get_audio_files.py / generate_validation_data.py
S3_GTZAN_PREFIX = "datasets/gtzan/"
S3_DEMAND_PREFIX = "datasets/demand/"

# Kaggle dataset handles
KAGGLE_GTZAN = "andradaolteanu/gtzan-dataset-music-genre-classification"
KAGGLE_DEMAND = "chrisfilo/demand"


# ---------------------------------------------------------------------------
# Kaggle download
# ---------------------------------------------------------------------------
def download_from_kaggle(handle: str) -> str:
    """Download a Kaggle dataset and return its local cache path."""
    try:
        import kagglehub
    except ImportError:
        print("Error: kagglehub is required. Install with:")
        print("  pip install kagglehub")
        sys.exit(1)

    print(f"Downloading {handle} from Kaggle...")
    try:
        path = kagglehub.dataset_download(handle)
        print(f"Downloaded to: {path}")
        return path
    except Exception as e:
        print(f"Error downloading {handle}: {e}")
        print("Make sure Kaggle credentials are configured:")
        print("  - Set KAGGLE_USERNAME and KAGGLE_KEY environment variables")
        print("  - Or place kaggle.json in ~/.kaggle/")
        sys.exit(1)


def collect_gtzan_wavs(dataset_path: str) -> list:
    """Collect all .wav files from the GTZAN download."""
    wavs = []
    for root, _dirs, files in os.walk(dataset_path):
        for f in files:
            if f.lower().endswith(".wav"):
                wavs.append(os.path.join(root, f))
    return wavs


def collect_demand_mono(dataset_path: str) -> list:
    """Collect only ch01.wav (mono) files from the DEMAND download."""
    mono = []
    for root, _dirs, files in os.walk(dataset_path):
        for f in files:
            if f.lower().endswith("ch01.wav"):
                mono.append(os.path.join(root, f))
    return mono


# ---------------------------------------------------------------------------
# AWS helpers
# ---------------------------------------------------------------------------
def get_s3_client(args):
    """Create a boto3 S3 client with credential chain resolution."""
    try:
        import boto3
    except ImportError:
        print("Error: boto3 is required. Install with:")
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
        client.list_buckets()
        return client
    except Exception as e:
        print(f"Error: Could not connect to AWS S3: {e}")
        sys.exit(1)


def ensure_bucket_exists(s3, bucket_name):
    """Check if the S3 bucket exists; create it if not."""
    try:
        s3.head_bucket(Bucket=bucket_name)
        print(f"Bucket '{bucket_name}' exists.")
    except s3.exceptions.ClientError as e:
        error_code = int(e.response["Error"]["Code"])
        if error_code == 404:
            print(f"Bucket '{bucket_name}' not found — creating...")
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
            except Exception as ce:
                print(f"Error creating bucket: {ce}")
                sys.exit(1)
        else:
            print(f"Error checking bucket: {e}")
            sys.exit(1)
    except Exception as e:
        print(f"Error checking bucket: {e}")
        sys.exit(1)


def s3_prefix_has_objects(s3, bucket, prefix):
    """Return True if any objects exist under the prefix."""
    try:
        resp = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=1)
        return resp.get("KeyCount", 0) > 0
    except Exception:
        return False


def upload_files(s3, bucket, prefix, file_paths, label="Uploading"):
    """Upload a list of local files to S3, using just the basename as key."""
    print(f"Uploading {len(file_paths)} files to s3://{bucket}/{prefix} ...")
    for fpath in tqdm(file_paths, desc=label):
        key = f"{prefix}{os.path.basename(fpath)}"
        try:
            s3.upload_file(fpath, bucket, key)
        except Exception as e:
            print(f"Warning: Failed to upload {fpath}: {e}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Download GTZAN & DEMAND datasets from Kaggle and upload to S3"
    )
    parser.add_argument("--s3-bucket", type=str, required=True, help="Target S3 bucket name")
    parser.add_argument("--aws-access-key", type=str, default=None, help="AWS access key ID")
    parser.add_argument("--aws-secret-key", type=str, default=None, help="AWS secret access key")
    parser.add_argument("--aws-region", type=str, default=None, help="AWS region")
    parser.add_argument(
        "--force", action="store_true",
        help="Re-upload even if datasets already exist in S3"
    )
    args = parser.parse_args()

    # Connect to S3
    print("Connecting to AWS S3...")
    s3 = get_s3_client(args)
    ensure_bucket_exists(s3, args.s3_bucket)

    # Check what already exists
    gtzan_exists = s3_prefix_has_objects(s3, args.s3_bucket, S3_GTZAN_PREFIX)
    demand_exists = s3_prefix_has_objects(s3, args.s3_bucket, S3_DEMAND_PREFIX)

    if gtzan_exists and demand_exists and not args.force:
        print("Both datasets already exist in S3. Use --force to re-upload.")
        print(f"  s3://{args.s3_bucket}/{S3_GTZAN_PREFIX}")
        print(f"  s3://{args.s3_bucket}/{S3_DEMAND_PREFIX}")
        return

    # --- GTZAN ---
    if not gtzan_exists or args.force:
        gtzan_path = download_from_kaggle(KAGGLE_GTZAN)
        gtzan_wavs = collect_gtzan_wavs(gtzan_path)
        print(f"Found {len(gtzan_wavs)} GTZAN .wav files")
        if gtzan_wavs:
            upload_files(s3, args.s3_bucket, S3_GTZAN_PREFIX, gtzan_wavs, "Uploading GTZAN")
        else:
            print("Warning: No .wav files found in GTZAN download!")
    else:
        print("GTZAN already in S3, skipping.")

    # --- DEMAND (mono only) ---
    if not demand_exists or args.force:
        demand_path = download_from_kaggle(KAGGLE_DEMAND)
        demand_mono = collect_demand_mono(demand_path)
        print(f"Found {len(demand_mono)} DEMAND mono (ch01) files")

        # Rename to include folder name for clarity (e.g., DKITCHEN_ch01.wav)
        renamed = []
        for fpath in demand_mono:
            folder = os.path.basename(os.path.dirname(fpath))
            new_name = f"{folder}_ch01.wav"
            renamed.append((fpath, new_name))

        print(f"Uploading {len(renamed)} mono files to s3://{args.s3_bucket}/{S3_DEMAND_PREFIX} ...")
        for fpath, name in tqdm(renamed, desc="Uploading DEMAND"):
            key = f"{S3_DEMAND_PREFIX}{name}"
            try:
                s3.upload_file(fpath, args.s3_bucket, key)
            except Exception as e:
                print(f"Warning: Failed to upload {name}: {e}")
    else:
        print("DEMAND already in S3, skipping.")

    print("\n" + "=" * 40)
    print("Done! S3 bucket populated.")
    print(f"  s3://{args.s3_bucket}/{S3_GTZAN_PREFIX}")
    print(f"  s3://{args.s3_bucket}/{S3_DEMAND_PREFIX}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nAborted.")
        sys.exit(1)
    except Exception as e:
        print(f"\nUnexpected error: {e}")
        sys.exit(1)
