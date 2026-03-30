#!/usr/bin/env python3
"""
FastAPI server for TempoFlow EBS processing.

This is a modern replacement for `ebs_server.py` (http.server) with:
  - POST /api/process  (multipart ref_video + user_video [+ session_id])
  - GET  /api/status?session=<id>
  - GET  /api/result?session=<id>

Run:
  python3 -m pip install -r requirements.txt
  python3 -m pip install fastapi uvicorn python-multipart
  uvicorn ebs_fastapi_server:app --host 127.0.0.1 --port 8787
"""

from __future__ import annotations

import json
import logging
import math
import uuid
import asyncio
import threading
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from ebs_ffmpeg_paths import resolve_ffprobe_executable
from ebs_gemini_move_feedback import run_move_feedback_pipeline
from ebs_segment import auto_align, extract_audio_from_video, load_audio, run_ebs_pipeline

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("ebs-fastapi")

app = FastAPI(title="TempoFlow EBS Service", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


SESSION_STATUS: dict[str, str] = {}
SESSION_RESULTS: dict[str, dict[str, Any]] = {}

# Overlay job tracking for real-time progress polling
OVERLAY_JOBS: dict[str, dict[str, Any]] = {}


def _sanitize_json(obj: Any) -> Any:
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _sanitize_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_json(v) for v in obj]
    return obj


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
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"ffprobe not found ({ffprobe_exe}). Install FFmpeg, add to PATH, "
            "or set EBS_FFPROBE_PATH."
        ) from exc
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr.strip()}")

    payload = json.loads(result.stdout or "{}")
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


def _save_upload(upload: UploadFile, prefix: str) -> str:
    suffix = Path(upload.filename or "video.mp4").suffix or ".mp4"
    tmp = tempfile.NamedTemporaryFile(prefix=f"ebs_{prefix}_", suffix=suffix, delete=False)
    try:
        data = upload.file.read()
        tmp.write(data)
    finally:
        tmp.close()
    return tmp.name


@app.post("/api/process")
async def process(
    ref_video: UploadFile = File(...),
    user_video: UploadFile = File(...),
    session_id: str | None = Form(default=None),
):
    sid = (session_id or "").strip() or "default"
    SESSION_STATUS[sid] = "processing"
    logger.info("Received video files — running EBS pipeline (session=%s)", sid)

    ref_tmp = _save_upload(ref_video, "ref")
    user_tmp = _save_upload(user_video, "user")
    ref_wav: str | None = None
    user_wav: str | None = None

    try:
        logger.info("Extracting audio…")
        ref_wav = extract_audio_from_video(ref_tmp)
        user_wav = extract_audio_from_video(user_tmp)

        logger.info("Auto-align…")
        ref_audio = load_audio(ref_wav)
        user_audio = load_audio(user_wav)
        alignment = auto_align(ref_audio, user_audio)

        logger.info("EBS segmentation…")
        artifact = run_ebs_pipeline(
            ref_audio_path=ref_wav,
            alignment=alignment,
            user_audio_path=user_wav,
        )

        try:
            artifact["video_meta"] = {
                "clip_1": probe_video_metadata(ref_tmp),
                "clip_2": probe_video_metadata(user_tmp),
            }
        except Exception as probe_exc:
            logger.warning("Video probe failed: %s", probe_exc)

        payload = _sanitize_json(artifact)
        SESSION_RESULTS[sid] = payload
        SESSION_STATUS[sid] = "done"
        return JSONResponse(payload, status_code=200)

    except Exception as exc:
        logger.exception("Pipeline error")
        SESSION_STATUS[sid] = "error"
        return JSONResponse({"error": str(exc)}, status_code=500)

    finally:
        for p in [ref_tmp, user_tmp, ref_wav, user_wav]:
            if not p:
                continue
            try:
                Path(p).unlink(missing_ok=True)
            except OSError:
                pass


@app.get("/api/status")
async def status(session: str | None = None):
    sid = (session or "").strip() or "default"
    st = SESSION_STATUS.get(sid, "idle")
    has_result = sid in SESSION_RESULTS
    segment_count = None
    if has_result:
        try:
            segment_count = len(SESSION_RESULTS[sid].get("segments") or [])
        except Exception:
            segment_count = None
    return {"session": sid, "status": st, "has_result": has_result, "segment_count": segment_count}


@app.get("/api/result")
async def result(session: str | None = None):
    sid = (session or "").strip() or "default"
    if sid not in SESSION_RESULTS:
        return JSONResponse({"error": "No result for this session yet."}, status_code=404)
    return JSONResponse(SESSION_RESULTS[sid], status_code=200)


# ---------------------------------------------------------------------------
# Gemini micro-timing move feedback
# ---------------------------------------------------------------------------

MOVE_FEEDBACK_JOBS: dict[str, dict[str, Any]] = {}


def _move_feedback_worker(
    job_id: str,
    ref_path: str,
    user_path: str,
    ebs_data: dict,
    segment_index: int,
) -> None:
    """Background worker that runs the Gemini move-feedback pipeline."""
    try:
        MOVE_FEEDBACK_JOBS[job_id]["status"] = "processing"
        result = run_move_feedback_pipeline(
            ref_video_path=ref_path,
            user_video_path=user_path,
            ebs_artifact=ebs_data,
            segment_index=segment_index,
        )
        MOVE_FEEDBACK_JOBS[job_id]["result"] = result
        MOVE_FEEDBACK_JOBS[job_id]["status"] = "done"
    except Exception as exc:
        logger.exception("Move feedback pipeline error (job %s)", job_id)
        MOVE_FEEDBACK_JOBS[job_id]["status"] = "error"
        MOVE_FEEDBACK_JOBS[job_id]["error"] = str(exc)
    finally:
        for p in (ref_path, user_path):
            try:
                Path(p).unlink(missing_ok=True)
            except OSError:
                pass


@app.post("/api/move-feedback/start")
async def move_feedback_start(
    ref_video: UploadFile = File(...),
    user_video: UploadFile = File(...),
    segment_index: int = Form(...),
    session_id: str | None = Form(default=None),
    ebs_data_json: str | None = Form(default=None),
):
    """Start an async Gemini move-feedback job for a single EBS segment.

    Accepts the original reference and user videos plus either:
      - ``ebs_data_json``: the full EBS artifact as a JSON string, **or**
      - ``session_id``: reuse the EBS result already stored from a prior
        ``/api/process`` call.

    If neither is supplied, the EBS pipeline runs automatically.

    Returns ``{"job_id": "..."}`` immediately. Poll
    ``GET /api/move-feedback/status?job_id=<id>`` for progress,
    then ``GET /api/move-feedback/result?job_id=<id>`` to retrieve
    the Gemini micro-timing JSON.
    """
    sid = (session_id or "").strip() or "default"
    job_id = str(uuid.uuid4())

    ref_tmp = _save_upload(ref_video, "mf_ref")
    user_tmp = _save_upload(user_video, "mf_user")

    ebs_data: dict | None = None

    if ebs_data_json:
        try:
            ebs_data = json.loads(ebs_data_json)
        except json.JSONDecodeError:
            return JSONResponse(
                {"error": "ebs_data_json is not valid JSON"}, status_code=400
            )

    if ebs_data is None and sid in SESSION_RESULTS:
        ebs_data = SESSION_RESULTS[sid]

    if ebs_data is None:
        try:
            ref_wav = extract_audio_from_video(ref_tmp)
            user_wav = extract_audio_from_video(user_tmp)
            ref_audio = load_audio(ref_wav)
            user_audio = load_audio(user_wav)
            alignment = auto_align(ref_audio, user_audio)
            ebs_data = run_ebs_pipeline(
                ref_audio_path=ref_wav,
                alignment=alignment,
                user_audio_path=user_wav,
            )
            for p in (ref_wav, user_wav):
                try:
                    Path(p).unlink(missing_ok=True)
                except OSError:
                    pass
        except Exception as exc:
            for p in (ref_tmp, user_tmp):
                try:
                    Path(p).unlink(missing_ok=True)
                except OSError:
                    pass
            return JSONResponse(
                {"error": f"EBS pipeline failed: {exc}"}, status_code=500
            )

    n_segments = len(ebs_data.get("segments", []))
    if segment_index < 0 or segment_index >= n_segments:
        for p in (ref_tmp, user_tmp):
            try:
                Path(p).unlink(missing_ok=True)
            except OSError:
                pass
        return JSONResponse(
            {"error": f"segment_index {segment_index} out of range (0..{n_segments - 1})"},
            status_code=400,
        )

    MOVE_FEEDBACK_JOBS[job_id] = {
        "status": "queued",
        "result": None,
        "error": None,
        "session_id": sid,
        "segment_index": segment_index,
    }

    t = threading.Thread(
        target=_move_feedback_worker,
        args=(job_id, ref_tmp, user_tmp, ebs_data, segment_index),
        daemon=True,
    )
    t.start()

    return JSONResponse({"job_id": job_id}, status_code=200)


@app.post("/api/move-feedback")
async def move_feedback_sync(
    ref_video: UploadFile = File(...),
    user_video: UploadFile = File(...),
    segment_index: int = Form(...),
    session_id: str | None = Form(default=None),
    ebs_data_json: str | None = Form(default=None),
):
    """Synchronous variant — blocks until Gemini returns the feedback JSON.

    Same parameter semantics as ``/api/move-feedback/start``.
    """
    sid = (session_id or "").strip() or "default"

    ref_tmp = _save_upload(ref_video, "mf_ref")
    user_tmp = _save_upload(user_video, "mf_user")

    ebs_data: dict | None = None

    if ebs_data_json:
        try:
            ebs_data = json.loads(ebs_data_json)
        except json.JSONDecodeError:
            return JSONResponse(
                {"error": "ebs_data_json is not valid JSON"}, status_code=400
            )

    if ebs_data is None and sid in SESSION_RESULTS:
        ebs_data = SESSION_RESULTS[sid]

    if ebs_data is None:
        try:
            ref_wav = extract_audio_from_video(ref_tmp)
            user_wav = extract_audio_from_video(user_tmp)
            ref_audio = load_audio(ref_wav)
            user_audio = load_audio(user_wav)
            alignment = auto_align(ref_audio, user_audio)
            ebs_data = run_ebs_pipeline(
                ref_audio_path=ref_wav,
                alignment=alignment,
                user_audio_path=user_wav,
            )
            for p in (ref_wav, user_wav):
                try:
                    Path(p).unlink(missing_ok=True)
                except OSError:
                    pass
        except Exception as exc:
            for p in (ref_tmp, user_tmp):
                try:
                    Path(p).unlink(missing_ok=True)
                except OSError:
                    pass
            return JSONResponse(
                {"error": f"EBS pipeline failed: {exc}"}, status_code=500
            )

    try:
        feedback = await asyncio.to_thread(
            run_move_feedback_pipeline,
            ref_video_path=ref_tmp,
            user_video_path=user_tmp,
            ebs_artifact=ebs_data,
            segment_index=segment_index,
        )
        return JSONResponse(feedback, status_code=200)
    except Exception as exc:
        logger.exception("Move feedback error")
        return JSONResponse({"error": str(exc)}, status_code=500)
    finally:
        for p in (ref_tmp, user_tmp):
            try:
                Path(p).unlink(missing_ok=True)
            except OSError:
                pass


@app.get("/api/move-feedback/status")
async def move_feedback_status(job_id: str):
    job = MOVE_FEEDBACK_JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    return {
        "job_id": job_id,
        "status": job.get("status", "unknown"),
        "segment_index": job.get("segment_index"),
        "error": job.get("error"),
    }


@app.get("/api/move-feedback/result")
async def move_feedback_result(job_id: str):
    job = MOVE_FEEDBACK_JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    if job.get("status") != "done":
        return JSONResponse(
            {"error": "Job not ready", "status": job.get("status")},
            status_code=409,
        )
    result = job.pop("result", {})
    MOVE_FEEDBACK_JOBS.pop(job_id, None)
    return JSONResponse(result, status_code=200)


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = (hex_color or "#38bdf8").strip().lstrip("#")
    if len(h) == 3:
        h = "".join([c * 2 for c in h])
    if len(h) != 6:
        return (56, 189, 248)
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


@app.post("/api/overlay/yolo")
async def overlay_yolo(
    background_tasks: BackgroundTasks,
    video: UploadFile = File(...),
    color: str = Form(default="#38bdf8"),
    fps: int = Form(default=12),
    session_id: str | None = Form(default=None),
    side: str | None = Form(default=None),
    backend: str = Form(default="wasm"),
):
    """
    Generate a transparent overlay video (WebM VP9 w/ alpha) for dancer segmentation.

    Notes:
      - Uses Ultralytics YOLO segmentation (person class only).
      - Returns `video/webm` with alpha channel.
    """
    sid = (session_id or "").strip() or "default"
    _ = side  # reserved for logging/caching later
    _ = backend  # reserved for future GPU selection

    # Dependency check happens once in the request thread; the heavy lifting is done in a worker thread.
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
        from ultralytics import YOLO  # type: ignore
    except Exception as exc:
        return JSONResponse(
            {"error": f"Missing overlay deps. Install ultralytics + opencv-python. Details: {exc}"},
            status_code=500,
        )

    # Resolve weights from repo (web-app/public/models/yolo26n-seg.pt)
    weights = (
        Path(__file__).resolve().parents[3] / "web-app" / "public" / "models" / "yolo26n-seg.pt"
    ).resolve()
    if not weights.exists():
        return JSONResponse({"error": f"YOLO weights not found at {weights}"}, status_code=500)

    tmp_in = _save_upload(video, "overlay")
    tmp_out = tempfile.NamedTemporaryFile(prefix="overlay_", suffix=".webm", delete=False).name

    def worker() -> None:
        cap = cv2.VideoCapture(tmp_in)
        if not cap.isOpened():
            raise RuntimeError("Failed to open video.")

        src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 640)
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 480)

        out_fps_local = max(1, int(fps))
        out_dt_local = 1.0 / float(out_fps_local)

        try:
            meta = probe_video_metadata(tmp_in)
            duration_sec = float(meta.get("duration_sec") or 0.0)
        except Exception:
            duration_sec = 0.0

        expected_frames_local = None
        if duration_sec > 0:
            expected_frames_local = max(1, int(math.ceil(duration_sec * out_fps_local)))

        logger.info(
            "YOLO overlay (session=%s) %dx%d src_fps=%.2f → out_fps=%d",
            sid,
            w,
            h,
            src_fps,
            out_fps_local,
        )

        model = YOLO(str(weights))
        r0, g0, b0 = _hex_to_rgb(color)

        fourcc = cv2.VideoWriter_fourcc(*"VP90")
        writer = cv2.VideoWriter(tmp_out, fourcc, out_fps_local, (w, h))
        if not writer.isOpened():
            raise RuntimeError("Failed to open VideoWriter for overlay.")

        written_frames_local = 0
        last_overlay_local = None

        next_out_time_local = 0.0
        last_frame_time_local = 0.0

        while True:
            ok, frame_bgr = cap.read()
            if not ok:
                break

            try:
                frame_time_sec_local = float(cap.get(cv2.CAP_PROP_POS_MSEC) or 0.0) / 1000.0
            except Exception:
                frame_time_sec_local = last_frame_time_local + out_dt_local
            last_frame_time_local = frame_time_sec_local

            if frame_time_sec_local + (out_dt_local * 0.25) < next_out_time_local:
                continue

            # Tune for dancer overlays: include thinner hand regions.
            results = model.predict(
                frame_bgr, imgsz=768, conf=0.12, iou=0.5, classes=[0], verbose=False
            )

            alpha_u8 = np.zeros((h, w), dtype=np.uint8)
            if results and results[0].masks is not None:
                m = results[0].masks.data
                mm = m.detach().cpu().numpy()  # type: ignore[attr-defined]
                alpha = np.max(mm, axis=0).astype(np.float32)
                alpha = np.clip(alpha, 0.0, 1.0)
                if alpha.shape[0] != h or alpha.shape[1] != w:
                    alpha = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_CUBIC)
                # Reduce blur to preserve hand/finger edges while still smoothing.
                alpha = cv2.GaussianBlur(alpha, (0, 0), sigmaX=0.9, sigmaY=0.9)
                alpha_u8 = (alpha * 255.0).astype(np.uint8)

            overlay = np.zeros((h, w, 3), dtype=np.uint8)
            overlay[..., 0] = (alpha_u8.astype(np.uint16) * b0 // 255).astype(np.uint8)
            overlay[..., 1] = (alpha_u8.astype(np.uint16) * g0 // 255).astype(np.uint8)
            overlay[..., 2] = (alpha_u8.astype(np.uint16) * r0 // 255).astype(np.uint8)

            slack_local = out_dt_local * 0.25
            dup_count_local = 1
            if frame_time_sec_local + slack_local > next_out_time_local:
                dup_count_local = int(
                    math.floor(
                        (frame_time_sec_local + slack_local - next_out_time_local) / out_dt_local
                    )
                ) + 1
                dup_count_local = max(1, dup_count_local)

            if expected_frames_local is not None:
                remaining_local = expected_frames_local - written_frames_local
                if remaining_local <= 0:
                    break
                dup_count_local = min(dup_count_local, remaining_local)

            for _ in range(dup_count_local):
                writer.write(overlay)
                last_overlay_local = overlay
                written_frames_local += 1
                next_out_time_local += out_dt_local
                if expected_frames_local is not None and written_frames_local >= expected_frames_local:
                    break

        cap.release()

        if expected_frames_local is not None and written_frames_local < expected_frames_local:
            if last_overlay_local is None:
                last_overlay_local = np.zeros((h, w, 3), dtype=np.uint8)
            pad_count_local = expected_frames_local - written_frames_local
            for _ in range(pad_count_local):
                writer.write(last_overlay_local)
            written_frames_local = expected_frames_local

        writer.release()

    try:
        await asyncio.to_thread(worker)
        background_tasks.add_task(lambda: Path(tmp_in).unlink(missing_ok=True))
        background_tasks.add_task(lambda: Path(tmp_out).unlink(missing_ok=True))

        return FileResponse(
            path=tmp_out,
            media_type="video/webm",
            filename=f"{sid}_yolo_overlay.webm",
        )
    except Exception as exc:
        logger.exception("YOLO overlay error")
        return JSONResponse({"error": str(exc)}, status_code=500)

def _expected_frames(duration_sec: float, out_fps: int) -> int:
    if duration_sec and duration_sec > 0:
        return max(1, int(math.ceil(duration_sec * out_fps)))
    return 1


def _resolve_segment_window(
    duration_sec: float,
    start_sec: float | None,
    end_sec: float | None,
) -> tuple[float, float]:
    segment_start = max(0.0, float(start_sec or 0.0))

    if end_sec is None:
        segment_end = duration_sec if duration_sec > 0 else segment_start + 1.0
    else:
        segment_end = max(segment_start, float(end_sec))
        if duration_sec > 0:
            segment_end = min(segment_end, duration_sec)

    return segment_start, segment_end


def _yolo_overlay_job_worker(
    job_id: str,
    tmp_in: str,
    tmp_out: str,
    color: str,
    fps: int,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> None:
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
        from ultralytics import YOLO  # type: ignore
    except Exception as exc:
        OVERLAY_JOBS[job_id]["status"] = "error"
        OVERLAY_JOBS[job_id]["error"] = f"Missing overlay deps: {exc}"
        return

    weights = (
        Path(__file__).resolve().parents[3] / "web-app" / "public" / "models" / "yolo26n-seg.pt"
    ).resolve()
    if not weights.exists():
        OVERLAY_JOBS[job_id]["status"] = "error"
        OVERLAY_JOBS[job_id]["error"] = f"YOLO weights not found at {weights}"
        return

    cap = cv2.VideoCapture(tmp_in)
    if not cap.isOpened():
        OVERLAY_JOBS[job_id]["status"] = "error"
        OVERLAY_JOBS[job_id]["error"] = "Failed to open video."
        return

    out_fps_local = max(1, int(fps))
    out_dt_local = 1.0 / float(out_fps_local)

    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 640)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 480)

    try:
        meta = probe_video_metadata(tmp_in)
        duration_sec = float(meta.get("duration_sec") or 0.0)
    except Exception:
        duration_sec = 0.0

    segment_start_sec, segment_end_sec = _resolve_segment_window(duration_sec, start_sec, end_sec)
    segment_duration_sec = segment_end_sec - segment_start_sec
    if segment_duration_sec <= 0:
        OVERLAY_JOBS[job_id]["status"] = "error"
        OVERLAY_JOBS[job_id]["error"] = "Overlay segment duration must be greater than 0."
        cap.release()
        return

    if segment_start_sec > 0:
        try:
            cap.set(cv2.CAP_PROP_POS_MSEC, segment_start_sec * 1000.0)
        except Exception:
            pass

    expected = _expected_frames(segment_duration_sec, out_fps_local)

    OVERLAY_JOBS[job_id]["frames_expected"] = expected
    OVERLAY_JOBS[job_id]["frames_written"] = 0
    OVERLAY_JOBS[job_id]["progress"] = 0.0
    OVERLAY_JOBS[job_id]["status"] = "processing"

    model = YOLO(str(weights))
    r0, g0, b0 = _hex_to_rgb(color)

    fourcc = cv2.VideoWriter_fourcc(*"VP90")
    writer = cv2.VideoWriter(tmp_out, fourcc, out_fps_local, (w, h))
    if not writer.isOpened():
        OVERLAY_JOBS[job_id]["status"] = "error"
        OVERLAY_JOBS[job_id]["error"] = "Failed to open VideoWriter."
        return

    written = 0
    next_out_time = 0.0
    last_frame_time = 0.0
    last_overlay = None

    while True:
        ok, frame_bgr = cap.read()
        if not ok:
            break

        try:
            abs_t = float(cap.get(cv2.CAP_PROP_POS_MSEC) or 0.0) / 1000.0
        except Exception:
            abs_t = last_frame_time + out_dt_local
        last_frame_time = abs_t

        rel_t = max(0.0, abs_t - segment_start_sec)
        if rel_t > segment_duration_sec + (out_dt_local * 0.25):
            break

        if rel_t + (out_dt_local * 0.25) < next_out_time:
            continue

        # Tune for dancer overlays: include thinner hand regions.
        results = model.predict(frame_bgr, imgsz=768, conf=0.12, iou=0.5, classes=[0], verbose=False)

        alpha_u8 = np.zeros((h, w), dtype=np.uint8)
        if results and results[0].masks is not None:
            m = results[0].masks.data
            mm = m.detach().cpu().numpy()  # type: ignore[attr-defined]
            alpha = np.max(mm, axis=0).astype(np.float32)
            alpha = np.clip(alpha, 0.0, 1.0)
            if alpha.shape[0] != h or alpha.shape[1] != w:
                alpha = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_CUBIC)
            # Reduce blur to preserve hand/finger edges while still smoothing.
            alpha = cv2.GaussianBlur(alpha, (0, 0), sigmaX=0.9, sigmaY=0.9)
            alpha_u8 = (alpha * 255.0).astype(np.uint8)

        overlay = np.zeros((h, w, 3), dtype=np.uint8)
        overlay[..., 0] = (alpha_u8.astype(np.uint16) * b0 // 255).astype(np.uint8)
        overlay[..., 1] = (alpha_u8.astype(np.uint16) * g0 // 255).astype(np.uint8)
        overlay[..., 2] = (alpha_u8.astype(np.uint16) * r0 // 255).astype(np.uint8)
        last_overlay = overlay

        slack = out_dt_local * 0.25
        dup_count = 1
        if rel_t + slack > next_out_time:
            dup_count = int(math.floor((rel_t + slack - next_out_time) / out_dt_local)) + 1
            dup_count = max(1, dup_count)

        remaining = expected - written
        if remaining <= 0:
            break
        dup_count = min(dup_count, remaining)

        for _ in range(dup_count):
            writer.write(overlay)
            written += 1
            next_out_time += out_dt_local
            OVERLAY_JOBS[job_id]["frames_written"] = written
            OVERLAY_JOBS[job_id]["progress"] = min(1.0, written / float(expected))
            if written >= expected:
                break

        if written >= expected:
            break

    # Pad if needed
    if written < expected and last_overlay is not None:
        for _ in range(expected - written):
            writer.write(last_overlay)
        written = expected
        OVERLAY_JOBS[job_id]["frames_written"] = written
        OVERLAY_JOBS[job_id]["progress"] = 1.0

    cap.release()
    writer.release()
    OVERLAY_JOBS[job_id]["status"] = "done"


@app.post("/api/overlay/yolo/start")
async def overlay_yolo_start(
    video: UploadFile = File(...),
    color: str = Form(default="#38bdf8"),
    fps: int = Form(default=12),
    session_id: str | None = Form(default=None),
    side: str | None = Form(default=None),
    backend: str = Form(default="wasm"),
    start_sec: float | None = Form(default=None),
    end_sec: float | None = Form(default=None),
):
    _ = backend
    sid = (session_id or "").strip() or "default"
    side_val = (side or "").strip() or "unknown"
    job_id = str(uuid.uuid4())

    tmp_in = _save_upload(video, f"overlay_{side_val}_{job_id}")
    tmp_out = tempfile.NamedTemporaryFile(prefix=f"overlay_{side_val}_{job_id}_", suffix=".webm", delete=False).name

    OVERLAY_JOBS[job_id] = {
        "status": "queued",
        "progress": 0.0,
        "frames_written": 0,
        "frames_expected": None,
        "tmp_in": tmp_in,
        "tmp_out": tmp_out,
        "session_id": sid,
        "side": side_val,
        "start_sec": start_sec,
        "end_sec": end_sec,
        "error": None,
    }

    t = threading.Thread(
        target=_yolo_overlay_job_worker,
        args=(job_id, tmp_in, tmp_out, color, fps, start_sec, end_sec),
        daemon=True,
    )
    t.start()

    return JSONResponse({"job_id": job_id}, status_code=200)


@app.get("/api/overlay/yolo/status")
async def overlay_yolo_status(job_id: str):
    job = OVERLAY_JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    return {
        "job_id": job_id,
        "status": job.get("status", "unknown"),
        "progress": float(job.get("progress", 0.0) or 0.0),
        "frames_written": job.get("frames_written"),
        "frames_expected": job.get("frames_expected"),
        "error": job.get("error"),
    }


@app.get("/api/overlay/yolo/result")
async def overlay_yolo_result(job_id: str, background_tasks: BackgroundTasks):
    job = OVERLAY_JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    if job.get("status") != "done":
        return JSONResponse({"error": "Job not ready"}, status_code=409)

    tmp_out = job.get("tmp_out")
    tmp_in = job.get("tmp_in")
    if not tmp_out:
        return JSONResponse({"error": "Missing output"}, status_code=500)

    background_tasks.add_task(lambda: Path(tmp_out).unlink(missing_ok=True))
    if tmp_in:
        background_tasks.add_task(lambda: Path(tmp_in).unlink(missing_ok=True))
    OVERLAY_JOBS.pop(job_id, None)

    return FileResponse(path=tmp_out, media_type="video/webm", filename=f"{job_id}_yolo_overlay.webm")


POSE_JOBS: dict[str, dict[str, Any]] = {}


def _visible_pose_point(
    xy: Any, conf: Any, idx: int, threshold: float = 0.25
) -> tuple[int, int] | None:
    try:
        if idx >= len(xy):
            return None
        score = float(conf[idx]) if conf is not None and idx < len(conf) else 1.0
        if score < threshold:
            return None
        point = xy[idx]
        return (int(round(float(point[0]))), int(round(float(point[1]))))
    except Exception:
        return None


def _scaled_bgr(color_hex: str, scale: float) -> tuple[int, int, int]:
    r, g, b = _hex_to_rgb(color_hex)
    scale = max(0.0, min(1.0, scale))
    return (
        int(round(b * scale)),
        int(round(g * scale)),
        int(round(r * scale)),
    )


def _draw_pose_circle(
    overlay: Any,
    center: tuple[int, int] | None,
    radius: int,
    color_bgr: tuple[int, int, int],
) -> None:
    if center is None or radius <= 0:
        return
    import cv2  # type: ignore

    cv2.circle(overlay, center, radius, color_bgr, thickness=-1, lineType=cv2.LINE_AA)


def _draw_pose_segment(
    overlay: Any,
    start: tuple[int, int] | None,
    end: tuple[int, int] | None,
    width: int,
    color_bgr: tuple[int, int, int],
) -> None:
    if start is None or end is None or width <= 0:
        return
    import cv2  # type: ignore

    cv2.line(overlay, start, end, color_bgr, thickness=width, lineType=cv2.LINE_AA)
    joint_r = max(2, int(round(width * 0.42)))
    cv2.circle(overlay, start, joint_r, color_bgr, thickness=-1, lineType=cv2.LINE_AA)
    cv2.circle(overlay, end, joint_r, color_bgr, thickness=-1, lineType=cv2.LINE_AA)


def _draw_pose_torso_head(
    overlay: Any,
    xy: Any,
    conf: Any,
    color_hex: str,
    shoulder_width: float,
    intensity: float = 0.5,
) -> None:
    import cv2  # type: ignore
    import numpy as np  # type: ignore

    ls = _visible_pose_point(xy, conf, 5)
    rs = _visible_pose_point(xy, conf, 6)
    lh = _visible_pose_point(xy, conf, 11)
    rh = _visible_pose_point(xy, conf, 12)
    nose = _visible_pose_point(xy, conf, 0, threshold=0.2)

    fill = _scaled_bgr(color_hex, 0.28 * intensity)
    edge = _scaled_bgr(color_hex, 0.52 * intensity)
    glow = _scaled_bgr(color_hex, 0.18 * intensity)

    if ls and rs and lh and rh:
        pts = np.array([ls, rs, rh, lh], dtype=np.int32)
        cv2.fillConvexPoly(overlay, pts, fill, lineType=cv2.LINE_AA)

    if nose is not None:
        head_radius = max(int(round(shoulder_width * 0.28)), 18)
        cv2.circle(
            overlay,
            nose,
            max(2, int(round(head_radius * 1.15))),
            glow,
            thickness=-1,
            lineType=cv2.LINE_AA,
        )
        cv2.circle(overlay, nose, head_radius, edge, thickness=-1, lineType=cv2.LINE_AA)

    torso_r = max(int(round(max(shoulder_width * 0.25, 10) * intensity)), 6)
    _draw_pose_circle(overlay, ls, torso_r, edge)
    _draw_pose_circle(overlay, rs, torso_r, edge)
    _draw_pose_circle(overlay, lh, torso_r, edge)
    _draw_pose_circle(overlay, rh, torso_r, edge)


def _render_pose_layers(
    xy: Any,
    conf: Any,
    w: int,
    h: int,
    arms_color: str,
    legs_color: str,
) -> tuple[Any, Any]:
    import numpy as np  # type: ignore

    arms_overlay = np.zeros((h, w, 3), dtype=np.uint8)
    legs_overlay = np.zeros((h, w, 3), dtype=np.uint8)

    ls = _visible_pose_point(xy, conf, 5)
    rs = _visible_pose_point(xy, conf, 6)
    lh = _visible_pose_point(xy, conf, 11)
    rh = _visible_pose_point(xy, conf, 12)

    if ls and rs:
        shoulder_width = math.hypot(ls[0] - rs[0], ls[1] - rs[1])
    else:
        shoulder_width = 60.0

    limb_width = max(int(round(shoulder_width * 0.7)), 18)
    arm_edge = _scaled_bgr(arms_color, 0.78)
    leg_edge = _scaled_bgr(legs_color, 0.78)

    # Shared torso/head at half intensity in both layers.
    _draw_pose_torso_head(arms_overlay, xy, conf, arms_color, shoulder_width, intensity=0.5)
    _draw_pose_torso_head(legs_overlay, xy, conf, legs_color, shoulder_width, intensity=0.5)

    # Arms: shoulder -> elbow -> wrist
    _draw_pose_segment(arms_overlay, ls, _visible_pose_point(xy, conf, 7), limb_width, arm_edge)
    _draw_pose_segment(
        arms_overlay,
        _visible_pose_point(xy, conf, 7),
        _visible_pose_point(xy, conf, 9),
        max(int(round(limb_width * 0.86)), 10),
        arm_edge,
    )
    _draw_pose_segment(arms_overlay, rs, _visible_pose_point(xy, conf, 8), limb_width, arm_edge)
    _draw_pose_segment(
        arms_overlay,
        _visible_pose_point(xy, conf, 8),
        _visible_pose_point(xy, conf, 10),
        max(int(round(limb_width * 0.86)), 10),
        arm_edge,
    )

    # Legs: hip -> knee -> ankle
    _draw_pose_segment(legs_overlay, lh, _visible_pose_point(xy, conf, 13), int(round(limb_width * 1.05)), leg_edge)
    _draw_pose_segment(
        legs_overlay,
        _visible_pose_point(xy, conf, 13),
        _visible_pose_point(xy, conf, 15),
        max(int(round(limb_width * 0.9)), 10),
        leg_edge,
    )
    _draw_pose_segment(legs_overlay, rh, _visible_pose_point(xy, conf, 14), int(round(limb_width * 1.05)), leg_edge)
    _draw_pose_segment(
        legs_overlay,
        _visible_pose_point(xy, conf, 14),
        _visible_pose_point(xy, conf, 16),
        max(int(round(limb_width * 0.9)), 10),
        leg_edge,
    )

    return arms_overlay, legs_overlay


def _yolo_pose_job_worker(
    job_id: str,
    tmp_in: str,
    arms_out: str,
    legs_out: str,
    arms_color: str,
    legs_color: str,
    fps: int,
) -> None:
    try:
        import cv2  # type: ignore
        from ultralytics import YOLO  # type: ignore
    except Exception as exc:
        POSE_JOBS[job_id]["status"] = "error"
        POSE_JOBS[job_id]["error"] = f"Missing pose deps: {exc}"
        return

    weights = (
        Path(__file__).resolve().parents[3] / "web-app" / "public" / "models" / "yolo26n-pose.pt"
    ).resolve()
    if not weights.exists():
        POSE_JOBS[job_id]["status"] = "error"
        POSE_JOBS[job_id]["error"] = f"YOLO pose weights not found at {weights}"
        return

    cap = cv2.VideoCapture(tmp_in)
    if not cap.isOpened():
        POSE_JOBS[job_id]["status"] = "error"
        POSE_JOBS[job_id]["error"] = "Failed to open video."
        return

    out_fps_local = max(1, int(fps))
    out_dt_local = 1.0 / float(out_fps_local)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 640)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 480)

    try:
        meta = probe_video_metadata(tmp_in)
        duration_sec = float(meta.get("duration_sec") or 0.0)
    except Exception:
        duration_sec = 0.0
    expected = _expected_frames(duration_sec, out_fps_local)

    POSE_JOBS[job_id]["frames_expected"] = expected
    POSE_JOBS[job_id]["frames_written"] = 0
    POSE_JOBS[job_id]["progress"] = 0.0
    POSE_JOBS[job_id]["status"] = "processing"

    model = YOLO(str(weights))

    fourcc = cv2.VideoWriter_fourcc(*"VP90")
    arms_writer = cv2.VideoWriter(arms_out, fourcc, out_fps_local, (w, h))
    legs_writer = cv2.VideoWriter(legs_out, fourcc, out_fps_local, (w, h))
    if not arms_writer.isOpened() or not legs_writer.isOpened():
        POSE_JOBS[job_id]["status"] = "error"
        POSE_JOBS[job_id]["error"] = "Failed to open VideoWriter for pose overlay."
        return

    written = 0
    next_out_time = 0.0
    last_frame_time = 0.0
    last_arms = None
    last_legs = None

    while True:
        ok, frame_bgr = cap.read()
        if not ok:
            break

        try:
            t = float(cap.get(cv2.CAP_PROP_POS_MSEC) or 0.0) / 1000.0
        except Exception:
            t = last_frame_time + out_dt_local
        last_frame_time = t

        if t + (out_dt_local * 0.25) < next_out_time:
            continue

        results = model.predict(frame_bgr, imgsz=768, conf=0.2, iou=0.5, verbose=False)
        arms_overlay = None
        legs_overlay = None

        if results and getattr(results[0], "keypoints", None) is not None:
            keypoints = results[0].keypoints
            xy_all = keypoints.xy
            conf_all = getattr(keypoints, "conf", None)

            if xy_all is not None and len(xy_all) > 0:
                xy = xy_all[0].detach().cpu().numpy()  # type: ignore[attr-defined]
                conf = conf_all[0].detach().cpu().numpy() if conf_all is not None and len(conf_all) > 0 else None  # type: ignore[attr-defined]
                arms_overlay, legs_overlay = _render_pose_layers(xy, conf, w, h, arms_color, legs_color)

        if arms_overlay is None or legs_overlay is None:
            import numpy as np  # type: ignore

            arms_overlay = np.zeros((h, w, 3), dtype=np.uint8)
            legs_overlay = np.zeros((h, w, 3), dtype=np.uint8)

        last_arms = arms_overlay
        last_legs = legs_overlay

        slack = out_dt_local * 0.25
        dup_count = 1
        if t + slack > next_out_time:
            dup_count = int(math.floor((t + slack - next_out_time) / out_dt_local)) + 1
            dup_count = max(1, dup_count)

        remaining = expected - written
        if remaining <= 0:
            break
        dup_count = min(dup_count, remaining)

        for _ in range(dup_count):
            arms_writer.write(arms_overlay)
            legs_writer.write(legs_overlay)
            written += 1
            next_out_time += out_dt_local
            POSE_JOBS[job_id]["frames_written"] = written
            POSE_JOBS[job_id]["progress"] = min(1.0, written / float(expected))
            if written >= expected:
                break

        if written >= expected:
            break

    if written < expected and last_arms is not None and last_legs is not None:
        for _ in range(expected - written):
            arms_writer.write(last_arms)
            legs_writer.write(last_legs)
        written = expected
        POSE_JOBS[job_id]["frames_written"] = written
        POSE_JOBS[job_id]["progress"] = 1.0

    cap.release()
    arms_writer.release()
    legs_writer.release()
    POSE_JOBS[job_id]["status"] = "done"


@app.post("/api/overlay/yolo-pose/start")
async def overlay_yolo_pose_start(
    video: UploadFile = File(...),
    arms_color: str = Form(default="#38bdf8"),
    legs_color: str = Form(default="#6366f1"),
    fps: int = Form(default=12),
    session_id: str | None = Form(default=None),
    side: str | None = Form(default=None),
):
    sid = (session_id or "").strip() or "default"
    side_val = (side or "").strip() or "unknown"
    job_id = str(uuid.uuid4())

    tmp_in = _save_upload(video, f"pose_{side_val}_{job_id}")
    arms_out = tempfile.NamedTemporaryFile(prefix=f"pose_arms_{side_val}_{job_id}_", suffix=".webm", delete=False).name
    legs_out = tempfile.NamedTemporaryFile(prefix=f"pose_legs_{side_val}_{job_id}_", suffix=".webm", delete=False).name

    POSE_JOBS[job_id] = {
        "status": "queued",
        "progress": 0.0,
        "frames_written": 0,
        "frames_expected": None,
        "tmp_in": tmp_in,
        "arms_out": arms_out,
        "legs_out": legs_out,
        "session_id": sid,
        "side": side_val,
        "error": None,
        "served_layers": set(),
    }

    t = threading.Thread(
        target=_yolo_pose_job_worker,
        args=(job_id, tmp_in, arms_out, legs_out, arms_color, legs_color, fps),
        daemon=True,
    )
    t.start()

    return JSONResponse({"job_id": job_id}, status_code=200)


@app.get("/api/overlay/yolo-pose/status")
async def overlay_yolo_pose_status(job_id: str):
    job = POSE_JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    return {
        "job_id": job_id,
        "status": job.get("status", "unknown"),
        "progress": float(job.get("progress", 0.0) or 0.0),
        "frames_written": job.get("frames_written"),
        "frames_expected": job.get("frames_expected"),
        "error": job.get("error"),
    }


@app.get("/api/overlay/yolo-pose/result")
async def overlay_yolo_pose_result(job_id: str, layer: str, background_tasks: BackgroundTasks):
    job = POSE_JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    if job.get("status") != "done":
        return JSONResponse({"error": "Job not ready"}, status_code=409)

    if layer not in {"arms", "legs"}:
        return JSONResponse({"error": "Invalid layer"}, status_code=400)

    path_key = "arms_out" if layer == "arms" else "legs_out"
    out_path = job.get(path_key)
    if not out_path:
        return JSONResponse({"error": "Missing output"}, status_code=500)

    served_layers = job.get("served_layers")
    if not isinstance(served_layers, set):
        served_layers = set()
        job["served_layers"] = served_layers
    served_layers.add(layer)

    background_tasks.add_task(lambda: Path(out_path).unlink(missing_ok=True))

    if served_layers == {"arms", "legs"}:
        tmp_in = job.get("tmp_in")
        other_path = job.get("legs_out" if layer == "arms" else "arms_out")
        if tmp_in:
          background_tasks.add_task(lambda: Path(tmp_in).unlink(missing_ok=True))
        if other_path:
          background_tasks.add_task(lambda: Path(other_path).unlink(missing_ok=True))
        POSE_JOBS.pop(job_id, None)

    return FileResponse(path=out_path, media_type="video/webm", filename=f"{job_id}_{layer}_overlay.webm")


BODYPix_JOBS: dict[str, dict[str, Any]] = {}


def _bodypix_job_worker(
    job_id: str,
    tmp_in: str,
    out_path: str,
    arms_color: str,
    legs_color: str,
    torso_color: str,
    head_color: str,
    fps: int,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> None:
    try:
        import cv2  # type: ignore
        from ultralytics import YOLO  # type: ignore
    except Exception as exc:
        BODYPix_JOBS[job_id]["status"] = "error"
        BODYPix_JOBS[job_id]["error"] = f"Missing bodypart deps: {exc}"
        return

    # Python "BodyPix-like" backend using YOLO pose keypoints to render semantic body regions.
    pose_weights = (
        Path(__file__).resolve().parents[3] / "web-app" / "public" / "models" / "yolo26n-pose.pt"
    ).resolve()
    if not pose_weights.exists():
        BODYPix_JOBS[job_id]["status"] = "error"
        BODYPix_JOBS[job_id]["error"] = f"YOLO pose weights not found at {pose_weights}"
        return

    cap = cv2.VideoCapture(tmp_in)
    if not cap.isOpened():
        BODYPix_JOBS[job_id]["status"] = "error"
        BODYPix_JOBS[job_id]["error"] = "Failed to open video."
        return

    out_fps_local = max(1, int(fps))
    out_dt_local = 1.0 / float(out_fps_local)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 640)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 480)

    try:
        meta = probe_video_metadata(tmp_in)
        duration_sec = float(meta.get("duration_sec") or 0.0)
    except Exception:
        duration_sec = 0.0
    segment_start_sec, segment_end_sec = _resolve_segment_window(duration_sec, start_sec, end_sec)
    segment_duration_sec = segment_end_sec - segment_start_sec
    if segment_duration_sec <= 0:
        BODYPix_JOBS[job_id]["status"] = "error"
        BODYPix_JOBS[job_id]["error"] = "Body overlay segment duration must be greater than 0."
        cap.release()
        return

    if segment_start_sec > 0:
        try:
            cap.set(cv2.CAP_PROP_POS_MSEC, segment_start_sec * 1000.0)
        except Exception:
            pass

    expected = _expected_frames(segment_duration_sec, out_fps_local)

    BODYPix_JOBS[job_id]["frames_expected"] = expected
    BODYPix_JOBS[job_id]["frames_written"] = 0
    BODYPix_JOBS[job_id]["progress"] = 0.0
    BODYPix_JOBS[job_id]["status"] = "processing"

    model = YOLO(str(pose_weights))
    fourcc = cv2.VideoWriter_fourcc(*"VP90")
    writer = cv2.VideoWriter(out_path, fourcc, out_fps_local, (w, h))
    if not writer.isOpened():
        BODYPix_JOBS[job_id]["status"] = "error"
        BODYPix_JOBS[job_id]["error"] = "Failed to open VideoWriter."
        return

    written = 0
    next_out_time = 0.0
    last_frame_time = 0.0
    last_overlay = None

    while True:
        ok, frame_bgr = cap.read()
        if not ok:
            break

        try:
            abs_t = float(cap.get(cv2.CAP_PROP_POS_MSEC) or 0.0) / 1000.0
        except Exception:
            abs_t = last_frame_time + out_dt_local
        last_frame_time = abs_t

        rel_t = max(0.0, abs_t - segment_start_sec)
        if rel_t > segment_duration_sec + (out_dt_local * 0.25):
            break

        if rel_t + (out_dt_local * 0.25) < next_out_time:
            continue

        results = model.predict(frame_bgr, imgsz=768, conf=0.2, iou=0.5, verbose=False)

        if results and getattr(results[0], "keypoints", None) is not None and len(results[0].keypoints.xy) > 0:
            kp = results[0].keypoints
            xy = kp.xy[0].detach().cpu().numpy()  # type: ignore[attr-defined]
            conf = kp.conf[0].detach().cpu().numpy() if getattr(kp, "conf", None) is not None else None  # type: ignore[attr-defined]

            arms_overlay, legs_overlay = _render_pose_layers(xy, conf, w, h, arms_color, legs_color)
            # bodypix-like single semantic overlay: combine layers and add torso/head from custom colors
            import numpy as np  # type: ignore

            overlay = np.maximum(arms_overlay, legs_overlay)
            shoulder_width = 60.0
            ls = _visible_pose_point(xy, conf, 5)
            rs = _visible_pose_point(xy, conf, 6)
            if ls and rs:
                shoulder_width = math.hypot(ls[0] - rs[0], ls[1] - rs[1])
            _draw_pose_torso_head(overlay, xy, conf, torso_color, shoulder_width, intensity=0.55)
            nose = _visible_pose_point(xy, conf, 0, threshold=0.2)
            if nose is not None:
                _draw_pose_circle(
                    overlay,
                    nose,
                    max(int(round(max(shoulder_width * 0.3, 18) * 0.9)), 10),
                    _scaled_bgr(head_color, 0.6),
                )
        else:
            import numpy as np  # type: ignore

            overlay = np.zeros((h, w, 3), dtype=np.uint8)

        last_overlay = overlay
        slack = out_dt_local * 0.25
        dup_count = 1
        if rel_t + slack > next_out_time:
            dup_count = int(math.floor((rel_t + slack - next_out_time) / out_dt_local)) + 1
            dup_count = max(1, dup_count)
        remaining = expected - written
        if remaining <= 0:
            break
        dup_count = min(dup_count, remaining)

        for _ in range(dup_count):
            writer.write(overlay)
            written += 1
            next_out_time += out_dt_local
            BODYPix_JOBS[job_id]["frames_written"] = written
            BODYPix_JOBS[job_id]["progress"] = min(1.0, written / float(expected))
            if written >= expected:
                break

        if written >= expected:
            break

    if written < expected and last_overlay is not None:
        for _ in range(expected - written):
            writer.write(last_overlay)
        written = expected
        BODYPix_JOBS[job_id]["frames_written"] = written
        BODYPix_JOBS[job_id]["progress"] = 1.0

    cap.release()
    writer.release()
    BODYPix_JOBS[job_id]["status"] = "done"


@app.post("/api/overlay/bodypix/start")
async def overlay_bodypix_start(
    video: UploadFile = File(...),
    arms_color: str = Form(default="#38bdf8"),
    legs_color: str = Form(default="#6366f1"),
    torso_color: str = Form(default="#22c55e"),
    head_color: str = Form(default="#f59e0b"),
    fps: int = Form(default=12),
    session_id: str | None = Form(default=None),
    side: str | None = Form(default=None),
    start_sec: float | None = Form(default=None),
    end_sec: float | None = Form(default=None),
):
    sid = (session_id or "").strip() or "default"
    side_val = (side or "").strip() or "unknown"
    job_id = str(uuid.uuid4())

    tmp_in = _save_upload(video, f"bodypix_{side_val}_{job_id}")
    out_path = tempfile.NamedTemporaryFile(prefix=f"bodypix_{side_val}_{job_id}_", suffix=".webm", delete=False).name

    BODYPix_JOBS[job_id] = {
        "status": "queued",
        "progress": 0.0,
        "frames_written": 0,
        "frames_expected": None,
        "tmp_in": tmp_in,
        "out_path": out_path,
        "session_id": sid,
        "side": side_val,
        "start_sec": start_sec,
        "end_sec": end_sec,
        "error": None,
    }

    t = threading.Thread(
        target=_bodypix_job_worker,
        args=(
            job_id,
            tmp_in,
            out_path,
            arms_color,
            legs_color,
            torso_color,
            head_color,
            fps,
            start_sec,
            end_sec,
        ),
        daemon=True,
    )
    t.start()

    return JSONResponse({"job_id": job_id}, status_code=200)


@app.get("/api/overlay/bodypix/status")
async def overlay_bodypix_status(job_id: str):
    job = BODYPix_JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    return {
        "job_id": job_id,
        "status": job.get("status", "unknown"),
        "progress": float(job.get("progress", 0.0) or 0.0),
        "frames_written": job.get("frames_written"),
        "frames_expected": job.get("frames_expected"),
        "error": job.get("error"),
    }


@app.get("/api/overlay/bodypix/result")
async def overlay_bodypix_result(job_id: str, background_tasks: BackgroundTasks):
    job = BODYPix_JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    if job.get("status") != "done":
        return JSONResponse({"error": "Job not ready"}, status_code=409)
    out_path = job.get("out_path")
    tmp_in = job.get("tmp_in")
    if not out_path:
        return JSONResponse({"error": "Missing output"}, status_code=500)

    background_tasks.add_task(lambda: Path(out_path).unlink(missing_ok=True))
    if tmp_in:
        background_tasks.add_task(lambda: Path(tmp_in).unlink(missing_ok=True))
    BODYPix_JOBS.pop(job_id, None)
    return FileResponse(path=out_path, media_type="video/webm", filename=f"{job_id}_bodypix_overlay.webm")
