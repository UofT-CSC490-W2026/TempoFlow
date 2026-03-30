"""Tests for `src.eval.storage`."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import src.eval.storage as st


def test_video_id_from_filename_caches(eval_dir):
    p = str(eval_dir / "My Clip!.mp4")
    a = st.video_id_from_filename(p)
    b = st.video_id_from_filename(p)
    assert a == b
    assert a.startswith("my-clip-")


def test_video_id_from_filename_slug_fallback_to_video(eval_dir):
    # Stem reduces to empty slug after sanitization → default "video"
    vid = st.video_id_from_filename(str(eval_dir / "___.mp4"))
    assert vid.startswith("video-")


def test_get_conn_reuses_thread_local(eval_dir):
    c1 = st._get_conn()
    c2 = st._get_conn()
    assert c1 is c2


def test_write_evaluation_creates_files_and_sqlite(eval_dir):
    st.write_evaluation("v1", "seg_00", "model-a", "v1.0", 12, {"moves": [], "ok": True})
    jpath = eval_dir / "v1" / "seg_00" / "model-a.json"
    assert jpath.is_file()
    rows = st._get_conn().execute("SELECT * FROM evaluations WHERE video_id='v1'").fetchall()
    assert len(rows) == 1


def test_write_evaluation_upsert(eval_dir):
    st.write_evaluation("v1", "seg_00", "m1", "v1", 1, {"a": 1})
    st.write_evaluation("v1", "seg_00", "m1", "v2", 2, {"a": 2})
    row = st._get_conn().execute(
        "SELECT prompt_version, latency_ms FROM evaluations WHERE id=?",
        ("v1__seg_00__m1",),
    ).fetchone()
    assert row["prompt_version"] == "v2"
    assert row["latency_ms"] == 2


def test_write_evaluation_filesystem_error_logs(eval_dir):
    with patch.object(Path, "write_text", side_effect=OSError("disk full")):
        st.write_evaluation("v1", "seg_00", "m1", "v1", 1, {"x": 1})


def test_write_evaluation_sqlite_error_logs(eval_dir):
    bad = MagicMock()
    bad.execute.side_effect = RuntimeError("sqlite boom")
    with patch.object(st, "_get_conn", return_value=bad):
        st.write_evaluation("v1", "seg_00", "m2", "v1", 1, {"x": 1})


def test_list_videos_missing_root(monkeypatch):
    missing = Path("/nonexistent_eval_root_xyz")
    monkeypatch.setattr(st, "EVAL_DIR", missing)
    if getattr(st._LOCAL, "conn", None):
        st._LOCAL.conn.close()
        delattr(st._LOCAL, "conn")
    assert st.list_videos() == []


def test_list_videos_skips_db_suffix_dir(eval_dir):
    (eval_dir / "foo.db").mkdir()
    (eval_dir / "real").mkdir()
    assert [v["video_id"] for v in st.list_videos()] == ["real"]


def test_list_videos_counts_and_corrupt_expert_ratings(eval_dir):
    v = eval_dir / "vid1"
    s0 = v / "seg_00"
    s0.mkdir(parents=True)
    (s0 / "model-x.json").write_text(
        json.dumps(
            {
                "id": "vid1__seg_00__model-x",
                "created_at": "2025-01-02T12:34:56+00:00",
                "output": {},
            }
        ),
        encoding="utf-8",
    )
    (s0 / "expert_ratings.json").write_text("{not json", encoding="utf-8")
    s1 = v / "seg_01"
    s1.mkdir()
    (s1 / "expert_ratings.json").write_text(
        json.dumps([{"expert_id": "expert_1", "model_id": "model-x", "move_index": 0}]),
        encoding="utf-8",
    )
    vids = st.list_videos()
    assert len(vids) == 1
    row = vids[0]
    assert row["video_id"] == "vid1"
    assert row["segments"] == 2
    assert row["rated"] == 1
    assert "model-x" in row["models"]


def test_list_videos_bad_model_json(eval_dir):
    v = eval_dir / "v2"
    s = v / "seg_00"
    s.mkdir(parents=True)
    (s / "bad.json").write_text("x", encoding="utf-8")
    st.list_videos()


def test_load_segment_evaluations_missing_segment_dir(eval_dir):
    assert st.load_segment_evaluations("missing", "seg_00") == {}


def test_load_segment_evaluations(eval_dir):
    seg = eval_dir / "v" / "seg_00"
    seg.mkdir(parents=True)
    (seg / "m1.json").write_text('{"stem": "m1", "output": {}}', encoding="utf-8")
    (seg / "expert_ratings.json").write_text("[]", encoding="utf-8")
    out = st.load_segment_evaluations("v", "seg_00")
    assert "m1" in out


def test_load_segment_evaluations_bad_file(eval_dir):
    seg = eval_dir / "v" / "seg_00"
    seg.mkdir(parents=True)
    (seg / "bad.json").write_text("{", encoding="utf-8")
    assert st.load_segment_evaluations("v", "seg_00") == {}


def test_load_expert_ratings_missing(eval_dir):
    assert st.load_expert_ratings("v", "seg_x") == []


def test_load_expert_ratings_filter_and_all(eval_dir):
    path = eval_dir / "v" / "s" / "expert_ratings.json"
    path.parent.mkdir(parents=True)
    data = [
        {"expert_id": "expert_1", "model_id": "m", "move_index": 0},
        {"expert_id": "expert_2", "model_id": "m", "move_index": 0},
    ]
    path.write_text(json.dumps(data), encoding="utf-8")
    assert len(st.load_expert_ratings("v", "s")) == 2
    assert len(st.load_expert_ratings("v", "s", expert_id="expert_2")) == 1


def test_load_expert_ratings_corrupt(eval_dir):
    p = eval_dir / "v" / "s" / "expert_ratings.json"
    p.parent.mkdir(parents=True)
    p.write_text("x", encoding="utf-8")
    assert st.load_expert_ratings("v", "s") == []


def test_experts_who_rated(eval_dir):
    p = eval_dir / "v" / "s" / "expert_ratings.json"
    p.parent.mkdir(parents=True)
    p.write_text(
        json.dumps([{"expert_id": "expert_3", "model_id": "m", "move_index": 0}]),
        encoding="utf-8",
    )
    assert st.experts_who_rated("v", "s") == {"expert_3"}


def test_segment_ids_for_video(eval_dir):
    (eval_dir / "vx" / "seg_01").mkdir(parents=True)
    (eval_dir / "vx" / "seg_00").mkdir(parents=True)
    assert st.segment_ids_for_video("vx") == ["seg_00", "seg_01"]


def test_segment_ids_missing(eval_dir):
    assert st.segment_ids_for_video("nope") == []


def test_validate_ratings_ok():
    assert st.validate_ratings([_valid_rating()]) is None


def test_validate_ratings_bad():
    r = _valid_rating()
    r["label_accuracy"] = 6
    err = st.validate_ratings([r])
    assert err is not None
    assert "label_accuracy" in err

    r2 = _valid_rating()
    r2["timing_granularity"] = "x"
    assert st.validate_ratings([r2]) is not None


def test_write_expert_ratings_merges_experts(eval_dir):
    st.write_expert_ratings("v", "s", [_rating_payload()], expert_id="expert_1")
    st.write_expert_ratings("v", "s", [_rating_payload(move_index=1)], expert_id="expert_2")
    merged = json.loads((eval_dir / "v" / "s" / "expert_ratings.json").read_text())
    assert len(merged) == 2


def test_write_expert_ratings_invalid_expert():
    with pytest.raises(ValueError, match="expert_id"):
        st.write_expert_ratings("v", "s", [_rating_payload()], expert_id="expert_99")


def test_write_expert_ratings_corrupt_existing(eval_dir):
    p = eval_dir / "v" / "s" / "expert_ratings.json"
    p.parent.mkdir(parents=True)
    p.write_text("{", encoding="utf-8")
    st.write_expert_ratings("v", "s", [_rating_payload()], expert_id="expert_1")
    data = json.loads(p.read_text())
    assert len(data) == 1


def test_write_expert_ratings_sqlite_error(eval_dir):
    st.write_evaluation("v", "s", "model-z", "pv", 1, {"moves": []})
    bad = MagicMock()
    bad.execute.side_effect = RuntimeError("db")
    with patch.object(st, "_get_conn", return_value=bad):
        st.write_expert_ratings("v", "s", [_rating_payload()], expert_id="expert_1")


def test_write_expert_ratings_filesystem_error(eval_dir):
    with patch.object(Path, "write_text", side_effect=OSError("fail")):
        st.write_expert_ratings("v", "s", [_rating_payload()], expert_id="expert_1")


def _valid_rating():
    return {
        "model_id": "m",
        "move_index": 0,
        "label_accuracy": 3,
        "body_part_specificity": 3,
        "timing_granularity": 3,
        "coaching_actionability": 3,
        "confidence_calibration": 3,
        "occlusion_handling": 3,
    }


def _rating_payload(move_index: int = 0):
    r = _valid_rating()
    r["move_index"] = move_index
    r["model_id"] = "model-z"
    return r


def _seed_eval_and_rating(eval_dir):
    st.write_evaluation("vid", "seg_00", "model-z", "pv1", 100, {"moves": []})
    st.write_expert_ratings(
        "vid",
        "seg_00",
        [_rating_payload()],
        expert_id="expert_1",
    )


def test_query_model_aggregates(eval_dir):
    _seed_eval_and_rating(eval_dir)
    rows = st.query_model_aggregates()
    assert len(rows) == 1
    assert rows[0]["model_id"] == "model-z"


def test_query_model_aggregates_prompt_filter(eval_dir):
    _seed_eval_and_rating(eval_dir)
    assert st.query_model_aggregates("pv1")
    assert st.query_model_aggregates("other") == []


def test_query_per_video_scores(eval_dir):
    _seed_eval_and_rating(eval_dir)
    rows = st.query_per_video_scores()
    assert len(rows) == 1
    assert rows[0]["video_id"] == "vid"


def test_query_per_video_scores_prompt_filter(eval_dir):
    _seed_eval_and_rating(eval_dir)
    assert len(st.query_per_video_scores("pv1")) == 1
    assert st.query_per_video_scores("nope") == []


def test_query_prompt_versions(eval_dir):
    assert st.query_prompt_versions() == []
    _seed_eval_and_rating(eval_dir)
    assert "pv1" in st.query_prompt_versions()


def test_init_db_idempotent(eval_dir):
    st.init_db()
    st.init_db()
