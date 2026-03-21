import librosa
import numpy as np

def track_beats(
    audio: np.ndarray, sr: int, rounding_precision: int = 3
) -> tuple[np.ndarray, float, dict, np.ndarray, np.ndarray]:
    
    onset_env = librosa.onset.onset_strength(y=audio, sr=sr)
    
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=sr
    )
    
    beat_times = np.sort(librosa.frames_to_time(beat_frames, sr=sr))
    beat_times = np.round(beat_times, rounding_precision)

    bpm = float(np.atleast_1d(tempo)[0])

    if len(beat_times) >= 2:
        intervals = np.diff(beat_times)
        median_interval = float(np.median(intervals))
        mean_interval = float(np.mean(intervals))
        std_interval = float(np.std(intervals))
        cv = std_interval / mean_interval if mean_interval > 0 else float("inf")
    else:
        median_interval = 0.0
        mean_interval = 0.0
        std_interval = 0.0
        cv = float("inf")

    confidence_info = {
        "num_beats": int(len(beat_times)),
        "estimated_bpm": round(bpm, 1),
        "median_interval_sec": round(median_interval, rounding_precision),
        "mean_interval_sec": round(mean_interval, rounding_precision),
        "std_interval_sec": round(std_interval, rounding_precision),
        "coefficient_of_variation": round(cv, rounding_precision),
    }
    return beat_times, bpm, confidence_info, onset_env, beat_frames


def estimate_downbeat_phase(
    onset_env: np.ndarray,
    beat_frames: np.ndarray,
    beats_per_seg: int,
) -> int:
    """Estimate which beat is "count 1" (the downbeat) of an 8-count phrase.

    For each candidate phase offset *k* in ``{0, …, beats_per_seg-1}``,
    compute the mean onset strength at beat positions
    ``k, k + beats_per_seg, k + 2*beats_per_seg, …``.
    The phase with the highest mean is most likely the downbeat because
    "count 1" in 4/4 dance music carries the strongest accent (kick drum).

    Returns the beat-index offset (0-based into *beat_frames*).
    """
    n_beats = len(beat_frames)

    if n_beats < beats_per_seg:
        raise ValueError(
            f"Not enough beats detected ({n_beats}) to estimate downbeat phase with beats_per_seg={beats_per_seg}."
        )

    # Onset strength at each beat position
    valid_frames = np.clip(beat_frames, 0, len(onset_env) - 1)
    beat_strengths = onset_env[valid_frames]

    best_k = 0
    best_score = -float("inf")
    scores: list[float] = []

    for k in range(min(beats_per_seg, n_beats)):
        indices = list(range(k, n_beats, beats_per_seg))
        score = float(np.mean(beat_strengths[indices]))
        scores.append(score)
        if score > best_score:
            best_score = score
            best_k = k

    return best_k


def generate_segments(
    beat_times: np.ndarray,
    downbeat_offset: int,
    beats_per_seg: int
) -> list[float]:
    """
    Generate segmentation points (timestamps) based on beats and downbeat offset.
    Returns a list of timestamps [t0, t1, t2...] defining the segment boundaries.
    """
    segment_boundaries = []
    num_beats = len(beat_times)
    
    start_idx = downbeat_offset

    # If we can't make at least one segment, return empty
    if start_idx + beats_per_seg > num_beats:
         return []

    # Add the first point (start of first segment)
    segment_boundaries.append(float(beat_times[start_idx]))

    while start_idx + beats_per_seg <= num_beats:
        end_idx = start_idx + beats_per_seg
        
        if end_idx < num_beats:
            end_time = beat_times[end_idx]
        else:
            # Extrapolate for the last beat duration
            if num_beats >= 2:
                last_interval = beat_times[-1] - beat_times[-2]
            else:
                last_interval = 0.5
            end_time = beat_times[-1] + last_interval

        segment_boundaries.append(float(end_time))
        start_idx += beats_per_seg
        
    return segment_boundaries