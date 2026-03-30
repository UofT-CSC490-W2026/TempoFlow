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

from src.ffmpeg_paths import resolve_ffmpeg_executable

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
- Video 1: reference (first clip; may have a REFERENCE label burned into the frame)
- Video 2: user / practice (second clip; may have a USER label burned into the frame)
- A list of move timestamp windows
- Optional: independent pose-based timing hints (peak motion offset). Treat these as \
soft priors to disambiguate early vs late; they can be wrong if pose tracking fails.
- Optional: YOLO pose / segmentation summaries for this segment. Coordinates are normalized 0..1 \
and serve as soft spatial grounding when motion is ambiguous.

Each move is the body transition between two consecutive beats, not a static pose.
Evaluate each move window separately.

Task:
For each move window, compare the user to the reference on micro-timing only.

Micro-timing means:
- when the move starts
- when the main motion or accent peaks
- when the move lands or settles

For each move you MUST also set user_relative_to_reference:
- ahead: user initiates or peaks clearly before the reference in that window
- behind: user initiates or peaks clearly after the reference
- aligned: within a small tolerance of the reference
- unclear: cannot tell (e.g. occlusion, minimal motion)

Requirements:
- explicitly mention left/right body parts when relevant
- explicitly mention weight state when relevant: left-weighted, right-weighted, \
centered, shifting left to right, shifting right to left
- describe the specific body position or transition that is mistimed
- focus on motion trajectory, timing of initiation, timing of peak, timing of landing
- do not comment on style or overall quality
- if evidence is weak because of blur, occlusion, cropping, or angle, say so briefly
- keep micro_timing_label consistent with user_relative_to_reference when possible

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
      "user_relative_to_reference": "ahead | behind | aligned | unclear",
      "micro_timing_evidence": "",
      "body_parts_involved": [],
      "coaching_note": "",
      "confidence": "high | medium | low"
    }
  ]
}
If a move window contains too little visible motion to judge reliably, \
label it "uncertain" instead of guessing and set user_relative_to_reference to "unclear"."""

# ---------------------------------------------------------------------------
# Video preprocessing helpers
# ---------------------------------------------------------------------------

# Cached per ffmpeg executable path (Homebrew macOS builds often omit libfreetype → no drawtext).
_FFMPEG_DRAWTEXT_CACHE: dict[str, bool] = {}


def _ffmpeg_has_drawtext(ffmpeg: str) -> bool:
    """Return whether ``ffmpeg`` was built with the ``drawtext`` filter (needs freetype)."""
    cached = _FFMPEG_DRAWTEXT_CACHE.get(ffmpeg)
    if cached is not None:
        return cached
    try:
        r = subprocess.run(
            [ffmpeg, "-hide_banner", "-filters"],
            capture_output=True,
            text=True,
            timeout=20,
        )
        combined = f"{r.stdout or ''}\n{r.stderr or ''}"
        # Listed as " ... drawtext           V->V       Draw text on top of video ..."
        ok = "drawtext" in combined
    except (OSError, subprocess.TimeoutExpired):
        ok = False
    _FFMPEG_DRAWTEXT_CACHE[ffmpeg] = ok
    if not ok:
        logger.warning(
            "ffmpeg at %s reports no drawtext filter (install a build with freetype, e.g. "
            "`brew reinstall ffmpeg` with drawtext support, or leave burn-in disabled).",
            ffmpeg,
        )
    return ok


def _ffmpeg_available() -> str | None:
    """Return the ffmpeg path if usable, else ``None``."""
    exe = resolve_ffmpeg_executable()
    if shutil.which(exe):
        return exe
    try:
        subprocess.run([exe, "-version"], capture_output=True, timeout=5)
        return exe
    except (FileNotFoundError, OSError):
        return None


def _escape_drawtext(s: str) -> str:
    """Escape single-quoted drawtext text for ffmpeg."""
    return s.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def _prepare_clip_ffmpeg(
    video_path: str,
    start_sec: float,
    end_sec: float,
    output_path: str,
    height: int,
    ffmpeg: str,
    *,
    strip_audio: bool = True,
    burn_in_text: str | None = None,
    _retried_without_burn_in: bool = False,
) -> str:
    duration = end_sec - start_sec
    vf = f"scale=-2:{height}"
    if burn_in_text:
        esc = _escape_drawtext(burn_in_text)
        vf += (
            f",drawtext=text='{esc}':x=w*0.02:y=h*0.02:fontsize=h*0.045:"
            "fontcolor=white:box=1:boxcolor=black@0.55"
        )
    cmd: list[str] = [
        ffmpeg,
        "-y",
        "-ss",
        f"{start_sec:.3f}",
        "-i",
        video_path,
        "-t",
        f"{duration:.3f}",
    ]
    if strip_audio:
        cmd.append("-an")
    else:
        cmd.extend(["-c:a", "aac", "-b:a", "128k"])
    cmd.extend(
        [
            "-vf",
            vf,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "28",
            output_path,
        ]
    )
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        err = (result.stderr or "").lower()
        if (
            burn_in_text
            and not _retried_without_burn_in
            and (
                "drawtext" in err
                or "no such filter" in err
                or "filter not found" in err
            )
        ):
            logger.warning(
                "ffmpeg failed on drawtext filter; retrying segment clip without burn-in labels.",
            )
            return _prepare_clip_ffmpeg(
                video_path,
                start_sec,
                end_sec,
                output_path,
                height,
                ffmpeg,
                strip_audio=strip_audio,
                burn_in_text=None,
                _retried_without_burn_in=True,
            )
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
    *,
    strip_audio: bool = True,
    burn_in_text: str | None = None,
) -> str:
    """Trim *video_path* to ``[start_sec, end_sec]``, optionally strip audio, scale down.

    Tries ffmpeg first (best quality / smallest file). Falls back to OpenCV
    if ffmpeg is not available (burn-in and audio retention require ffmpeg).

    Returns the path to the written MP4 file.
    """
    if output_path is None:
        tmp = tempfile.NamedTemporaryFile(prefix="gemini_clip_", suffix=".mp4", delete=False)
        output_path = tmp.name
        tmp.close()

    ffmpeg = _ffmpeg_available()
    if ffmpeg:
        eff_burn = burn_in_text
        if burn_in_text and not _ffmpeg_has_drawtext(ffmpeg):
            logger.warning(
                "Skipping on-video burn-in: this ffmpeg build has no drawtext filter.",
            )
            eff_burn = None
        logger.info(
            "Preparing clip via ffmpeg (strip_audio=%s, burn_in=%s)",
            strip_audio,
            bool(eff_burn),
        )
        return _prepare_clip_ffmpeg(
            video_path,
            start_sec,
            end_sec,
            output_path,
            height,
            ffmpeg,
            strip_audio=strip_audio,
            burn_in_text=eff_burn,
        )

    if burn_in_text or not strip_audio:
        logger.warning("ffmpeg not found; OpenCV fallback cannot burn in labels or keep audio")
    logger.warning("ffmpeg not found; falling back to OpenCV for clip preparation")
    return _prepare_clip_opencv(video_path, start_sec, end_sec, output_path, height)


# ---------------------------------------------------------------------------
# Move derivation from EBS artifact
# ---------------------------------------------------------------------------


def derive_moves_for_segment(ebs_artifact: dict, segment_index: int) -> list[dict]:
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
        raise ValueError(f"segment_index {segment_index} out of range (0..{len(segments) - 1})")

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


def format_move_windows(moves: list[dict], seg_shared_start: float) -> tuple[str, list[dict]]:
    """Build the move-window portion of the Gemini user prompt.

    Timestamps are made relative to the trimmed clip (i.e. the segment
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


def format_pose_priors_for_prompt(pose_priors: dict[str, Any] | None) -> str:
    """Format client-computed pose timing priors for the Gemini user message."""
    if not pose_priors:
        return ""
    moves = pose_priors.get("moves")
    if not isinstance(moves, list) or not moves:
        return ""
    lines = [
        "Independent pose-based timing estimates (from MoveNet/BodyPix sampling in the browser). "
        "Use as a soft prior; they may be wrong if the dancer was occluded or off-frame.\n",
    ]
    for m in moves:
        if not isinstance(m, dict):
            continue
        idx = m.get("move_index")
        rel = m.get("user_relative_to_reference", "unclear")
        off = m.get("phase_offset_ms")
        conf = m.get("prior_confidence", "medium")
        off_s = f", phase_offset_ms≈{off:.1f}" if isinstance(off, (int, float)) else ""
        lines.append(f"- Move {idx}: user_relative_to_reference≈{rel}{off_s} (prior_confidence={conf})")
    lines.append("")
    return "\n".join(lines)


def format_yolo_context_for_prompt(yolo_context: dict[str, Any] | None) -> str:
    """Format per-segment YOLO summaries for the Gemini user message."""
    if not yolo_context:
        return ""
    return (
        "YOLO segment context (soft spatial grounding; normalized coordinates in 0..1). "
        "Use this to understand visible person positions / scale, but trust the videos first if they disagree.\n"
        f"{json.dumps(yolo_context, separators=(',', ':'), ensure_ascii=True)}\n"
    )


# Labels that imply "ahead of reference" vs "behind" for guardrail checks
_LABEL_AHEADISH = frozenset({"early", "rushed"})
_LABEL_BEHINDISH = frozenset({"late", "dragged"})


def apply_move_feedback_guardrails(result: dict[str, Any], pose_priors: dict[str, Any] | None) -> dict[str, Any]:
    """Downgrade confidence or add notes when Gemini disagrees with pose priors."""
    if not pose_priors:
        return result
    moves_in = pose_priors.get("moves")
    if not isinstance(moves_in, list):
        return result
    prior_by_idx: dict[int, dict[str, Any]] = {}
    for pm in moves_in:
        if isinstance(pm, dict) and isinstance(pm.get("move_index"), int):
            prior_by_idx[pm["move_index"]] = pm

    for mv in result.get("moves", []):
        if not isinstance(mv, dict):
            continue
        idx = mv.get("move_index")
        if not isinstance(idx, int):
            continue
        prior = prior_by_idx.get(idx)
        if not prior:
            continue
        rel = str(prior.get("user_relative_to_reference", "unclear")).lower()
        label = str(mv.get("micro_timing_label", "")).lower()
        pconf = str(prior.get("prior_confidence", "medium")).lower()
        phase_ms = prior.get("phase_offset_ms")
        small_offset = isinstance(phase_ms, (int, float)) and abs(float(phase_ms)) < 55.0

        conflict = False
        if rel == "ahead" and label in _LABEL_BEHINDISH:
            conflict = True
        elif rel == "behind" and label in _LABEL_AHEADISH:
            conflict = True
        elif rel in {"aligned", "unclear"} and small_offset and label in _LABEL_AHEADISH | _LABEL_BEHINDISH:
            conflict = True

        if conflict:
            note = "Pose prior disagrees with video judgment; confidence downgraded."
            prev = mv.get("guardrail_note")
            mv["guardrail_note"] = f"{prev}; {note}" if prev else note
            if pconf in {"high", "medium"}:
                mv["confidence"] = "low"
            else:
                mv["confidence"] = mv.get("confidence") or "low"
        elif small_offset and label in _LABEL_AHEADISH | _LABEL_BEHINDISH and rel in {"aligned", "unclear"}:
            gn = (mv.get("guardrail_note") or "").strip()
            extra = "Small pose offset vs strong timing label — verify visually."
            mv["guardrail_note"] = f"{gn}; {extra}" if gn else extra

    return result


# ---------------------------------------------------------------------------
# Gemini API interaction
# ---------------------------------------------------------------------------


def _resolve_api_key(api_key: str | None) -> str:
    key = api_key or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        raise RuntimeError("No Gemini API key. Set GEMINI_API_KEY or GOOGLE_API_KEY env var.")
    return key


def _wait_for_file_active(file_ref: Any, timeout: int = GEMINI_UPLOAD_TIMEOUT_SEC) -> Any:
    """Poll until a Gemini File API upload reaches ACTIVE state."""
    import google.generativeai as genai

    start = time.monotonic()
    while file_ref.state.name == "PROCESSING":
        if time.monotonic() - start > timeout:
            raise TimeoutError(f"Gemini file {file_ref.name} still PROCESSING after {timeout}s")
        time.sleep(GEMINI_UPLOAD_POLL_SEC)
        file_ref = genai.get_file(file_ref.name)

    if file_ref.state.name != "ACTIVE":
        raise RuntimeError(f"Gemini file {file_ref.name} in unexpected state: {file_ref.state.name}")
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


def _is_retryable_gemini_error(exc: BaseException) -> bool:
    """Transient network/TLS issues — safe to retry full upload + generate."""
    msg = str(exc).lower()
    if "timeout" in msg or "timed out" in msg:
        return True
    if "wrong version number" in msg:
        return True
    if "decryption failed" in msg or "bad record mac" in msg:
        return True
    if "ssl" in msg and ("eof" in msg or "connection" in msg):
        return True
    if "connection reset" in msg or "broken pipe" in msg:
        return True
    name = type(exc).__name__
    if name in ("ReadTimeout", "ConnectTimeout", "SSLError", "SSLCertVerificationError"):
        return True
    return False


def _call_gemini_move_feedback_once(
    ref_clip_path: str,
    user_clip_path: str,
    move_windows_text: str,
    api_key: str | None = None,
    model_name: str = GEMINI_MODEL,
    pose_priors_text: str | None = None,
    yolo_context_text: str | None = None,
) -> dict:
    """Single attempt: upload clips, generate, delete files, return parsed JSON."""
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

    user_parts: list[Any] = [
        ref_file,
        "\nAbove is the REFERENCE dance video (first clip).\n",
        user_file,
        "\nAbove is the USER / practice dance video (second clip).\n",
    ]
    if pose_priors_text:
        user_parts.append(pose_priors_text)
    if yolo_context_text:
        user_parts.append(yolo_context_text)
    user_parts.append(move_windows_text)

    try:
        model = genai.GenerativeModel(model_name=model_name, system_instruction=SYSTEM_PROMPT)
        response = model.generate_content(
            user_parts,
            generation_config=genai.GenerationConfig(temperature=0.3, response_mime_type="application/json"),
        )
        return _parse_gemini_json(response.text)
    finally:
        for f in (ref_file, user_file):
            try:
                genai.delete_file(f.name)
            except Exception as exc:
                logger.warning("Could not delete uploaded file %s: %s", f.name, exc)


def call_gemini_move_feedback(
    ref_clip_path: str,
    user_clip_path: str,
    move_windows_text: str,
    api_key: str | None = None,
    model_name: str = GEMINI_MODEL,
    pose_priors_text: str | None = None,
    yolo_context_text: str | None = None,
    max_attempts: int = 4,
) -> dict:
    """Upload segment clips and call Gemini for micro-timing feedback (with retries)."""
    last_exc: BaseException | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            return _call_gemini_move_feedback_once(
                ref_clip_path,
                user_clip_path,
                move_windows_text,
                api_key=api_key,
                model_name=model_name,
                pose_priors_text=pose_priors_text,
                yolo_context_text=yolo_context_text,
            )
        except BaseException as exc:
            last_exc = exc
            if attempt >= max_attempts or not _is_retryable_gemini_error(exc):
                raise
            delay = min(8.0, 2.0 ** (attempt - 1))
            logger.warning(
                "Gemini call failed (attempt %d/%d), retrying in %.1fs: %s",
                attempt,
                max_attempts,
                delay,
                exc,
            )
            time.sleep(delay)
    assert last_exc is not None
    raise last_exc


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
    pose_priors: dict[str, Any] | None = None,
    yolo_context: dict[str, Any] | None = None,
    burn_in_labels: bool = True,
    include_audio: bool = False,
) -> dict:
    """Full pipeline: derive moves, prep clips, call Gemini, return feedback."""
    alignment = ebs_artifact.get("alignment", {})
    segments = ebs_artifact.get("segments", [])

    if segment_index < 0 or segment_index >= len(segments):
        raise ValueError(f"segment_index {segment_index} out of range (0..{len(segments) - 1})")

    seg = segments[segment_index]

    # Absolute clip timestamps for this segment
    ref_start = seg.get("clip_1_seg_start_sec", alignment["clip_1_start_sec"] + seg["shared_start_sec"])
    ref_end = seg.get("clip_1_seg_end_sec", alignment["clip_1_start_sec"] + seg["shared_end_sec"])
    user_start = seg.get("clip_2_seg_start_sec", alignment["clip_2_start_sec"] + seg["shared_start_sec"])
    user_end = seg.get("clip_2_seg_end_sec", alignment["clip_2_start_sec"] + seg["shared_end_sec"])

    logger.info(
        "move-feedback segment=%d ref_clip=[%.4f, %.4f] user_clip=[%.4f, %.4f] burn_in=%s audio=%s",
        segment_index,
        ref_start,
        ref_end,
        user_start,
        user_end,
        burn_in_labels,
        include_audio,
    )

    # Derive moves
    moves = derive_moves_for_segment(ebs_artifact, segment_index)
    if not moves:
        return {"error": "No moves found in segment", "moves": []}

    move_text, annotated_moves = format_move_windows(moves, seg["shared_start_sec"])
    pose_priors_text = format_pose_priors_for_prompt(pose_priors) if pose_priors else None
    yolo_context_text = format_yolo_context_for_prompt(yolo_context) if yolo_context else None

    tmp_files: list[str] = []
    try:
        logger.info("Preparing ref clip [%.3f-%.3f] at %dp", ref_start, ref_end, low_res_height)
        ref_clip = prepare_segment_clip(
            ref_video_path,
            ref_start,
            ref_end,
            height=low_res_height,
            strip_audio=not include_audio,
            burn_in_text="REFERENCE" if burn_in_labels else None,
        )
        tmp_files.append(ref_clip)

        logger.info("Preparing user clip [%.3f-%.3f] at %dp", user_start, user_end, low_res_height)
        user_clip = prepare_segment_clip(
            user_video_path,
            user_start,
            user_end,
            height=low_res_height,
            strip_audio=not include_audio,
            burn_in_text="USER" if burn_in_labels else None,
        )
        tmp_files.append(user_clip)

        logger.info("Calling Gemini (%s) for %d moves in segment %d", model_name, len(moves), segment_index)
        result = call_gemini_move_feedback(
            ref_clip,
            user_clip,
            move_text,
            api_key=api_key,
            model_name=model_name,
            pose_priors_text=pose_priors_text,
            yolo_context_text=yolo_context_text,
        )
        result = apply_move_feedback_guardrails(result, pose_priors)

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
