from __future__ import annotations

from typing import Any

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse

from src.alignment_and_segmentation.router import router as alignment_router
from src.ebs_web_adapter import process_uploads
from src.overlay_api import router as overlay_router

app = FastAPI(title="Audio Alignment API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(alignment_router, prefix="/a5")
app.include_router(overlay_router)

SESSION_STATUS: dict[str, str] = {}
SESSION_RESULTS: dict[str, dict[str, Any]] = {}

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

    ref = ref_video or file_a
    usr = user_video or file_b
    if not ref or not usr:
        SESSION_STATUS[sid] = "error"
        return JSONResponse(
            {"error": "Both ref_video/user_video (or file_a/file_b) are required."},
            status_code=400,
        )
    try:
        artifact = process_uploads(ref, usr)
        SESSION_RESULTS[sid] = artifact
        SESSION_STATUS[sid] = "done"
        return JSONResponse(artifact, status_code=200)
    except Exception as exc:
        SESSION_STATUS[sid] = "error"
        return JSONResponse({"error": str(exc)}, status_code=500)


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
