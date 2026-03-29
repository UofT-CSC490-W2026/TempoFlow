"""/review routes — expert rating UI for model comparison."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from .config import EVAL_DIR
from .storage import (
    EXPERT_IDS,
    MAX_EXPERTS,
    experts_who_rated,
    list_videos,
    load_expert_ratings,
    load_segment_evaluations,
    segment_ids_for_video,
    validate_ratings,
    write_expert_ratings,
)

logger = logging.getLogger("eval-review")

router = APIRouter(tags=["review"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent / "templates"))


@router.get("/review", response_class=HTMLResponse)
async def review_list(request: Request):
    videos = list_videos()
    return templates.TemplateResponse("review_list.html", {"request": request, "videos": videos})


@router.get("/review/{video_id}", response_class=HTMLResponse)
async def review_video_redirect(video_id: str):
    segments = segment_ids_for_video(video_id)
    if not segments:
        return HTMLResponse("<h3>No segments found for this video.</h3>", status_code=404)
    first_unrated = segments[0]
    for seg in segments:
        if not (EVAL_DIR / video_id / seg / "expert_ratings.json").exists():
            first_unrated = seg
            break
    return RedirectResponse(f"/review/{video_id}/{first_unrated}", status_code=302)


@router.get("/review/{video_id}/{segment_id}", response_class=HTMLResponse)
async def review_segment(
    request: Request, video_id: str, segment_id: str, expert: str = "expert_1",
):
    if expert not in EXPERT_IDS:
        expert = "expert_1"

    evals = load_segment_evaluations(video_id, segment_id)
    existing = load_expert_ratings(video_id, segment_id, expert_id=expert)
    segments = segment_ids_for_video(video_id)

    unrated: set[str] = set()
    for s in segments:
        done = experts_who_rated(video_id, s)
        if len(done) < MAX_EXPERTS:
            unrated.add(s)

    model_ids = sorted(evals.keys())

    models_data: list[dict[str, Any]] = []
    for mid in model_ids:
        rec = evals[mid]
        output = rec.get("output", rec)
        models_data.append(
            {
                "model_id": mid,
                "moves": output.get("moves", []),
                "error": output.get("error"),
                "latency_ms": rec.get("latency_ms"),
            }
        )

    existing_map: dict[str, dict[str, Any]] = {}
    for r in existing:
        key = f"{r.get('model_id', '')}_{r.get('move_index', '')}"
        existing_map[key] = r

    seg_experts_done = experts_who_rated(video_id, segment_id)

    return templates.TemplateResponse(
        "review_segment.html",
        {
            "request": request,
            "video_id": video_id,
            "segment_id": segment_id,
            "segments": segments,
            "unrated": unrated,
            "models": models_data,
            "existing_ratings": existing_map,
            "expert_ids": EXPERT_IDS,
            "current_expert": expert,
            "seg_experts_done": sorted(seg_experts_done),
        },
    )


@router.post("/review/rate")
async def rate_segment(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "Invalid JSON body"}, status_code=400)

    video_id = body.get("video_id", "")
    segment_id = body.get("segment_id", "")
    expert_id = body.get("expert_id", "expert_1")
    ratings = body.get("ratings", [])

    if not video_id or not segment_id:
        return JSONResponse({"ok": False, "error": "video_id and segment_id required"}, status_code=400)
    if expert_id not in EXPERT_IDS:
        return JSONResponse({"ok": False, "error": f"expert_id must be one of {EXPERT_IDS}"}, status_code=400)
    if not ratings:
        return JSONResponse({"ok": False, "error": "No ratings provided"}, status_code=400)

    err = validate_ratings(ratings)
    if err:
        return JSONResponse({"ok": False, "error": err}, status_code=400)

    try:
        write_expert_ratings(video_id, segment_id, ratings, expert_id=expert_id)
        return {"ok": True}
    except Exception as exc:
        logger.exception("Rating write failed")
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)
