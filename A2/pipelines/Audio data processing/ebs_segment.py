#!/usr/bin/env python3
"""
Eight-Beat Segmentation (EBS) Pipeline

Converts an audio-aligned pair of dance clips into beat-aligned "primitive"
segments (8 beats per segment).  Beat tracking runs on the reference clip's
shared window (typically cleaner audio), and segment boundaries are mapped
back to absolute times in both clips.

Usage (with pre-computed alignment):
    python ebs_segment.py \
        --ref-audio ./data/val_001_A.wav \
        --alignment ./data/manifest.json \
        --test-id val_001_rock \
        --out ./output/ebs_segments.json

Usage (directly from video files, auto-align):
    python ebs_segment.py \
        --ref-video ref_dance.mp4 \
        --user-video user_dance.mp4 \
        --auto-align \
        --out ./output/ebs_segments.json

Output: ebs_segments.json (see README for full schema).
"""

import json
import os
import argparse
import logging
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import librosa
from scipy.signal import fftconvolve

from ebs_alignment_chroma import perform_alignment as chroma_perform_alignment
from ebs_ffmpeg_paths import resolve_ffmpeg_executable

# ---------------------------------------------------------------------------
# Constants – match existing audio pipeline conventions
# ---------------------------------------------------------------------------

SAMPLE_RATE = 22050

# Chroma STFT hop (must match librosa.feature.chroma_stft default used below)
CHROMA_HOP_LENGTH = 512

# EBS parameters
BEATS_PER_SEGMENT = 8
FALLBACK_CHUNK_SEC = 3.0
ROUNDING_PRECISION = 3

# Beat-confidence thresholds
MIN_BEATS_FOR_SEGMENT = 9          # ≥9 beats needed for one 8-beat segment
BEAT_INTERVAL_MIN_SEC = 0.25       # ~240 BPM ceiling
BEAT_INTERVAL_MAX_SEC = 1.0        # ~60 BPM floor
BEAT_CV_THRESHOLD = 0.3            # max coefficient of variation

PIPELINE_VERSION = "1.1.0"

# ---------------------------------------------------------------------------
# Audio helpers
# ---------------------------------------------------------------------------


def load_audio(filepath: str, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Load an audio file and return as mono numpy array."""
    audio, _ = librosa.load(filepath, sr=sr, mono=True)
    return audio


def extract_shared_window(
    audio: np.ndarray,
    start_sec: float,
    end_sec: float,
    sr: int = SAMPLE_RATE,
) -> np.ndarray:
    """Slice the shared-content window out of a full clip."""
    start_sample = int(start_sec * sr)
    end_sample = int(end_sec * sr)
    end_sample = min(end_sample, len(audio))
    return audio[start_sample:end_sample]


# ---------------------------------------------------------------------------
# Video → audio extraction
# ---------------------------------------------------------------------------


def extract_audio_from_video(
    video_path: str, output_wav: str | None = None, sr: int = SAMPLE_RATE
) -> str:
    """Extract audio from a video file and save as mono WAV.

    Tries ffmpeg first (fastest, most robust).  Falls back to
    ``librosa.load`` which delegates to the ``audioread`` backends
    (CoreAudio on macOS, GStreamer on Linux).

    Returns the path to the written WAV file.
    """
    logger = logging.getLogger("ebs")
    video_path = str(video_path)

    if output_wav is None:
        suffix = Path(video_path).stem
        tmp = tempfile.NamedTemporaryFile(
            prefix=f"ebs_{suffix}_", suffix=".wav", delete=False
        )
        output_wav = tmp.name
        tmp.close()

    # --- try ffmpeg (PATH, EBS_FFMPEG_PATH, or common Windows locations) ---
    ffmpeg_exe = resolve_ffmpeg_executable()
    logger.info("Extracting audio via ffmpeg (%s): %s", ffmpeg_exe, video_path)
    cmd = [
        ffmpeg_exe,
        "-y",
        "-i",
        video_path,
        "-vn",  # drop video
        "-acodec",
        "pcm_s16le",  # 16-bit PCM
        "-ar",
        str(sr),  # target sample rate
        "-ac",
        "1",  # mono
        output_wav,
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120
        )
    except FileNotFoundError:
        logger.warning(
            "ffmpeg not found (%s); add to PATH or set EBS_FFMPEG_PATH — using librosa",
            ffmpeg_exe,
        )
        result = None
    if result is not None and result.returncode == 0:
        logger.info("ffmpeg extraction OK → %s", output_wav)
        return output_wav
    if result is not None:
        logger.warning(
            "ffmpeg failed (rc=%d), trying librosa fallback", result.returncode
        )

    # --- librosa / audioread fallback --------------------------------------
    logger.info("Extracting audio via librosa/audioread: %s", video_path)
    import soundfile as sf

    audio, _ = librosa.load(video_path, sr=sr, mono=True)
    sf.write(output_wav, audio, sr)
    logger.info("librosa extraction OK → %s", output_wav)
    return output_wav


# ---------------------------------------------------------------------------
# Auto-alignment: chroma + local match (default) or onset cross-correlation
# ---------------------------------------------------------------------------


def _auto_align_mode_from_env() -> str:
    """Read ``EBS_AUTO_ALIGN_MODE``: ``chroma_sw`` (default) or ``onset_xcorr``."""
    raw = (os.environ.get("EBS_AUTO_ALIGN_MODE") or "chroma_sw").strip().lower()
    if raw in ("chroma_sw", "chroma", "sw", "a5"):
        return "chroma_sw"
    if raw in ("onset_xcorr", "onset", "legacy", "xcorr"):
        return "onset_xcorr"
    logging.getLogger("ebs").warning(
        "Unknown EBS_AUTO_ALIGN_MODE=%r — using chroma_sw", raw
    )
    return "chroma_sw"


def auto_align_onset_xcorr(
    ref_audio: np.ndarray,
    user_audio: np.ndarray,
    sr: int = SAMPLE_RATE,
) -> dict:
    """Global lag alignment via onset envelopes + FFT cross-correlation (legacy)."""
    logger = logging.getLogger("ebs")

    # Onset envelopes (one value per hop ≈ 23 ms at sr=22050, hop=512)
    hop = 512
    ref_env = librosa.onset.onset_strength(y=ref_audio, sr=sr, hop_length=hop)
    usr_env = librosa.onset.onset_strength(y=user_audio, sr=sr, hop_length=hop)

    # Normalise to zero-mean / unit-variance for a cleaner correlation peak
    def _norm(x: np.ndarray) -> np.ndarray:
        x = x - np.mean(x)
        std = np.std(x)
        return x / std if std > 1e-10 else x

    ref_env = _norm(ref_env)
    usr_env = _norm(usr_env)

    # Cross-correlate (FFT-based, much faster than np.correlate for long signals)
    corr = fftconvolve(ref_env, usr_env[::-1], mode="full")
    peak_idx = int(np.argmax(corr))
    lag_frames = peak_idx - (len(usr_env) - 1)
    lag_sec = lag_frames * hop / sr

    ref_dur = len(ref_audio) / sr
    usr_dur = len(user_audio) / sr

    logger.debug("Cross-correlation peak at lag = %.3fs", lag_sec)

    if lag_sec >= 0:
        # Reference starts first; user content begins at lag_sec in ref time
        c1_start = lag_sec
        c2_start = 0.0
        shared_len = min(ref_dur - lag_sec, usr_dur)
    else:
        # User starts first; reference content begins at |lag_sec| in user time
        c1_start = 0.0
        c2_start = -lag_sec
        shared_len = min(ref_dur, usr_dur + lag_sec)

    shared_len = max(shared_len, 0.0)

    alignment = {
        "clip_1_start_sec": round(c1_start, ROUNDING_PRECISION),
        "clip_1_end_sec": round(c1_start + shared_len, ROUNDING_PRECISION),
        "clip_2_start_sec": round(c2_start, ROUNDING_PRECISION),
        "clip_2_end_sec": round(c2_start + shared_len, ROUNDING_PRECISION),
        "auto_align": True,
        "auto_align_mode": "onset_xcorr",
        "lag_sec": round(lag_sec, ROUNDING_PRECISION),
        "correlation_peak": round(float(corr[peak_idx]), ROUNDING_PRECISION),
    }

    logger.info(
        "Auto-alignment (onset_xcorr): lag=%.3fs, shared=%.3fs, "
        "clip_1=[%.3f,%.3f], clip_2=[%.3f,%.3f]",
        lag_sec, shared_len,
        alignment["clip_1_start_sec"], alignment["clip_1_end_sec"],
        alignment["clip_2_start_sec"], alignment["clip_2_end_sec"],
    )
    return alignment


def auto_align_chroma_sw(
    ref_audio: np.ndarray,
    user_audio: np.ndarray,
    sr: int = SAMPLE_RATE,
    match_score_bias: float = 0.5,
) -> dict:
    """Local alignment via chroma + Smith–Waterman-style scoring (A5-style)."""
    logger = logging.getLogger("ebs")

    chroma_a = librosa.feature.chroma_stft(
        y=ref_audio, sr=sr, hop_length=CHROMA_HOP_LENGTH
    )
    chroma_b = librosa.feature.chroma_stft(
        y=user_audio, sr=sr, hop_length=CHROMA_HOP_LENGTH
    )
    ta, tb = chroma_a.shape[1], chroma_b.shape[1]
    if ta < 4 or tb < 4:
        raise ValueError(f"chroma too short for alignment (frames {ta}, {tb})")

    start_a, end_a, start_b, end_b = chroma_perform_alignment(
        chroma_a, chroma_b, match_score_bias=match_score_bias
    )

    # Normalize / order indices
    if end_a < start_a:
        start_a, end_a = end_a, start_a
    if end_b < start_b:
        start_b, end_b = end_b, start_b

    start_a = int(np.clip(start_a, 0, ta - 1))
    end_a = int(np.clip(end_a, 0, ta - 1))
    start_b = int(np.clip(start_b, 0, tb - 1))
    end_b = int(np.clip(end_b, 0, tb - 1))
    if end_a < start_a:
        start_a, end_a = end_a, start_a
    if end_b < start_b:
        start_b, end_b = end_b, start_b

    start_time_a = float(
        librosa.frames_to_time(start_a, sr=sr, hop_length=CHROMA_HOP_LENGTH)
    )
    end_time_a = float(
        librosa.frames_to_time(end_a, sr=sr, hop_length=CHROMA_HOP_LENGTH)
    )
    start_time_b = float(
        librosa.frames_to_time(start_b, sr=sr, hop_length=CHROMA_HOP_LENGTH)
    )
    end_time_b = float(
        librosa.frames_to_time(end_b, sr=sr, hop_length=CHROMA_HOP_LENGTH)
    )

    ref_dur = len(ref_audio) / sr
    usr_dur = len(user_audio) / sr

    c1_start = float(np.clip(start_time_a, 0.0, ref_dur))
    c1_end_raw = float(np.clip(end_time_a, 0.0, ref_dur))
    c2_start = float(np.clip(start_time_b, 0.0, usr_dur))
    c2_end_raw = float(np.clip(end_time_b, 0.0, usr_dur))

    if c1_end_raw <= c1_start or c2_end_raw <= c2_start:
        raise ValueError("degenerate chroma alignment window after clamping")

    len1 = c1_end_raw - c1_start
    len2 = c2_end_raw - c2_start
    shared_len = min(len1, len2, ref_dur - c1_start, usr_dur - c2_start)
    shared_len = max(float(shared_len), 0.0)

    if shared_len < 0.05:
        raise ValueError(f"chroma alignment window too short ({shared_len:.3f}s)")

    alignment = {
        "clip_1_start_sec": round(c1_start, ROUNDING_PRECISION),
        "clip_1_end_sec": round(c1_start + shared_len, ROUNDING_PRECISION),
        "clip_2_start_sec": round(c2_start, ROUNDING_PRECISION),
        "clip_2_end_sec": round(c2_start + shared_len, ROUNDING_PRECISION),
        "auto_align": True,
        "auto_align_mode": "chroma_sw",
    }

    logger.info(
        "Auto-alignment (chroma_sw): shared=%.3fs, clip_1=[%.3f,%.3f], clip_2=[%.3f,%.3f]",
        shared_len,
        alignment["clip_1_start_sec"],
        alignment["clip_1_end_sec"],
        alignment["clip_2_start_sec"],
        alignment["clip_2_end_sec"],
    )
    return alignment


def auto_align(
    ref_audio: np.ndarray,
    user_audio: np.ndarray,
    sr: int = SAMPLE_RATE,
) -> dict:
    """Compute the shared-content window between two clips.

    **Default** (``EBS_AUTO_ALIGN_MODE=chroma_sw``): chroma features + local
    scoring (A5-style), better when the match is a *segment* rather than a
    single global time shift.

    **Legacy** (``EBS_AUTO_ALIGN_MODE=onset_xcorr``): onset envelopes +
    FFT cross-correlation (single lag).

    Returns an alignment dict compatible with the EBS pipeline:
    ``{clip_1_start_sec, clip_1_end_sec, clip_2_start_sec, clip_2_end_sec}``
    """
    logger = logging.getLogger("ebs")
    mode = _auto_align_mode_from_env()
    if mode == "onset_xcorr":
        return auto_align_onset_xcorr(ref_audio, user_audio, sr=sr)
    try:
        return auto_align_chroma_sw(ref_audio, user_audio, sr=sr)
    except Exception as exc:
        logger.warning(
            "chroma_sw auto-align failed (%s); falling back to onset_xcorr",
            exc,
        )
        return auto_align_onset_xcorr(ref_audio, user_audio, sr=sr)


# ---------------------------------------------------------------------------
# Alignment I/O
# ---------------------------------------------------------------------------

_REQUIRED_ALIGNMENT_FIELDS = [
    "clip_1_start_sec",
    "clip_1_end_sec",
    "clip_2_start_sec",
    "clip_2_end_sec",
]


def load_alignment(alignment_path: str, test_id: str | None = None) -> dict:
    """Load alignment data from a JSON file.

    Supports:
      - A single object  ``{...}``
      - An array          ``[{...}, ...]``  (requires *test_id* when len > 1)
    """
    with open(alignment_path, "r") as fh:
        data = json.load(fh)

    if isinstance(data, list):
        if test_id is not None:
            matches = [e for e in data if e.get("test_id") == test_id]
            if not matches:
                raise ValueError(
                    f"test_id '{test_id}' not found in alignment manifest"
                )
            return matches[0]
        if len(data) == 1:
            return data[0]
        raise ValueError(
            f"Alignment file contains {len(data)} entries. "
            "Specify --test-id to select one."
        )

    if isinstance(data, dict):
        return data

    raise ValueError("Alignment JSON must be an object or array of objects")


def validate_alignment(alignment: dict) -> float:
    """Validate required fields and return the shared window length (seconds).

    If the two clips disagree on shared-window length the *shorter* value is
    used and a warning is emitted.
    """
    missing = [f for f in _REQUIRED_ALIGNMENT_FIELDS if f not in alignment]
    if missing:
        raise ValueError(f"Missing alignment fields: {missing}")

    clip_1_len = alignment["clip_1_end_sec"] - alignment["clip_1_start_sec"]
    clip_2_len = alignment["clip_2_end_sec"] - alignment["clip_2_start_sec"]

    if abs(clip_1_len - clip_2_len) > 0.1:
        logging.getLogger("ebs").warning(
            "Shared window lengths differ: clip_1=%.3fs, clip_2=%.3fs "
            "(delta=%.3fs)",
            clip_1_len,
            clip_2_len,
            abs(clip_1_len - clip_2_len),
        )

    return round(min(clip_1_len, clip_2_len), ROUNDING_PRECISION)


# ---------------------------------------------------------------------------
# Beat tracking
# ---------------------------------------------------------------------------


def track_beats(
    audio: np.ndarray, sr: int = SAMPLE_RATE
) -> tuple[np.ndarray, float, dict, np.ndarray, np.ndarray]:
    """Run beat tracking on *audio* and return beat times in seconds.

    Returns
    -------
    beats_sec : np.ndarray
        Sorted, rounded beat timestamps (relative to audio start).
    bpm : float
        Estimated tempo.
    confidence_info : dict
        Metrics used for the confidence gate.
    onset_env : np.ndarray
        Onset-strength envelope (needed by ``estimate_downbeat_phase``).
    beat_frames : np.ndarray
        Beat positions in frames (needed by ``estimate_downbeat_phase``).
    """
    onset_env = librosa.onset.onset_strength(y=audio, sr=sr)
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=sr
    )
    beat_times = np.sort(librosa.frames_to_time(beat_frames, sr=sr))
    beat_times = np.round(beat_times, ROUNDING_PRECISION)

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
        "median_interval_sec": round(median_interval, ROUNDING_PRECISION),
        "mean_interval_sec": round(mean_interval, ROUNDING_PRECISION),
        "std_interval_sec": round(std_interval, ROUNDING_PRECISION),
        "coefficient_of_variation": round(cv, ROUNDING_PRECISION),
    }
    return beat_times, bpm, confidence_info, onset_env, beat_frames


def estimate_downbeat_phase(
    onset_env: np.ndarray,
    beat_frames: np.ndarray,
    beats_per_seg: int = BEATS_PER_SEGMENT,
) -> int:
    """Estimate which beat is "count 1" (the downbeat) of an 8-count phrase.

    For each candidate phase offset *k* in ``{0, …, beats_per_seg-1}``,
    compute the mean onset strength at beat positions
    ``k, k + beats_per_seg, k + 2*beats_per_seg, …``.
    The phase with the highest mean is most likely the downbeat because
    "count 1" in 4/4 dance music carries the strongest accent (kick drum).

    Returns the beat-index offset (0-based into *beat_frames*).
    """
    logger = logging.getLogger("ebs")
    n_beats = len(beat_frames)

    if n_beats < beats_per_seg:
        logger.debug("Too few beats for phase estimation; defaulting to 0")
        return 0

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

    logger.info(
        "Downbeat phase: k=%d, scores=%s",
        best_k,
        [round(s, ROUNDING_PRECISION) for s in scores],
    )
    return best_k


def check_beat_confidence(
    confidence_info: dict, shared_len_sec: float
) -> tuple[bool, list[str]]:
    """Gate that decides whether detected beats are trustworthy.

    Returns ``(passed, list_of_failure_reasons)``.
    """
    reasons: list[str] = []

    if confidence_info["num_beats"] < MIN_BEATS_FOR_SEGMENT:
        reasons.append(
            f"Too few beats ({confidence_info['num_beats']} "
            f"< {MIN_BEATS_FOR_SEGMENT})"
        )

    med = confidence_info["median_interval_sec"]
    if med > 0 and not (BEAT_INTERVAL_MIN_SEC <= med <= BEAT_INTERVAL_MAX_SEC):
        reasons.append(
            f"Median beat interval {med:.3f}s outside "
            f"[{BEAT_INTERVAL_MIN_SEC}, {BEAT_INTERVAL_MAX_SEC}]"
        )

    cv = confidence_info["coefficient_of_variation"]
    if cv > BEAT_CV_THRESHOLD:
        reasons.append(
            f"Beat CV {cv:.3f} exceeds threshold {BEAT_CV_THRESHOLD}"
        )

    return len(reasons) == 0, reasons


# ---------------------------------------------------------------------------
# Segmentation
# ---------------------------------------------------------------------------


def segment_by_beats(
    beats_sec: np.ndarray,
    beats_per_seg: int = BEATS_PER_SEGMENT,
    start_idx: int = 0,
) -> list[dict]:
    """Split *beats_sec* into groups of *beats_per_seg*.

    Iteration begins at *start_idx* so that segments can be aligned
    with the detected downbeat phase.  Each segment spans
    ``[beat[i], beat[i + beats_per_seg])``.  Incomplete tails are dropped.
    """
    segments: list[dict] = []
    n = len(beats_sec)
    i = start_idx
    seg_id = 0
    while i + beats_per_seg < n:
        segments.append(
            {
                "seg_id": seg_id,
                "beat_idx_range": [int(i), int(i + beats_per_seg)],
                "shared_start_sec": round(
                    float(beats_sec[i]), ROUNDING_PRECISION
                ),
                "shared_end_sec": round(
                    float(beats_sec[i + beats_per_seg]), ROUNDING_PRECISION
                ),
            }
        )
        seg_id += 1
        i += beats_per_seg
    return segments


def segment_fixed_time(
    shared_len_sec: float, chunk_sec: float = FALLBACK_CHUNK_SEC
) -> list[dict]:
    """Fallback: chop the shared window into fixed-duration chunks.

    Incomplete tails are dropped.
    """
    segments: list[dict] = []
    seg_id = 0
    t = 0.0
    while t + chunk_sec <= shared_len_sec:
        segments.append(
            {
                "seg_id": seg_id,
                "beat_idx_range": None,
                "shared_start_sec": round(t, ROUNDING_PRECISION),
                "shared_end_sec": round(t + chunk_sec, ROUNDING_PRECISION),
            }
        )
        seg_id += 1
        t += chunk_sec
    return segments


def map_segments_to_clips(
    segments: list[dict], clip_1_start: float, clip_2_start: float
) -> list[dict]:
    """Add absolute clip-level timestamps to each segment.

    Mapping: ``clip_X_seg_* = clip_X_start_sec + shared_*``
    """
    for seg in segments:
        seg["clip_1_seg_start_sec"] = round(
            clip_1_start + seg["shared_start_sec"], ROUNDING_PRECISION
        )
        seg["clip_1_seg_end_sec"] = round(
            clip_1_start + seg["shared_end_sec"], ROUNDING_PRECISION
        )
        seg["clip_2_seg_start_sec"] = round(
            clip_2_start + seg["shared_start_sec"], ROUNDING_PRECISION
        )
        seg["clip_2_seg_end_sec"] = round(
            clip_2_start + seg["shared_end_sec"], ROUNDING_PRECISION
        )
    return segments


# ---------------------------------------------------------------------------
# Pipeline orchestrator
# ---------------------------------------------------------------------------


def run_ebs_pipeline(
    ref_audio_path: str,
    alignment: dict,
    user_audio_path: str | None = None,
) -> dict:
    """Execute the full EBS pipeline and return the output artifact.

    Parameters
    ----------
    ref_audio_path : str
        Path to the reference clip audio (WAV).  Beat tracking runs on this.
    alignment : dict
        A single alignment entry (must contain ``clip_1_start_sec`` etc.).
    user_audio_path : str, optional
        Path to the user clip audio.  Recorded in the artifact for
        provenance but not used for beat detection.
    """
    logger = logging.getLogger("ebs")

    # ---- validate alignment ------------------------------------------------
    shared_len_sec = validate_alignment(alignment)

    clip_1_start = alignment["clip_1_start_sec"]
    clip_1_end = alignment["clip_1_end_sec"]
    clip_2_start = alignment["clip_2_start_sec"]
    clip_2_end = alignment["clip_2_end_sec"]

    logger.info("Shared window length: %.3fs", shared_len_sec)
    logger.info("Clip 1 window: [%.3f, %.3f]", clip_1_start, clip_1_end)
    logger.info("Clip 2 window: [%.3f, %.3f]", clip_2_start, clip_2_end)

    # ---- load reference audio & extract shared window ----------------------
    logger.info("Loading reference audio: %s", ref_audio_path)
    ref_audio = load_audio(ref_audio_path)
    shared_audio = extract_shared_window(ref_audio, clip_1_start, clip_1_end)
    logger.info(
        "Shared window audio: %d samples (%.3fs)",
        len(shared_audio),
        len(shared_audio) / SAMPLE_RATE,
    )

    # ---- beat tracking -----------------------------------------------------
    logger.info("Running beat tracking on reference shared window …")
    beats_sec, bpm, confidence_info, onset_env, beat_frames = track_beats(
        shared_audio
    )
    logger.info(
        "Detected %d beats — estimated BPM: %.1f",
        len(beats_sec),
        bpm,
    )

        # ---- extrapolate beats to cover the tail of the shared window ----------
    # We do NOT prepend synthetic beats before the first detected beat.
    # Any audio before the first estimated count-1 is kept as intro segment 0.
    if len(beats_sec) >= 2:
        med_ivl = confidence_info["median_interval_sec"]
        n_detected = len(beats_sec)

        # Extrapolate forward only
        extra_fwd: list[float] = []
        t = float(beats_sec[-1]) + med_ivl
        while t <= shared_len_sec:
            extra_fwd.append(round(t, ROUNDING_PRECISION))
            t += med_ivl

        if extra_fwd:
            beats_sec = np.array(
                [round(float(b), ROUNDING_PRECISION) for b in beats_sec] + extra_fwd
            )
            logger.info(
                "Extrapolated %d beats forward → %d total (was %d detected)",
                len(extra_fwd), len(beats_sec), n_detected,
            )
            confidence_info["num_beats_detected"] = n_detected
            confidence_info["num_beats"] = int(len(beats_sec))

    # ---- confidence gate ---------------------------------------------------
    passed, reasons = check_beat_confidence(confidence_info, shared_len_sec)

    downbeat_phase: int | None = None

    if passed:
        logger.info("Beat confidence check PASSED")

        # -- downbeat-phase alignment ----------------------------------------
        # Phase estimation uses the *detected* beat frames (with onset data).
        # After backward extrapolation the array is shifted by n_extra_bwd,
        # so we adjust the phase index accordingly.
        # raw_phase = estimate_downbeat_phase(
        #     onset_env, beat_frames, BEATS_PER_SEGMENT
        # )
        # downbeat_phase = (raw_phase + n_extra_bwd) % BEATS_PER_SEGMENT
        # first_regular = downbeat_phase + BEATS_PER_SEGMENT
        # logger.info(
        #     "Adjusted downbeat phase: raw=%d, bwd_offset=%d, adjusted=%d, "
        #     "first_regular_idx=%d",
        #     raw_phase, n_extra_bwd, downbeat_phase, first_regular,
        # )
        downbeat_phase = estimate_downbeat_phase(
            onset_env, beat_frames, BEATS_PER_SEGMENT
        )
        logger.info(
            "Estimated downbeat phase: %d",
            downbeat_phase,
        )
        # if first_regular < len(beats_sec):
        #     # Intro segment: [0.0, beat[phase + 8])
        #     intro_seg: dict = {
        #         "seg_id": 0,
        #         "beat_idx_range": [0, int(first_regular)],
        #         "shared_start_sec": 0.0,
        #         "shared_end_sec": round(
        #             float(beats_sec[first_regular]), ROUNDING_PRECISION
        #         ),
        #     }
        #     # Regular 8-beat segments starting from the second downbeat
        #     rest = segment_by_beats(
        #         beats_sec,
        #         beats_per_seg=BEATS_PER_SEGMENT,
        #         start_idx=first_regular,
        #     )
        #     # Renumber: intro is 0, rest continue from 1
        #     for seg in rest:
        #         seg["seg_id"] += 1
        #     segments = [intro_seg] + rest
        # else:
        #     # Not enough beats after phase for a regular segment;
        #     # fall back to simple segmentation with seg 0 starting at 0.0
        #     segments = segment_by_beats(beats_sec)
        #     if segments:
        #         segments[0]["shared_start_sec"] = 0.0
        if downbeat_phase < len(beats_sec):
            # Segment 0: everything before the first estimated count-1
            intro_seg: dict = {
                "seg_id": 0,
                "beat_idx_range": [0, int(downbeat_phase)] if downbeat_phase > 0 else [0, 0],
                "shared_start_sec": 0.0,
                "shared_end_sec": round(
                    float(beats_sec[downbeat_phase]), ROUNDING_PRECISION
                ),
            }

            # Regular 8-beat segments start exactly at the first estimated count-1
            rest = segment_by_beats(
                beats_sec,
                beats_per_seg=BEATS_PER_SEGMENT,
                start_idx=downbeat_phase,
            )

            for seg in rest:
                seg["seg_id"] += 1

            segments = [intro_seg] + rest

            # If the first count-1 is already at time 0, segment 0 is empty.
            # Drop it to avoid a zero-length intro segment.
            if intro_seg["shared_end_sec"] <= 0.0:
                segments = rest
        else:
            segments = []

        segmentation_mode = "eight_beat"
        beats_shared: list[float] = [
            round(float(b), ROUNDING_PRECISION) for b in beats_sec
        ]
    else:
        logger.warning(
            "Beat confidence check FAILED: %s", "; ".join(reasons)
        )
        logger.info(
            "Falling back to fixed-time segmentation (%.1fs chunks)",
            FALLBACK_CHUNK_SEC,
        )
        segments = segment_fixed_time(shared_len_sec)
        segmentation_mode = "fixed_time"
        beats_shared = []

    # ---- map shared → absolute clip times ----------------------------------
    segments = map_segments_to_clips(segments, clip_1_start, clip_2_start)
    logger.info(
        "Generated %d segment(s) — mode: %s",
        len(segments),
        segmentation_mode,
    )

    # ---- assemble artifact -------------------------------------------------
    artifact: dict = {
        "pipeline": {
            "name": "ebs",
            "version": PIPELINE_VERSION,
            "params": {
                "beats_per_segment": BEATS_PER_SEGMENT,
                "sample_rate": SAMPLE_RATE,
                "fallback_chunk_sec": FALLBACK_CHUNK_SEC,
                "beat_cv_threshold": BEAT_CV_THRESHOLD,
            },
        },
        "alignment": {
            "clip_1_start_sec": clip_1_start,
            "clip_1_end_sec": clip_1_end,
            "clip_2_start_sec": clip_2_start,
            "clip_2_end_sec": clip_2_end,
            "shared_len_sec": shared_len_sec,
            **(
                {"auto_align_mode": alignment["auto_align_mode"]}
                if alignment.get("auto_align_mode")
                else {}
            ),
        },
        "beat_tracking": {
            "estimated_bpm": confidence_info["estimated_bpm"],
            "num_beats": confidence_info["num_beats"],
            "num_beats_detected": confidence_info.get(
                "num_beats_detected", confidence_info["num_beats"]
            ),
            "confidence": {
                "median_interval_sec": confidence_info[
                    "median_interval_sec"
                ],
                "coefficient_of_variation": confidence_info[
                    "coefficient_of_variation"
                ],
                "passed": passed,
            },
            "downbeat_phase": downbeat_phase,
            "source": "librosa.beat.beat_track",
        },
        "beats_shared_sec": beats_shared,
        "segmentation_mode": segmentation_mode,
        "segments": segments,
    }
    return artifact


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Eight-Beat Segmentation (EBS) Pipeline — segment "
            "audio-aligned clip pairs into 8-beat primitives"
        ),
    )

    # --- input sources (audio OR video) ------------------------------------
    src = parser.add_argument_group("input sources (provide audio OR video)")
    src.add_argument(
        "--ref-audio",
        type=str,
        default=None,
        help="Path to reference audio clip (WAV)",
    )
    src.add_argument(
        "--user-audio",
        type=str,
        default=None,
        help="Path to user audio clip (WAV)",
    )
    src.add_argument(
        "--ref-video",
        type=str,
        default=None,
        help="Path to reference video file (mp4/mov/…); audio is extracted automatically",
    )
    src.add_argument(
        "--user-video",
        type=str,
        default=None,
        help="Path to user video file (mp4/mov/…); audio is extracted automatically",
    )

    # --- alignment ---------------------------------------------------------
    align_grp = parser.add_argument_group("alignment")
    align_grp.add_argument(
        "--alignment",
        type=str,
        default=None,
        help="Path to alignment JSON (manifest.json or single-entry object)",
    )
    align_grp.add_argument(
        "--test-id",
        type=str,
        default=None,
        help=(
            "Test ID to select from a multi-entry manifest array "
            "(required when the manifest contains more than one entry)"
        ),
    )
    align_grp.add_argument(
        "--auto-align",
        action="store_true",
        help=(
            "Compute alignment automatically (default: chroma + local match; "
            "override with --auto-align-mode or env EBS_AUTO_ALIGN_MODE)"
        ),
    )
    align_grp.add_argument(
        "--auto-align-mode",
        type=str,
        choices=("chroma_sw", "onset_xcorr"),
        default=None,
        help=(
            "Auto-align algorithm: chroma_sw (default) or onset_xcorr (legacy). "
            "Same as env EBS_AUTO_ALIGN_MODE."
        ),
    )

    # --- output / flags ----------------------------------------------------
    parser.add_argument(
        "--out",
        type=str,
        default="ebs_segments.json",
        help="Output path for EBS segments JSON (default: ebs_segments.json)",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose (DEBUG-level) logging",
    )

    args = parser.parse_args()

    # -- logging -------------------------------------------------------------
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    logger = logging.getLogger("ebs")
    logger.info("=== EBS Pipeline START ===")

    tmp_files: list[str] = []  # track temp WAVs for cleanup

    try:
        # -- resolve reference audio -----------------------------------------
        ref_audio_path: str | None = args.ref_audio
        if ref_audio_path is None and args.ref_video:
            if not Path(args.ref_video).exists():
                logger.error("Reference video not found: %s", args.ref_video)
                return 1
            ref_audio_path = extract_audio_from_video(args.ref_video)
            tmp_files.append(ref_audio_path)
        if ref_audio_path is None:
            logger.error("Provide --ref-audio or --ref-video")
            return 1
        if not Path(ref_audio_path).exists():
            logger.error("Reference audio not found: %s", ref_audio_path)
            return 1

        # -- resolve user audio ----------------------------------------------
        user_audio_path: str | None = args.user_audio
        if user_audio_path is None and args.user_video:
            if not Path(args.user_video).exists():
                logger.error("User video not found: %s", args.user_video)
                return 1
            user_audio_path = extract_audio_from_video(args.user_video)
            tmp_files.append(user_audio_path)

        # -- resolve alignment -----------------------------------------------
        if args.auto_align:
            if args.auto_align_mode:
                os.environ["EBS_AUTO_ALIGN_MODE"] = args.auto_align_mode
            if user_audio_path is None:
                logger.error(
                    "--auto-align requires a user clip "
                    "(--user-audio or --user-video)"
                )
                return 1
            logger.info("Computing auto-alignment …")
            ref_full = load_audio(ref_audio_path)
            usr_full = load_audio(user_audio_path)
            alignment = auto_align(ref_full, usr_full)
        elif args.alignment:
            if not Path(args.alignment).exists():
                logger.error(
                    "Alignment file not found: %s", args.alignment
                )
                return 1
            alignment = load_alignment(
                args.alignment, test_id=args.test_id
            )
            logger.info(
                "Loaded alignment entry: %s",
                alignment.get("test_id", "N/A"),
            )
        else:
            logger.error("Provide --alignment <json> or --auto-align")
            return 1

        # -- run pipeline ----------------------------------------------------
        artifact = run_ebs_pipeline(
            ref_audio_path=ref_audio_path,
            alignment=alignment,
            user_audio_path=user_audio_path,
        )

        # -- write output ----------------------------------------------------
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w") as fh:
            json.dump(artifact, fh, indent=2)

        logger.info("Output written to %s", out_path)
        logger.info(
            "Segments: %d (%s)",
            len(artifact["segments"]),
            artifact["segmentation_mode"],
        )
        logger.info("=== EBS Pipeline END ===")
        return 0

    finally:
        # clean up any temporary WAV files extracted from videos
        for tmp in tmp_files:
            try:
                Path(tmp).unlink(missing_ok=True)
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
