"""Tests for `src.eval.review_ui`."""

from __future__ import annotations

import json
from unittest.mock import patch

from fastapi.testclient import TestClient

import src.eval.storage as st
from src.main import app

client = TestClient(app)


def test_review_list_page(eval_dir):
    r = client.get("/review")
    assert r.status_code == 200


def test_review_redirect_404_when_no_segments(eval_dir):
    (eval_dir / "novid").mkdir()
    r = client.get("/review/novid", follow_redirects=False)
    assert r.status_code == 404


def test_review_redirect_to_first_segment(eval_dir):
    v = eval_dir / "vid9"
    (v / "seg_00").mkdir(parents=True)
    (v / "seg_01").mkdir(parents=True)
    r = client.get("/review/vid9", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"].endswith("/seg_00")


def test_review_segment_renders(eval_dir):
    seg = eval_dir / "rv" / "seg_00"
    seg.mkdir(parents=True)
    (seg / "model-a.json").write_text(
        json.dumps(
            {
                "model_id": "model-a",
                "latency_ms": 9,
                "output": {"moves": [{"move_index": 1}], "error": None},
            }
        ),
        encoding="utf-8",
    )
    r = client.get("/review/rv/seg_00?expert=expert_2")
    assert r.status_code == 200


def test_review_segment_invalid_expert_defaults(eval_dir):
    seg = eval_dir / "rv2" / "s0"
    seg.mkdir(parents=True)
    (seg / "m.json").write_text(
        json.dumps({"model_id": "m", "output": {"moves": []}}),
        encoding="utf-8",
    )
    r = client.get("/review/rv2/s0?expert=not_real")
    assert r.status_code == 200


def test_review_segment_populates_existing_ratings_map(eval_dir):
    seg = eval_dir / "rx" / "s1"
    seg.mkdir(parents=True)
    (seg / "model-x.json").write_text(
        json.dumps({"model_id": "model-x", "output": {"moves": []}}),
        encoding="utf-8",
    )
    (seg / "expert_ratings.json").write_text(
        json.dumps(
            [
                {
                    "expert_id": "expert_1",
                    "model_id": "model-x",
                    "move_index": 0,
                    "label_accuracy": 4,
                }
            ]
        ),
        encoding="utf-8",
    )
    r = client.get("/review/rx/s1?expert=expert_1")
    assert r.status_code == 200


def test_review_segment_nested_output_shape(eval_dir):
    """Uses `rec` directly when there is no `output` wrapper."""
    seg = eval_dir / "rv3" / "s0"
    seg.mkdir(parents=True)
    (seg / "m.json").write_text(
        json.dumps({"model_id": "m", "moves": [], "error": "boom"}),
        encoding="utf-8",
    )
    r = client.get("/review/rv3/s0")
    assert r.status_code == 200


def _valid_rate_body():
    return {
        "video_id": "vr",
        "segment_id": "s0",
        "expert_id": "expert_1",
        "ratings": [
            {
                "model_id": "m1",
                "move_index": 0,
                "label_accuracy": 3,
                "body_part_specificity": 3,
                "timing_granularity": 3,
                "coaching_actionability": 3,
                "confidence_calibration": 3,
                "occlusion_handling": 3,
            }
        ],
    }


def test_rate_segment_success(eval_dir):
    st.write_evaluation("vr", "s0", "m1", "pv", 1, {"moves": []})
    r = client.post("/review/rate", json=_valid_rate_body())
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_rate_segment_invalid_json(eval_dir):
    r = client.post("/review/rate", content=b"not-json", headers={"Content-Type": "application/json"})
    assert r.status_code == 400


def test_rate_segment_missing_ids(eval_dir):
    r = client.post("/review/rate", json={"ratings": [_valid_rate_body()["ratings"][0]]})
    assert r.status_code == 400


def test_rate_segment_bad_expert(eval_dir):
    body = _valid_rate_body()
    body["expert_id"] = "nope"
    r = client.post("/review/rate", json=body)
    assert r.status_code == 400


def test_rate_segment_no_ratings(eval_dir):
    body = _valid_rate_body()
    body["ratings"] = []
    r = client.post("/review/rate", json=body)
    assert r.status_code == 400


def test_rate_segment_validation_error(eval_dir):
    body = _valid_rate_body()
    body["ratings"][0]["label_accuracy"] = 99
    r = client.post("/review/rate", json=body)
    assert r.status_code == 400


def test_rate_segment_write_failure(eval_dir):
    st.write_evaluation("vr", "s0", "m1", "pv", 1, {"moves": []})
    with patch(
        "src.eval.review_ui.write_expert_ratings",
        side_effect=RuntimeError("disk"),
    ):
        r = client.post("/review/rate", json=_valid_rate_body())
    assert r.status_code == 500
    assert "disk" in r.json()["error"]
