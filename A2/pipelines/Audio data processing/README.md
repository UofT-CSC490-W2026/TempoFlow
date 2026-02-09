# Audio Alignment Validation Dataset Generator

Generate degraded audio clip pairs with precise timestamp metadata for testing audio synchronization algorithms.

## Overview

This tool creates validation datasets by:
1. Selecting random tracks from the GTZAN dataset
2. Creating two degraded copies with different bandpass filters and environmental noise
3. Adding distractor audio padding to create temporal offsets
4. Exporting ground truth timestamps as JSON

## Prerequisites

- Python 3.8+
- ~2GB disk space for datasets
- Downloaded dataset archives (see Dataset Setup below)

## Installation

1. **Create and activate a virtual environment:**

   ```powershell
   cd "c:\Users\abell\Desktop\Audio data processing"
   python -m venv venv
   .\venv\Scripts\Activate
   ```

2. **Install dependencies:**

   ```powershell
   pip install -r requirements.txt
   ```

## Dataset Setup

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

## Usage

### Generate validation pairs

```powershell
python generate_validation_data.py --num-pairs 100 --output-dir ./data
```

### Options

| Argument | Default | Description |
|----------|---------|-------------|
| `--num-pairs` | 10 | Number of audio pairs to generate |
| `--output-dir` | `./data` | Output directory for generated files |
| `--dataset-dir` | `./dataset` | Directory containing source datasets |
| `--seed` | None | Random seed for reproducibility |

### Example

```powershell
# Generate 50 pairs with reproducible results
python generate_validation_data.py --num-pairs 50 --output-dir ./validation_set --seed 42
```

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

The timestamps indicate where the shared audio content begins and ends in each clip.

## How It Works

### Signal Degradation
- **Bandpass Filtering**: Each clip receives a randomized bandpass filter (e.g., 200Hz-3kHz vs 100Hz-5kHz) to simulate different microphone frequency responses
- **Noise Injection**: DEMAND environmental recordings are mixed in at 5-20dB SNR

### Temporal Shifting
Random segments from other GTZAN tracks are concatenated to the start/end of each clip, creating different offsets. This forces alignment algorithms to distinguish target audio from semantically similar "distractor" content.

## License

For research and development use only. GTZAN and DEMAND datasets have their own respective licenses.
