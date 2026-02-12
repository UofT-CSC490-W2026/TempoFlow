# Dancer Alignment Validation Data Generation Pipeline

Generate validation datasets by applying mathematical affine transformations to reference dance videos. This ensures the scoring algorithm evaluates kinematic performance rather than recording environment differences.

## Quick Start

```bash
# Create virtual environment
python -m venv venv
venv\Scripts\activate  # Windows
# source venv/bin/activate  # Linux/Mac

# Install dependencies
pip install -r requirements.txt

# Generate validation dataset locally
python main.py generate --input ./input --output ./output

# Upload directly to S3 (no local save)
python main.py generate --input ./input --to-s3

# Stream from S3 and run model
python main.py stream
```

## Commands

### `generate`

Generate validation dataset from source videos.

```bash
python main.py generate [OPTIONS]
```

**Options:**
| Option | Default | Description |
|--------|---------|-------------|
| `--input` | `./input` | Source video directory |
| `--output` | `./output` | Output directory (ignored if `--to-s3`) |
| `--to-s3` | `false` | Upload to S3 instead of local save |

When `--to-s3` is set, you'll be prompted for AWS credentials. Credentials are validated before any video processing begins.

### `stream`

Stream videos from S3 and run the alignment model.

```bash
python main.py stream
```

Prompts for AWS credentials, then streams video pairs and runs the scoring model (when implemented).

## Transformations Applied

| Type | Parameter Range | Expected Score |
|------|----------------|----------------|
| Scale | 0.8x - 1.2x | 90-100% |
| Rotation | ±15° | 85-100% |
| Translation | ±10% | 90-100% |
| Aspect Ratio | 0.9x - 1.1x | 85-100% |
| Combined | All above | 80-100% |
| Temporal Offset | 0.1s - 0.5s | 40-95% |
| Negative Pair | Different video | 0-15% |

**Body Boundary Protection:** Rotation and translation are automatically clamped using MediaPipe pose detection to ensure the dancer remains fully visible in frame.

## Video ID Scheme

Each reference video is assigned a sequential ID (`R001`, `R002`, …). Transformed videos inherit their parent reference ID and append a transform index (`R001_T001`, `R001_T002`, …).

| Video | Example Filename |
|-------|------------------|
| Reference #1 | `R001_dance_reference.mp4` |
| Scale 0.8× of Ref #1 | `R001_T001_dance_spatial_scale_0.8.mp4` |
| Rotation 10° of Ref #1 | `R001_T002_dance_spatial_rotation_10.mp4` |
| Combined of Ref #1 | `R001_T011_dance_combined.mp4` |
| Reference #2 | `R002_hiphop_reference.mp4` |
| Scale 0.8× of Ref #2 | `R002_T001_hiphop_spatial_scale_0.8.mp4` |

This makes it easy to determine which transformed video corresponds to which reference at a glance.

## Output Structure

```
output/
├── references/
│   └── R001_video_reference.mp4
├── transformed_videos/
│   ├── R001_T001_video_spatial_scale_0.8.mp4
│   ├── R001_T002_video_spatial_rotation_10.mp4
│   ├── R001_T011_video_combined.mp4
│   └── ...
└── test_cases.json
```

### Ground Truth Format

```json
{
  "test_cases": [
    {
      "test_id": "R001_T001_dance_spatial_scale_0.8",
      "ref_s3_key": "references/R001_dance_reference.mp4",
      "transformed_video_s3_key": "transformed_videos/R001_T001_dance_spatial_scale_0.8.mp4",
      "transformation_type": "spatial_scale",
      "param_value": 0.8,
      "expected_score_min": 0.90,
      "expected_score_max": 1.0
    }
  ],
  "total_count": 12
}
```

## Project Structure

```
├── main.py                    # CLI entry point
├── requirements.txt
├── pipeline/
│   ├── video_utils.py         # Video I/O, clip extraction
│   ├── body_detection.py      # MediaPipe bounding box
│   ├── transformations.py     # Affine transforms
│   ├── temporal.py            # Offset injection
│   ├── negative_sampling.py   # Distinct clip selection
│   └── ground_truth.py        # JSON export
├── aws/
│   ├── credentials.py         # AWS validation
│   ├── s3_upload.py           # S3 uploads
│   └── s3_stream.py           # Presigned URLs
└── model/
    └── runner.py              # Model (TODO)
```

## Requirements

- Python 3.8+
- FFmpeg (for video encoding - install separately)
- Dependencies in `requirements.txt`
