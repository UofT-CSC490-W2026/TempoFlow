import json
import os
import sys
import types
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from src import gemini_move_feedback as gm


def test_ffmpeg_available_via_shutil_which(monkeypatch):
    monkeypatch.setattr(gm, "resolve_ffmpeg_executable", lambda: "ffmpeg")
    monkeypatch.setattr(gm.shutil, "which", lambda exe: "/usr/bin/ffmpeg")
    assert gm._ffmpeg_available() == "ffmpeg"


def test_ffmpeg_available_via_subprocess_probe(monkeypatch):
    monkeypatch.setattr(gm, "resolve_ffmpeg_executable", lambda: "ffmpeg-probe")
    monkeypatch.setattr(gm.shutil, "which", lambda exe: None)
    monkeypatch.setattr(gm.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0))
    assert gm._ffmpeg_available() == "ffmpeg-probe"


def test_ffmpeg_available_none_when_missing(monkeypatch):
    monkeypatch.setattr(gm, "resolve_ffmpeg_executable", lambda: "nope-ffmpeg")
    monkeypatch.setattr(gm.shutil, "which", lambda exe: None)

    def _raise(*_a, **_k):
        raise FileNotFoundError()

    monkeypatch.setattr(gm.subprocess, "run", _raise)
    assert gm._ffmpeg_available() is None


def test_prepare_clip_ffmpeg_success(monkeypatch, tmp_path):
    out = tmp_path / "out.mp4"
    calls = {}

    def _run(cmd, **kwargs):
        calls["cmd"] = cmd
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(gm.subprocess, "run", _run)
    result = gm._prepare_clip_ffmpeg(
        video_path="in.mp4",
        start_sec=1.0,
        end_sec=2.0,
        output_path=str(out),
        height=gm.LOW_RES_HEIGHT,
        ffmpeg="ffmpeg",
    )
    assert result == str(out)
    assert calls["cmd"][0] == "ffmpeg"


def test_prepare_clip_ffmpeg_raises_on_error(monkeypatch, tmp_path):
    out = tmp_path / "out.mp4"

    def _run(*_a, **_k):
        return SimpleNamespace(returncode=1, stderr="boom")

    monkeypatch.setattr(gm.subprocess, "run", _run)
    with pytest.raises(RuntimeError, match="ffmpeg clip preparation failed"):
        gm._prepare_clip_ffmpeg("in.mp4", 0.0, 1.0, str(out), 360, "ffmpeg")


def test_prepare_clip_ffmpeg_retries_without_drawtext_when_filter_missing(monkeypatch, tmp_path):
    """Homebrew ffmpeg often lacks drawtext; we retry once without burn-in."""
    out = tmp_path / "out.mp4"
    attempts = {"n": 0}

    def _run(*_a, **_k):
        attempts["n"] += 1
        if attempts["n"] == 1:
            return SimpleNamespace(returncode=1, stderr="No such filter: 'drawtext'")
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(gm.subprocess, "run", _run)
    gm._prepare_clip_ffmpeg(
        "in.mp4",
        0.0,
        1.0,
        str(out),
        gm.LOW_RES_HEIGHT,
        "ffmpeg",
        burn_in_text="REF",
    )
    assert attempts["n"] == 2


def test_ffmpeg_has_drawtext_detects_filter(monkeypatch):
    gm._FFMPEG_DRAWTEXT_CACHE.clear()

    def _run(cmd, **_k):
        if "-filters" in cmd:
            return SimpleNamespace(stdout=" TSC drawtext        V->V       Draw text\n", stderr="", returncode=0)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(gm.subprocess, "run", _run)
    assert gm._ffmpeg_has_drawtext("myffmpeg") is True
    assert gm._ffmpeg_has_drawtext("myffmpeg") is True  # cached


def test_ffmpeg_has_drawtext_false_without_filter(monkeypatch):
    gm._FFMPEG_DRAWTEXT_CACHE.clear()
    monkeypatch.setattr(
        gm.subprocess,
        "run",
        lambda *a, **k: SimpleNamespace(stdout="  scale  V->V  Scale\n", stderr="", returncode=0),
    )
    assert gm._ffmpeg_has_drawtext("ff") is False


def _install_mock_cv2(
    monkeypatch,
    *,
    open_ok=True,
    writer_ok=True,
    fps=30.0,
    frames=3,
    src_w=640,
    src_h=720,
    msec_step=200.0,
):
    class MockCap:
        def __init__(self, _path):
            self._opened = open_ok
            self._msec = 0.0
            self._idx = 0

        def isOpened(self):
            return self._opened

        def get(self, prop):
            if prop == mock_cv2.CAP_PROP_FPS:
                return fps
            if prop == mock_cv2.CAP_PROP_FRAME_WIDTH:
                return src_w
            if prop == mock_cv2.CAP_PROP_FRAME_HEIGHT:
                return src_h
            if prop == mock_cv2.CAP_PROP_POS_MSEC:
                return self._msec
            return 0.0

        def set(self, prop, value):
            if prop == mock_cv2.CAP_PROP_POS_MSEC:
                self._msec = float(value)

        def read(self):
            if self._idx >= frames:
                return False, None
            self._idx += 1
            self._msec += msec_step
            return True, {"frame": self._idx}

        def release(self):
            return None

    class MockWriter:
        def __init__(self, *_a, **_k):
            self._opened = writer_ok
            self.writes = 0

        def isOpened(self):
            return self._opened

        def write(self, _frame):
            self.writes += 1

        def release(self):
            return None

    mock_cv2 = types.SimpleNamespace(
        VideoCapture=MockCap,
        VideoWriter=MockWriter,
        VideoWriter_fourcc=lambda *a: 1234,
        resize=MagicMock(side_effect=lambda frame, size, interpolation=None: frame),
        INTER_AREA=1,
        CAP_PROP_FPS=5,
        CAP_PROP_FRAME_WIDTH=3,
        CAP_PROP_FRAME_HEIGHT=4,
        CAP_PROP_POS_MSEC=0,
    )
    monkeypatch.setitem(sys.modules, "cv2", mock_cv2)
    return mock_cv2


def test_prepare_clip_opencv_raises_when_cannot_open(monkeypatch, tmp_path):
    _install_mock_cv2(monkeypatch, open_ok=False)
    with pytest.raises(RuntimeError, match="OpenCV cannot open"):
        gm._prepare_clip_opencv("in.mp4", 0.0, 1.0, str(tmp_path / "o.mp4"), 360)


def test_prepare_clip_opencv_writer_open_fail(monkeypatch, tmp_path):
    _install_mock_cv2(monkeypatch, open_ok=True, writer_ok=False)
    with pytest.raises(RuntimeError, match="VideoWriter failed to open"):
        gm._prepare_clip_opencv("in.mp4", 0.0, 1.0, str(tmp_path / "o.mp4"), 360)


def test_prepare_clip_opencv_resizes_when_scaling_down(monkeypatch, tmp_path):
    mock_cv2 = _install_mock_cv2(monkeypatch, open_ok=True, writer_ok=True, frames=2)
    out = gm._prepare_clip_opencv("in.mp4", 0.0, 10.0, str(tmp_path / "o.mp4"), height=360)
    assert out.endswith(".mp4")
    assert mock_cv2.resize.called


def test_prepare_clip_opencv_rounds_width_to_even_and_stops_at_end(monkeypatch, tmp_path):
    # Pick src_h such that scale makes out_w odd:
    # scale = 360 / 721 ~= 0.4993; out_w=int(640*scale)=319 (odd) -> +1 branch
    mock_cv2 = _install_mock_cv2(
        monkeypatch,
        open_ok=True,
        writer_ok=True,
        frames=5,
        src_w=640,
        src_h=721,
        msec_step=200.0,
    )
    # end_sec small so pos_sec > end_sec triggers the early break
    out = gm._prepare_clip_opencv("in.mp4", 0.0, 0.1, str(tmp_path / "o.mp4"), height=360)
    assert out.endswith(".mp4")
    assert not mock_cv2.resize.called


def test_prepare_segment_clip_uses_ffmpeg_when_available(monkeypatch, tmp_path):
    monkeypatch.setattr(gm, "_ffmpeg_available", lambda: "ffmpeg")
    monkeypatch.setattr(gm, "_prepare_clip_ffmpeg", lambda *a, **k: "ffmpeg_out.mp4")
    out = gm.prepare_segment_clip("in.mp4", 0.0, 1.0, output_path=str(tmp_path / "x.mp4"))
    assert out == "ffmpeg_out.mp4"


def test_prepare_segment_clip_creates_tempfile_when_output_path_none(monkeypatch):
    created = {}

    class _Tmp:
        def __init__(self):
            self.name = "temp_created.mp4"

        def close(self):
            created["closed"] = True

    monkeypatch.setattr(gm.tempfile, "NamedTemporaryFile", lambda **_k: _Tmp())
    monkeypatch.setattr(gm, "_ffmpeg_available", lambda: "ffmpeg")
    monkeypatch.setattr(gm, "_prepare_clip_ffmpeg", lambda *a, **k: a[3])

    out = gm.prepare_segment_clip("in.mp4", 0.0, 1.0, output_path=None)
    assert out == "temp_created.mp4"
    assert created["closed"] is True


def test_prepare_segment_clip_falls_back_to_opencv(monkeypatch, tmp_path):
    monkeypatch.setattr(gm, "_ffmpeg_available", lambda: None)
    monkeypatch.setattr(gm, "_prepare_clip_opencv", lambda *a, **k: "cv_out.mp4")
    out = gm.prepare_segment_clip("in.mp4", 0.0, 1.0, output_path=str(tmp_path / "x.mp4"))
    assert out == "cv_out.mp4"


def test_derive_moves_for_segment_validation():
    with pytest.raises(ValueError, match="out of range"):
        gm.derive_moves_for_segment({"segments": []}, 0)

    with pytest.raises(ValueError, match="no beat_idx_range"):
        gm.derive_moves_for_segment({"segments": [{}], "beats_shared_sec": [0.0, 1.0]}, 0)


def test_derive_moves_for_segment_breaks_when_beats_short():
    artifact = {
        "segments": [{"beat_idx_range": (0, 10)}],
        "beats_shared_sec": [0.0, 0.5, 1.0],
    }
    moves = gm.derive_moves_for_segment(artifact, 0)
    assert [m["move_index"] for m in moves] == [1, 2]


def test_fmt_time_and_format_move_windows():
    assert gm._fmt_time(0.0) == "00:00.0"
    assert gm._fmt_time(61.2) == "01:01.2"

    moves = [{"move_index": 1, "shared_start_sec": 10.0, "shared_end_sec": 10.6}]
    text, annotated = gm.format_move_windows(moves, seg_shared_start=10.0)
    assert "1. 00:00.0-00:00.6" in text
    assert annotated[0]["time_window"] == "00:00.0-00:00.6"


def test_resolve_api_key_from_arg_and_env(monkeypatch):
    assert gm._resolve_api_key("x") == "x"
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="No Gemini API key"):
        gm._resolve_api_key(None)
    monkeypatch.setenv("GOOGLE_API_KEY", "envkey")
    assert gm._resolve_api_key(None) == "envkey"


def test_wait_for_file_active_success(monkeypatch):
    genai = types.SimpleNamespace(get_file=MagicMock())
    monkeypatch.setitem(sys.modules, "google.generativeai", genai)

    # PROCESSING -> ACTIVE
    ref1 = SimpleNamespace(name="f1", state=SimpleNamespace(name="PROCESSING"))
    ref2 = SimpleNamespace(name="f1", state=SimpleNamespace(name="ACTIVE"))
    genai.get_file.return_value = ref2

    monkeypatch.setattr(gm.time, "sleep", lambda *_a, **_k: None)
    monkeypatch.setattr(gm.time, "monotonic", lambda: 0.0)
    active = gm._wait_for_file_active(ref1, timeout=5)
    assert active.state.name == "ACTIVE"


def test_wait_for_file_active_timeout(monkeypatch):
    genai = types.SimpleNamespace(get_file=MagicMock())
    monkeypatch.setitem(sys.modules, "google.generativeai", genai)
    ref = SimpleNamespace(name="f1", state=SimpleNamespace(name="PROCESSING"))
    genai.get_file.return_value = ref

    times = iter([0.0, 999.0])
    monkeypatch.setattr(gm.time, "monotonic", lambda: next(times))
    monkeypatch.setattr(gm.time, "sleep", lambda *_a, **_k: None)
    with pytest.raises(TimeoutError, match="still PROCESSING"):
        gm._wait_for_file_active(ref, timeout=1)


def test_wait_for_file_active_unexpected_state(monkeypatch):
    genai = types.SimpleNamespace(get_file=MagicMock())
    monkeypatch.setitem(sys.modules, "google.generativeai", genai)
    ref = SimpleNamespace(name="f1", state=SimpleNamespace(name="FAILED"))
    with pytest.raises(RuntimeError, match="unexpected state"):
        gm._wait_for_file_active(ref, timeout=1)


def test_parse_gemini_json_variants():
    assert gm._parse_gemini_json('{"a": 1}') == {"a": 1}
    fenced = "```json\n{ \"moves\": [] }\n```"
    assert gm._parse_gemini_json(fenced) == {"moves": []}
    with pytest.raises(ValueError, match="non-JSON"):
        gm._parse_gemini_json("not json")


def test_call_gemini_move_feedback_happy_path_and_cleanup(monkeypatch):
    class MockModel:
        def __init__(self, *a, **k):
            pass

        def generate_content(self, *_a, **_k):
            return SimpleNamespace(text='{"moves": []}')

    deleted = []

    def _delete_file(name):
        deleted.append(name)
        if name == "user":
            raise RuntimeError("delete failed")

    genai = types.SimpleNamespace(
        configure=MagicMock(),
        upload_file=MagicMock(side_effect=[SimpleNamespace(name="ref", state=SimpleNamespace(name="ACTIVE")), SimpleNamespace(name="user", state=SimpleNamespace(name="ACTIVE"))]),
        delete_file=_delete_file,
        get_file=MagicMock(),
        GenerativeModel=MockModel,
        GenerationConfig=lambda **k: k,
    )
    monkeypatch.setitem(sys.modules, "google.generativeai", genai)
    monkeypatch.setattr(gm, "_resolve_api_key", lambda api_key: "k")
    monkeypatch.setattr(gm, "_wait_for_file_active", lambda f: f)

    result = gm.call_gemini_move_feedback("r.mp4", "u.mp4", "moves text", api_key=None, model_name="m")
    assert result == {"moves": []}
    assert set(deleted) == {"ref", "user"}


def test_run_move_feedback_pipeline_out_of_range():
    with pytest.raises(ValueError, match="out of range"):
        gm.run_move_feedback_pipeline(
            ref_video_path="r.mp4",
            user_video_path="u.mp4",
            ebs_artifact={"segments": [], "alignment": {}},
            segment_index=0,
        )


def test_run_move_feedback_pipeline_no_moves(monkeypatch):
    monkeypatch.setattr(gm, "derive_moves_for_segment", lambda *_a, **_k: [])
    out = gm.run_move_feedback_pipeline(
        ref_video_path="r.mp4",
        user_video_path="u.mp4",
        ebs_artifact={
            "alignment": {"clip_1_start_sec": 0.0, "clip_2_start_sec": 0.0},
            "segments": [{"shared_start_sec": 1.0, "shared_end_sec": 2.0, "beat_idx_range": (0, 1)}],
            "beats_shared_sec": [1.0, 2.0],
        },
        segment_index=0,
    )
    assert out["error"] == "No moves found in segment"
    assert out["moves"] == []


def test_run_move_feedback_pipeline_success_and_enriches_moves(monkeypatch):
    ebs = {
        "alignment": {"clip_1_start_sec": 10.0, "clip_2_start_sec": 20.0},
        "segments": [{"shared_start_sec": 1.0, "shared_end_sec": 2.0, "beat_idx_range": (0, 1)}],
        "beats_shared_sec": [1.0, 1.5],
    }
    monkeypatch.setattr(
        gm,
        "derive_moves_for_segment",
        lambda *_a, **_k: [{"move_index": 1, "shared_start_sec": 1.0, "shared_end_sec": 1.5}],
    )
    annotated = [{"move_index": 1, "shared_start_sec": 1.0, "shared_end_sec": 1.5, "time_window": "00:00.0-00:00.5"}]
    monkeypatch.setattr(gm, "format_move_windows", lambda *_a, **_k: ("txt", annotated))
    monkeypatch.setattr(gm, "prepare_segment_clip", lambda *_a, **_k: "tmp.mp4")
    monkeypatch.setattr(gm, "call_gemini_move_feedback", lambda *_a, **_k: {"moves": [{"move_index": 1, "micro_timing_label": "on-time"}]})

    unlinked = []

    def _unlink(self, missing_ok=False):
        unlinked.append(str(self))

    monkeypatch.setattr(gm.Path, "unlink", _unlink, raising=False)

    result = gm.run_move_feedback_pipeline("r.mp4", "u.mp4", ebs, segment_index=0, model_name="x")
    assert result["segment_index"] == 0
    assert result["model"] == "x"
    assert result["moves"][0]["shared_start_sec"] == 1.0
    assert result["moves"][0]["shared_end_sec"] == 1.5
    assert len(unlinked) == 2


def test_run_move_feedback_pipeline_cleans_up_on_exception(monkeypatch):
    ebs = {
        "alignment": {"clip_1_start_sec": 0.0, "clip_2_start_sec": 0.0},
        "segments": [{"shared_start_sec": 1.0, "shared_end_sec": 2.0, "beat_idx_range": (0, 1)}],
        "beats_shared_sec": [1.0, 1.5],
    }
    monkeypatch.setattr(
        gm,
        "derive_moves_for_segment",
        lambda *_a, **_k: [{"move_index": 1, "shared_start_sec": 1.0, "shared_end_sec": 1.5}],
    )
    monkeypatch.setattr(gm, "format_move_windows", lambda *_a, **_k: ("txt", [{"move_index": 1, "shared_start_sec": 1.0, "shared_end_sec": 1.5}]))

    tmp_iter = iter(["a.mp4", "b.mp4"])
    monkeypatch.setattr(gm, "prepare_segment_clip", lambda *_a, **_k: next(tmp_iter))
    monkeypatch.setattr(gm, "call_gemini_move_feedback", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("boom")))

    unlinked = []

    def _unlink(self, missing_ok=False):
        unlinked.append(str(self))

    monkeypatch.setattr(gm.Path, "unlink", _unlink, raising=False)

    with pytest.raises(RuntimeError, match="boom"):
        gm.run_move_feedback_pipeline("r.mp4", "u.mp4", ebs, segment_index=0)
    assert unlinked == ["a.mp4", "b.mp4"]


def test_run_move_feedback_pipeline_cleanup_ignores_oserror(monkeypatch):
    ebs = {
        "alignment": {"clip_1_start_sec": 0.0, "clip_2_start_sec": 0.0},
        "segments": [{"shared_start_sec": 1.0, "shared_end_sec": 2.0, "beat_idx_range": (0, 1)}],
        "beats_shared_sec": [1.0, 1.5],
    }
    monkeypatch.setattr(
        gm,
        "derive_moves_for_segment",
        lambda *_a, **_k: [{"move_index": 1, "shared_start_sec": 1.0, "shared_end_sec": 1.5}],
    )
    monkeypatch.setattr(gm, "format_move_windows", lambda *_a, **_k: ("txt", [{"move_index": 1, "shared_start_sec": 1.0, "shared_end_sec": 1.5}]))
    tmp_iter = iter(["a.mp4", "b.mp4"])
    monkeypatch.setattr(gm, "prepare_segment_clip", lambda *_a, **_k: next(tmp_iter))
    monkeypatch.setattr(gm, "call_gemini_move_feedback", lambda *_a, **_k: {"moves": []})

    def _unlink(self, missing_ok=False):
        raise OSError("nope")

    monkeypatch.setattr(gm.Path, "unlink", _unlink, raising=False)
    # Should not raise due to cleanup failure
    out = gm.run_move_feedback_pipeline("r.mp4", "u.mp4", ebs, segment_index=0)
    assert out["moves"] == []


def test_format_pose_priors_for_prompt():
    assert gm.format_pose_priors_for_prompt(None) == ""
    assert gm.format_pose_priors_for_prompt({}) == ""
    text = gm.format_pose_priors_for_prompt(
        {
            "moves": [
                {
                    "move_index": 1,
                    "user_relative_to_reference": "behind",
                    "phase_offset_ms": 40.0,
                    "prior_confidence": "medium",
                }
            ]
        }
    )
    assert "Move 1" in text
    assert "behind" in text


def test_format_yolo_context_for_prompt():
    assert gm.format_yolo_context_for_prompt(None) == ""
    text = gm.format_yolo_context_for_prompt(
        {
            "segment_index": 0,
            "source": "yolo-hybrid-segment",
            "reference": {"segmentation": {"person_count": 1}},
            "practice": {"segmentation": {"person_count": 2}},
        }
    )
    assert "YOLO segment context" in text
    assert '"segment_index":0' in text
    assert '"person_count":2' in text


def test_apply_move_feedback_guardrails_conflict_downgrades():
    result = {
        "moves": [
            {"move_index": 1, "micro_timing_label": "late", "confidence": "high"},
        ]
    }
    priors = {
        "moves": [
            {
                "move_index": 1,
                "user_relative_to_reference": "ahead",
                "phase_offset_ms": 80.0,
                "prior_confidence": "high",
            }
        ]
    }
    out = gm.apply_move_feedback_guardrails(result, priors)
    assert out["moves"][0]["confidence"] == "low"
    assert "guardrail_note" in out["moves"][0]


def test_apply_move_feedback_guardrails_no_conflict():
    result = {
        "moves": [
            {"move_index": 1, "micro_timing_label": "late", "confidence": "high"},
        ]
    }
    priors = {
        "moves": [
            {
                "move_index": 1,
                "user_relative_to_reference": "behind",
                "phase_offset_ms": 80.0,
                "prior_confidence": "high",
            }
        ]
    }
    out = gm.apply_move_feedback_guardrails(result, priors)
    assert out["moves"][0]["confidence"] == "high"
