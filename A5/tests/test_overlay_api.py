"""Tests for `src/overlay_api` helpers and lightweight route branches."""

from __future__ import annotations

import io
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import src.overlay_api as oa


@pytest.fixture()
def overlay_client():
    app = FastAPI()
    app.include_router(oa.router)
    return TestClient(app)


def test_hex_to_rgb_defaults_and_short_form():
    assert oa._hex_to_rgb("") == (56, 189, 248)
    assert oa._hex_to_rgb("#abc") == (170, 187, 204)
    assert oa._hex_to_rgb("#010203") == (1, 2, 3)
    assert oa._hex_to_rgb("not-a-color") == (56, 189, 248)


def test_scaled_bgr_clamps():
    r, g, b = oa._scaled_bgr("#ff0000", 0.5)
    assert (r, g, b) == (0, 0, 128)


def test_expected_frames():
    assert oa._expected_frames(0, 30) == 1
    assert oa._expected_frames(-1, 30) == 1
    assert oa._expected_frames(1.0, 10) == 10
    assert oa._expected_frames(1.0, 0) == 1


def test_resolve_segment_window():
    assert oa._resolve_segment_window(10.0, None, None) == (0.0, 10.0)
    assert oa._resolve_segment_window(10.0, 2.0, 5.0) == (2.0, 5.0)
    assert oa._resolve_segment_window(0.0, 0.0, None) == (0.0, 0.0)
    # end <= start collapses to start
    s, e = oa._resolve_segment_window(10.0, 5.0, 3.0)
    assert s == 5.0 and e == 5.0


def test_visible_pose_point():
    xy = [(1.0, 2.0), (3.0, 4.0)]
    conf = [0.9, 0.1]
    assert oa._visible_pose_point(xy, conf, 0, threshold=0.25) == (1, 2)
    assert oa._visible_pose_point(xy, conf, 1, threshold=0.25) is None
    assert oa._visible_pose_point(xy, None, 0) == (1, 2)
    assert oa._visible_pose_point([], [], 0) is None
    assert oa._visible_pose_point("not-indexable", None, 0) is None


def test_render_pose_layers_default_shoulder_width(monkeypatch):
    cv2 = MagicMock()
    cv2.LINE_AA = 16
    monkeypatch.setitem(sys.modules, "cv2", cv2)
    xy = np.zeros((17, 2), dtype=np.float32)
    conf = np.zeros(17, dtype=np.float32)
    arms, legs = oa._render_pose_layers(xy, conf, 48, 48, "#ff0000", "#00ff00")
    assert arms.shape == (48, 48, 3)
    assert legs.shape == (48, 48, 3)


def test_draw_pose_segment_skips_when_width_zero():
    overlay = np.zeros((20, 20, 3), dtype=np.uint8)
    oa._draw_pose_segment(overlay, (1, 1), (5, 5), 0, (1, 2, 3))


def test_draw_pose_segment_uses_cv2(monkeypatch):
    cv2 = MagicMock()
    cv2.LINE_AA = 16
    monkeypatch.setitem(sys.modules, "cv2", cv2)
    overlay = np.zeros((32, 32, 3), dtype=np.uint8)
    oa._draw_pose_segment(overlay, (2, 2), (10, 10), 3, (10, 20, 30))
    assert cv2.line.called and cv2.circle.call_count == 2


def test_draw_pose_circle_skips_invalid():
    overlay = np.zeros((10, 10, 3), dtype=np.uint8)
    oa._draw_pose_circle(overlay, None, 5, (1, 2, 3))
    oa._draw_pose_circle(overlay, (5, 5), 0, (1, 2, 3))


def test_render_pose_layers_minimal(monkeypatch):
    cv2 = MagicMock()
    cv2.LINE_AA = 16
    monkeypatch.setitem(sys.modules, "cv2", cv2)
    xy = np.zeros((17, 2), dtype=np.float32)
    xy[5] = [10, 10]
    xy[6] = [20, 10]
    xy[11] = [8, 40]
    xy[12] = [22, 40]
    conf = np.ones(17, dtype=np.float32)
    arms, legs = oa._render_pose_layers(xy, conf, 64, 64, "#ff0000", "#00ff00")
    assert arms.shape == (64, 64, 3) and legs.shape == (64, 64, 3)


def test_weights_path_ends_with_models():
    p = oa._weights_path("yolo26n-seg.pt")
    assert p.name == "yolo26n-seg.pt"
    assert "web-app" in p.parts and "models" in p.parts


def test_overlay_yolo_status_404(overlay_client):
    r = overlay_client.get("/api/overlay/yolo/status?job_id=missing")
    assert r.status_code == 404


def test_overlay_yolo_result_not_found(overlay_client):
    r = overlay_client.get("/api/overlay/yolo/result?job_id=missing")
    assert r.status_code == 404


def test_overlay_yolo_result_not_ready(overlay_client):
    jid = "job1"
    oa.OVERLAY_JOBS[jid] = {"status": "queued", "tmp_out": "/tmp/x", "tmp_in": "/tmp/in"}
    try:
        r = overlay_client.get(f"/api/overlay/yolo/result?job_id={jid}")
        assert r.status_code == 409
    finally:
        oa.OVERLAY_JOBS.pop(jid, None)


def test_overlay_yolo_result_missing_output(overlay_client):
    jid = "job2"
    oa.OVERLAY_JOBS[jid] = {"status": "done", "tmp_out": None, "tmp_in": None}
    try:
        r = overlay_client.get(f"/api/overlay/yolo/result?job_id={jid}")
        assert r.status_code == 500
    finally:
        oa.OVERLAY_JOBS.pop(jid, None)


def test_overlay_pose_status_404(overlay_client):
    assert overlay_client.get("/api/overlay/yolo-pose/status?job_id=x").status_code == 404


def test_overlay_pose_result_invalid_layer(overlay_client):
    jid = "pj"
    oa.POSE_JOBS[jid] = {
        "status": "done",
        "arms_out": "/a.webm",
        "legs_out": "/b.webm",
        "tmp_in": "/in.mp4",
        "served_layers": set(),
    }
    try:
        r = overlay_client.get(f"/api/overlay/yolo-pose/result?job_id={jid}&layer=torso")
        assert r.status_code == 400
    finally:
        oa.POSE_JOBS.pop(jid, None)


def test_overlay_bodypix_status_404(overlay_client):
    assert overlay_client.get("/api/overlay/bodypix/status?job_id=x").status_code == 404


def test_overlay_bodypix_result_paths(overlay_client):
    assert overlay_client.get("/api/overlay/bodypix/result?job_id=x").status_code == 404
    jid = "bj"
    oa.BODYPX_JOBS[jid] = {"status": "processing", "out_path": "/o.webm"}
    try:
        assert overlay_client.get(f"/api/overlay/bodypix/result?job_id={jid}").status_code == 409
    finally:
        oa.BODYPX_JOBS.pop(jid, None)
    oa.BODYPX_JOBS[jid] = {"status": "done", "out_path": None}
    try:
        assert overlay_client.get(f"/api/overlay/bodypix/result?job_id={jid}").status_code == 500
    finally:
        oa.BODYPX_JOBS.pop(jid, None)


@patch("src.overlay_api.save_upload", return_value="/tmp/in.mp4")
def test_overlay_yolo_start_returns_job_id(mock_save, overlay_client):
    vid = ("v.mp4", io.BytesIO(b"mock"), "video/mp4")
    r = overlay_client.post(
        "/api/overlay/yolo/start",
        data={"color": "#ff0000", "fps": 12, "session_id": "s", "side": "left", "backend": "wasm"},
        files={"video": vid},
    )
    assert r.status_code == 200
    assert "job_id" in r.json()


def test_run_yolo_overlay_job_missing_import(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def guard(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "cv2" or name.startswith("cv2."):
            raise ImportError("no cv2")
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", guard)
    jid = "import_fail"
    oa.OVERLAY_JOBS[jid] = {"status": "queued"}
    oa._run_yolo_overlay_job(jid, "/in", "/out", "#fff", 12, None, None)
    assert oa.OVERLAY_JOBS[jid]["status"] == "error"
    assert "Missing overlay deps" in (oa.OVERLAY_JOBS[jid].get("error") or "")
    del oa.OVERLAY_JOBS[jid]


def test_overlay_yolo_status_200(overlay_client):
    jid = "yolo-status-ok"
    oa.OVERLAY_JOBS[jid] = {
        "status": "processing",
        "progress": 0.33,
        "frames_written": 10,
        "frames_expected": 30,
        "error": None,
    }
    try:
        r = overlay_client.get(f"/api/overlay/yolo/status?job_id={jid}")
        assert r.status_code == 200
        body = r.json()
        assert body["job_id"] == jid
        assert body["status"] == "processing"
        assert body["progress"] == 0.33
        assert body["frames_written"] == 10
        assert body["frames_expected"] == 30
        assert body["error"] is None
    finally:
        oa.OVERLAY_JOBS.pop(jid, None)


def test_overlay_yolo_result_200_serves_file_and_pops_job(overlay_client, tmp_path):
    out = tmp_path / "out.webm"
    out.write_bytes(b"webm-bytes")
    inp = tmp_path / "in.mp4"
    inp.write_bytes(b"in")
    jid = "yolo-result-ok"
    oa.OVERLAY_JOBS[jid] = {
        "status": "done",
        "tmp_out": str(out),
        "tmp_in": str(inp),
    }
    try:
        r = overlay_client.get(f"/api/overlay/yolo/result?job_id={jid}")
        assert r.status_code == 200
        assert "video/webm" in r.headers.get("content-type", "")
        assert r.content == b"webm-bytes"
        assert jid not in oa.OVERLAY_JOBS
    finally:
        oa.OVERLAY_JOBS.pop(jid, None)


@patch("src.overlay_api.save_upload", return_value="/tmp/pose_in.mp4")
def test_overlay_yolo_pose_start_returns_job_id(mock_save, overlay_client):
    vid = ("v.mp4", io.BytesIO(b"mock"), "video/mp4")
    r = overlay_client.post(
        "/api/overlay/yolo-pose/start",
        data={
            "arms_color": "#ff0000",
            "legs_color": "#00ff00",
            "fps": 12,
            "session_id": "sess",
            "side": "ref",
        },
        files={"video": vid},
    )
    assert r.status_code == 200
    assert "job_id" in r.json()


def test_overlay_yolo_pose_status_200(overlay_client):
    jid = "pose-status-ok"
    oa.POSE_JOBS[jid] = {
        "status": "processing",
        "progress": 0.5,
        "frames_written": 5,
        "frames_expected": 10,
        "error": None,
    }
    try:
        r = overlay_client.get(f"/api/overlay/yolo-pose/status?job_id={jid}")
        assert r.status_code == 200
        body = r.json()
        assert body["job_id"] == jid
        assert body["status"] == "processing"
        assert body["progress"] == 0.5
        assert body["frames_written"] == 5
        assert body["frames_expected"] == 10
    finally:
        oa.POSE_JOBS.pop(jid, None)


def test_overlay_yolo_pose_result_arms_200_keeps_job_until_both_layers(overlay_client, tmp_path):
    arms = tmp_path / "arms.webm"
    legs = tmp_path / "legs.webm"
    arms.write_bytes(b"arms-data")
    legs.write_bytes(b"legs-data")
    inp = tmp_path / "in.mp4"
    inp.write_bytes(b"x")
    jid = "pose-result-arms"
    oa.POSE_JOBS[jid] = {
        "status": "done",
        "arms_out": str(arms),
        "legs_out": str(legs),
        "tmp_in": str(inp),
        "served_layers": set(),
    }
    try:
        r = overlay_client.get(f"/api/overlay/yolo-pose/result?job_id={jid}&layer=arms")
        assert r.status_code == 200
        assert r.content == b"arms-data"
        assert jid in oa.POSE_JOBS
        assert "arms" in oa.POSE_JOBS[jid]["served_layers"]
    finally:
        oa.POSE_JOBS.pop(jid, None)


def test_overlay_yolo_pose_result_second_layer_pops_job(overlay_client, tmp_path):
    arms = tmp_path / "a2.webm"
    legs = tmp_path / "l2.webm"
    arms.write_bytes(b"a")
    legs.write_bytes(b"l")
    inp = tmp_path / "in2.mp4"
    inp.write_bytes(b"x")
    jid = "pose-result-both"
    oa.POSE_JOBS[jid] = {
        "status": "done",
        "arms_out": str(arms),
        "legs_out": str(legs),
        "tmp_in": str(inp),
        "served_layers": {"arms"},
    }
    try:
        r = overlay_client.get(f"/api/overlay/yolo-pose/result?job_id={jid}&layer=legs")
        assert r.status_code == 200
        assert r.content == b"l"
        assert jid not in oa.POSE_JOBS
    finally:
        oa.POSE_JOBS.pop(jid, None)


def test_overlay_yolo_pose_result_served_layers_not_a_set(overlay_client, tmp_path):
    """Covers branch that normalizes served_layers to a set (overlay_api ~648–650)."""
    arms = tmp_path / "arms3.webm"
    legs = tmp_path / "legs3.webm"
    arms.write_bytes(b"a")
    legs.write_bytes(b"l")
    jid = "pose-bad-layer-type"
    oa.POSE_JOBS[jid] = {
        "status": "done",
        "arms_out": str(arms),
        "legs_out": str(legs),
        "tmp_in": None,
        "served_layers": [],
    }
    try:
        r = overlay_client.get(f"/api/overlay/yolo-pose/result?job_id={jid}&layer=arms")
        assert r.status_code == 200
        assert isinstance(oa.POSE_JOBS[jid]["served_layers"], set)
    finally:
        oa.POSE_JOBS.pop(jid, None)


def test_overlay_yolo_pose_result_missing_job_and_not_ready_and_missing_output(overlay_client):
    assert overlay_client.get("/api/overlay/yolo-pose/result?job_id=none&layer=arms").status_code == 404

    jid = "pose-not-ready"
    oa.POSE_JOBS[jid] = {"status": "processing", "served_layers": set()}
    try:
        assert overlay_client.get(f"/api/overlay/yolo-pose/result?job_id={jid}&layer=arms").status_code == 409
    finally:
        oa.POSE_JOBS.pop(jid, None)

    jid = "pose-missing-output"
    oa.POSE_JOBS[jid] = {"status": "done", "arms_out": None, "legs_out": None, "served_layers": set()}
    try:
        assert overlay_client.get(f"/api/overlay/yolo-pose/result?job_id={jid}&layer=arms").status_code == 500
    finally:
        oa.POSE_JOBS.pop(jid, None)


@patch("src.overlay_api.save_upload", return_value="/tmp/body_in.mp4")
def test_overlay_bodypix_start_returns_job_id(mock_save, overlay_client):
    vid = ("v.mp4", io.BytesIO(b"mock"), "video/mp4")
    r = overlay_client.post(
        "/api/overlay/bodypix/start",
        data={
            "arms_color": "#ff0000",
            "legs_color": "#00ff00",
            "torso_color": "#0000ff",
            "head_color": "#ffff00",
            "fps": 12,
            "session_id": "s",
            "side": "user",
            "start_sec": "0",
            "end_sec": "1",
        },
        files={"video": vid},
    )
    assert r.status_code == 200
    assert "job_id" in r.json()


def test_overlay_bodypix_status_200(overlay_client):
    jid = "bodypix-status-ok"
    oa.BODYPX_JOBS[jid] = {
        "status": "done",
        "progress": 1.0,
        "frames_written": 12,
        "frames_expected": 12,
        "error": None,
    }
    try:
        r = overlay_client.get(f"/api/overlay/bodypix/status?job_id={jid}")
        assert r.status_code == 200
        body = r.json()
        assert body["job_id"] == jid
        assert body["status"] == "done"
        assert body["progress"] == 1.0
    finally:
        oa.BODYPX_JOBS.pop(jid, None)


class _MockTensor:
    def __init__(self, arr):
        self._arr = np.asarray(arr)

    def detach(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self._arr

    def __getitem__(self, idx):
        return _MockTensor(self._arr[idx])

    def __len__(self):
        return len(self._arr)


class _MockMasks:
    def __init__(self, h: int, w: int):
        self.data = _MockTensor(np.ones((1, h, w), dtype=np.float32))


class _MockKeypoints:
    def __init__(self):
        xy = np.zeros((1, 17, 2), dtype=np.float32)
        conf = np.ones((1, 17), dtype=np.float32)
        xy[0, 5] = [10, 10]
        xy[0, 6] = [30, 10]
        xy[0, 11] = [12, 35]
        xy[0, 12] = [28, 35]
        xy[0, 0] = [20, 8]
        self.xy = _MockTensor(xy)
        self.conf = _MockTensor(conf)


class _MockResult:
    def __init__(self, h: int, w: int, with_masks: bool = False, with_keypoints: bool = False):
        self.masks = _MockMasks(h, w) if with_masks else None
        self.keypoints = _MockKeypoints() if with_keypoints else None


class _MockYOLO:
    def __init__(self, mode: str, h: int, w: int):
        self._mode = mode
        self._h = h
        self._w = w

    def predict(self, frame, **kwargs):
        if self._mode == "seg":
            return [_MockResult(self._h, self._w, with_masks=True)]
        if self._mode == "pose":
            return [_MockResult(self._h, self._w, with_keypoints=True)]
        return [_MockResult(self._h, self._w)]


class _MockWriter:
    def __init__(self, opened: bool = True):
        self._opened = opened
        self.frames = []

    def isOpened(self):
        return self._opened

    def write(self, frame):
        self.frames.append(frame)

    def release(self):
        return None


class _MockCapture:
    def __init__(self, w: int = 64, h: int = 48, fps: float = 30.0, opened: bool = True, frames: int = 1):
        self._w = w
        self._h = h
        self._fps = fps
        self._opened = opened
        self._idx = 0
        self._frames = [np.zeros((h, w, 3), dtype=np.uint8) for _ in range(frames)]
        self._pos_msec = 0.0

    def isOpened(self):
        return self._opened

    def get(self, prop):
        if prop == 3:
            return self._w
        if prop == 4:
            return self._h
        if prop == 5:
            return self._fps
        if prop == 0:
            return self._pos_msec
        return 0

    def set(self, prop, value):
        if prop == 0:
            self._pos_msec = float(value)
        return True

    def read(self):
        if self._idx >= len(self._frames):
            return False, None
        frame = self._frames[self._idx]
        self._idx += 1
        self._pos_msec += 1000.0 / max(self._fps, 1.0)
        return True, frame

    def release(self):
        return None


def _install_mock_cv2_and_ultralytics(monkeypatch, mode: str, opened_capture: bool = True, opened_writer: bool = True):
    cap = _MockCapture(opened=opened_capture, frames=1)
    writer = _MockWriter(opened=opened_writer)
    cv2 = types.SimpleNamespace(
        CAP_PROP_POS_MSEC=0,
        CAP_PROP_FRAME_WIDTH=3,
        CAP_PROP_FRAME_HEIGHT=4,
        CAP_PROP_FPS=5,
        LINE_AA=16,
        INTER_CUBIC=2,
        VideoCapture=lambda path: cap,
        VideoWriter=lambda *args, **kwargs: writer,
        VideoWriter_fourcc=lambda *args: 42,
        resize=lambda arr, size, interpolation=None: arr,
        GaussianBlur=lambda arr, ksize, sigmaX=0.0, sigmaY=0.0: arr,
        line=lambda *args, **kwargs: None,
        circle=lambda *args, **kwargs: None,
        fillConvexPoly=lambda *args, **kwargs: None,
    )
    ultralytics = types.SimpleNamespace(YOLO=lambda path: _MockYOLO(mode, 48, 64))
    monkeypatch.setitem(sys.modules, "cv2", cv2)
    monkeypatch.setitem(sys.modules, "ultralytics", ultralytics)
    return cap, writer


def test_run_yolo_overlay_job_success(monkeypatch, tmp_path):
    _, writer = _install_mock_cv2_and_ultralytics(monkeypatch, mode="seg")
    monkeypatch.setattr(oa, "probe_video_metadata", lambda _: {"duration_sec": 1.0})
    weights = tmp_path / "yolo26n-seg.pt"
    weights.write_bytes(b"w")
    monkeypatch.setattr(oa, "_weights_path", lambda _: weights)
    jid = "yolo-success"
    oa.OVERLAY_JOBS[jid] = {"status": "queued"}
    oa._run_yolo_overlay_job(jid, "/tmp/in.mp4", "/tmp/out.webm", "#38bdf8", 1, None, None)
    assert oa.OVERLAY_JOBS[jid]["status"] == "done"
    assert oa.OVERLAY_JOBS[jid]["frames_written"] == 1
    assert len(writer.frames) == 1
    oa.OVERLAY_JOBS.pop(jid, None)


def test_run_yolo_overlay_job_writer_open_error(monkeypatch, tmp_path):
    _install_mock_cv2_and_ultralytics(monkeypatch, mode="seg", opened_writer=False)
    monkeypatch.setattr(oa, "probe_video_metadata", lambda _: {"duration_sec": 1.0})
    weights = tmp_path / "yolo26n-seg.pt"
    weights.write_bytes(b"w")
    monkeypatch.setattr(oa, "_weights_path", lambda _: weights)
    jid = "yolo-writer-error"
    oa.OVERLAY_JOBS[jid] = {"status": "queued"}
    oa._run_yolo_overlay_job(jid, "/tmp/in.mp4", "/tmp/out.webm", "#fff", 12, None, None)
    assert oa.OVERLAY_JOBS[jid]["status"] == "error"
    assert "VideoWriter" in oa.OVERLAY_JOBS[jid]["error"]
    oa.OVERLAY_JOBS.pop(jid, None)


def test_run_pose_overlay_job_success(monkeypatch, tmp_path):
    _, writer = _install_mock_cv2_and_ultralytics(monkeypatch, mode="pose")
    monkeypatch.setattr(oa, "probe_video_metadata", lambda _: {"duration_sec": 1.0})
    weights = tmp_path / "yolo26n-pose.pt"
    weights.write_bytes(b"w")
    monkeypatch.setattr(oa, "_weights_path", lambda _: weights)
    jid = "pose-success"
    oa.POSE_JOBS[jid] = {"status": "queued"}
    oa._run_pose_overlay_job(jid, "/tmp/in.mp4", "/tmp/arms.webm", "/tmp/legs.webm", "#f00", "#0f0", 1)
    assert oa.POSE_JOBS[jid]["status"] == "done"
    assert oa.POSE_JOBS[jid]["frames_written"] == 1
    # Both arms and legs writes go through writers in this mocked path.
    assert len(writer.frames) >= 1
    oa.POSE_JOBS.pop(jid, None)


def test_run_bodypx_job_success(monkeypatch, tmp_path):
    _, writer = _install_mock_cv2_and_ultralytics(monkeypatch, mode="pose")
    monkeypatch.setattr(oa, "probe_video_metadata", lambda _: {"duration_sec": 1.0})
    weights = tmp_path / "yolo26n-pose.pt"
    weights.write_bytes(b"w")
    monkeypatch.setattr(oa, "_weights_path", lambda _: weights)
    jid = "bodypx-success"
    oa.BODYPX_JOBS[jid] = {"status": "queued"}
    oa._run_bodypx_job(jid, "/tmp/in.mp4", "/tmp/out.webm", "#f00", "#0f0", "#00f", "#ff0", 1, None, None)
    assert oa.BODYPX_JOBS[jid]["status"] == "done"
    assert oa.BODYPX_JOBS[jid]["frames_written"] == 1
    assert len(writer.frames) >= 1
    oa.BODYPX_JOBS.pop(jid, None)


def test_overlay_bodypix_result_200_serves_file_and_pops_job(overlay_client, tmp_path):
    out = tmp_path / "body.webm"
    out.write_bytes(b"bodypix-out")
    inp = tmp_path / "bin.mp4"
    inp.write_bytes(b"in")
    jid = "bodypix-result-ok"
    oa.BODYPX_JOBS[jid] = {
        "status": "done",
        "out_path": str(out),
        "tmp_in": str(inp),
    }
    try:
        r = overlay_client.get(f"/api/overlay/bodypix/result?job_id={jid}")
        assert r.status_code == 200
        assert "video/webm" in r.headers.get("content-type", "")
        assert r.content == b"bodypix-out"
        assert jid not in oa.BODYPX_JOBS
    finally:
        oa.BODYPX_JOBS.pop(jid, None)
