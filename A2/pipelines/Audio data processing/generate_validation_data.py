#!/usr/bin/env python3
"""
Audio Alignment Validation Dataset Generator

Generates degraded audio clip pairs with precise timestamp metadata 
for testing audio synchronization algorithms.
"""

import os
import json
import random
import argparse
from pathlib import Path

import numpy as np
import librosa
import soundfile as sf
from scipy.signal import butter, sosfilt
from tqdm import tqdm


# Default sample rate for all processing
SAMPLE_RATE = 22050


def load_audio(filepath: str, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Load an audio file and return as mono numpy array."""
    audio, _ = librosa.load(filepath, sr=sr, mono=True)
    return audio


def apply_bandpass_filter(audio: np.ndarray, low_freq: float, high_freq: float, 
                          sr: int = SAMPLE_RATE, order: int = 4) -> np.ndarray:
    """
    Apply a Butterworth bandpass filter to simulate microphone frequency response.
    
    Args:
        audio: Input audio signal
        low_freq: Lower cutoff frequency in Hz
        high_freq: Upper cutoff frequency in Hz
        sr: Sample rate
        order: Filter order
    
    Returns:
        Filtered audio signal
    """
    nyquist = sr / 2
    low = low_freq / nyquist
    high = high_freq / nyquist
    
    # Clamp to valid range
    low = max(0.001, min(low, 0.99))
    high = max(low + 0.01, min(high, 0.999))
    
    sos = butter(order, [low, high], btype='band', output='sos')
    filtered = sosfilt(sos, audio)
    
    return filtered.astype(np.float32)


def calculate_rms(audio: np.ndarray) -> float:
    """Calculate root mean square of audio signal."""
    return np.sqrt(np.mean(audio ** 2))


def mix_with_noise(signal: np.ndarray, noise: np.ndarray, snr_db: float) -> np.ndarray:
    """
    Mix signal with noise at a specified SNR level.
    
    Args:
        signal: Original audio signal
        noise: Noise signal (will be looped/trimmed to match signal length)
        snr_db: Target signal-to-noise ratio in decibels
    
    Returns:
        Mixed audio with noise at specified SNR
    """
    # Adjust noise length to match signal
    if len(noise) < len(signal):
        # Loop noise to match signal length
        repeats = int(np.ceil(len(signal) / len(noise)))
        noise = np.tile(noise, repeats)
    noise = noise[:len(signal)]
    
    # Calculate RMS values
    signal_rms = calculate_rms(signal)
    noise_rms = calculate_rms(noise)
    
    if noise_rms < 1e-10:
        return signal.copy()
    
    # Calculate target noise level for desired SNR
    # SNR = 20 * log10(signal_rms / noise_rms)
    # noise_rms_target = signal_rms / 10^(snr_db/20)
    target_noise_rms = signal_rms / (10 ** (snr_db / 20))
    noise_scaled = noise * (target_noise_rms / noise_rms)
    
    mixed = signal + noise_scaled
    
    # Normalize to prevent clipping
    max_val = np.max(np.abs(mixed))
    if max_val > 1.0:
        mixed = mixed / max_val * 0.99
    
    return mixed.astype(np.float32)


def get_random_segment(audio: np.ndarray, duration_samples: int, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Extract a random segment from audio."""
    if len(audio) <= duration_samples:
        # If audio is shorter, return it padded with zeros
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
    """
    Generate a pair of degraded audio clips with ground truth timestamps.
    
    Args:
        source_audio: The source track (Match Window)
        distractor_audios: List of audio arrays to use as distractors
        noise_audios: List of noise audio arrays (from DEMAND)
        sr: Sample rate
    
    Returns:
        Tuple of (clip_a, clip_b, metadata_dict)
    """
    # Randomize bandpass filter ranges for each clip
    # Clip A: narrower range simulating poor microphone
    clip_a_low = random.uniform(150, 300)
    clip_a_high = random.uniform(2500, 4000)
    
    # Clip B: wider range simulating better microphone  
    clip_b_low = random.uniform(80, 150)
    clip_b_high = random.uniform(4000, 6000)
    
    # Apply bandpass filters
    filtered_a = apply_bandpass_filter(source_audio, clip_a_low, clip_a_high, sr)
    filtered_b = apply_bandpass_filter(source_audio, clip_b_low, clip_b_high, sr)
    
    # Add noise at random SNR (5-20 dB)
    noise_a = random.choice(noise_audios) if noise_audios else np.zeros(1)
    noise_b = random.choice(noise_audios) if noise_audios else np.zeros(1)
    
    snr_a = random.uniform(5, 20)
    snr_b = random.uniform(5, 20)
    
    noisy_a = mix_with_noise(filtered_a, noise_a, snr_a)
    noisy_b = mix_with_noise(filtered_b, noise_b, snr_b)
    
    # Generate distractor padding (1-5 seconds each)
    pad_start_a_dur = random.uniform(1.0, 5.0)
    pad_end_a_dur = random.uniform(1.0, 5.0)
    pad_start_b_dur = random.uniform(1.0, 5.0)
    pad_end_b_dur = random.uniform(1.0, 5.0)
    
    pad_start_a_samples = int(pad_start_a_dur * sr)
    pad_end_a_samples = int(pad_end_a_dur * sr)
    pad_start_b_samples = int(pad_start_b_dur * sr)
    pad_end_b_samples = int(pad_end_b_dur * sr)
    
    # Get distractor segments
    distractor_a_start = get_random_segment(random.choice(distractor_audios), pad_start_a_samples, sr) if distractor_audios else np.zeros(pad_start_a_samples)
    distractor_a_end = get_random_segment(random.choice(distractor_audios), pad_end_a_samples, sr) if distractor_audios else np.zeros(pad_end_a_samples)
    distractor_b_start = get_random_segment(random.choice(distractor_audios), pad_start_b_samples, sr) if distractor_audios else np.zeros(pad_start_b_samples)
    distractor_b_end = get_random_segment(random.choice(distractor_audios), pad_end_b_samples, sr) if distractor_audios else np.zeros(pad_end_b_samples)
    
    # Apply same degradation to distractors for consistency
    distractor_a_start = apply_bandpass_filter(distractor_a_start, clip_a_low, clip_a_high, sr)
    distractor_a_end = apply_bandpass_filter(distractor_a_end, clip_a_low, clip_a_high, sr)
    distractor_b_start = apply_bandpass_filter(distractor_b_start, clip_b_low, clip_b_high, sr)
    distractor_b_end = apply_bandpass_filter(distractor_b_end, clip_b_low, clip_b_high, sr)
    
    # Concatenate: [distractor_start] + [degraded_source] + [distractor_end]
    clip_a = np.concatenate([distractor_a_start, noisy_a, distractor_a_end])
    clip_b = np.concatenate([distractor_b_start, noisy_b, distractor_b_end])
    
    # Calculate ground truth timestamps
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
    
    args = parser.parse_args()
    
    if args.seed is not None:
        random.seed(args.seed)
        np.random.seed(args.seed)
    
    # Setup directories
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    dataset_dir = Path(args.dataset_dir)
    dance_dir = dataset_dir / "dance"
    bg_dir = dataset_dir / "background"
    
    # Check for dataset
    if not dance_dir.exists():
        print(f"Error: Dance dataset not found at {dance_dir}")
        print("Run get_audio_files.py first to download the datasets.")
        return 1
    
    # Load all source audio files
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
    
    print(f"\nGenerating {args.num_pairs} audio pairs...")
    for i in tqdm(range(args.num_pairs), desc="Generating pairs"):
        # Select random source track
        source_file = random.choice(dance_files)
        source_audio = load_audio(str(source_file))
        
        # Get genre from filename for test_id
        genre = source_file.stem.split(".")[0] if "." in source_file.stem else "unknown"
        test_id = f"val_{i+1:03d}_{genre}"
        
        # Get distractor audios (different from source)
        distractor_files = [f for f in dance_files if f != source_file]
        distractor_audios = []
        # Load a few random distractors
        for df in random.sample(distractor_files, min(5, len(distractor_files))):
            try:
                distractor_audios.append(load_audio(str(df)))
            except:
                pass
        
        # Generate the pair
        clip_a, clip_b, metadata = generate_pair(
            source_audio, distractor_audios, noise_audios
        )
        
        # Save audio files
        clip_a_path = output_dir / f"val_{i+1:03d}_A.wav"
        clip_b_path = output_dir / f"val_{i+1:03d}_B.wav"
        
        sf.write(str(clip_a_path), clip_a, SAMPLE_RATE)
        sf.write(str(clip_b_path), clip_b, SAMPLE_RATE)
        
        # Add to manifest
        manifest.append({
            "test_id": test_id,
            "clip_1_path": f"./{clip_a_path.name}",
            "clip_2_path": f"./{clip_b_path.name}",
            "clip_1_start_sec": metadata["clip_1_start_sec"],
            "clip_1_end_sec": metadata["clip_1_end_sec"],
            "clip_2_start_sec": metadata["clip_2_start_sec"],
            "clip_2_end_sec": metadata["clip_2_end_sec"]
        })
    
    # Save manifest
    manifest_path = output_dir / "manifest.json"
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)
    
    print(f"\nDone! Generated {args.num_pairs} pairs.")
    print(f"Output directory: {output_dir.absolute()}")
    print(f"Manifest: {manifest_path}")
    
    return 0


if __name__ == "__main__":
    exit(main())
