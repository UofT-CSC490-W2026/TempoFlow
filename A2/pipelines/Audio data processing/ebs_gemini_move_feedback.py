#!/usr/bin/env python3
"""
Gemini Vision micro-timing move feedback.

Given an EBS artifact, two dance videos, and a target segment index:
1. Derive per-beat "moves" (inter-beat intervals) from the segment.
2. Trim both videos to the segment window, strip audio, lower resolution.
3. Upload both clips to the Gemini File API.
4. Send clips + move-window timestamps to Gemini 2.5 Flash-Lite.
5. Return structured JSON micro-timing comparison.

Requires:
  - GEMINI_API_KEY (or GOOGLE_API_KEY) environment variable
  - ffmpeg on PATH (or EBS_FFMPEG_PATH)
  - pip install google-generativeai
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from ebs_ffmpeg_paths import resolve_ffmpeg_executable

logger = logging.getLogger("ebs-gemini")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

LOW_RES_HEIGHT = 360
GEMINI_MODEL = "gemini-2.5-flash-lite"
GEMINI_UPLOAD_POLL_SEC = 2
GEMINI_UPLOAD_TIMEOUT_SEC = 120

SYSTEM_PROMPT = """\
You are a dance micro-timing comparison assistant.

Inputs:
- Video 1: reference
- Video 2: user
- A list of move timestamp windows

Each move is the body transition between two consecutive beats, not a static pose.
Evaluate each move window separately.

Task:
For each move window, compare the user to the reference on micro-timing only.

Micro-timing means:
- when the move starts
- when the main motion or accent peaks
- when the move lands or settles

Requirements:
- explicitly mention left/right body parts when relevant
- explicitly mention weight state when relevant: left-weighted, right-weighted, \
centered, shifting left to right, shifting right to left
- describe the specific body position or transition that is mistimed
- focus on motion trajectory, timing of initiation, timing of peak, timing of landing
- do not comment on style or overall quality
- if evidence is weak because of blur, occlusion, cropping, or angle, say so briefly

Use exactly one label per move:
- on-time
- early
- late
- rushed
- dragged
- mixed
- uncertain

Return JSON only:

{
  "moves": [
    {
      "move_index": 1,
      "time_window": "00:00.0-00:00.6",
      "micro_timing_label": "",
      "micro_timing_evidence": "",
      "body_parts_involved": [],
      "coaching_note": "",
      "confidence": "high | medium | low"
    }
  ]
}
If a move window contains too little visible motion to judge reliably, \
label it "uncertain" instead of guessing."""

# ---------------------------------------------------------------------------
# Video preprocessing helpers
# ---------------------------------------------------------------------------


def _ffmpeg_available() -> str | None:
    """Return the ffmpeg path if usable, else ``None``."""
    exe = resolve_ffmpeg_executable()
    if shutil.which(exe):
        return exe
    try:
        subprocess.run(
            [exe, "-version"], capture_output=True, timeout=5
        )
        return exe
    except (FileNotFoundError, OSError):
        return None


def _prepare_clip_ffmpeg(
    video_path: str,
    start_sec: float,
    end_sec: float,
    output_path: str,
    height: int,
    ffmpeg: str,
) -> str:
    duration = end_sec - start_sec
    cmd = [
        ffmpeg,
        "-y",
        "-ss", f"{start_sec:.3f}",
        "-i", video_path,
        "-t", f"{duration:.3f}",
        "-an",
        "-vf", f"scale=-2:{height}",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg clip preparation failed: {result.stderr.strip()}")
    return output_path


def _prepare_clip_opencv(
    video_path: str,
    start_sec: float,
    end_sec: float,
    output_path: str,
    height: int,
) -> str:
    """Fallback clip prep using OpenCV when ffmpeg is not on PATH."""
    import cv2

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"OpenCV cannot open {video_path}")

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    scale = height / src_h if src_h > height else 1.0
    out_h = min(src_h, height)
    out_w = int(src_w * scale)
    if out_w % 2 != 0:
        out_w += 1

    cap.set(cv2.CAP_PROP_POS_MSEC, start_sec * 1000.0)

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(output_path, fourcc, src_fps, (out_w, out_h))
    if not writer.isOpened():
        cap.release()
        raise RuntimeError("OpenCV VideoWriter failed to open")

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        pos_sec = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        if pos_sec > end_sec:
            break
        if scale < 1.0:
            frame = cv2.resize(frame, (out_w, out_h), interpolation=cv2.INTER_AREA)
        writer.write(frame)

    cap.release()
    writer.release()
    return output_path


def prepare_segment_clip(
    video_path: str,
    start_sec: float,
    end_sec: float,
    output_path: str | None = None,
    height: int = LOW_RES_HEIGHT,
) -> str:
    """Trim *video_path* to ``[start_sec, end_sec]``, strip audio, scale down.

    Tries ffmpeg first (best quality / smallest file). Falls back to OpenCV
    if ffmpeg is not available.

    Returns the path to the written MP4 file.
    """
    if output_path is None:
        tmp = tempfile.NamedTemporaryFile(
            prefix="gemini_clip_", suffix=".mp4", delete=False
        )
        output_path = tmp.name
        tmp.close()

    ffmpeg = _ffmpeg_available()
    if ffmpeg:
        logger.info("Preparing clip via ffmpeg")
        return _prepare_clip_ffmpeg(
            video_path, start_sec, end_sec, output_path, height, ffmpeg
        )

    logger.warning("ffmpeg not found; falling back to OpenCV for clip preparation")
    return _prepare_clip_opencv(
        video_path, start_sec, end_sec, output_path, height
    )


# ---------------------------------------------------------------------------
# Move derivation from EBS artifact
# ---------------------------------------------------------------------------


def derive_moves_for_segment(
    ebs_artifact: dict,
    segment_index: int,
) -> list[dict]:
    """Build move windows (inter-beat intervals) for one EBS segment.

    Each "move" spans ``[beats[i], beats[i+1])`` within the segment's
    ``beat_idx_range``, matching the front-end ``buildMoves`` logic in
    ``useEbsViewer.ts``.

    Returns a list of dicts with keys:
      ``move_index`` (1-based), ``shared_start_sec``, ``shared_end_sec``.
    """
    segments = ebs_artifact.get("segments", [])
    beats = ebs_artifact.get("beats_shared_sec", [])

    if segment_index < 0 or segment_index >= len(segments):
        raise ValueError(
            f"segment_index {segment_index} out of range (0..{len(segments) - 1})"
        )

    seg = segments[segment_index]
    beat_range = seg.get("beat_idx_range")
    if not beat_range:
        raise ValueError(f"Segment {segment_index} has no beat_idx_range")

    beat_start, beat_end = beat_range
    moves: list[dict] = []
    for i in range(beat_start, beat_end):
        if i >= len(beats) or i + 1 >= len(beats):
            break
        moves.append(
            {
                "move_index": len(moves) + 1,
                "shared_start_sec": beats[i],
                "shared_end_sec": beats[i + 1],
            }
        )
    return moves


# ---------------------------------------------------------------------------
# Move-window prompt formatting
# ---------------------------------------------------------------------------


def _fmt_time(sec: float) -> str:
    """Format seconds as ``MM:SS.d`` (e.g. ``00:01.2``)."""
    minutes = int(sec // 60)
    remainder = sec - minutes * 60
    return f"{minutes:02d}:{remainder:04.1f}"


def format_move_windows(
    moves: list[dict],
    seg_shared_start: float,
) -> tuple[str, list[dict]]:
    """Build the move-window portion of the Gemini user prompt.

    Timestamps are made *relative to the trimmed clip* (i.e. the segment
    start becomes ``00:00.0``).

    Returns ``(prompt_text, annotated_moves)`` where each annotated move
    carries the extra keys ``rel_start``, ``rel_end``, ``time_window``.
    """
    lines = ["Evaluate the following move windows:\n"]
    annotated: list[dict] = []

    for m in moves:
        rel_start = m["shared_start_sec"] - seg_shared_start
        rel_end = m["shared_end_sec"] - seg_shared_start
        time_window = f"{_fmt_time(rel_start)}-{_fmt_time(rel_end)}"

        lines.append(f"{m['move_index']}. {time_window}")
        annotated.append(
            {
                **m,
                "rel_start": rel_start,
                "rel_end": rel_end,
                "time_window": time_window,
            }
        )

    lines.append("\nReturn one JSON object with feedback for all moves.")
    lines.append("Keep evidence short and specific.")
    return "\n".join(lines), annotated


# ---------------------------------------------------------------------------
# Gemini API interaction
# ---------------------------------------------------------------------------


def _resolve_api_key(api_key: str | None) -> str:
    key = api_key or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        raise RuntimeError(
            "No Gemini API key. Set GEMINI_API_KEY or GOOGLE_API_KEY env var."
        )
    return key


def _wait_for_file_active(file_ref: Any, timeout: int = GEMINI_UPLOAD_TIMEOUT_SEC) -> Any:
    """Poll until a Gemini File API upload reaches ACTIVE state."""
    import google.generativeai as genai

    start = time.monotonic()
    while file_ref.state.name == "PROCESSING":
        if time.monotonic() - start > timeout:
            raise TimeoutError(
                f"Gemini file {file_ref.name} still PROCESSING after {timeout}s"
            )
        time.sleep(GEMINI_UPLOAD_POLL_SEC)
        file_ref = genai.get_file(file_ref.name)
    if file_ref.state.name != "ACTIVE":
        raise RuntimeError(
            f"Gemini file {file_ref.name} in unexpected state: {file_ref.state.name}"
        )
    return file_ref


def _parse_gemini_json(raw: str) -> dict:
    """Best-effort JSON extraction from Gemini response text."""
    text = raw.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if match:
        return json.loads(match.group(1).strip())
    raise ValueError(f"Gemini returned non-JSON response: {text[:500]}")


def call_gemini_move_feedback(
    ref_clip_path: str,
    user_clip_path: str,
    move_windows_text: str,
    api_key: str | None = None,
    model_name: str = GEMINI_MODEL,
) -> dict:
    """Upload segment clips and call Gemini for micro-timing feedback.

    Uses the google-generativeai File API for video upload, then sends
    the system prompt + move windows as a multimodal generate_content call.
    """
    import google.generativeai as genai

    key = _resolve_api_key(api_key)
    genai.configure(api_key=key)

    logger.info("Uploading reference clip to Gemini…")
    ref_file = genai.upload_file(ref_clip_path, mime_type="video/mp4")
    logger.info("Uploading user clip to Gemini…")
    user_file = genai.upload_file(user_clip_path, mime_type="video/mp4")

    ref_file = _wait_for_file_active(ref_file)
    user_file = _wait_for_file_active(user_file)
    logger.info("Both clips active on Gemini File API")

    model = genai.GenerativeModel(
        model_name=model_name,
        system_instruction=SYSTEM_PROMPT,
    )

    response = model.generate_content(
        [
            ref_file,
            "\nAbove is the REFERENCE dance video.\n",
            user_file,
            "\nAbove is the USER dance video.\n",
            move_windows_text,
        ],
        generation_config=genai.GenerationConfig(
            temperature=0.3,
            response_mime_type="application/json",
        ),
    )

    for f in (ref_file, user_file):
        try:
            genai.delete_file(f.name)
        except Exception as exc:
            logger.warning("Could not delete uploaded file %s: %s", f.name, exc)

    return _parse_gemini_json(response.text)


# ---------------------------------------------------------------------------
# Pipeline orchestrator
# ---------------------------------------------------------------------------


def run_move_feedback_pipeline(
    ref_video_path: str,
    user_video_path: str,
    ebs_artifact: dict,
    segment_index: int,
    api_key: str | None = None,
    model_name: str = GEMINI_MODEL,
    low_res_height: int = LOW_RES_HEIGHT,
) -> dict:
    """Full pipeline: derive moves, prep clips, call Gemini, return feedback.

    Parameters
    ----------
    ref_video_path :
        Path to the original reference dance video.
    user_video_path :
        Path to the original user practice video.
    ebs_artifact :
        Complete EBS pipeline output (must include ``alignment``,
        ``segments``, and ``beats_shared_sec``).
    segment_index :
        0-based index of the segment to analyse.
    api_key :
        Gemini API key (falls back to ``GEMINI_API_KEY`` / ``GOOGLE_API_KEY``).
    model_name :
        Gemini model identifier.
    low_res_height :
        Target video height in pixels for the clips sent to Gemini.

    Returns
    -------
    dict
        Gemini's structured micro-timing feedback, enriched with
        ``segment_index`` and ``model`` metadata.
    """
    alignment = ebs_artifact.get("alignment", {})
    segments = ebs_artifact.get("segments", [])

    if segment_index < 0 or segment_index >= len(segments):
        raise ValueError(
            f"segment_index {segment_index} out of range (0..{len(segments) - 1})"
        )

    seg = segments[segment_index]

    # Absolute clip timestamps for this segment
    ref_start = seg.get(
        "clip_1_seg_start_sec",
        alignment["clip_1_start_sec"] + seg["shared_start_sec"],
    )
    ref_end = seg.get(
        "clip_1_seg_end_sec",
        alignment["clip_1_start_sec"] + seg["shared_end_sec"],
    )
    user_start = seg.get(
        "clip_2_seg_start_sec",
        alignment["clip_2_start_sec"] + seg["shared_start_sec"],
    )
    user_end = seg.get(
        "clip_2_seg_end_sec",
        alignment["clip_2_start_sec"] + seg["shared_end_sec"],
    )

    # Derive moves
    moves = derive_moves_for_segment(ebs_artifact, segment_index)
    if not moves:
        return {"error": "No moves found in segment", "moves": []}

    move_text, annotated_moves = format_move_windows(
        moves, seg["shared_start_sec"]
    )

    tmp_files: list[str] = []
    try:
        logger.info(
            "Preparing ref clip [%.3f–%.3f] at %dp",
            ref_start, ref_end, low_res_height,
        )
        ref_clip = prepare_segment_clip(
            ref_video_path, ref_start, ref_end, height=low_res_height
        )
        tmp_files.append(ref_clip)

        logger.info(
            "Preparing user clip [%.3f–%.3f] at %dp",
            user_start, user_end, low_res_height,
        )
        user_clip = prepare_segment_clip(
            user_video_path, user_start, user_end, height=low_res_height
        )
        tmp_files.append(user_clip)

        logger.info(
            "Calling Gemini (%s) for %d moves in segment %d",
            model_name, len(moves), segment_index,
        )
        result = call_gemini_move_feedback(
            ref_clip,
            user_clip,
            move_text,
            api_key=api_key,
            model_name=model_name,
        )

        for rm in result.get("moves", []):
            idx = rm.get("move_index", 0)
            if 1 <= idx <= len(annotated_moves):
                am = annotated_moves[idx - 1]
                rm["shared_start_sec"] = am["shared_start_sec"]
                rm["shared_end_sec"] = am["shared_end_sec"]

        result["segment_index"] = segment_index
        result["model"] = model_name
        return result

    finally:
        for p in tmp_files:
            try:
                Path(p).unlink(missing_ok=True)
            except OSError:
                pass
