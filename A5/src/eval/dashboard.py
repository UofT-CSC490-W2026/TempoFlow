"""/dashboard routes — aggregate evaluation analytics."""
from __future__ import annotations

import logging
from collections import defaultdict
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from .storage import query_model_aggregates, query_per_video_scores, query_prompt_versions

logger = logging.getLogger("eval-dashboard")

router = APIRouter(tags=["dashboard"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent / "templates"))

METRICS = [
    "avg_label_accuracy",
    "avg_body_part_specificity",
    "avg_timing_granularity",
    "avg_coaching_actionability",
    "avg_confidence_calibration",
    "avg_occlusion_handling",
]

METRIC_SHORT = [
    "Label Acc",
    "Body Spec",
    "Timing",
    "Coaching",
    "Confidence",
    "Occlusion",
]


@router.get("/dashboard", response_class=HTMLResponse)
async def dashboard(request: Request, prompt_version: str | None = None):
    versions = query_prompt_versions()
    if prompt_version and prompt_version not in versions:
        prompt_version = None

    model_stats = query_model_aggregates(prompt_version)
    per_video_raw = query_per_video_scores(prompt_version)

    # Restructure per-video data into nested dict: video -> segment -> model -> scores
    per_video: dict[str, dict[str, dict[str, dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(dict)
    )
    for row in per_video_raw:
        per_video[row["video_id"]][row["segment_id"]][row["model_id"]] = row

    # Collect all model_ids that appear in the data
    all_models = sorted({row["model_id"] for row in per_video_raw}) if per_video_raw else []

    return templates.TemplateResponse(
        "dashboard.html",
        {
            "request": request,
            "versions": versions,
            "current_version": prompt_version,
            "model_stats": model_stats,
            "per_video": dict(per_video),
            "all_models": all_models,
            "metrics": METRICS,
            "metric_short": METRIC_SHORT,
        },
    )
