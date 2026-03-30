"""Tests for `src.eval.dashboard`."""

from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

from src.main import app

client = TestClient(app)

_AVG_ROW = {
    "avg_label_accuracy": 3.0,
    "avg_body_part_specificity": 3.0,
    "avg_timing_granularity": 3.0,
    "avg_coaching_actionability": 3.0,
    "avg_confidence_calibration": 3.0,
    "avg_occlusion_handling": 3.0,
}


def test_dashboard_renders():
    with (
        patch("src.eval.dashboard.query_prompt_versions", return_value=["v1"]),
        patch("src.eval.dashboard.query_model_aggregates", return_value=[]),
        patch("src.eval.dashboard.query_per_video_scores", return_value=[]),
    ):
        r = client.get("/dashboard")
    assert r.status_code == 200
    assert b"dashboard" in r.content.lower() or b"metrics" in r.content.lower()


def test_dashboard_invalid_prompt_version_ignored():
    with (
        patch("src.eval.dashboard.query_prompt_versions", return_value=["v1"]),
        patch("src.eval.dashboard.query_model_aggregates", return_value=[]),
        patch("src.eval.dashboard.query_per_video_scores", return_value=[]),
    ):
        r = client.get("/dashboard?prompt_version=not_a_version")
    assert r.status_code == 200


def test_dashboard_passes_prompt_version_when_valid():
    model_row = {
        "model_id": "m1",
        "segments_rated": 1,
        **_AVG_ROW,
        "overall_avg": 3.0,
        "win_rate": 0.0,
        "avg_latency": 10.0,
    }
    per_video = [
        {
            "video_id": "vid1",
            "segment_id": "seg_00",
            "model_id": "m1",
            **_AVG_ROW,
        },
    ]
    with (
        patch("src.eval.dashboard.query_prompt_versions", return_value=["pv1"]),
        patch("src.eval.dashboard.query_model_aggregates", return_value=[model_row]),
        patch("src.eval.dashboard.query_per_video_scores", return_value=per_video),
    ):
        r = client.get("/dashboard?prompt_version=pv1")
    assert r.status_code == 200
    assert "vid1" in r.text


def test_dashboard_per_video_empty_models_list():
    with (
        patch("src.eval.dashboard.query_prompt_versions", return_value=[]),
        patch("src.eval.dashboard.query_model_aggregates", return_value=[]),
        patch("src.eval.dashboard.query_per_video_scores", return_value=[]),
    ):
        r = client.get("/dashboard")
    assert r.status_code == 200
