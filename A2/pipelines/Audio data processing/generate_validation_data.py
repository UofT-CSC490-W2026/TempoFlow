#!/usr/bin/env python3
"""
Audio Alignment Validation Dataset Generator

Generates degraded audio clip pairs with precise timestamp metadata
for testing audio synchronization algorithms.

Supports three execution modes:
  - local       : Read/write local filesystem (default, original behaviour)
  - local-upload: Generate locally then upload output to S3
  - aws         : Download sources from S3, generate, upload outputs to S3
"""

import os
import sys
import json
import random
import argparse
import tempfile
from pathlib import Path

import numpy as np
import librosa
import soundfile as sf
from scipy.signal import butter, sosfilt
from tqdm import tqdm


# Default sample rate for all processing
SAMPLE_RATE = 22050

# S3 prefixes (must match get_audio_files.py)
S3_GTZAN_PREFIX = "datasets/gtzan/"
S3_DEMAND_PREFIX = "datasets/demand/"


# ---------------------------------------------------------------------------
# AWS helpers
# ---------------------------------------------------------------------------
def get_s3_client(args):
    """Create a boto3 S3 client with credential chain resolution."""
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
        client.list_buckets()
        return client
    except Exception as e:
        print(f"Error: Could not connect to AWS S3: {e}")
        print("Ensure your credentials are valid (CLI flags, env vars, or IAM role).")
        sys.exit(1)


def ensure_bucket_exists(s3, bucket_name):
    """Check if the bucket exists; create if it does not."""
    try:
        s3.head_bucket(Bucket=bucket_name)
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
            except Exception as ce:
                print(f"Error creating bucket: {ce}")
                sys.exit(1)
        else:
            print(f"Error accessing bucket '{bucket_name}': {e}")
            sys.exit(1)
    except Exception as e:
        print(f"Error checking bucket '{bucket_name}': {e}")
        sys.exit(1)


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
        if not rel:
            continue
        dest = os.path.join(local_dir, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        try:
            s3.download_file(bucket, key, dest)
        except Exception as e:
            print(f"Warning: Failed to download {key}: {e}")

    return True


def upload_directory_to_s3(s3, local_dir, bucket, s3_prefix):
    """Recursively upload a local directory to S3."""
    files = []
    for root, _dirs, filenames in os.walk(local_dir):
        for fname in filenames:
            files.append(os.path.join(root, fname))

    if not files:
        return

    print(f"Uploading {len(files)} files to s3://{bucket}/{s3_prefix} ...")
    for fpath in tqdm(files, desc="Uploading"):
        rel = os.path.relpath(fpath, local_dir).replace("\\", "/")
        key = f"{s3_prefix}{rel}"
        try:
            s3.upload_file(fpath, bucket, key)
        except Exception as e:
            print(f"Warning: Failed to upload {fpath}: {e}")


# ---------------------------------------------------------------------------
# Audio processing (unchanged from original)
# ---------------------------------------------------------------------------
def load_audio(filepath: str, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Load an audio file and return as mono numpy array."""
    audio, _ = librosa.load(filepath, sr=sr, mono=True)
    return audio


def apply_bandpass_filter(audio: np.ndarray, low_freq: float, high_freq: float,
                          sr: int = SAMPLE_RATE, order: int = 4) -> np.ndarray:
    """Apply a Butterworth bandpass filter to simulate microphone frequency response."""
    nyquist = sr / 2
    low = max(0.001, min(low_freq / nyquist, 0.99))
    high = max(low + 0.01, min(high_freq / nyquist, 0.999))

    sos = butter(order, [low, high], btype='band', output='sos')
    filtered = sosfilt(sos, audio)
    return filtered.astype(np.float32)


def calculate_rms(audio: np.ndarray) -> float:
    """Calculate root mean square of audio signal."""
    return np.sqrt(np.mean(audio ** 2))


def mix_with_noise(signal: np.ndarray, noise: np.ndarray, snr_db: float) -> np.ndarray:
    """Mix signal with noise at a specified SNR level."""
    if len(noise) < len(signal):
        repeats = int(np.ceil(len(signal) / len(noise)))
        noise = np.tile(noise, repeats)
    noise = noise[:len(signal)]

    signal_rms = calculate_rms(signal)
    noise_rms = calculate_rms(noise)

    if noise_rms < 1e-10:
        return signal.copy()

    target_noise_rms = signal_rms / (10 ** (snr_db / 20))
    noise_scaled = noise * (target_noise_rms / noise_rms)

    mixed = signal + noise_scaled

    max_val = np.max(np.abs(mixed))
    if max_val > 1.0:
        mixed = mixed / max_val * 0.99

    return mixed.astype(np.float32)


def get_random_segment(audio: np.ndarray, duration_samples: int, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Extract a random segment from audio."""
    if len(audio) <= duration_samples:
        result = np.zeros(duration_samples, dtype=np.float32)
        result[:len(audio)] = audio
        return result

    start = random.randint(0, len(audio) - duration_samples)
    return audio[start:start + duration_samples].astype(np.float32)


def generate_pair(
    source_audio: np.ndarray,
    distractor_audios: list,
    noise_audios: list,
    sr: int = SAMPLE_RATE
) -> tuple:
    """Generate a pair of degraded audio clips with ground truth timestamps."""
    clip_a_low = random.uniform(150, 300)
    clip_a_high = random.uniform(2500, 4000)
    clip_b_low = random.uniform(80, 150)
    clip_b_high = random.uniform(4000, 6000)

    filtered_a = apply_bandpass_filter(source_audio, clip_a_low, clip_a_high, sr)
    filtered_b = apply_bandpass_filter(source_audio, clip_b_low, clip_b_high, sr)

    noise_a = random.choice(noise_audios) if noise_audios else np.zeros(1)
    noise_b = random.choice(noise_audios) if noise_audios else np.zeros(1)

    snr_a = random.uniform(5, 20)
    snr_b = random.uniform(5, 20)

    noisy_a = mix_with_noise(filtered_a, noise_a, snr_a)
    noisy_b = mix_with_noise(filtered_b, noise_b, snr_b)

    pad_start_a_dur = random.uniform(1.0, 5.0)
    pad_end_a_dur = random.uniform(1.0, 5.0)
    pad_start_b_dur = random.uniform(1.0, 5.0)
    pad_end_b_dur = random.uniform(1.0, 5.0)

    pad_start_a_samples = int(pad_start_a_dur * sr)
    pad_end_a_samples = int(pad_end_a_dur * sr)
    pad_start_b_samples = int(pad_start_b_dur * sr)
    pad_end_b_samples = int(pad_end_b_dur * sr)

    distractor_a_start = get_random_segment(random.choice(distractor_audios), pad_start_a_samples, sr) if distractor_audios else np.zeros(pad_start_a_samples)
    distractor_a_end = get_random_segment(random.choice(distractor_audios), pad_end_a_samples, sr) if distractor_audios else np.zeros(pad_end_a_samples)
    distractor_b_start = get_random_segment(random.choice(distractor_audios), pad_start_b_samples, sr) if distractor_audios else np.zeros(pad_start_b_samples)
    distractor_b_end = get_random_segment(random.choice(distractor_audios), pad_end_b_samples, sr) if distractor_audios else np.zeros(pad_end_b_samples)

    distractor_a_start = apply_bandpass_filter(distractor_a_start, clip_a_low, clip_a_high, sr)
    distractor_a_end = apply_bandpass_filter(distractor_a_end, clip_a_low, clip_a_high, sr)
    distractor_b_start = apply_bandpass_filter(distractor_b_start, clip_b_low, clip_b_high, sr)
    distractor_b_end = apply_bandpass_filter(distractor_b_end, clip_b_low, clip_b_high, sr)

    clip_a = np.concatenate([distractor_a_start, noisy_a, distractor_a_end])
    clip_b = np.concatenate([distractor_b_start, noisy_b, distractor_b_end])

    clip_1_start_sec = pad_start_a_dur
    clip_1_end_sec = pad_start_a_dur + (len(noisy_a) / sr)
    clip_2_start_sec = pad_start_b_dur
    clip_2_end_sec = pad_start_b_dur + (len(noisy_b) / sr)

    metadata = {
        "clip_1_start_sec": round(clip_1_start_sec, 3),
        "clip_1_end_sec": round(clip_1_end_sec, 3),
        "clip_2_start_sec": round(clip_2_start_sec, 3),
        "clip_2_end_sec": round(clip_2_end_sec, 3),
        "processing_params": {
            "clip_a_bandpass": [clip_a_low, clip_a_high],
            "clip_b_bandpass": [clip_b_low, clip_b_high],
            "clip_a_snr_db": snr_a,
            "clip_b_snr_db": snr_b
        }
    }

    return clip_a, clip_b, metadata


# ---------------------------------------------------------------------------
# Core generation logic (shared across modes)
# ---------------------------------------------------------------------------
def run_generation(dataset_dir: str, output_dir: str, num_pairs: int, seed=None):
    """
    Run the generation pipeline against local directories.

    Returns 0 on success, 1 on failure.
    """
    if seed is not None:
        random.seed(seed)
        np.random.seed(seed)

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    dance_dir = Path(dataset_dir) / "dance"
    bg_dir = Path(dataset_dir) / "background"

    if not dance_dir.exists():
        print(f"Error: Dance dataset not found at {dance_dir}")
        print("Run get_audio_files.py first to set up the datasets.")
        return 1

    # Load source audio
    print("Loading source audio files...")
    dance_files = list(dance_dir.glob("*.wav")) + list(dance_dir.glob("*.au"))
    if not dance_files:
        print(f"Error: No audio files found in {dance_dir}")
        return 1

    print(f"Found {len(dance_files)} source tracks")

    # Load noise files
    noise_audios = []
    if bg_dir.exists():
        noise_files = list(bg_dir.glob("*.wav"))
        print(f"Loading {len(noise_files)} background noise files...")
        for nf in tqdm(noise_files, desc="Loading noise"):
            try:
                noise_audios.append(load_audio(str(nf)))
            except Exception as e:
                print(f"Warning: Could not load {nf}: {e}")
    else:
        print("Warning: No background noise directory found. Proceeding without noise injection.")

    # Generate pairs
    manifest = []

    print(f"\nGenerating {num_pairs} audio pairs...")
    for i in tqdm(range(num_pairs), desc="Generating pairs"):
        try:
            source_file = random.choice(dance_files)
            source_audio = load_audio(str(source_file))

            genre = source_file.stem.split(".")[0] if "." in source_file.stem else "unknown"
            test_id = f"val_{i+1:03d}_{genre}"

            distractor_files = [f for f in dance_files if f != source_file]
            distractor_audios = []
            for df in random.sample(distractor_files, min(5, len(distractor_files))):
                try:
                    distractor_audios.append(load_audio(str(df)))
                except Exception:
                    pass

            clip_a, clip_b, metadata = generate_pair(
                source_audio, distractor_audios, noise_audios
            )

            clip_a_path = output_path / f"val_{i+1:03d}_A.wav"
            clip_b_path = output_path / f"val_{i+1:03d}_B.wav"

            sf.write(str(clip_a_path), clip_a, SAMPLE_RATE)
            sf.write(str(clip_b_path), clip_b, SAMPLE_RATE)

            manifest.append({
                "test_id": test_id,
                "clip_1_path": f"./{clip_a_path.name}",
                "clip_2_path": f"./{clip_b_path.name}",
                "clip_1_start_sec": metadata["clip_1_start_sec"],
                "clip_1_end_sec": metadata["clip_1_end_sec"],
                "clip_2_start_sec": metadata["clip_2_start_sec"],
                "clip_2_end_sec": metadata["clip_2_end_sec"]
            })
        except Exception as e:
            print(f"\nWarning: Failed to generate pair {i+1}: {e}")
            continue

    # Save manifest
    manifest_path = output_path / "manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\nDone! Generated {len(manifest)} pairs.")
    print(f"Output directory: {output_path.absolute()}")
    print(f"Manifest: {manifest_path}")
    return 0


# ---------------------------------------------------------------------------
# Mode runners
# ---------------------------------------------------------------------------
def run_local(args):
    """Mode: local — read/write local filesystem (original behaviour)."""
    return run_generation(args.dataset_dir, args.output_dir, args.num_pairs, args.seed)


def run_local_upload(args):
    """Mode: local-upload — generate locally then upload output to S3."""
    if not args.s3_bucket:
        print("Error: --s3-bucket is required for local-upload mode.")
        return 1

    rc = run_generation(args.dataset_dir, args.output_dir, args.num_pairs, args.seed)
    if rc != 0:
        return rc

    print("\nConnecting to AWS S3...")
    s3 = get_s3_client(args)
    ensure_bucket_exists(s3, args.s3_bucket)

    prefix = args.s3_output_prefix or "output/"
    upload_directory_to_s3(s3, args.output_dir, args.s3_bucket, prefix)

    print(f"\nOutput uploaded to s3://{args.s3_bucket}/{prefix}")
    return 0


def _list_s3_keys(s3, bucket, prefix):
    """List all object keys under an S3 prefix."""
    paginator = s3.get_paginator("list_objects_v2")
    keys = []
    try:
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                keys.append(obj["Key"])
    except Exception as e:
        print(f"Error listing s3://{bucket}/{prefix}: {e}")
    return keys


def _download_s3_keys(s3, bucket, keys, local_dir, strip_prefix=""):
    """Download a list of specific S3 keys into *local_dir*."""
    for key in tqdm(keys, desc="Downloading"):
        rel = key[len(strip_prefix):] if strip_prefix else os.path.basename(key)
        if not rel:
            continue
        dest = os.path.join(local_dir, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        try:
            s3.download_file(bucket, key, dest)
        except Exception as e:
            print(f"Warning: Failed to download {key}: {e}")


def run_aws(args):
    """Mode: aws — sample sources from S3, generate, upload outputs to S3.

    Only downloads a random subset of GTZAN tracks (enough for the
    requested number of pairs) rather than the entire dataset.  All
    DEMAND mono files (~18) are downloaded since they are tiny.
    """
    if not args.s3_bucket:
        print("Error: --s3-bucket is required for aws mode.")
        return 1

    print("Connecting to AWS S3...")
    s3 = get_s3_client(args)
    ensure_bucket_exists(s3, args.s3_bucket)

    with tempfile.TemporaryDirectory() as tmpdir:
        dataset_dir = os.path.join(tmpdir, "dataset")
        dance_dir = os.path.join(dataset_dir, "dance")
        bg_dir = os.path.join(dataset_dir, "background")
        os.makedirs(dance_dir, exist_ok=True)
        os.makedirs(bg_dir, exist_ok=True)

        # --- GTZAN: sample only what we need ---
        print("\nListing GTZAN tracks in S3...")
        gtzan_keys = [k for k in _list_s3_keys(s3, args.s3_bucket, S3_GTZAN_PREFIX)
                      if k.lower().endswith((".wav", ".au"))]
        if not gtzan_keys:
            print("Error: No GTZAN files found in S3.")
            print("Run the dataset helper to populate the S3 bucket first.")
            return 1

        # We need: num_pairs sources + up to 5 distractors per pair, but
        # many pairs reuse tracks, so 2× num_pairs + 10 is plenty.
        sample_size = min(len(gtzan_keys), args.num_pairs * 2 + 10)
        sampled_keys = random.sample(gtzan_keys, sample_size)
        print(f"Sampling {sample_size} of {len(gtzan_keys)} GTZAN tracks...")
        _download_s3_keys(s3, args.s3_bucket, sampled_keys, dance_dir,
                          strip_prefix=S3_GTZAN_PREFIX)

        # --- DEMAND: grab all (~18 mono files, tiny) ---
        print("\nDownloading DEMAND noise files from S3...")
        if not download_s3_prefix(s3, args.s3_bucket, S3_DEMAND_PREFIX, bg_dir):
            print("Warning: DEMAND noise dataset not found in S3. Proceeding without noise.")

        # --- Generate ---
        output_dir = os.path.join(tmpdir, "output")
        rc = run_generation(dataset_dir, output_dir, args.num_pairs, args.seed)
        if rc != 0:
            return rc

        # --- Upload outputs ---
        prefix = args.s3_output_prefix or "output/"
        upload_directory_to_s3(s3, output_dir, args.s3_bucket, prefix)
        print(f"\nOutput uploaded to s3://{args.s3_bucket}/{prefix}")

    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Generate audio alignment validation dataset"
    )
    parser.add_argument(
        "--num-pairs", type=int, default=10,
        help="Number of audio pairs to generate (default: 10)"
    )
    parser.add_argument(
        "--output-dir", type=str, default="./data",
        help="Output directory for generated files (default: ./data)"
    )
    parser.add_argument(
        "--dataset-dir", type=str, default="./dataset",
        help="Directory containing source datasets (default: ./dataset)"
    )
    parser.add_argument(
        "--seed", type=int, default=None,
        help="Random seed for reproducibility"
    )

    # AWS arguments
    parser.add_argument(
        "--mode", choices=["local", "local-upload", "aws"], default="local",
        help="Execution mode (default: local)"
    )
    parser.add_argument("--s3-bucket", type=str, default=None, help="S3 bucket name (required for S3 modes)")
    parser.add_argument("--s3-output-prefix", type=str, default=None, help="S3 prefix for outputs (default: output/)")
    parser.add_argument("--aws-access-key", type=str, default=None, help="AWS access key ID (or set AWS_ACCESS_KEY_ID)")
    parser.add_argument("--aws-secret-key", type=str, default=None, help="AWS secret access key (or set AWS_SECRET_ACCESS_KEY)")
    parser.add_argument("--aws-region", type=str, default=None, help="AWS region (or set AWS_DEFAULT_REGION)")

    args = parser.parse_args()

    MODE_RUNNERS = {
        "local": run_local,
        "local-upload": run_local_upload,
        "aws": run_aws,
    }

    try:
        rc = MODE_RUNNERS[args.mode](args)
        return rc
    except KeyboardInterrupt:
        print("\nAborted.")
        return 1
    except Exception as e:
        print(f"\nUnexpected error: {e}")
        return 1


if __name__ == "__main__":
    exit(main())
