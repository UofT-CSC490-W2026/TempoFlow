import cProfile
import pstats
import io
import os
import sys
import time

# Add the project root to the python path so we can import src modules
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.alignment_and_segmentation.alignment_core import perform_alignment
from src.alignment_and_segmentation.segmentation_core import track_beats, generate_segments
from src.alignment_and_segmentation.utils import (
    load_audio_files, 
    extract_chroma,
    map_segments_to_clips
)
import librosa
import numpy as np

def run_alignment_pipeline():
    # Define paths to test files (using the local copies in profiling folder)
    current_dir = os.path.dirname(os.path.abspath(__file__))
    file_a_path = os.path.join(current_dir, "file_a.wav")
    file_b_path = os.path.join(current_dir, "file_b.wav")

    if not os.path.exists(file_a_path) or not os.path.exists(file_b_path):
        print(f"Error: Could not find test files at {file_a_path} or {file_b_path}")
        return

    print(f"Profiling alignment pipeline with: {file_a_path} & {file_b_path}")

    # --- Pipeline Steps (Simulating router.py logic) ---
    
    # 1. Load Audio

    
    print("Loading audio...")
    start_time = time.time()
    with open(file_a_path, "rb") as f_a_stream, open(file_b_path, "rb") as f_b_stream:
        y_a, y_b, sr = load_audio_files(f_a_stream, f_b_stream)
    print(f"REAL wait time: {time.time() - start_time:.2f} seconds")

    # 2. Extract Features
    print("Extracting chroma features...")
    chroma_a = extract_chroma(y_a, sr)
    chroma_b = extract_chroma(y_b, sr)

    # 3. Perform Alignment
    print("Aligning...")
    start_a, end_a, start_b, end_b = perform_alignment(chroma_a, chroma_b)
    
    # Convert frames to time
    start_time_a = librosa.frames_to_time(start_a, sr=sr)
    end_time_a = librosa.frames_to_time(end_a, sr=sr)
    start_time_b = librosa.frames_to_time(start_b, sr=sr)
    end_time_b = librosa.frames_to_time(end_b, sr=sr)
    
    # 4. Segmentation Logic
    print("Segmenting...")
    hop_length = 512
    sample_start_a = librosa.frames_to_samples(start_a, hop_length=hop_length)
    sample_end_a = librosa.frames_to_samples(end_a, hop_length=hop_length)
    
    sample_start_a = max(0, sample_start_a)
    sample_end_a = min(len(y_a), sample_end_a)
    
    y_aligned_a = y_a[sample_start_a:sample_end_a]

    if len(y_aligned_a) == 0:
        print("Warning: Aligned audio is empty.")
        return

    beat_times, bpm, confidence_info, onset_env, beat_frames = track_beats(y_aligned_a, sr)
    
    # We skip check logic for profiling
    
    beats_per_seg = 8
    # Simple downbeat offset (assuming 0 for this profiled run or re-implement estimate if critical)
    # The router calls estimate_downbeat_phase, let's include it if imported, but I missed importing it.
    # Let's import it now.
    from src.alignment_and_segmentation.segmentation_core import estimate_downbeat_phase
    
    try:
        downbeat_offset = estimate_downbeat_phase(onset_env, beat_frames, beats_per_seg)
    except ValueError:
        downbeat_offset = 0

    segment_boundaries, segment_beat_times = generate_segments(
        beat_times,
        downbeat_offset,
        beats_per_seg,
    )
    
    # 5. Map segments
    clip_segments_a = map_segments_to_clips(
        segment_boundaries,
        start_time_a,
        end_time_a,
        segment_beat_times=segment_beat_times,
    )
    clip_segments_b = map_segments_to_clips(
        segment_boundaries,
        start_time_b,
        end_time_b,
        segment_beat_times=segment_beat_times,
    )
    
    print("Pipeline complete.")

if __name__ == "__main__":
    pr = cProfile.Profile()
    pr.enable()
    
    run_alignment_pipeline()
    
    pr.disable()
    s = io.StringIO()
    # Sort by cumulative time to see expensive functions
    sortby = 'cumulative'
    ps = pstats.Stats(pr, stream=s).sort_stats(sortby)
    ps.print_stats() 
    
    # --- Generate a Plot ---
    import matplotlib.pyplot as plt
    
    # Get the stats data: list of (filename, line, funcname) -> (cc, nc, tt, ct, callers)
    # We want to plot the top 20 by cumulative time
    # Use standard ps.stats dictionary to avoid AttributeErrors with non-standard methods
    
    # Define source directory for filtering (the `src` folder)
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src_dir = os.path.join(project_root, "src")
    
    func_list = []
    if hasattr(ps, 'stats'):
        for func, (cc, nc, tt, ct, callers) in ps.stats.items():
            file_name, line_number, func_name = func
            
            # Filter: Only allow files that are inside our src directory
            # This filters out library code like numpy, librosa, etc.
            # Convert both to abs and lower (for windows case-insensitivity safety)
            if file_name:
                abs_file = os.path.abspath(file_name).lower()
                abs_src = os.path.abspath(src_dir).lower()
                if abs_src in abs_file:
                    func_list.append({
                        "file_name": file_name,
                        "line_number": line_number,
                        "func_name": func_name,
                        "cumtime": ct
                    })
            
    # Sort by cumulative time (descending)
    func_list_sorted = sorted(func_list, key=lambda x: x['cumtime'], reverse=True)
    
    # Filter to show relevant functions
    top_n = 20
    top_funcs = func_list_sorted[:top_n]
    
    names = []
    times = []
    
    for f in top_funcs:
        # Format name nicely: filename:line(func)
        filename = os.path.basename(f['file_name'])
        func_name = f['func_name']
        # If filename is empty (e.g. built-in), handle it
        if not filename and func_name.startswith("<"):
             filename = "built-in"
             
        label = f"{filename}:{f['line_number']}\n({func_name})"
        names.append(label)
        times.append(f['cumtime'])
        
    # Plotting
    plt.figure(figsize=(12, 8))
    # Invert so highest is at top
    plt.barh(names[::-1], times[::-1], color='skyblue')
    plt.xlabel('Cumulative Time (seconds)')
    plt.title(f'Top {top_n} Functions by Cumulative Execution Time After Optimizing Code')
    plt.tight_layout()
    
    current_dir = os.path.dirname(os.path.abspath(__file__))
    output_image = os.path.join(current_dir, "profile_results.png")
    
    plt.savefig(output_image)
    print(f"\nProfile plot saved to: {output_image}")
    
    # Still print text stats if needed
    ps.print_stats(30)

