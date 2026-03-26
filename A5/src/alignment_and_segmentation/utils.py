from typing import BinaryIO, Tuple, Union
import numpy as np
import librosa
from fastapi import UploadFile

from typing import BinaryIO, Tuple, Union
import concurrent
import numpy as np
import librosa
from fastapi import UploadFile
import soundfile as sf

def load_audio_files(
    file_a: Union[str, BinaryIO, UploadFile], 
    file_b: Union[str, BinaryIO, UploadFile]
) -> Tuple[np.ndarray, np.ndarray, int]:
    """
    Optimized loading of two audio files. 
    Accepts file paths (str), file-like objects or FastAPI UploadFiles.
    """
    # Extract the underlying file-like object if it's an UploadFile
    f_a = file_a.file if hasattr(file_a, 'file') else file_a
    f_b = file_b.file if hasattr(file_b, 'file') else file_b

    # Read the sample rates from the headers
    sr_a = sf.info(f_a).samplerate
    sr_b = sf.info(f_b).samplerate
    
    # Reset the file pointers since we are strictly dealing with streams
    if hasattr(f_a, 'seek'):
        f_a.seek(0)
    if hasattr(f_b, 'seek'):
        f_b.seek(0)

    target_sr = min(sr_a, sr_b)

    def load_and_resample(file_obj):
        # Allow librosa to handle resampling during load
        y, _ = librosa.load(file_obj, sr=target_sr)
        return y

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        future_a = executor.submit(load_and_resample, f_a)
        future_b = executor.submit(load_and_resample, f_b)
        
        y_a = future_a.result()
        y_b = future_b.result()

    return y_a, y_b, target_sr

def check_less_than_one_minute(y: np.ndarray, sr: int) -> None:
    """
    Raise ValueError if the audio track is longer than 1 minute.
    """
    duration_sec = len(y) / sr
    if duration_sec > 60:
        raise ValueError(f"Audio track is too long ({duration_sec:.2f} seconds). Maximum allowed is 60 seconds.")

def check_audio_not_silent(y: np.ndarray, threshold_db: float = -60.0) -> None:
    """
    Raise ValueError if the audio track is effectively silent.
    """
    rms = np.sqrt(np.mean(y**2))
    if rms <= 1e-9: # Avoid log(0)
        raise ValueError("Audio track is completely silent.")
        
    rms_db = librosa.amplitude_to_db(np.array([rms]))[0]
    
    if rms_db < threshold_db:
        raise ValueError(f"Audio track is effectively silent (RMS: {rms_db:.1f} dB)")

def extract_chroma(y: np.ndarray, sr: int) -> np.ndarray:
    """
    Extract Chroma STFT features from an audio time series.
    Returns array of shape (n_chroma, t).
    """
    return librosa.feature.chroma_stft(y=y, sr=sr)

def map_segments_to_clips(
    segment_points: list[float],
    clip_start_time: float,
    clip_end_time: float,
    segment_beat_times: list[list[tuple[float, float]]] | None = None,
) -> list[tuple[float, float, list[tuple[float, float]]]]:
    """
    Map relative segmentation points to absolute clip times.
    
    Args:
        segment_points: List of relative timestamps [t0, t1, t2...] from the start of the aligned region.
        clip_start_time: Absolute start time of the aligned region in the clip.
        clip_end_time: Absolute end time of the aligned region in the clip.
        segment_beat_times: Optional per-segment beat timestamps (relative to aligned region).
        
    Returns:
        List of (start, end, beat_times) tuples in absolute clip time.
    """
    segments = []
    if not segment_points or len(segment_points) < 2:
        return []
    
    for i in range(len(segment_points) - 1):
        rel_start = segment_points[i]
        rel_end = segment_points[i+1]
        
        # Convert to absolute time
        abs_start = clip_start_time + rel_start
        abs_end = clip_start_time + rel_end
        
        # Filter out segments that strictly start after the clip ends
        if abs_start >= clip_end_time:
            continue

        # Get beat times for this segment (keep relative, not offset)
        if segment_beat_times is not None and i < len(segment_beat_times):
            beats = segment_beat_times[i]
        else:
            beats = []
            
        segments.append((float(abs_start), float(abs_end), beats))
        
    return segments