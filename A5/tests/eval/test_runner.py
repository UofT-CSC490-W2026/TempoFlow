"""Tests for `src.eval.runner`."""

from __future__ import annotations

import base64
import contextlib
import json
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import src.eval.runner as runner

_GEM = "src.gemini_move_feedback"


@pytest.fixture
def tmp_clips(tmp_path):
    ref = tmp_path / "ref.mp4"
    user = tmp_path / "user.mp4"
    ref.write_bytes(b"fake")
    user.write_bytes(b"fake")
    return str(ref), str(user)


def _minimal_ebs():
    return {
        "alignment": {
            "clip_1_start_sec": 0.0,
            "clip_2_start_sec": 0.0,
        },
        "segments": [
            {
                "shared_start_sec": 0.0,
                "shared_end_sec": 1.0,
            }
        ],
    }


@contextlib.contextmanager
def _pipeline_mocks(
    *,
    derive_moves,
    format_windows,
    prepare_clip,
    call_model,
    write_eval=None,
    guardrails=None,
):
    we = MagicMock() if write_eval is None else write_eval
    g = guardrails or (lambda r, p: r)
    with (
        patch(f"{_GEM}.derive_moves_for_segment", return_value=derive_moves),
        patch(f"{_GEM}.format_move_windows", return_value=format_windows),
        patch(f"{_GEM}.prepare_segment_clip", side_effect=prepare_clip),
        patch("src.eval.runner._call_model", side_effect=call_model),
        patch(f"{_GEM}.apply_move_feedback_guardrails", side_effect=g),
        patch("src.eval.runner.write_evaluation", we),
    ):
        yield we


def test_run_pipeline_segment_out_of_range(tmp_clips):
    ref, user = tmp_clips
    art = _minimal_ebs()
    with pytest.raises(ValueError, match="segment_index"):
        runner.run_move_feedback_pipeline(ref, user, art, segment_index=99)


def test_run_pipeline_no_moves(tmp_clips):
    ref, user = tmp_clips
    with _pipeline_mocks(
        derive_moves=[],
        format_windows=("t", []),
        prepare_clip=lambda *a, **k: "/x.mp4",
        call_model=lambda *a, **k: {},
    ):
        out = runner.run_move_feedback_pipeline(ref, user, _minimal_ebs(), 0)
    assert out.get("error") == "No moves found in segment"


def test_run_pipeline_baseline_branch_unlink_oserror(tmp_clips, monkeypatch, eval_dir):
    monkeypatch.setattr(runner, "EVAL_MODELS", ["gemini-2.5-flash-lite"])
    ref_p, user_p = tmp_clips
    ref_clip = str(eval_dir / "os_ref.mp4")
    user_clip = str(eval_dir / "os_user.mp4")
    Path(ref_clip).write_bytes(b"x")
    Path(user_clip).write_bytes(b"y")

    def fake_prepare(path, start, end, **kwargs):
        return ref_clip if path == ref_p else user_clip

    def bad_unlink(self, *a, **kw):
        raise OSError("cannot unlink")

    baseline = {"moves": [{"move_index": 1}]}
    with (
        _pipeline_mocks(
            derive_moves=[{"x": 1}],
            format_windows=("t", [{"shared_start_sec": 0.0, "shared_end_sec": 1.0}]),
            prepare_clip=fake_prepare,
            call_model=lambda *a, **k: baseline,
        ),
        patch.object(Path, "unlink", bad_unlink),
    ):
        runner.run_move_feedback_pipeline(ref_p, user_p, _minimal_ebs(), 0)


def test_run_pipeline_baseline_only_unlinks_clips(tmp_clips, monkeypatch, eval_dir):
    monkeypatch.setattr(runner, "EVAL_MODELS", ["gemini-2.5-flash-lite"])
    ref_p, user_p = tmp_clips
    ref_clip = str(eval_dir / "c_ref.mp4")
    user_clip = str(eval_dir / "c_user.mp4")
    Path(ref_clip).write_bytes(b"x")
    Path(user_clip).write_bytes(b"y")

    def fake_prepare(path, start, end, **kwargs):
        return ref_clip if path == ref_p else user_clip

    baseline = {"moves": [{"move_index": 1, "micro_timing_label": "on-time"}]}
    with _pipeline_mocks(
        derive_moves=[{"x": 1}],
        format_windows=("text", [{"shared_start_sec": 0.0, "shared_end_sec": 1.0}]),
        prepare_clip=fake_prepare,
        call_model=lambda *a, **k: baseline,
    ):
        out = runner.run_move_feedback_pipeline(ref_p, user_p, _minimal_ebs(), 0)

    assert out.get("model") == "gemini-2.5-flash-lite"
    assert not Path(ref_clip).exists()
    assert not Path(user_clip).exists()


def test_run_pipeline_background_runs_other_models(tmp_clips, monkeypatch, eval_dir):
    monkeypatch.setattr(runner, "EVAL_MODELS", ["gemini-2.5-flash-lite", "gemini-2.5-flash"])
    monkeypatch.setenv("OPENAI_API_KEY", "")
    ref_p, user_p = tmp_clips
    ref_clip = str(eval_dir / "cr.mp4")
    user_clip = str(eval_dir / "cu.mp4")
    Path(ref_clip).write_bytes(b"x")
    Path(user_clip).write_bytes(b"y")

    def fake_prepare(path, start, end, **kwargs):
        return ref_clip if path == ref_p else user_clip

    def sync_start(self):
        threading.Thread.run(self)

    baseline = {"moves": [{"move_index": 1}]}
    with (
        _pipeline_mocks(
            derive_moves=[{"x": 1}],
            format_windows=("t", [{"shared_start_sec": 0.0, "shared_end_sec": 0.5}]),
            prepare_clip=fake_prepare,
            call_model=lambda *a, **k: baseline,
        ),
        patch.object(threading.Thread, "start", sync_start),
    ):
        runner.run_move_feedback_pipeline(ref_p, user_p, _minimal_ebs(), 0)

    assert not Path(ref_clip).exists()


def test_run_single_model_failure_persists_error(tmp_clips, monkeypatch, eval_dir):
    monkeypatch.setattr(runner, "EVAL_MODELS", ["gemini-2.5-flash-lite"])
    ref_p, user_p = tmp_clips
    ref_clip = str(eval_dir / "e_ref.mp4")
    user_clip = str(eval_dir / "e_user.mp4")
    Path(ref_clip).write_bytes(b"x")
    Path(user_clip).write_bytes(b"y")

    def fake_prepare(path, start, end, **kwargs):
        return ref_clip if path == ref_p else user_clip

    we = MagicMock()
    with _pipeline_mocks(
        derive_moves=[{"x": 1}],
        format_windows=("t", [{"shared_start_sec": 0.0, "shared_end_sec": 0.5}]),
        prepare_clip=fake_prepare,
        call_model=MagicMock(side_effect=RuntimeError("api down")),
        write_eval=we,
    ):
        out = runner.run_move_feedback_pipeline(ref_p, user_p, _minimal_ebs(), 0)

    assert "error" in out
    assert we.called


def test_run_pipeline_optional_pose_yolo_text(tmp_clips, monkeypatch, eval_dir):
    monkeypatch.setattr(runner, "EVAL_MODELS", ["gemini-2.5-flash-lite"])
    ref_p, user_p = tmp_clips
    ref_clip = str(eval_dir / "p_ref.mp4")
    user_clip = str(eval_dir / "p_user.mp4")
    Path(ref_clip).write_bytes(b"x")
    Path(user_clip).write_bytes(b"y")

    def fake_prepare(path, start, end, **kwargs):
        return ref_clip if path == ref_p else user_clip

    captured = {}

    def grab_model(*args, **kwargs):
        captured["pose"] = kwargs.get("pose_priors_text")
        captured["yolo"] = kwargs.get("yolo_context_text")
        return {"moves": []}

    with (
        _pipeline_mocks(
            derive_moves=[{"x": 1}],
            format_windows=("t", [{"shared_start_sec": 0.0, "shared_end_sec": 0.5}]),
            prepare_clip=fake_prepare,
            call_model=grab_model,
        ),
        patch(f"{_GEM}.format_pose_priors_for_prompt", return_value="POSE"),
        patch(f"{_GEM}.format_yolo_context_for_prompt", return_value="YOLO"),
    ):
        runner.run_move_feedback_pipeline(
            ref_p,
            user_p,
            _minimal_ebs(),
            0,
            pose_priors={"a": 1},
            yolo_context={"b": 2},
            burn_in_labels=False,
            include_audio=True,
            low_res_height=240,
        )

    assert captured["pose"] == "POSE"
    assert captured["yolo"] == "YOLO"


def test_extract_frames_success(monkeypatch, tmp_path):
    ffmpeg = "/bin/ffmpeg"
    frame = tmp_path / "frame_0001.jpg"
    frame.write_bytes(b"\xff\xd8\xff")

    def fake_run(cmd, **kwargs):
        assert ffmpeg in cmd[0] or ffmpeg in cmd

    with (
        patch("src.ffmpeg_paths.resolve_ffmpeg_executable", return_value=ffmpeg),
        patch("src.eval.runner.tempfile.mkdtemp", return_value=str(tmp_path)),
        patch("src.eval.runner.subprocess.run", side_effect=fake_run),
        patch("src.eval.runner._glob.glob", return_value=[str(frame)]),
    ):
        out = runner._extract_frames("/clip.mp4", fps=2)

    assert len(out) == 1
    assert base64.b64decode(out[0]) == b"\xff\xd8\xff"


def test_extract_frames_rmdir_oserror(monkeypatch, tmp_path):
    ffmpeg = "/bin/ffmpeg"
    frame = tmp_path / "frame_0001.jpg"
    frame.write_bytes(b"jpeg")

    with (
        patch("src.ffmpeg_paths.resolve_ffmpeg_executable", return_value=ffmpeg),
        patch("src.eval.runner.tempfile.mkdtemp", return_value=str(tmp_path)),
        patch("src.eval.runner.subprocess.run"),
        patch("src.eval.runner._glob.glob", return_value=[str(frame)]),
        patch("src.eval.runner.os.rmdir", side_effect=OSError("busy")),
    ):
        runner._extract_frames("/c.mp4")


def test_call_openai_missing_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        runner._call_openai_model("a.mp4", "b.mp4", "txt", "gpt-5", "sys")


def test_call_openai_no_frames(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    with patch("src.eval.runner._extract_frames", return_value=[]):
        with pytest.raises(RuntimeError, match="no frames"):
            runner._call_openai_model("a.mp4", "b.mp4", "txt", "gpt-5", "sys")


def test_call_openai_http_error(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    mock_resp = MagicMock(status_code=500, text="err")
    mock_client = MagicMock()
    mock_client.post.return_value = mock_resp
    mock_cm = MagicMock()
    mock_cm.__enter__.return_value = mock_client
    mock_cm.__exit__.return_value = None

    with (
        patch("src.eval.runner._extract_frames", return_value=["YQ==", "Yg=="]),
        patch("src.eval.runner.httpx.Client", return_value=mock_cm),
    ):
        with pytest.raises(RuntimeError, match="OpenAI"):
            runner._call_openai_model("a.mp4", "b.mp4", "t", "gpt-5", "sys")


def test_call_openai_success(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    payload = {"moves": []}
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {
        "choices": [{"message": {"content": json.dumps(payload)}}],
    }
    mock_client = MagicMock()
    mock_client.post.return_value = mock_resp
    mock_cm = MagicMock()
    mock_cm.__enter__.return_value = mock_client
    mock_cm.__exit__.return_value = None

    with (
        patch("src.eval.runner._extract_frames", return_value=["YQ==", "Yg=="]),
        patch("src.eval.runner.httpx.Client", return_value=mock_cm),
    ):
        out = runner._call_openai_model(
            "a.mp4",
            "b.mp4",
            "mw",
            "gpt-5",
            "system",
            pose_priors_text="p",
            yolo_context_text="y",
        )
    assert out == payload


def test_call_model_dispatches_gpt(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    with patch("src.eval.runner._call_openai_model", return_value={"ok": True}) as m:
        out = runner._call_model("gpt-5", "a", "b", "t", "key", "sys")
    assert out == {"ok": True}
    m.assert_called_once()


def test_call_model_dispatches_gemini(monkeypatch):
    with patch(f"{_GEM}.call_gemini_move_feedback", return_value={"g": 1}) as m:
        out = runner._call_model("gemini-2.5-flash-lite", "a", "b", "t", "key", "sys")
    assert out == {"g": 1}
    m.assert_called_once()


def test_run_pipeline_uses_seg_clip_overrides(tmp_clips, monkeypatch, eval_dir):
    monkeypatch.setattr(runner, "EVAL_MODELS", ["gemini-2.5-flash-lite"])
    ref_p, user_p = tmp_clips
    art = {
        "alignment": {"clip_1_start_sec": 1.0, "clip_2_start_sec": 2.0},
        "segments": [
            {
                "shared_start_sec": 0.5,
                "shared_end_sec": 1.5,
                "clip_1_seg_start_sec": 0.1,
                "clip_1_seg_end_sec": 0.2,
                "clip_2_seg_start_sec": 0.3,
                "clip_2_seg_end_sec": 0.4,
            }
        ],
    }
    seen = []

    def fake_prepare(path, start, end, **kwargs):
        seen.append((path, start, end))
        p = str(eval_dir / f"{'r' if path == ref_p else 'u'}.mp4")
        Path(p).write_bytes(b"z")
        return p

    with _pipeline_mocks(
        derive_moves=[{"x": 1}],
        format_windows=("t", [{"shared_start_sec": 0.0, "shared_end_sec": 1.0}]),
        prepare_clip=fake_prepare,
        call_model=lambda *a, **k: {"moves": [{"move_index": 1}]},
    ):
        runner.run_move_feedback_pipeline(ref_p, user_p, art, 0)

    ref_calls = [x for x in seen if x[0] == ref_p]
    assert ref_calls[0][1:3] == (0.1, 0.2)


def test_background_unlink_handles_oserror(tmp_clips, monkeypatch, eval_dir):
    monkeypatch.setattr(runner, "EVAL_MODELS", ["gemini-2.5-flash-lite", "gemini-2.5-flash"])
    monkeypatch.setenv("OPENAI_API_KEY", "")
    ref_p, user_p = tmp_clips
    ref_clip = str(eval_dir / "u_ref.mp4")
    user_clip = str(eval_dir / "u_user.mp4")
    Path(ref_clip).write_bytes(b"x")
    Path(user_clip).write_bytes(b"y")

    def fake_prepare(path, start, end, **kwargs):
        return ref_clip if path == ref_p else user_clip

    def sync_start(self):
        threading.Thread.run(self)

    real_unlink = Path.unlink

    def picky_unlink(self, *a, **kw):
        if str(self) == ref_clip:
            raise OSError("perm")
        return real_unlink(self, *a, **kw)

    with (
        _pipeline_mocks(
            derive_moves=[{"x": 1}],
            format_windows=("t", [{"shared_start_sec": 0.0, "shared_end_sec": 0.5}]),
            prepare_clip=fake_prepare,
            call_model=lambda *a, **k: {"moves": [{"move_index": 1}]},
        ),
        patch.object(threading.Thread, "start", sync_start),
        patch.object(Path, "unlink", picky_unlink),
    ):
        runner.run_move_feedback_pipeline(ref_p, user_p, _minimal_ebs(), 0)
