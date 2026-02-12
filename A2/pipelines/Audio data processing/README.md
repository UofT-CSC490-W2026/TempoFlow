# Audio Alignment Validation Dataset Generator

Generate degraded audio clip pairs with precise timestamp metadata for testing audio synchronization algorithms.

## Overview

This tool creates validation datasets by:
1. Selecting random tracks from the GTZAN dataset
2. Creating two degraded copies with different bandpass filters and environmental noise
3. Adding distractor audio padding to create temporal offsets
4. Exporting ground truth timestamps as JSON

Supports three execution modes: **local**, **local-upload** (local + push to S3), and **aws** (fully cloud-based).

## Prerequisites

- Python 3.8+
- ~2GB disk space for datasets (local modes)
- Downloaded dataset archives (see Dataset Setup below)
- AWS credentials (only for `local-upload` and `aws` modes)

## Installation

1. **Create and activate a virtual environment:**

   ```powershell
   python -m venv venv
   .\venv\Scripts\Activate
   ```

2. **Install dependencies:**

   ```powershell
   pip install -r requirements.txt
   ```

## Dataset Setup

### Local mode

Download the following datasets and place the zip files in this directory:

1. **GTZAN Dataset** → Save as `archive.zip`
   - Source: [Kaggle GTZAN Dataset](https://www.kaggle.com/datasets/andradaolteanu/gtzan-dataset-music-genre-classification)

2. **DEMAND Dataset** → Save as `archive(1).zip`
   - Source: [Kaggle DEMAND Dataset](https://www.kaggle.com/datasets/chrisfilo/demand) or Zenodo

3. **Extract the datasets:**

   ```powershell
   python get_audio_files.py
   ```

   This extracts:
   - GTZAN music files → `dataset/dance/`
   - DEMAND noise files (ch01 mono) → `dataset/background/`

### AWS mode

Datasets must be in S3 before running `generate_validation_data.py --mode aws`. Two ways to populate the bucket:

1. **`populate_s3.py`** — downloads GTZAN (full) and DEMAND (mono ch01 only) from Kaggle and uploads to S3:
   ```powershell
   python populate_s3.py --s3-bucket my-audio-bucket
   ```
   Requires Kaggle credentials (`KAGGLE_USERNAME` + `KAGGLE_KEY` env vars, or `~/.kaggle/kaggle.json`).

2. **`local-upload` mode** — if you already have the local zip archives:
   ```powershell
   python get_audio_files.py --mode local-upload --s3-bucket my-audio-bucket
   ```

Verify datasets are in S3:
```powershell
python get_audio_files.py --mode aws --s3-bucket my-audio-bucket
```

## Execution Modes

Both `get_audio_files.py` and `generate_validation_data.py` support the same three modes via `--mode`:

| Mode | Description |
|------|-------------|
| `local` | Default. Reads/writes the local filesystem only. Original behaviour. |
| `local-upload` | Runs locally, then uploads results to an S3 bucket. |
| `aws` | **get_audio_files**: verifies S3 has datasets. **generate_validation_data**: samples from S3, generates, uploads output. |

> **Note:** In `aws` mode, `generate_validation_data.py` only downloads a random subset of GTZAN tracks from S3 (enough for the requested pairs), not the entire dataset. All ~18 DEMAND mono files are downloaded since they are tiny.

### AWS Credential Resolution

Credentials are resolved in this order:
1. **CLI flags** `--aws-access-key` and `--aws-secret-key`
2. **Environment variables** `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
3. **IAM role / instance profile** (automatic when running inside AWS)

### AWS Arguments

| Argument | Description |
|----------|-------------|
| `--mode` | `local`, `local-upload`, or `aws` |
| `--s3-bucket` | S3 bucket name (required for S3 modes) |
| `--s3-output-prefix` | S3 key prefix for outputs (default: `output/`) — `generate_validation_data.py` only |
| `--aws-access-key` | AWS access key ID |
| `--aws-secret-key` | AWS secret access key |
| `--aws-region` | AWS region name |

## Usage Examples

### Local mode (default)

```powershell
# Extract datasets
python get_audio_files.py

# Generate 100 pairs
python generate_validation_data.py --num-pairs 100 --output-dir ./data
```

### Local + S3 upload

```powershell
# Extract and upload datasets to S3
python get_audio_files.py --mode local-upload --s3-bucket my-audio-bucket --aws-access-key AKIA... --aws-secret-key ...

# Generate pairs and upload to S3
python generate_validation_data.py --mode local-upload --num-pairs 100 --s3-bucket my-audio-bucket --s3-output-prefix validation/run1/
```

### Pure AWS mode

```powershell
# 1. Populate S3 with the dataset download helper (separate script)
#    OR use local-upload mode as shown above

# 2. Verify datasets exist in S3
python get_audio_files.py --mode aws --s3-bucket my-audio-bucket

# 3. Generate pairs entirely in the cloud
python generate_validation_data.py --mode aws --num-pairs 100 --s3-bucket my-audio-bucket --s3-output-prefix validation/run1/
```

### Generation Options

| Argument | Default | Description |
|----------|---------|-------------|
| `--num-pairs` | 10 | Number of audio pairs to generate |
| `--output-dir` | `./data` | Output directory for generated files |
| `--dataset-dir` | `./dataset` | Directory containing source datasets |
| `--seed` | None | Random seed for reproducibility |

## Output Format

The generator creates:
- `val_XXX_A.wav` - First clip of each pair
- `val_XXX_B.wav` - Second clip of each pair
- `manifest.json` - Ground truth timestamps

### Manifest Structure

```json
[
  {
    "test_id": "val_001_rock",
    "clip_1_path": "./val_001_A.wav",
    "clip_2_path": "./val_001_B.wav",
    "clip_1_start_sec": 2.0,
    "clip_1_end_sec": 12.0,
    "clip_2_start_sec": 5.5,
    "clip_2_end_sec": 15.5
  }
]
```

### S3 Layout

```
s3://my-audio-bucket/
  datasets/gtzan/         ← GTZAN .wav music files
  datasets/demand/        ← DEMAND .wav files (mono ch01)
  output/                 ← Generated pairs + manifest (configurable via --s3-output-prefix)
```

## How It Works

### Signal Degradation
- **Bandpass Filtering**: Each clip receives a randomized bandpass filter (e.g., 200Hz–3kHz vs 100Hz–5kHz) to simulate different microphone frequency responses
- **Noise Injection**: DEMAND environmental recordings are mixed in at 5–20 dB SNR

### Temporal Shifting
Random segments from other GTZAN tracks are concatenated to the start/end of each clip, creating different offsets. This forces alignment algorithms to distinguish target audio from semantically similar "distractor" content.

## License

For research and development use only. GTZAN and DEMAND datasets have their own respective licenses.
