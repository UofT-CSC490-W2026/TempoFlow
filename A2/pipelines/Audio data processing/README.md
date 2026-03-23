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
   .\venv\Scripts\Activate  # or ./venv/bin/activate on Linux/Mac
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

---

## Eight-Beat Segmentation (EBS) Pipeline

The EBS pipeline segments audio-aligned dance clip pairs into **8-beat
primitives** that respect musical phrase boundaries. It supports two input
modes: pre-computed alignment (from the validation dataset generator) or
direct video input with automatic alignment.

### Key features

- **Downbeat-phase estimation** — identifies "count 1" of each 8-count
  musical phrase by scoring onset strength across phase candidates, so segment
  boundaries align with choreographic phrases instead of cutting moves in half.
- **Beat extrapolation** — extends the detected beat grid to the edges of the
  shared window using the median interval, recovering segments that librosa's
  beat tracker would otherwise miss near signal boundaries.
- **Segment 0 starts at 0.0** — the intro segment spans from the start of the
  shared window through the first downbeat-aligned 8-count boundary, capturing
  any pre-beat lead-in.
- **Auto-alignment** — when given two video files, computes the shared content
  window automatically. **Default:** chroma features + local match (A5-style),
  with automatic fallback to onset-envelope cross-correlation if chroma fails.
  Set ``EBS_AUTO_ALIGN_MODE=onset_xcorr`` to force the legacy global-lag method only.
- **Robust fallback** — if beat detection fails confidence checks, falls back
  to fixed-time 3.0 s chunks.

### Quick start

```bash
# Mode A: from pre-computed alignment + audio
python ebs_segment.py \
    --ref-audio ./data/val_001_A.wav \
    --alignment ./data/manifest.json \
    --test-id val_001_unknown \
    --out ./output/ebs_segments.json

# Mode B: directly from video files (auto-align)
python ebs_segment.py \
    --ref-video reference.mp4 \
    --user-video user.mp4 \
    --auto-align \
    --out ./output/ebs_segments.json
```

### CLI options

| Argument | Default | Description |
|----------|---------|-------------|
| **Input sources** (provide audio OR video) | | |
| `--ref-audio` | — | Path to reference audio clip (WAV) |
| `--user-audio` | — | Path to user audio clip (WAV) |
| `--ref-video` | — | Path to reference video (mp4/mov); audio extracted automatically |
| `--user-video` | — | Path to user video (mp4/mov); audio extracted automatically |
| **Alignment** | | |
| `--alignment` | — | Path to alignment JSON (manifest.json or single-entry object) |
| `--test-id` | — | Select entry from a multi-entry manifest array |
| `--auto-align` | — | Compute alignment automatically (default: chroma + local match) |
| `--auto-align-mode` | env default | `chroma_sw` (default) or `onset_xcorr` (legacy); same as ``EBS_AUTO_ALIGN_MODE`` |
| **Output** | | |
| `--out` | `ebs_segments.json` | Output JSON path |
| `--verbose` | — | Enable DEBUG-level logging |

At minimum, provide `--ref-audio` or `--ref-video`, plus either `--alignment`
or `--auto-align`. Auto-alignment additionally requires a user clip
(`--user-audio` / `--user-video`).

### FFmpeg / ffprobe (all platforms)

Video extraction and metadata use **ffmpeg** and **ffprobe**. Resolution order:

1. **`EBS_FFMPEG_PATH`** / **`EBS_FFPROBE_PATH`** — full path to each binary (use when they are not on `PATH`, e.g. some Windows installs).
2. **`shutil.which`** — standard `PATH` lookup.
3. **Windows** — if still missing, common folders are checked: `%ProgramFiles%\ffmpeg\bin`, `%ProgramFiles(x86)%\ffmpeg\bin`, `C:\ffmpeg\bin`.

If ffmpeg is missing, the pipeline falls back to **librosa/audioread** for audio (slower). If ffprobe is missing, `video_meta` in the API may fail; set **`EBS_FFPROBE_PATH`** or install FFmpeg and add it to `PATH`.

### How it works

1. **Audio extraction** — if video inputs are provided, audio is extracted via
   ffmpeg (preferred) or librosa/audioread (fallback).
2. **Alignment** — either loaded from a JSON manifest or computed automatically:
   chroma STFT + local scoring (default), with fallback to onset-envelope
   cross-correlation (`scipy.signal.fftconvolve`) if needed.
3. **Beat tracking** — `librosa.beat.beat_track` runs on the reference clip's
   shared window (mono, 22050 Hz). Returns beat times, onset envelope, and
   beat frame positions.
4. **Beat extrapolation** — the detected beat grid is extended forward and
   backward using the median beat interval to cover the full shared window.
   This compensates for librosa missing beats near audio boundaries.
5. **Downbeat-phase estimation** — for each candidate phase offset k in
   {0..7}, the mean onset strength at beats k, k+8, k+16, … is computed. The
   phase with the highest score is "count 1" (the downbeat), aligning segments
   with natural musical phrases.
6. **Segmentation** —
   - **Segment 0** (intro): `[0.0, beat[phase + 8])` — covers the lead-in
     through the first full 8-count.
   - **Segments 1+**: clean 8-beat blocks starting on successive downbeats.
   - Incomplete tails are dropped.
7. **Clip mapping** — shared-time segment boundaries are mapped to absolute
   timestamps in each clip via `clip_X_start_sec + shared_*`.
8. **Confidence gate** — if beat detection fails (too few beats, irregular
   intervals, or high CV), the pipeline falls back to fixed-time 3.0 s chunks.

### Output schema (`ebs_segments.json`)

```json
{
  "pipeline": {
    "name": "ebs",
    "version": "1.0.0",
    "params": {
      "beats_per_segment": 8,
      "sample_rate": 22050,
      "fallback_chunk_sec": 3.0,
      "beat_cv_threshold": 0.3
    }
  },
  "alignment": {
    "clip_1_start_sec": 0.0,
    "clip_1_end_sec": 49.084,
    "clip_2_start_sec": 1.3,
    "clip_2_end_sec": 50.384,
    "shared_len_sec": 49.084
  },
  "beat_tracking": {
    "estimated_bpm": 152.0,
    "num_beats": 125,
    "num_beats_detected": 111,
    "confidence": {
      "median_interval_sec": 0.395,
      "coefficient_of_variation": 0.014,
      "passed": true
    },
    "downbeat_phase": 3,
    "source": "librosa.beat.beat_track"
  },
  "beats_shared_sec": [0.116, 0.511, 0.906, "..."],
  "segmentation_mode": "eight_beat",
  "segments": [
    {
      "seg_id": 0,
      "beat_idx_range": [0, 11],
      "shared_start_sec": 0.0,
      "shared_end_sec": 3.692,
      "clip_1_seg_start_sec": 0.0,
      "clip_1_seg_end_sec": 3.692,
      "clip_2_seg_start_sec": 1.3,
      "clip_2_seg_end_sec": 4.992
    },
    {
      "seg_id": 1,
      "beat_idx_range": [11, 19],
      "shared_start_sec": 3.692,
      "shared_end_sec": 6.85,
      "clip_1_seg_start_sec": 3.692,
      "clip_1_seg_end_sec": 6.85,
      "clip_2_seg_start_sec": 4.992,
      "clip_2_seg_end_sec": 8.15
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `segmentation_mode` | `"eight_beat"` when beat tracking passes; `"fixed_time"` on fallback |
| `num_beats` | Total beats (detected + extrapolated) |
| `num_beats_detected` | Beats detected by librosa (before extrapolation) |
| `downbeat_phase` | Phase offset k identifying "count 1" in the beat array |
| `beats_shared_sec` | All beat times relative to shared window start (empty on fallback) |
| `segments[].beat_idx_range` | `[start, end]` into `beats_shared_sec`; `null` for fixed-time |
| `segments[].shared_*_sec` | Timestamps relative to the shared window start |
| `segments[].clip_X_seg_*` | Absolute timestamps in each clip: `clip_X_start_sec + shared_*` |

### Confidence checks & fallback

Beat tracking must pass three checks to use eight-beat segmentation:

| Check | Threshold | Description |
|-------|-----------|-------------|
| Minimum beats | >= 9 | At least 9 beats for one 8-beat segment |
| Beat interval | 0.25–1.0 s | Median interval within ~60–240 BPM |
| Regularity (CV) | < 0.3 | Coefficient of variation of beat intervals |

If any check fails, the pipeline falls back to **fixed-time segmentation**
(3.0 s chunks, `segmentation_mode: "fixed_time"`).

## License

For research and development use only. GTZAN and DEMAND datasets have their own respective licenses.
