"""Fan-out runner — wraps the existing Gemini pipeline to call all eval models in parallel."""
from __future__ import annotations

import base64
import glob as _glob
import json
import logging
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

import certifi
import httpx

from .config import EVAL_DIR, EVAL_MODELS, PROMPT_VERSION
from .storage import video_id_from_filename, write_evaluation

logger = logging.getLogger("eval-runner")

OPENAI_FRAMES_PER_SEC = 2


# ---------------------------------------------------------------------------
# Frame extraction (OpenAI needs images, not raw video)
# ---------------------------------------------------------------------------


def _extract_frames(clip_path: str, fps: int = OPENAI_FRAMES_PER_SEC) -> list[str]:
    """Extract JPEG frames from *clip_path* at *fps* and return base64 strings."""
    from src.ffmpeg_paths import resolve_ffmpeg_executable

    tmpdir = tempfile.mkdtemp(prefix="oai_frames_")
    ffmpeg = resolve_ffmpeg_executable()
    pattern = os.path.join(tmpdir, "frame_%04d.jpg")
    subprocess.run(
        [ffmpeg, "-y", "-i", clip_path, "-vf", f"fps={fps}", "-q:v", "2", pattern],
        capture_output=True, timeout=60,
    )
    frames_b64: list[str] = []
    for fpath in sorted(_glob.glob(os.path.join(tmpdir, "frame_*.jpg"))):
        with open(fpath, "rb") as f:
            frames_b64.append(base64.b64encode(f.read()).decode())
        os.unlink(fpath)
    try:
        os.rmdir(tmpdir)
    except OSError:
        pass
    return frames_b64


# ---------------------------------------------------------------------------
# Model dispatch helpers
# ---------------------------------------------------------------------------


def _call_openai_model(
    ref_clip_path: str,
    user_clip_path: str,
    move_windows_text: str,
    model_name: str,
    system_prompt: str,
    pose_priors_text: str | None = None,
) -> dict[str, Any]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set")

    ref_frames = _extract_frames(ref_clip_path)
    user_frames = _extract_frames(user_clip_path)

    if not ref_frames or not user_frames:
        raise RuntimeError("Frame extraction produced no frames — is ffmpeg available?")

    content: list[dict[str, Any]] = []

    content.append({"type": "text", "text": "REFERENCE dance video frames:"})
    for b64 in ref_frames:
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "low"},
        })

    content.append({"type": "text", "text": "USER dance video frames:"})
    for b64 in user_frames:
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "low"},
        })

    if pose_priors_text:
        content.append({"type": "text", "text": pose_priors_text})
    content.append({"type": "text", "text": move_windows_text})

    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": content},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.3,
    }

    with httpx.Client(timeout=300.0, verify=certifi.where()) as client:
        r = client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        if r.status_code != 200:
            body = r.text[:1000]
            raise RuntimeError(f"OpenAI {model_name} returned {r.status_code}: {body}")
        data = r.json()

    return json.loads(data["choices"][0]["message"]["content"])


def _call_model(
    model_name: str,
    ref_clip_path: str,
    user_clip_path: str,
    move_windows_text: str,
    api_key: str | None,
    system_prompt: str,
    pose_priors_text: str | None = None,
) -> dict[str, Any]:
    if model_name.startswith("gpt-"):
        return _call_openai_model(
            ref_clip_path,
            user_clip_path,
            move_windows_text,
            model_name,
            system_prompt,
            pose_priors_text=pose_priors_text,
        )

    from src.gemini_move_feedback import call_gemini_move_feedback

    return call_gemini_move_feedback(
        ref_clip_path,
        user_clip_path,
        move_windows_text,
        api_key=api_key,
        model_name=model_name,
        pose_priors_text=pose_priors_text,
    )


# ---------------------------------------------------------------------------
# Fan-out pipeline (drop-in replacement signature)
# ---------------------------------------------------------------------------


def run_move_feedback_pipeline(
    ref_video_path: str,
    user_video_path: str,
    ebs_artifact: dict[str, Any],
    segment_index: int,
    api_key: str | None = None,
    model_name: str | None = None,
    low_res_height: int | None = None,
    pose_priors: dict[str, Any] | None = None,
    burn_in_labels: bool = True,
    include_audio: bool = False,
) -> dict[str, Any]:
    """Drop-in replacement for ``gemini_move_feedback.run_move_feedback_pipeline``.

    Runs the baseline model synchronously (returned to caller), then spawns a
    background thread that fans out to all remaining ``EVAL_MODELS``.  Every
    result (success or error) is persisted to the evaluations store.
    """
    from src.gemini_move_feedback import (
        LOW_RES_HEIGHT,
        SYSTEM_PROMPT,
        apply_move_feedback_guardrails,
        derive_moves_for_segment,
        format_move_windows,
        format_pose_priors_for_prompt,
        prepare_segment_clip,
    )

    if low_res_height is None:
        low_res_height = LOW_RES_HEIGHT

    alignment = ebs_artifact.get("alignment", {})
    segments = ebs_artifact.get("segments", [])
    if segment_index < 0 or segment_index >= len(segments):
        raise ValueError(f"segment_index {segment_index} out of range (0..{len(segments) - 1})")

    seg = segments[segment_index]
    ref_start = seg.get("clip_1_seg_start_sec", alignment["clip_1_start_sec"] + seg["shared_start_sec"])
    ref_end = seg.get("clip_1_seg_end_sec", alignment["clip_1_start_sec"] + seg["shared_end_sec"])
    user_start = seg.get("clip_2_seg_start_sec", alignment["clip_2_start_sec"] + seg["shared_start_sec"])
    user_end = seg.get("clip_2_seg_end_sec", alignment["clip_2_start_sec"] + seg["shared_end_sec"])

    moves = derive_moves_for_segment(ebs_artifact, segment_index)
    if not moves:
        return {"error": "No moves found in segment", "moves": []}

    move_text, annotated_moves = format_move_windows(moves, seg["shared_start_sec"])
    pose_priors_text = format_pose_priors_for_prompt(pose_priors) if pose_priors else None

    logger.info(
        "Preparing clips for fan-out (%dp) segment=%d ref=[%.4f,%.4f] user=[%.4f,%.4f]",
        low_res_height,
        segment_index,
        ref_start,
        ref_end,
        user_start,
        user_end,
    )
    ref_clip = prepare_segment_clip(
        ref_video_path,
        ref_start,
        ref_end,
        height=low_res_height,
        strip_audio=not include_audio,
        burn_in_text="REFERENCE" if burn_in_labels else None,
    )
    user_clip = prepare_segment_clip(
        user_video_path,
        user_start,
        user_end,
        height=low_res_height,
        strip_audio=not include_audio,
        burn_in_text="USER" if burn_in_labels else None,
    )

    vid = video_id_from_filename(ref_video_path)
    segment_id = f"seg_{segment_index:02d}"

    # ---- helper shared by all models ----
    def _annotate(result: dict[str, Any], mname: str) -> dict[str, Any]:
        for rm in result.get("moves", []):
            idx = rm.get("move_index", 0)
            if 1 <= idx <= len(annotated_moves):
                am = annotated_moves[idx - 1]
                rm["shared_start_sec"] = am["shared_start_sec"]
                rm["shared_end_sec"] = am["shared_end_sec"]
        result["segment_index"] = segment_index
        result["model"] = mname
        return result

    def _run_single(mname: str) -> dict[str, Any]:
        t0 = time.monotonic()
        try:
            raw = _call_model(
                mname,
                ref_clip,
                user_clip,
                move_text,
                api_key,
                SYSTEM_PROMPT,
                pose_priors_text=pose_priors_text,
            )
            latency = int((time.monotonic() - t0) * 1000)
            result = _annotate(raw, mname)
            result = apply_move_feedback_guardrails(result, pose_priors)
            write_evaluation(vid, segment_id, mname, PROMPT_VERSION, latency, result)
            return result
        except Exception as exc:
            latency = int((time.monotonic() - t0) * 1000)
            err = {"error": str(exc)}
            write_evaluation(vid, segment_id, mname, PROMPT_VERSION, latency, err)
            logger.error("Model %s failed for %s/%s: %s", mname, vid, segment_id, exc)
            return err

    # ---- determine models ----
    openai_key = os.environ.get("OPENAI_API_KEY")
    models_to_run = [
        m for m in EVAL_MODELS
        if not (m.startswith("gpt-") and not openai_key)
    ]

    baseline_model = EVAL_MODELS[0]
    other_models = [m for m in models_to_run if m != baseline_model]

    # ---- run baseline synchronously ----
    logger.info("Running baseline model %s for %s/%s", baseline_model, vid, segment_id)
    baseline_result = _run_single(baseline_model)

    # ---- run remaining models sequentially (avoids SSL / timeout contention) ----
    def _background() -> None:
        try:
            for m in other_models:
                try:
                    _run_single(m)
                except Exception:
                    logger.exception("Unexpected failure for model %s", m)
        finally:
            for p in (ref_clip, user_clip):
                try:
                    Path(p).unlink(missing_ok=True)
                except OSError:
                    pass

    if other_models:
        import threading

        threading.Thread(target=_background, daemon=True).start()
    else:
        for p in (ref_clip, user_clip):
            try:
                Path(p).unlink(missing_ok=True)
            except OSError:
                pass

    return baseline_result
