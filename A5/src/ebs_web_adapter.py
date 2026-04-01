from __future__ import annotations

import math
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import librosa
import numpy as np
from fastapi import UploadFile

from src.alignment_and_segmentation.alignment_core import perform_alignment
from src.alignment_and_segmentation.segmentation_core import (
    estimate_downbeat_phase,
    generate_segments,
    track_beats,
)
from src.ffmpeg_paths import resolve_ffmpeg_executable, resolve_ffprobe_executable

SAMPLE_RATE = 22050
CHROMA_HOP_LENGTH = 512
ROUNDING_PRECISION = 3
BEATS_PER_SEGMENT = 8
FALLBACK_CHUNK_SEC = 3.0

# Performance constants for long videos
LONG_SESSION_THRESHOLD_SEC = 300  # 5 minutes
LOWER_SAMPLE_RATE = 11025
LARGER_HOP_LENGTH = 1024


def sanitize_json(obj: Any) -> Any:
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: sanitize_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize_json(v) for v in obj]
    return obj


def save_upload(upload: UploadFile, prefix: str) -> str:
    suffix = Path(upload.filename or "video.mp4").suffix or ".mp4"
    tmp = tempfile.NamedTemporaryFile(prefix=f"ebs_{prefix}_", suffix=suffix, delete=False)
    try:
        tmp.write(upload.file.read())
    finally:
        tmp.close()
    return tmp.name


async def save_upload_async(upload: UploadFile, prefix: str) -> str:
    """Read multipart body asynchronously; write to disk without blocking the event loop."""
    data = await upload.read()
    suffix = Path(upload.filename or "video.mp4").suffix or ".mp4"
    tmp = tempfile.NamedTemporaryFile(prefix=f"ebs_{prefix}_", suffix=suffix, delete=False)
    try:
        tmp.write(data)
    finally:
        tmp.close()
    return tmp.name


def extract_audio_from_video(video_path: str, sr: int = SAMPLE_RATE) -> str:
    ffmpeg_exe = resolve_ffmpeg_executable()
    out = tempfile.NamedTemporaryFile(prefix="ebs_audio_", suffix=".wav", delete=False)
    out_path = out.name
    out.close()

    cmd = [
        ffmpeg_exe,
        "-y",
        "-i",
        video_path,
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        str(sr),
        "-ac",
        "1",
        out_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg extraction failed: {result.stderr.strip()}")
    return out_path


def probe_video_metadata(video_path: str) -> dict[str, Any]:
    ffprobe_exe = resolve_ffprobe_executable()
    cmd = [
        ffprobe_exe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=avg_frame_rate,nb_frames,duration",
        "-of",
        "json",
        video_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr.strip()}")

    payload = __import__("json").loads(result.stdout or "{}")
    streams = payload.get("streams", [])
    if not streams:
        raise RuntimeError("No video stream found")
    stream = streams[0]

    fps_raw = stream.get("avg_frame_rate", "0/1")
    num, den = fps_raw.split("/")
    fps = float(num) / float(den) if float(den) != 0 else 0.0
    duration_sec = float(stream.get("duration") or 0.0)
    nb_frames_raw = stream.get("nb_frames")
    if nb_frames_raw and str(nb_frames_raw).isdigit():
        frame_count = int(nb_frames_raw)
    else:
        frame_count = int(round(duration_sec * fps)) if fps > 0 else 0
    return {"fps": fps, "duration_sec": duration_sec, "frame_count": frame_count}


    # Choose adaptive SR/Hop
    ref_dur = len(ref_audio) / sr
    eff_sr = sr
    eff_hop = CHROMA_HOP_LENGTH
    
    if ref_dur > LONG_SESSION_THRESHOLD_SEC:
        eff_sr = LOWER_SAMPLE_RATE
        eff_hop = LARGER_HOP_LENGTH
        # Downsample if needed for alignment speed
        if sr != eff_sr:
            ref_audio = librosa.resample(ref_audio, orig_sr=sr, target_sr=eff_sr)
            user_audio = librosa.resample(user_audio, orig_sr=sr, target_sr=eff_sr)

    chroma_a = librosa.feature.chroma_stft(y=ref_audio, sr=eff_sr, hop_length=eff_hop)
    chroma_b = librosa.feature.chroma_stft(y=user_audio, sr=eff_sr, hop_length=eff_hop)

    start_a, end_a, start_b, end_b = perform_alignment(chroma_a, chroma_b)
    if end_a < start_a:
        start_a, end_a = end_a, start_a
    if end_b < start_b:
        start_b, end_b = end_b, start_b

    ta, tb = chroma_a.shape[1], chroma_b.shape[1]
    start_a = int(np.clip(start_a, 0, ta - 1))
    end_a = int(np.clip(end_a, 0, ta - 1))
    start_b = int(np.clip(start_b, 0, tb - 1))
    end_b = int(np.clip(end_b, 0, tb - 1))

    start_time_a = float(librosa.frames_to_time(start_a, sr=eff_sr, hop_length=eff_hop))
    end_time_a = float(librosa.frames_to_time(end_a, sr=eff_sr, hop_length=eff_hop))
    start_time_b = float(librosa.frames_to_time(start_b, sr=eff_sr, hop_length=eff_hop))
    end_time_b = float(librosa.frames_to_time(end_b, sr=eff_sr, hop_length=eff_hop))

    ref_dur = len(ref_audio) / sr
    usr_dur = len(user_audio) / sr
    c1_start = float(np.clip(start_time_a, 0.0, ref_dur))
    c2_start = float(np.clip(start_time_b, 0.0, usr_dur))
    len1 = max(0.0, min(end_time_a, ref_dur) - c1_start)
    len2 = max(0.0, min(end_time_b, usr_dur) - c2_start)
    shared_len = max(0.0, min(len1, len2, ref_dur - c1_start, usr_dur - c2_start))
    if shared_len <= 0:
        raise ValueError("Unable to compute shared alignment window.")

    return {
        "clip_1_start_sec": round(c1_start, ROUNDING_PRECISION),
        "clip_1_end_sec": round(c1_start + shared_len, ROUNDING_PRECISION),
        "clip_2_start_sec": round(c2_start, ROUNDING_PRECISION),
        "clip_2_end_sec": round(c2_start + shared_len, ROUNDING_PRECISION),
        "auto_align_mode": "chroma_sw",
    }


def _build_fallback_segments(shared_len_sec: float) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    t = 0.0
    idx = 0
    while t < shared_len_sec:
        end = min(shared_len_sec, t + FALLBACK_CHUNK_SEC)
        segments.append(
            {
                "seg_id": idx,
                "beat_idx_range": None,
                "shared_start_sec": round(t, ROUNDING_PRECISION),
                "shared_end_sec": round(end, ROUNDING_PRECISION),
            }
        )
        idx += 1
        t = end
    return segments


def _build_segments_from_beats(
    beat_times: np.ndarray,
    segment_points: list[float],
    shared_len_sec: float,
) -> list[dict[str, Any]]:
    if len(segment_points) < 2:
        return []

    segments: list[dict[str, Any]] = []
    for idx in range(len(segment_points) - 1):
        start = float(segment_points[idx])
        end = float(segment_points[idx + 1])
        if end <= start:
            continue
        start = max(0.0, min(start, shared_len_sec))
        end = max(start, min(end, shared_len_sec))
        b_start = int(np.searchsorted(beat_times, start, side="left"))
        b_end = int(np.searchsorted(beat_times, end, side="left"))
        segments.append(
            {
                "seg_id": idx,
                "beat_idx_range": [b_start, b_end],
                "shared_start_sec": round(start, ROUNDING_PRECISION),
                "shared_end_sec": round(end, ROUNDING_PRECISION),
            }
        )
    return segments


def _ensure_segment_starts_at_zero(segment_points: list[float]) -> list[float]:
    if not segment_points:
        return segment_points
    first = float(segment_points[0])
    if first <= 1e-6:
        return segment_points
    return [0.0, *segment_points]


def process_uploads(ref_video: UploadFile, user_video: UploadFile) -> dict[str, Any]:
    ref_tmp = save_upload(ref_video, "ref")
    user_tmp = save_upload(user_video, "user")
    ref_wav = None
    user_wav = None
    try:
        # Adaptive loading for RAM efficiency
        meta = probe_video_metadata(ref_tmp)
        load_sr = SAMPLE_RATE
        if meta["duration_sec"] > LONG_SESSION_THRESHOLD_SEC:
            load_sr = LOWER_SAMPLE_RATE

        ref_audio, _ = librosa.load(ref_wav, sr=load_sr, mono=True)
        user_audio, _ = librosa.load(user_wav, sr=load_sr, mono=True)

        alignment = _auto_align(ref_audio, user_audio, load_sr)
        shared_start = alignment["clip_1_start_sec"]
        shared_end = alignment["clip_1_end_sec"]
        shared_len_sec = round(float(shared_end - shared_start), ROUNDING_PRECISION)

        shared_audio = ref_audio[int(shared_start * SAMPLE_RATE) : int(shared_end * SAMPLE_RATE)]
        beat_times, bpm, confidence_info, onset_env, beat_frames = track_beats(shared_audio, SAMPLE_RATE)

        segmentation_mode = "fixed_time"
        beats_shared: list[float] = []
        segments: list[dict[str, Any]] = _build_fallback_segments(shared_len_sec)

        try:
            if len(beat_times) >= BEATS_PER_SEGMENT + 1 and confidence_info["coefficient_of_variation"] <= 0.3:
                downbeat_offset = estimate_downbeat_phase(onset_env, beat_frames, BEATS_PER_SEGMENT)
                segment_points, _segment_beat_times = generate_segments(
                    beat_times, downbeat_offset, BEATS_PER_SEGMENT
                )
                segment_points = _ensure_segment_starts_at_zero(segment_points)
                segs = _build_segments_from_beats(beat_times, segment_points, shared_len_sec)
                if segs:
                    segmentation_mode = "eight_beat"
                    segments = segs
                    beats_shared = [round(float(b), ROUNDING_PRECISION) for b in beat_times]
        except Exception:
            pass

        clip_1_start = float(alignment["clip_1_start_sec"])
        clip_2_start = float(alignment["clip_2_start_sec"])
        for seg in segments:
            seg["clip_1_seg_start_sec"] = round(clip_1_start + seg["shared_start_sec"], ROUNDING_PRECISION)
            seg["clip_1_seg_end_sec"] = round(clip_1_start + seg["shared_end_sec"], ROUNDING_PRECISION)
            seg["clip_2_seg_start_sec"] = round(clip_2_start + seg["shared_start_sec"], ROUNDING_PRECISION)
            seg["clip_2_seg_end_sec"] = round(clip_2_start + seg["shared_end_sec"], ROUNDING_PRECISION)

        artifact: dict[str, Any] = {
            "alignment": {
                "clip_1_start_sec": clip_1_start,
                "clip_1_end_sec": float(alignment["clip_1_end_sec"]),
                "clip_2_start_sec": clip_2_start,
                "clip_2_end_sec": float(alignment["clip_2_end_sec"]),
                "shared_len_sec": shared_len_sec,
                "auto_align_mode": "chroma_sw",
            },
            "beat_tracking": {
                "estimated_bpm": confidence_info.get("estimated_bpm", round(float(bpm), 1)),
                "num_beats": confidence_info.get("num_beats", int(len(beat_times))),
                "num_beats_detected": confidence_info.get("num_beats", int(len(beat_times))),
                "source": "librosa.beat.beat_track",
            },
            "beats_shared_sec": beats_shared,
            "segmentation_mode": segmentation_mode,
            "segments": segments,
            "video_meta": {
                "clip_1": probe_video_metadata(ref_tmp),
                "clip_2": probe_video_metadata(user_tmp),
            },
        }
        return sanitize_json(artifact)
    finally:
        for p in (ref_tmp, user_tmp, ref_wav, user_wav):
            if not p:
                continue
            try:
                Path(p).unlink(missing_ok=True)
            except OSError:
                pass


def process_videos_from_paths(ref_video_path: str, user_video_path: str) -> dict[str, Any]:
    """Run the EBS alignment+segmentation pipeline for two saved video files.

    Unlike `process_uploads()`, this function DOES NOT delete `ref_video_path`
    or `user_video_path`. It only cleans up the extracted temporary audio
    `.wav` files.
    """
    # Defensive check for missing or empty paths
    for label, p in [("Reference", ref_video_path), ("Practice", user_video_path)]:
        if not p or not Path(p).exists():
             raise ValueError(f"Invalid file: {label} path is {p}")
        if Path(p).stat().st_size == 0:
             raise ValueError(f"Invalid file: {label} ({Path(p).name}) is empty (0 bytes)")

    ref_wav: str | None = None
    user_wav: str | None = None
    try:
        # Adaptive loading for RAM efficiency
        meta = probe_video_metadata(ref_video_path)
        load_sr = SAMPLE_RATE
        if meta["duration_sec"] > LONG_SESSION_THRESHOLD_SEC:
            load_sr = LOWER_SAMPLE_RATE

        ref_audio, _ = librosa.load(ref_wav, sr=load_sr, mono=True)
        user_audio, _ = librosa.load(user_wav, sr=load_sr, mono=True)

        alignment = _auto_align(ref_audio, user_audio, load_sr)
        shared_start = alignment["clip_1_start_sec"]
        shared_end = alignment["clip_1_end_sec"]
        shared_len_sec = round(float(shared_end - shared_start), ROUNDING_PRECISION)

        shared_audio = ref_audio[int(shared_start * SAMPLE_RATE) : int(shared_end * SAMPLE_RATE)]
        beat_times, bpm, confidence_info, onset_env, beat_frames = track_beats(shared_audio, SAMPLE_RATE)

        segmentation_mode = "fixed_time"
        beats_shared: list[float] = []
        segments: list[dict[str, Any]] = _build_fallback_segments(shared_len_sec)

        try:
            if len(beat_times) >= BEATS_PER_SEGMENT + 1 and confidence_info["coefficient_of_variation"] <= 0.3:
                downbeat_offset = estimate_downbeat_phase(onset_env, beat_frames, BEATS_PER_SEGMENT)
                segment_points, _segment_beat_times = generate_segments(
                    beat_times, downbeat_offset, BEATS_PER_SEGMENT
                )
                segment_points = _ensure_segment_starts_at_zero(segment_points)
                segs = _build_segments_from_beats(beat_times, segment_points, shared_len_sec)
                if segs:
                    segmentation_mode = "eight_beat"
                    segments = segs
                    beats_shared = [round(float(b), ROUNDING_PRECISION) for b in beat_times]
        except Exception:
            pass

        clip_1_start = float(alignment["clip_1_start_sec"])
        clip_2_start = float(alignment["clip_2_start_sec"])
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

        artifact: dict[str, Any] = {
            "alignment": {
                "clip_1_start_sec": clip_1_start,
                "clip_1_end_sec": float(alignment["clip_1_end_sec"]),
                "clip_2_start_sec": clip_2_start,
                "clip_2_end_sec": float(alignment["clip_2_end_sec"]),
                "shared_len_sec": shared_len_sec,
                "auto_align_mode": "chroma_sw",
            },
            "beat_tracking": {
                "estimated_bpm": confidence_info.get("estimated_bpm", round(float(bpm), 1)),
                "num_beats": confidence_info.get("num_beats", int(len(beat_times))),
                "num_beats_detected": confidence_info.get("num_beats", int(len(beat_times))),
                "source": "librosa.beat.beat_track",
            },
            "beats_shared_sec": beats_shared,
            "segmentation_mode": segmentation_mode,
            "segments": segments,
            "video_meta": {
                "clip_1": probe_video_metadata(ref_video_path),
                "clip_2": probe_video_metadata(user_video_path),
            },
        }
        return sanitize_json(artifact)
    finally:
        for p in (ref_wav, user_wav):
            if not p:
                continue
            try:
                Path(p).unlink(missing_ok=True)
            except OSError:
                pass
