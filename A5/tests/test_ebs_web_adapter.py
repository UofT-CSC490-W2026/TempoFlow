import io
import importlib
import json
import sys
import types
import asyncio
from types import SimpleNamespace

import pytest


def _install_mock_numpy_and_librosa(monkeypatch):
    """
    This repo's Python environment can hard-crash when importing the real numpy.
    `src/ebs_web_adapter.py` imports numpy+librosa at import time, so we provide
    minimal mocks sufficient for unit tests and branch coverage.
    """

    class _MockNDArray(list):
        # Just enough to support len() and slicing used in the module
        pass

    def _zeros(n, dtype=None):
        return _MockNDArray([0.0] * int(n))

    def _clip(x, a, b):
        # x may be scalar
        return max(a, min(b, x))

    def _searchsorted(arr, x, side="left"):
        # arr is a sorted python list
        if side == "left":
            for i, v in enumerate(arr):
                if v >= x:
                    return i
            return len(arr)
        raise AssertionError("only side='left' used")

    def _linspace(start, end, num):
        num = int(num)
        if num <= 1:
            return [float(start)]
        step = (float(end) - float(start)) / (num - 1)
        return [float(start) + i * step for i in range(num)]

    mock_np = types.ModuleType("numpy")
    mock_np.ndarray = _MockNDArray
    mock_np.zeros = _zeros
    mock_np.clip = _clip
    mock_np.searchsorted = _searchsorted
    mock_np.linspace = _linspace

    mock_librosa = types.ModuleType("librosa")
    mock_librosa.feature = types.SimpleNamespace(
        chroma_stft=lambda **_k: types.SimpleNamespace(shape=(12, 5))
    )
    mock_librosa.frames_to_time = lambda frame, **_k: float(frame) * 0.1
    mock_librosa.load = lambda *_a, **_k: (_zeros(10), 22050)

    monkeypatch.setitem(sys.modules, "numpy", mock_np)
    monkeypatch.setitem(sys.modules, "librosa", mock_librosa)


def _import_ebs_web_adapter(monkeypatch):
    _install_mock_numpy_and_librosa(monkeypatch)

    # Prevent importing heavy deps (sklearn/scipy) by stubbing the internal
    # alignment/segmentation modules that `ebs_web_adapter` imports.
    mock_alignment_core = types.ModuleType("src.alignment_and_segmentation.alignment_core")
    mock_alignment_core.perform_alignment = lambda *_a, **_k: (0, 1, 0, 1)
    monkeypatch.setitem(sys.modules, "src.alignment_and_segmentation.alignment_core", mock_alignment_core)

    mock_segmentation_core = types.ModuleType("src.alignment_and_segmentation.segmentation_core")
    mock_segmentation_core.estimate_downbeat_phase = lambda *_a, **_k: 0
    mock_segmentation_core.generate_segments = lambda *_a, **_k: ([], [])
    mock_segmentation_core.track_beats = lambda *_a, **_k: ([], 0.0, {"coefficient_of_variation": 1.0}, [], [])
    monkeypatch.setitem(sys.modules, "src.alignment_and_segmentation.segmentation_core", mock_segmentation_core)

    import src.ebs_web_adapter as mod

    return importlib.reload(mod)


def test_sanitize_json_replaces_nonfinite():
    mp = pytest.MonkeyPatch()
    try:
        ewa = _import_ebs_web_adapter(mp)
        obj = {"a": float("inf"), "b": [1.0, float("nan")], "c": {"d": -float("inf")}, "e": "x"}
        out = ewa.sanitize_json(obj)
        assert out == {"a": None, "b": [1.0, None], "c": {"d": None}, "e": "x"}
    finally:
        mp.undo()


def test_save_upload_writes_bytes_and_suffix(monkeypatch, tmp_path):
    ewa = _import_ebs_web_adapter(monkeypatch)
    captured = {}

    class _Tmp:
        def __init__(self, name):
            self.name = name
            self._buf = io.BytesIO()

        def write(self, b):
            captured["bytes"] = b
            return self._buf.write(b)

        def close(self):
            captured["closed"] = True

    def _ntf(prefix, suffix, delete):
        assert prefix.startswith("ebs_ref_")
        assert suffix == ".mp4"
        assert delete is False
        return _Tmp(str(tmp_path / "x.mp4"))

    monkeypatch.setattr(ewa.tempfile, "NamedTemporaryFile", _ntf)
    upload = SimpleNamespace(filename="v.mp4", file=io.BytesIO(b"abc"))
    p = ewa.save_upload(upload, "ref")
    assert p.endswith(".mp4")
    assert captured["bytes"] == b"abc"
    assert captured["closed"] is True


def test_save_upload_defaults_suffix_when_missing(monkeypatch, tmp_path):
    ewa = _import_ebs_web_adapter(monkeypatch)
    def _ntf(prefix, suffix, delete):
        assert suffix == ".mp4"
        return SimpleNamespace(name=str(tmp_path / "x.mp4"), write=lambda b: None, close=lambda: None)

    monkeypatch.setattr(ewa.tempfile, "NamedTemporaryFile", _ntf)
    upload = SimpleNamespace(filename=None, file=io.BytesIO(b"abc"))
    assert ewa.save_upload(upload, "ref").endswith(".mp4")


def test_save_upload_async_writes_bytes(monkeypatch, tmp_path):
    ewa = _import_ebs_web_adapter(monkeypatch)
    captured = {}

    class _Tmp:
        def __init__(self, name):
            self.name = name

        def write(self, b):
            captured["bytes"] = b
            return len(b)

        def close(self):
            captured["closed"] = True

    monkeypatch.setattr(
        ewa.tempfile,
        "NamedTemporaryFile",
        lambda prefix, suffix, delete: _Tmp(str(tmp_path / "async.mp4")),
    )

    async def _run():
        upload = SimpleNamespace(filename="v.mp4", read=lambda: asyncio.sleep(0, result=b"xyz"))
        return await ewa.save_upload_async(upload, "ref")

    p = asyncio.run(_run())
    assert p.endswith(".mp4")
    assert captured["bytes"] == b"xyz"
    assert captured["closed"] is True


def test_extract_audio_from_video_success(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)
    monkeypatch.setattr(ewa, "resolve_ffmpeg_executable", lambda: "ffmpeg")

    class _Tmp:
        name = "out.wav"

        def close(self):
            return None

    monkeypatch.setattr(ewa.tempfile, "NamedTemporaryFile", lambda **_k: _Tmp())

    calls = {}

    def _run(cmd, **kwargs):
        calls["cmd"] = cmd
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(ewa.subprocess, "run", _run)
    out = ewa.extract_audio_from_video("in.mp4", sr=123)
    assert out == "out.wav"
    assert calls["cmd"][0] == "ffmpeg"


def test_extract_audio_from_video_raises_on_ffmpeg_error(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)
    monkeypatch.setattr(ewa, "resolve_ffmpeg_executable", lambda: "ffmpeg")

    class _Tmp:
        name = "out.wav"

        def close(self):
            return None

    monkeypatch.setattr(ewa.tempfile, "NamedTemporaryFile", lambda **_k: _Tmp())
    monkeypatch.setattr(
        ewa.subprocess,
        "run",
        lambda *_a, **_k: SimpleNamespace(returncode=1, stderr="bad"),
    )
    with pytest.raises(RuntimeError, match="ffmpeg extraction failed"):
        ewa.extract_audio_from_video("in.mp4")


def test_extract_audio_pair_returns_ref_and_user_outputs(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)
    seen = []

    def _extract(path, sr=None):
        seen.append((path, sr))
        return f"{path}.{sr}.wav"

    monkeypatch.setattr(ewa, "extract_audio_from_video", _extract)
    ref_wav, user_wav = ewa.extract_audio_pair("ref.mp4", "user.mp4", 12345)
    assert ref_wav == "ref.mp4.12345.wav"
    assert user_wav == "user.mp4.12345.wav"
    assert sorted(seen) == [("ref.mp4", 12345), ("user.mp4", 12345)]


def test_probe_video_metadata_happy_path_nb_frames_digit(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)
    monkeypatch.setattr(ewa, "resolve_ffprobe_executable", lambda: "ffprobe")
    payload = {"streams": [{"avg_frame_rate": "30000/1001", "nb_frames": "12", "duration": "1.0", "width": 1920, "height": 1080}]}
    monkeypatch.setattr(
        ewa.subprocess,
        "run",
        lambda *_a, **_k: SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr=""),
    )
    meta = ewa.probe_video_metadata("v.mp4")
    assert meta["frame_count"] == 12
    assert meta["fps"] > 0
    assert meta["width"] == 1920
    assert meta["height"] == 1080


def test_probe_video_metadata_uses_duration_times_fps_when_nb_frames_missing(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)
    monkeypatch.setattr(ewa, "resolve_ffprobe_executable", lambda: "ffprobe")
    payload = {"streams": [{"avg_frame_rate": "10/1", "duration": "2.0", "width": 640, "height": 360}]}
    monkeypatch.setattr(
        ewa.subprocess,
        "run",
        lambda *_a, **_k: SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr=""),
    )
    meta = ewa.probe_video_metadata("v.mp4")
    assert meta["fps"] == 10.0
    assert meta["frame_count"] == 20


def test_probe_video_metadata_handles_den_zero_and_fps_zero(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)
    monkeypatch.setattr(ewa, "resolve_ffprobe_executable", lambda: "ffprobe")
    payload = {"streams": [{"avg_frame_rate": "1/0", "duration": "2.0", "width": 0, "height": 0}]}
    monkeypatch.setattr(
        ewa.subprocess,
        "run",
        lambda *_a, **_k: SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr=""),
    )
    meta = ewa.probe_video_metadata("v.mp4")
    assert meta["fps"] == 0.0
    assert meta["frame_count"] == 0


def test_probe_video_metadata_errors(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)
    monkeypatch.setattr(ewa, "resolve_ffprobe_executable", lambda: "ffprobe")
    monkeypatch.setattr(
        ewa.subprocess,
        "run",
        lambda *_a, **_k: SimpleNamespace(returncode=1, stdout="", stderr="nope"),
    )
    with pytest.raises(RuntimeError, match="ffprobe failed"):
        ewa.probe_video_metadata("v.mp4")

    monkeypatch.setattr(
        ewa.subprocess,
        "run",
        lambda *_a, **_k: SimpleNamespace(returncode=0, stdout=json.dumps({"streams": []}), stderr=""),
    )
    with pytest.raises(RuntimeError, match="No video stream found"):
        ewa.probe_video_metadata("v.mp4")


def test_compute_downscale_dimensions_returns_even_dimensions(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)
    dims = ewa._compute_downscale_dimensions({"width": 1920, "height": 1080})
    assert dims == (1280, 720)


def test_compute_downscale_dimensions_skips_small_or_invalid_videos(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)
    assert ewa._compute_downscale_dimensions({"width": 640, "height": 360}) is None
    assert ewa._compute_downscale_dimensions({"width": 0, "height": 360}) is None


def test_maybe_downscale_uploaded_video_transcodes_and_replaces_original(monkeypatch, tmp_path):
    ewa = _import_ebs_web_adapter(monkeypatch)
    original = tmp_path / "upload.mov"
    original.write_bytes(b"orig")
    scaled = tmp_path / "scaled.mp4"
    scaled.write_bytes(b"scaled")

    monkeypatch.setattr(
        ewa,
        "probe_video_metadata",
        lambda *_a, **_k: {"width": 1920, "height": 1080, "duration_sec": 10.0, "fps": 30.0, "frame_count": 300},
    )
    seen = {}

    def _transcode(path, width, height):
        seen["args"] = (path, width, height)
        return str(scaled)

    monkeypatch.setattr(ewa, "_transcode_video_for_upload", _transcode)
    result = ewa._maybe_downscale_uploaded_video(str(original))
    assert result == str(scaled)
    assert seen["args"] == (str(original), 1280, 720)
    assert not original.exists()


def test_maybe_downscale_uploaded_video_can_preserve_original(monkeypatch, tmp_path):
    ewa = _import_ebs_web_adapter(monkeypatch)
    original = tmp_path / "upload.mov"
    original.write_bytes(b"orig")
    scaled = tmp_path / "scaled.mp4"
    scaled.write_bytes(b"scaled")

    monkeypatch.setattr(
        ewa,
        "probe_video_metadata",
        lambda *_a, **_k: {"width": 1920, "height": 1080, "duration_sec": 10.0, "fps": 30.0, "frame_count": 300},
    )
    monkeypatch.setattr(ewa, "_transcode_video_for_upload", lambda *_a, **_k: str(scaled))
    result = ewa._maybe_downscale_uploaded_video(str(original), preserve_original=True)
    assert result == str(scaled)
    assert original.exists()


def test_maybe_downscale_uploaded_video_returns_original_when_not_needed(monkeypatch, tmp_path):
    ewa = _import_ebs_web_adapter(monkeypatch)
    original = tmp_path / "upload.mp4"
    original.write_bytes(b"orig")
    monkeypatch.setattr(
        ewa,
        "probe_video_metadata",
        lambda *_a, **_k: {"width": 640, "height": 360, "duration_sec": 10.0, "fps": 30.0, "frame_count": 300},
    )
    result = ewa._maybe_downscale_uploaded_video(str(original))
    assert result == str(original)
    assert original.exists()


def test_maybe_downscale_uploaded_video_falls_back_to_original_on_failure(monkeypatch, tmp_path):
    ewa = _import_ebs_web_adapter(monkeypatch)
    original = tmp_path / "upload.mp4"
    original.write_bytes(b"orig")
    monkeypatch.setattr(
        ewa,
        "probe_video_metadata",
        lambda *_a, **_k: {"width": 1920, "height": 1080, "duration_sec": 10.0, "fps": 30.0, "frame_count": 300},
    )
    monkeypatch.setattr(
        ewa,
        "_transcode_video_for_upload",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("ffmpeg failed")),
    )
    result = ewa._maybe_downscale_uploaded_video(str(original))
    assert result == str(original)
    assert original.exists()


def test_auto_align_swaps_and_clips_and_raises_when_shared_len_nonpositive(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)
    # Make chroma shapes small so clipping is exercised.
    monkeypatch.setattr(
        ewa.librosa.feature,
        "chroma_stft",
        lambda **_k: types.SimpleNamespace(shape=(12, 3)),
    )

    # Return inverted ranges so swaps happen, but after frames_to_time we'll force shared_len<=0.
    monkeypatch.setattr(ewa, "perform_alignment", lambda *_a, **_k: (2, 1, 2, 1))

    # frames_to_time returns same time for start/end -> shared_len==0 triggers ValueError
    monkeypatch.setattr(ewa.librosa, "frames_to_time", lambda *_a, **_k: 0.0)
    with pytest.raises(ValueError, match="shared alignment window"):
        ewa._auto_align([0.0] * 10, [0.0] * 10, sr=10)


def test_auto_align_happy_path(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)
    monkeypatch.setattr(
        ewa.librosa.feature,
        "chroma_stft",
        lambda **_k: types.SimpleNamespace(shape=(12, 5)),
    )
    monkeypatch.setattr(ewa, "perform_alignment", lambda *_a, **_k: (0, 4, 1, 3))

    def _frames_to_time(frame, **_k):
        return float(frame) * 0.1

    monkeypatch.setattr(ewa.librosa, "frames_to_time", _frames_to_time)
    out = ewa._auto_align([0.0] * 100, [0.0] * 80, sr=10)
    assert out["auto_align_mode"] == "chroma_sw"
    assert out["clip_1_end_sec"] > out["clip_1_start_sec"]


def test_build_fallback_segments_and_ensure_starts_at_zero():
    mp = pytest.MonkeyPatch()
    try:
        ewa = _import_ebs_web_adapter(mp)
        segs = ewa._build_fallback_segments(7.0)
        assert segs[0]["shared_start_sec"] == 0.0
        assert segs[-1]["shared_end_sec"] == 7.0
        assert all(s["beat_idx_range"] is None for s in segs)

        assert ewa._ensure_segment_starts_at_zero([]) == []
        assert ewa._ensure_segment_starts_at_zero([0.0, 1.0]) == [0.0, 1.0]
        assert ewa._ensure_segment_starts_at_zero([0.2, 1.0])[0] == 0.0
    finally:
        mp.undo()


def test_build_segments_from_beats_branches():
    mp = pytest.MonkeyPatch()
    try:
        ewa = _import_ebs_web_adapter(mp)
        beat_times = [0.0, 0.5, 1.0, 1.5, 2.0]
        assert ewa._build_segments_from_beats(beat_times, [0.0], 2.0) == []

        # Includes a non-increasing pair that should be skipped
        segs = ewa._build_segments_from_beats(beat_times, [0.0, 0.0, 3.0], 2.0)
        assert len(segs) == 1
        assert segs[0]["shared_end_sec"] == 2.0  # clamped
        assert segs[0]["beat_idx_range"][0] <= segs[0]["beat_idx_range"][1]
    finally:
        mp.undo()


def _mock_pipeline_deps(monkeypatch, *, eight_beat=True, segs_nonempty=True, generate_raises=False):
    ewa = _import_ebs_web_adapter(monkeypatch)
    # Avoid touching real filesystem in finally blocks.
    monkeypatch.setattr(ewa, "save_upload", lambda *_a, **_k: "ref.mp4")
    monkeypatch.setattr(ewa, "extract_audio_from_video", lambda p, sr=None: f"{p}.wav")
    monkeypatch.setattr(ewa.librosa, "load", lambda *_a, **_k: ([0.0] * int(ewa.SAMPLE_RATE * 2), ewa.SAMPLE_RATE))
    monkeypatch.setattr(
        ewa,
        "_auto_align",
        lambda *_a, **_k: {
            "clip_1_start_sec": 0.0,
            "clip_1_end_sec": 6.0,
            "clip_2_start_sec": 1.0,
            "clip_2_end_sec": 7.0,
            "auto_align_mode": "chroma_sw",
        },
    )
    # Beat tracking: return many beats and low CoV to take eight-beat path.
    beat_times = (
        ewa.np.linspace(0.0, 5.0, ewa.BEATS_PER_SEGMENT + 2) if eight_beat else [0.0, 1.0]
    )
    confidence_info = {"coefficient_of_variation": 0.1 if eight_beat else 1.0, "estimated_bpm": 120.0, "num_beats": int(len(beat_times))}
    monkeypatch.setattr(ewa, "track_beats", lambda *_a, **_k: (beat_times, 120.0, confidence_info, [0.0], [0]))
    monkeypatch.setattr(ewa, "estimate_downbeat_phase", lambda *_a, **_k: 0)

    if generate_raises:
        monkeypatch.setattr(ewa, "generate_segments", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("boom")))
    else:
        # Provide segment points that start after 0 to cover ensure_starts_at_zero prepend.
        monkeypatch.setattr(ewa, "generate_segments", lambda *_a, **_k: ([1.0, 5.0] if segs_nonempty else [1.0], []))

    # Make build_segments_from_beats controllable
    if segs_nonempty:
        monkeypatch.setattr(
            ewa,
            "_build_segments_from_beats",
            lambda *_a, **_k: [{"seg_id": 0, "beat_idx_range": [0, 1], "shared_start_sec": 0.0, "shared_end_sec": 3.0}],
        )
    else:
        monkeypatch.setattr(ewa, "_build_segments_from_beats", lambda *_a, **_k: [])

    monkeypatch.setattr(ewa, "probe_video_metadata", lambda *_a, **_k: {"fps": 30.0, "duration_sec": 10.0, "frame_count": 300})
    return ewa


def test_process_uploads_fallback_segmentation_and_cleanup(monkeypatch):
    ewa = _mock_pipeline_deps(monkeypatch, eight_beat=False)

    unlinked = []

    def _unlink(self, missing_ok=False):
        unlinked.append(str(self))
        raise OSError("ignore")

    monkeypatch.setattr(ewa.Path, "unlink", _unlink, raising=False)
    ref = SimpleNamespace(filename="a.mp4", file=io.BytesIO(b"x"))
    usr = SimpleNamespace(filename="b.mp4", file=io.BytesIO(b"y"))
    artifact = ewa.process_uploads(ref, usr)
    assert artifact["segmentation_mode"] == "fixed_time"
    assert "segments" in artifact
    # cleanup attempted for 4 paths, errors ignored
    assert len(unlinked) == 4


def test_process_uploads_eight_beat_mode(monkeypatch):
    ewa = _mock_pipeline_deps(monkeypatch, eight_beat=True, segs_nonempty=True)
    ref = SimpleNamespace(filename="a.mp4", file=io.BytesIO(b"x"))
    usr = SimpleNamespace(filename="b.mp4", file=io.BytesIO(b"y"))
    artifact = ewa.process_uploads(ref, usr)
    assert artifact["segmentation_mode"] == "eight_beat"
    assert artifact["beats_shared_sec"]
    seg = artifact["segments"][0]
    assert seg["clip_1_seg_start_sec"] == 0.0
    assert seg["clip_2_seg_start_sec"] == 1.0


def test_process_uploads_segmentation_try_except_swallows(monkeypatch):
    # generate_segments raises -> should silently fall back to fixed_time segments
    ewa = _mock_pipeline_deps(monkeypatch, eight_beat=True, generate_raises=True)
    ref = SimpleNamespace(filename="a.mp4", file=io.BytesIO(b"x"))
    usr = SimpleNamespace(filename="b.mp4", file=io.BytesIO(b"y"))
    artifact = ewa.process_uploads(ref, usr)
    assert artifact["segmentation_mode"] == "fixed_time"


def test_process_videos_from_paths_does_not_delete_inputs_and_cleans_wavs(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)
    # Keep real input paths (function promises not to delete them).
    monkeypatch.setattr(ewa, "extract_audio_from_video", lambda p, sr=None: f"{p}.wav")
    monkeypatch.setattr(ewa.librosa, "load", lambda *_a, **_k: ([0.0] * int(ewa.SAMPLE_RATE * 2), ewa.SAMPLE_RATE))
    monkeypatch.setattr(
        ewa,
        "_auto_align",
        lambda *_a, **_k: {
            "clip_1_start_sec": 0.0,
            "clip_1_end_sec": 6.0,
            "clip_2_start_sec": 1.0,
            "clip_2_end_sec": 7.0,
            "auto_align_mode": "chroma_sw",
        },
    )
    monkeypatch.setattr(
        ewa,
        "track_beats",
        lambda *_a, **_k: ([0.0, 1.0], 120.0, {"coefficient_of_variation": 1.0}, [0.0], [0]),
    )
    monkeypatch.setattr(ewa, "probe_video_metadata", lambda *_a, **_k: {"fps": 30.0, "duration_sec": 10.0, "frame_count": 300})
    monkeypatch.setattr(ewa.Path, "exists", lambda self: True, raising=False)
    monkeypatch.setattr(ewa.Path, "stat", lambda self: SimpleNamespace(st_size=1), raising=False)

    unlinked = []

    def _unlink(self, missing_ok=False):
        unlinked.append(str(self))

    monkeypatch.setattr(ewa.Path, "unlink", _unlink, raising=False)
    artifact = ewa.process_videos_from_paths("ref_in.mp4", "usr_in.mp4")
    assert artifact["video_meta"]["clip_1"]["frame_count"] == 300
    # Only wavs cleaned up
    assert unlinked == ["ref_in.mp4.wav", "usr_in.mp4.wav"]


def test_process_videos_from_paths_uses_original_inputs_for_audio_extraction(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)
    monkeypatch.setattr(ewa.Path, "exists", lambda self: True, raising=False)
    monkeypatch.setattr(ewa.Path, "stat", lambda self: SimpleNamespace(st_size=1), raising=False)

    seen = {}
    monkeypatch.setattr(
        ewa,
        "probe_video_metadata",
        lambda p, **_k: {"fps": 30.0, "duration_sec": 10.0, "frame_count": 300, "path": p},
    )
    monkeypatch.setattr(
        ewa,
        "extract_audio_pair",
        lambda ref, user, sr: seen.update({"args": (ref, user, sr)}) or (f"{ref}.wav", f"{user}.wav"),
    )
    monkeypatch.setattr(ewa.librosa, "load", lambda *_a, **_k: ([0.0] * int(ewa.SAMPLE_RATE * 2), ewa.SAMPLE_RATE))
    monkeypatch.setattr(
        ewa,
        "_auto_align",
        lambda *_a, **_k: {
            "clip_1_start_sec": 0.0,
            "clip_1_end_sec": 6.0,
            "clip_2_start_sec": 1.0,
            "clip_2_end_sec": 7.0,
            "auto_align_mode": "chroma_sw",
        },
    )
    monkeypatch.setattr(
        ewa,
        "track_beats",
        lambda *_a, **_k: ([0.0, 1.0], 120.0, {"coefficient_of_variation": 1.0}, [0.0], [0]),
    )
    monkeypatch.setattr(ewa.Path, "unlink", lambda *_a, **_k: None, raising=False)

    artifact = ewa.process_videos_from_paths("ref_in.mp4", "usr_in.mp4")
    assert seen["args"] == ("ref_in.mp4", "usr_in.mp4", ewa.SAMPLE_RATE)
    assert artifact["video_meta"]["clip_1"]["path"] == "ref_in.mp4"


def test_process_uploads_finally_skips_none_paths(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)

    monkeypatch.setattr(ewa, "save_upload", lambda *_a, **_k: "ref.mp4")
    monkeypatch.setattr(ewa, "probe_video_metadata", lambda *_a, **_k: {"fps": 30.0, "duration_sec": 10.0, "frame_count": 300})

    def _boom(_p, sr=None):
        raise RuntimeError("extract failed early")

    monkeypatch.setattr(ewa, "extract_audio_from_video", _boom)

    unlinked = []

    def _unlink(self, missing_ok=False):
        unlinked.append(str(self))

    monkeypatch.setattr(ewa.Path, "unlink", _unlink, raising=False)

    ref = SimpleNamespace(filename="a.mp4", file=io.BytesIO(b"x"))
    usr = SimpleNamespace(filename="b.mp4", file=io.BytesIO(b"y"))
    with pytest.raises(RuntimeError, match="extract failed early"):
        ewa.process_uploads(ref, usr)
    # ref_wav/user_wav are None -> continue branches executed; only ref/user mp4 attempted
    assert unlinked == ["ref.mp4", "ref.mp4"]


def test_process_videos_from_paths_eight_beat_and_swallow_segmentation_exception(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)

    monkeypatch.setattr(ewa, "extract_audio_from_video", lambda p, sr=None: f"{p}.wav")
    monkeypatch.setattr(ewa.librosa, "load", lambda *_a, **_k: ([0.0] * int(ewa.SAMPLE_RATE * 2), ewa.SAMPLE_RATE))
    monkeypatch.setattr(
        ewa,
        "_auto_align",
        lambda *_a, **_k: {
            "clip_1_start_sec": 0.0,
            "clip_1_end_sec": 6.0,
            "clip_2_start_sec": 1.0,
            "clip_2_end_sec": 7.0,
            "auto_align_mode": "chroma_sw",
        },
    )

    beat_times = ewa.np.linspace(0.0, 5.0, ewa.BEATS_PER_SEGMENT + 2)
    confidence = {"coefficient_of_variation": 0.1, "estimated_bpm": 120.0, "num_beats": len(beat_times)}
    monkeypatch.setattr(ewa, "track_beats", lambda *_a, **_k: (beat_times, 120.0, confidence, [0.0], [0]))
    monkeypatch.setattr(ewa, "estimate_downbeat_phase", lambda *_a, **_k: 0)
    monkeypatch.setattr(ewa, "generate_segments", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("seg boom")))
    monkeypatch.setattr(ewa, "probe_video_metadata", lambda *_a, **_k: {"fps": 30.0, "duration_sec": 10.0, "frame_count": 300})
    monkeypatch.setattr(ewa.Path, "exists", lambda self: True, raising=False)
    monkeypatch.setattr(ewa.Path, "stat", lambda self: SimpleNamespace(st_size=1), raising=False)

    out = ewa.process_videos_from_paths("ref_in.mp4", "usr_in.mp4")
    assert out["segmentation_mode"] == "fixed_time"


def test_process_videos_from_paths_finally_continue_and_oserror(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)

    # Fail before user_wav assigned -> tests `if not p: continue`
    calls = {"n": 0}

    monkeypatch.setattr(ewa.Path, "exists", lambda self: True, raising=False)
    monkeypatch.setattr(ewa.Path, "stat", lambda self: SimpleNamespace(st_size=1), raising=False)
    monkeypatch.setattr(ewa, "probe_video_metadata", lambda *_a, **_k: {"fps": 30.0, "duration_sec": 10.0, "frame_count": 300})

    def _extract(p, sr=None):
        calls["n"] += 1
        if calls["n"] == 1:
            return f"{p}.wav"
        raise RuntimeError("second extract fails")

    monkeypatch.setattr(ewa, "extract_audio_from_video", _extract)
    monkeypatch.setattr(ewa.Path, "unlink", lambda *_a, **_k: (_ for _ in ()).throw(OSError("ignore")), raising=False)

    with pytest.raises(RuntimeError, match="second extract fails"):
        ewa.process_videos_from_paths("ref_in.mp4", "usr_in.mp4")


def test_process_videos_from_paths_eight_beat_success(monkeypatch):
    ewa = _import_ebs_web_adapter(monkeypatch)

    monkeypatch.setattr(ewa, "extract_audio_from_video", lambda p, sr=None: f"{p}.wav")
    monkeypatch.setattr(ewa.librosa, "load", lambda *_a, **_k: ([0.0] * int(ewa.SAMPLE_RATE * 2), ewa.SAMPLE_RATE))
    monkeypatch.setattr(
        ewa,
        "_auto_align",
        lambda *_a, **_k: {
            "clip_1_start_sec": 0.0,
            "clip_1_end_sec": 6.0,
            "clip_2_start_sec": 1.0,
            "clip_2_end_sec": 7.0,
            "auto_align_mode": "chroma_sw",
        },
    )

    beat_times = ewa.np.linspace(0.0, 5.0, ewa.BEATS_PER_SEGMENT + 2)
    confidence = {"coefficient_of_variation": 0.1, "estimated_bpm": 120.0, "num_beats": len(beat_times)}
    monkeypatch.setattr(ewa, "track_beats", lambda *_a, **_k: (beat_times, 120.0, confidence, [0.0], [0]))
    monkeypatch.setattr(ewa, "estimate_downbeat_phase", lambda *_a, **_k: 0)
    monkeypatch.setattr(ewa, "generate_segments", lambda *_a, **_k: ([1.0, 5.0], []))
    monkeypatch.setattr(
        ewa,
        "_build_segments_from_beats",
        lambda *_a, **_k: [{"seg_id": 0, "beat_idx_range": [0, 1], "shared_start_sec": 0.0, "shared_end_sec": 3.0}],
    )
    monkeypatch.setattr(ewa, "probe_video_metadata", lambda *_a, **_k: {"fps": 30.0, "duration_sec": 10.0, "frame_count": 300})
    monkeypatch.setattr(ewa.Path, "exists", lambda self: True, raising=False)
    monkeypatch.setattr(ewa.Path, "stat", lambda self: SimpleNamespace(st_size=1), raising=False)

    out = ewa.process_videos_from_paths("ref_in.mp4", "usr_in.mp4")
    assert out["segmentation_mode"] == "eight_beat"
    assert out["beats_shared_sec"]
