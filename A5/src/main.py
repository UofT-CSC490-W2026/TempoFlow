from __future__ import annotations

from pathlib import Path

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    def load_dotenv(*_args, **_kwargs):
        return False

# Load A5/.env before any code that reads os.environ (e.g. eval config, Gemini).
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import asyncio
import json
import threading
import uuid
from typing import Any

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse

from src.alignment_and_segmentation.router import router as alignment_router
from src.ebs_web_adapter import process_videos_from_paths, save_upload, save_upload_async
from src.gemini_move_feedback import run_move_feedback_pipeline
from src.overlay_api import router as overlay_router
from src.eval import router as eval_router

app = FastAPI(title="Audio Alignment API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_cross_origin_resource_policy(request, call_next):
    """Allow browser JS to read cross-origin fetch() responses when the web app uses COEP.

    Next.js sends Cross-Origin-Embedder-Policy: require-corp (for WASM/WebGPU). In that mode,
    responses from CloudFront/EB must include this header or the client sees Failed to fetch.
    """
    response = await call_next(request)
    response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
    return response


# Include routers
app.include_router(alignment_router, prefix="/a5")
app.include_router(overlay_router)
app.include_router(eval_router)

SESSION_STATUS: dict[str, str] = {}
SESSION_RESULTS: dict[str, dict[str, Any]] = {}
SESSION_TIMESTAMPS: dict[str, float] = {}  # Added: track when sessions were last updated

MOVE_FEEDBACK_JOBS: dict[str, dict[str, Any]] = {}

# Added: Limit concurrent Gemini workers to avoid CPU saturation
from concurrent.futures import ThreadPoolExecutor
import time

GEMINI_EXECUTOR = ThreadPoolExecutor(max_workers=2)
MAX_STATE_AGE_SEC = 45 * 60  # Cleanup state older than 45 minutes


def _parse_optional_bool(val: str | None, default: bool) -> bool:
    if val is None or str(val).strip() == "":
        return default
    return str(val).strip().lower() in ("1", "true", "yes", "on")


def _parse_pose_priors_json(raw: str | None) -> dict[str, Any] | None:
    if not raw or not str(raw).strip():
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _parse_context_json(raw: str | None) -> dict[str, Any] | None:
    if not raw or not str(raw).strip():
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _move_feedback_worker(
    job_id: str,
    ref_path: str,
    user_path: str,
    ebs_data: dict[str, Any],
    segment_index: int,
    pose_priors: dict[str, Any] | None,
    yolo_context: dict[str, Any] | None,
    burn_in_labels: bool,
    include_audio: bool,
) -> None:
    """Background worker for Gemini micro-timing move feedback."""
    try:
        MOVE_FEEDBACK_JOBS[job_id]["status"] = "processing"
        result = run_move_feedback_pipeline(
            ref_video_path=ref_path,
            user_video_path=user_path,
            ebs_artifact=ebs_data,
            segment_index=segment_index,
            pose_priors=pose_priors,
            yolo_context=yolo_context,
            burn_in_labels=burn_in_labels,
            include_audio=include_audio,
        )
        MOVE_FEEDBACK_JOBS[job_id]["result"] = result
        MOVE_FEEDBACK_JOBS[job_id]["status"] = "done"
    except Exception as exc:
        MOVE_FEEDBACK_JOBS[job_id]["status"] = "error"
        MOVE_FEEDBACK_JOBS[job_id]["error"] = str(exc)
    finally:
        for p in (ref_path, user_path):
            try:
                Path(p).unlink(missing_ok=True)
            except OSError:
                pass


@app.on_event("startup")
async def startup_event():
    """Cleanup orphaned temp files and start the stale state monitor."""
    import glob

    # 1. Cleanup old files from previous system runs
    for pattern in ["/tmp/ebs_*", "/tmp/gemini_clip_*"]:
        for f in glob.glob(pattern):
            try:
                Path(f).unlink(missing_ok=True)
            except OSError:
                pass

    # 2. Start a background task to prune stale in-memory dicts AND /tmp files
    async def stale_state_monitor():
        while True:
            await asyncio.sleep(600)  # Check every 10 minutes
            now = time.time()

            # A. Prune old in-memory sessions
            for sid in list(SESSION_TIMESTAMPS.keys()):
                if now - SESSION_TIMESTAMPS[sid] > MAX_STATE_AGE_SEC:
                    SESSION_STATUS.pop(sid, None)
                    SESSION_RESULTS.pop(sid, None)
                    SESSION_TIMESTAMPS.pop(sid, None)

            # B. Prune old Gemini jobs
            for jid in list(MOVE_FEEDBACK_JOBS.keys()):
                job = MOVE_FEEDBACK_JOBS[jid]
                created = job.get("created_at", 0)
                if created > 0 and now - created > MAX_STATE_AGE_SEC:
                    MOVE_FEEDBACK_JOBS.pop(jid, None)

            # C. Prune orphaned /tmp files (EBS, Gemini, MF)
            tmp_root = Path("/tmp")
            if tmp_root.exists():
                patterns = ["ebs_*", "gemini_clip_*", "mf_ref_*", "mf_user_*"]
                for pattern in patterns:
                    for p in tmp_root.glob(pattern):
                        try:
                            # If older than 45 mins, delete.
                            if now - p.stat().st_mtime > MAX_STATE_AGE_SEC:
                                p.unlink(missing_ok=True)
                        except Exception:
                            pass

    asyncio.create_task(stale_state_monitor())

@app.get("/")
async def root():
    return {"message": "Audio Alignment API is running"}


@app.head("/ebs_viewer.html")
@app.get("/ebs_viewer.html")
async def ebs_viewer_probe():
    # Web app uses this as a cheap processor health check.
    return HTMLResponse("<html><body>ok</body></html>")


@app.post("/api/process")
async def process(
    ref_video: UploadFile = File(default=None),
    user_video: UploadFile = File(default=None),
    file_a: UploadFile = File(default=None),
    file_b: UploadFile = File(default=None),
    session_id: str | None = Form(default=None),
):
    sid = (session_id or "").strip() or "default"
    SESSION_STATUS[sid] = "processing"
    SESSION_TIMESTAMPS[sid] = time.time()

    ref = ref_video or file_a
    usr = user_video or file_b
    if not ref or not usr:
        SESSION_STATUS[sid] = "error"
        return JSONResponse(
            {"error": "Both ref_video/user_video (or file_a/file_b) are required."},
            status_code=400,
        )

    ref_tmp: str | None = None
    user_tmp: str | None = None
    try:
        ref_tmp = await save_upload_async(ref, "ref")
        user_tmp = await save_upload_async(usr, "user")
        # librosa/CPU work must not block the asyncio loop — otherwise GET /api/status never runs
        # and the web UI polls "idle" forever while the POST is in progress.
        artifact = await asyncio.to_thread(process_videos_from_paths, ref_tmp, user_tmp)
        SESSION_RESULTS[sid] = artifact
        SESSION_STATUS[sid] = "done"
        SESSION_TIMESTAMPS[sid] = time.time()
        return JSONResponse(artifact, status_code=200)
    except Exception as exc:
        SESSION_STATUS[sid] = "error"
        return JSONResponse({"error": str(exc)}, status_code=500)
    finally:
        for p in (ref_tmp, user_tmp):
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
    segment_count = len(SESSION_RESULTS[sid].get("segments", [])) if has_result else None
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


@app.post("/api/move-feedback/start")
async def move_feedback_start(
    ref_video: UploadFile = File(...),
    user_video: UploadFile = File(...),
    segment_index: int = Form(...),
    session_id: str | None = Form(default=None),
    ebs_data_json: str | None = Form(default=None),
    pose_priors_json: str | None = Form(default=None),
    yolo_context_json: str | None = Form(default=None),
    burn_in_labels: str | None = Form(default=None),
    include_audio: str | None = Form(default=None),
):
    """Start an async Gemini move-feedback job for a single EBS segment.

    Accepts the original reference and user videos plus either:
      - ``ebs_data_json``: full EBS artifact as JSON string, or
      - ``session_id``: reuse the EBS artifact stored from a prior ``/api/process`` call.

    If neither is supplied, the EBS pipeline runs automatically.
    """
    sid = (session_id or "").strip() or "default"
    job_id = str(uuid.uuid4())

    ref_tmp = save_upload(ref_video, "mf_ref")
    user_tmp = save_upload(user_video, "mf_user")

    ebs_data: dict[str, Any] | None = None
    try:
        if ebs_data_json:
            try:
                ebs_data = json.loads(ebs_data_json)
            except json.JSONDecodeError:
                return JSONResponse({"error": "ebs_data_json is not valid JSON"}, status_code=400)

        if ebs_data is None and sid in SESSION_RESULTS:
            ebs_data = SESSION_RESULTS[sid]

        if ebs_data is None:
            try:
                ebs_data = await asyncio.to_thread(process_videos_from_paths, ref_tmp, user_tmp)
            except Exception as exc:
                return JSONResponse({"error": f"EBS pipeline failed: {exc}"}, status_code=500)

        n_segments = len(ebs_data.get("segments", []))
        if segment_index < 0 or segment_index >= n_segments:
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
            "created_at": time.time(),  # Track for pruning
        }

        pose_priors = _parse_pose_priors_json(pose_priors_json)
        yolo_context = _parse_context_json(yolo_context_json)
        burn_in = _parse_optional_bool(burn_in_labels, True)
        audio_on = _parse_optional_bool(include_audio, False)

        # Use ThreadPoolExecutor instead of raw daemon threads for resource control
        GEMINI_EXECUTOR.submit(
            _move_feedback_worker,
            job_id,
            ref_tmp,
            user_tmp,
            ebs_data,
            segment_index,
            pose_priors,
            yolo_context,
            burn_in,
            audio_on,
        )

        return JSONResponse({"job_id": job_id}, status_code=200)
    except Exception as exc:
        # Ensure temp videos are removed if we fail before the worker takes over.
        for p in (ref_tmp, user_tmp):
            try:
                Path(p).unlink(missing_ok=True)
            except OSError:
                pass
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.post("/api/move-feedback")
async def move_feedback_sync(
    ref_video: UploadFile = File(...),
    user_video: UploadFile = File(...),
    segment_index: int = Form(...),
    session_id: str | None = Form(default=None),
    ebs_data_json: str | None = Form(default=None),
    pose_priors_json: str | None = Form(default=None),
    yolo_context_json: str | None = Form(default=None),
    burn_in_labels: str | None = Form(default=None),
    include_audio: str | None = Form(default=None),
):
    """Synchronous variant — blocks until Gemini returns feedback JSON."""
    sid = (session_id or "").strip() or "default"

    ref_tmp = save_upload(ref_video, "mf_ref")
    user_tmp = save_upload(user_video, "mf_user")

    ebs_data: dict[str, Any] | None = None
    try:
        if ebs_data_json:
            try:
                ebs_data = json.loads(ebs_data_json)
            except json.JSONDecodeError:
                return JSONResponse({"error": "ebs_data_json is not valid JSON"}, status_code=400)

        if ebs_data is None and sid in SESSION_RESULTS:
            ebs_data = SESSION_RESULTS[sid]

        if ebs_data is None:
            try:
                ebs_data = await asyncio.to_thread(process_videos_from_paths, ref_tmp, user_tmp)
            except Exception as exc:
                return JSONResponse({"error": f"EBS pipeline failed: {exc}"}, status_code=500)

        n_segments = len(ebs_data.get("segments", []))
        if segment_index < 0 or segment_index >= n_segments:
            return JSONResponse(
                {"error": f"segment_index {segment_index} out of range (0..{n_segments - 1})"},
                status_code=400,
            )

        pose_priors = _parse_pose_priors_json(pose_priors_json)
        yolo_context = _parse_context_json(yolo_context_json)
        burn_in = _parse_optional_bool(burn_in_labels, True)
        audio_on = _parse_optional_bool(include_audio, False)

        feedback = await asyncio.to_thread(
            run_move_feedback_pipeline,
            ref_video_path=ref_tmp,
            user_video_path=user_tmp,
            ebs_artifact=ebs_data,
            segment_index=segment_index,
            pose_priors=pose_priors,
            yolo_context=yolo_context,
            burn_in_labels=burn_in,
            include_audio=audio_on,
        )
        return JSONResponse(feedback, status_code=200)
    except Exception as exc:
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
