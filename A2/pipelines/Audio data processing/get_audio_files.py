#!/usr/bin/env python3
"""
Extract audio datasets from locally downloaded archives.

Assumes the following files are already downloaded and placed in this directory:
- archive.zip (GTZAN dataset from Kaggle)
- archive(1).zip (DEMAND dataset from Kaggle/Zenodo)
"""

import os
import zipfile
from tqdm import tqdm

# --- CONFIGURATION ---
BASE_DIR = "dataset"
DANCE_DIR = os.path.join(BASE_DIR, "dance")
BG_DIR = os.path.join(BASE_DIR, "background")

# Local archive paths
GTZAN_ARCHIVE = "archive.zip"
DEMAND_ARCHIVE = "archive(1).zip"


def create_dirs():
    """Create the necessary directory structure."""
    if not os.path.exists(DANCE_DIR):
        os.makedirs(DANCE_DIR)
    if not os.path.exists(BG_DIR):
        os.makedirs(BG_DIR)
    print(f"Created directories: {DANCE_DIR}, {BG_DIR}")


def extract_gtzan():
    """Extract GTZAN music files from local archive."""
    if not os.path.exists(GTZAN_ARCHIVE):
        print(f"Error: {GTZAN_ARCHIVE} not found!")
        print("Please download the GTZAN dataset and place it as 'archive.zip' in this directory.")
        return False
    
    print(f"Extracting GTZAN from {GTZAN_ARCHIVE}...")
    with zipfile.ZipFile(GTZAN_ARCHIVE, 'r') as zip_ref:
        # Get all .wav files
        wav_files = [f for f in zip_ref.namelist() if f.endswith(".wav")]
        
        for file in tqdm(wav_files, desc="Extracting Music"):
            # Extract file data
            data = zip_ref.read(file)
            
            # Get just the filename (flatten directory structure)
            filename = os.path.basename(file)
            if filename:  # Skip empty names (directories)
                dest_path = os.path.join(DANCE_DIR, filename)
                with open(dest_path, "wb") as out:
                    out.write(data)
    
    print(f"GTZAN extraction complete. Files are in {DANCE_DIR}")
    return True


def extract_demand():
    """Extract DEMAND background noise files from local archive (mono ch01 only)."""
    if not os.path.exists(DEMAND_ARCHIVE):
        print(f"Error: {DEMAND_ARCHIVE} not found!")
        print("Please download the DEMAND dataset and place it as 'archive(1).zip' in this directory.")
        return False
    
    print(f"\nExtracting DEMAND from {DEMAND_ARCHIVE}...")
    with zipfile.ZipFile(DEMAND_ARCHIVE, 'r') as zip_ref:
        # Filter for channel 1 files only (*ch01.wav)
        ch01_files = [f for f in zip_ref.namelist() if f.endswith("ch01.wav")]
        
        for file in tqdm(ch01_files, desc="Extracting Background Noise"):
            # Extract file data
            data = zip_ref.read(file)
            
            # Get folder name for naming (e.g., DKITCHEN from path/DKITCHEN/ch01.wav)
            folder_name = os.path.basename(os.path.dirname(file))
            new_name = f"{folder_name}_ch01.wav"
            dest_path = os.path.join(BG_DIR, new_name)
            
            with open(dest_path, "wb") as out:
                out.write(data)
    
    print(f"DEMAND extraction complete. Files are in {BG_DIR}")
    return True


if __name__ == "__main__":
    print("Audio Dataset Extractor")
    print("=" * 40)
    print(f"Looking for: {GTZAN_ARCHIVE}, {DEMAND_ARCHIVE}")
    print()
    
    create_dirs()
    extract_gtzan()
    extract_demand()
    
    # Count extracted files
    dance_count = len([f for f in os.listdir(DANCE_DIR) if f.endswith('.wav')]) if os.path.exists(DANCE_DIR) else 0
    bg_count = len([f for f in os.listdir(BG_DIR) if f.endswith('.wav')]) if os.path.exists(BG_DIR) else 0
    
    print()
    print("=" * 40)
    print(f"Done! Extracted {dance_count} music files, {bg_count} background noise files.")