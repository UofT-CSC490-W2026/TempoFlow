from __future__ import annotations

import math
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, File, Form, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from src.ebs_web_adapter import probe_video_metadata, save_upload

router = APIRouter()

OVERLAY_JOBS: dict[str, dict[str, Any]] = {}
POSE_JOBS: dict[str, dict[str, Any]] = {}
BODYPX_JOBS: dict[str, dict[str, Any]] = {}


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = (hex_color or "#38bdf8").strip().lstrip("#")
    if len(h) == 3:
        h = "".join([c * 2 for c in h])
    if len(h) != 6:
        return (56, 189, 248)
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _scaled_bgr(color_hex: str, scale: float) -> tuple[int, int, int]:
    r, g, b = _hex_to_rgb(color_hex)
    scale = max(0.0, min(1.0, scale))
    return (int(round(b * scale)), int(round(g * scale)), int(round(r * scale)))


def _expected_frames(duration_sec: float, fps: int) -> int:
    if duration_sec <= 0:
        return 1
    return max(1, int(math.ceil(duration_sec * max(1, fps))))


def _resolve_segment_window(duration_sec: float, start_sec: float | None, end_sec: float | None) -> tuple[float, float]:
    start = max(0.0, float(start_sec or 0.0))
    end = float(end_sec) if end_sec is not None else duration_sec
    if duration_sec > 0:
        end = min(end, duration_sec)
    if end <= start:
        end = start
    return start, end


def _visible_pose_point(xy: Any, conf: Any, idx: int, threshold: float = 0.25) -> tuple[int, int] | None:
    try:
        if idx >= len(xy):
            return None
        score = float(conf[idx]) if conf is not None and idx < len(conf) else 1.0
        if score < threshold:
            return None
        p = xy[idx]
        return (int(round(float(p[0]))), int(round(float(p[1]))))
    except Exception:
        return None


def _draw_pose_segment(overlay: Any, start: tuple[int, int] | None, end: tuple[int, int] | None, width: int, color: tuple[int, int, int]) -> None:
    if start is None or end is None or width <= 0:
        return
    import cv2  # type: ignore

    cv2.line(overlay, start, end, color, thickness=width, lineType=cv2.LINE_AA)
    joint_r = max(2, int(round(width * 0.42)))
    cv2.circle(overlay, start, joint_r, color, thickness=-1, lineType=cv2.LINE_AA)
    cv2.circle(overlay, end, joint_r, color, thickness=-1, lineType=cv2.LINE_AA)


def _draw_pose_circle(
    overlay: Any,
    center: tuple[int, int] | None,
    radius: int,
    color_bgr: tuple[int, int, int],
) -> None:
    if center is None or radius <= 0:
        return
    import cv2  # type: ignore

    cv2.circle(overlay, center, radius, color_bgr, thickness=-1, lineType=cv2.LINE_AA)


def _draw_pose_torso_head(
    overlay: Any,
    xy: Any,
    conf: Any,
    color_hex: str,
    shoulder_width: float,
    intensity: float = 0.5,
) -> None:
    import cv2  # type: ignore
    import numpy as np  # type: ignore

    ls = _visible_pose_point(xy, conf, 5)
    rs = _visible_pose_point(xy, conf, 6)
    lh = _visible_pose_point(xy, conf, 11)
    rh = _visible_pose_point(xy, conf, 12)
    nose = _visible_pose_point(xy, conf, 0, threshold=0.2)

    fill = _scaled_bgr(color_hex, 0.28 * intensity)
    edge = _scaled_bgr(color_hex, 0.52 * intensity)
    glow = _scaled_bgr(color_hex, 0.18 * intensity)

    if ls and rs and lh and rh:
        pts = np.array([ls, rs, rh, lh], dtype=np.int32)
        cv2.fillConvexPoly(overlay, pts, fill, lineType=cv2.LINE_AA)

    if nose is not None:
        head_radius = max(int(round(shoulder_width * 0.28)), 18)
        cv2.circle(
            overlay,
            nose,
            max(2, int(round(head_radius * 1.15))),
            glow,
            thickness=-1,
            lineType=cv2.LINE_AA,
        )
        cv2.circle(overlay, nose, head_radius, edge, thickness=-1, lineType=cv2.LINE_AA)

    torso_r = max(int(round(max(shoulder_width * 0.25, 10) * intensity)), 6)
    _draw_pose_circle(overlay, ls, torso_r, edge)
    _draw_pose_circle(overlay, rs, torso_r, edge)
    _draw_pose_circle(overlay, lh, torso_r, edge)
    _draw_pose_circle(overlay, rh, torso_r, edge)


def _render_pose_layers(
    xy: Any,
    conf: Any,
    w: int,
    h: int,
    arms_color: str,
    legs_color: str,
) -> tuple[Any, Any]:
    import numpy as np  # type: ignore

    arms_overlay = np.zeros((h, w, 3), dtype=np.uint8)
    legs_overlay = np.zeros((h, w, 3), dtype=np.uint8)

    ls = _visible_pose_point(xy, conf, 5)
    rs = _visible_pose_point(xy, conf, 6)
    lh = _visible_pose_point(xy, conf, 11)
    rh = _visible_pose_point(xy, conf, 12)

    if ls and rs:
        shoulder_width = math.hypot(ls[0] - rs[0], ls[1] - rs[1])
    else:
        shoulder_width = 60.0

    limb_width = max(int(round(shoulder_width * 0.7)), 18)
    arm_edge = _scaled_bgr(arms_color, 0.78)
    leg_edge = _scaled_bgr(legs_color, 0.78)

    _draw_pose_torso_head(arms_overlay, xy, conf, arms_color, shoulder_width, intensity=0.5)
    _draw_pose_torso_head(legs_overlay, xy, conf, legs_color, shoulder_width, intensity=0.5)

    _draw_pose_segment(arms_overlay, ls, _visible_pose_point(xy, conf, 7), limb_width, arm_edge)
    _draw_pose_segment(
        arms_overlay,
        _visible_pose_point(xy, conf, 7),
        _visible_pose_point(xy, conf, 9),
        max(int(round(limb_width * 0.86)), 10),
        arm_edge,
    )
    _draw_pose_segment(arms_overlay, rs, _visible_pose_point(xy, conf, 8), limb_width, arm_edge)
    _draw_pose_segment(
        arms_overlay,
        _visible_pose_point(xy, conf, 8),
        _visible_pose_point(xy, conf, 10),
        max(int(round(limb_width * 0.86)), 10),
        arm_edge,
    )

    _draw_pose_segment(legs_overlay, lh, _visible_pose_point(xy, conf, 13), int(round(limb_width * 1.05)), leg_edge)
    _draw_pose_segment(
        legs_overlay,
        _visible_pose_point(xy, conf, 13),
        _visible_pose_point(xy, conf, 15),
        max(int(round(limb_width * 0.9)), 10),
        leg_edge,
    )
    _draw_pose_segment(legs_overlay, rh, _visible_pose_point(xy, conf, 14), int(round(limb_width * 1.05)), leg_edge)
    _draw_pose_segment(
        legs_overlay,
        _visible_pose_point(xy, conf, 14),
        _visible_pose_point(xy, conf, 16),
        max(int(round(limb_width * 0.9)), 10),
        leg_edge,
    )

    return arms_overlay, legs_overlay


def _weights_path(filename: str) -> Path:
    # A5/src -> A5 -> repo root
    return (Path(__file__).resolve().parents[2] / "web-app" / "public" / "models" / filename).resolve()


def _run_yolo_overlay_job(job_id: str, tmp_in: str, tmp_out: str, color: str, fps: int, start_sec: float | None, end_sec: float | None) -> None:
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
        from ultralytics import YOLO  # type: ignore
    except Exception as exc:
        OVERLAY_JOBS[job_id]["status"] = "error"
        OVERLAY_JOBS[job_id]["error"] = f"Missing overlay deps: {exc}"
        return

    weights = _weights_path("yolo26n-seg.pt")
    if not weights.exists():
        OVERLAY_JOBS[job_id]["status"] = "error"
        OVERLAY_JOBS[job_id]["error"] = f"YOLO weights not found at {weights}"
        return

    cap = cv2.VideoCapture(tmp_in)
    if not cap.isOpened():
        OVERLAY_JOBS[job_id]["status"] = "error"
        OVERLAY_JOBS[job_id]["error"] = "Failed to open video."
        return

    out_fps = max(1, int(fps))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 640)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 480)
    duration_sec = float((probe_video_metadata(tmp_in).get("duration_sec") or 0.0))
    seg_start, seg_end = _resolve_segment_window(duration_sec, start_sec, end_sec)
    seg_duration = seg_end - seg_start
    if seg_duration <= 0:
        OVERLAY_JOBS[job_id]["status"] = "error"
        OVERLAY_JOBS[job_id]["error"] = "Overlay segment duration must be greater than 0."
        cap.release()
        return

    cap.set(cv2.CAP_PROP_POS_MSEC, seg_start * 1000.0)
    expected = _expected_frames(seg_duration, out_fps)
    OVERLAY_JOBS[job_id]["frames_expected"] = expected
    OVERLAY_JOBS[job_id]["frames_written"] = 0
    OVERLAY_JOBS[job_id]["progress"] = 0.0
    OVERLAY_JOBS[job_id]["status"] = "processing"

    writer = cv2.VideoWriter(tmp_out, cv2.VideoWriter_fourcc(*"VP90"), out_fps, (w, h))
    if not writer.isOpened():
        OVERLAY_JOBS[job_id]["status"] = "error"
        OVERLAY_JOBS[job_id]["error"] = "Failed to open VideoWriter."
        cap.release()
        return

    model = YOLO(str(weights))
    r0, g0, b0 = _hex_to_rgb(color)
    out_dt = 1.0 / float(out_fps)
    next_out_time = 0.0
    written = 0
    last_overlay = np.zeros((h, w, 3), dtype=np.uint8)

    while written < expected:
        ok, frame = cap.read()
        if not ok:
            break
        abs_t = float(cap.get(cv2.CAP_PROP_POS_MSEC) or 0.0) / 1000.0
        rel_t = max(0.0, abs_t - seg_start)
        if rel_t > seg_duration + (out_dt * 0.25):
            break
        if rel_t + (out_dt * 0.25) < next_out_time:
            continue

        result = model.predict(frame, imgsz=768, conf=0.12, iou=0.5, classes=[0], verbose=False)

        alpha_u8 = np.zeros((h, w), dtype=np.uint8)
        if result and result[0].masks is not None:
            m = result[0].masks.data
            mm = m.detach().cpu().numpy()  # type: ignore[attr-defined]
            alpha = np.max(mm, axis=0).astype(np.float32)
            alpha = np.clip(alpha, 0.0, 1.0)
            if alpha.shape[0] != h or alpha.shape[1] != w:
                alpha = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_CUBIC)
            alpha = cv2.GaussianBlur(alpha, (0, 0), sigmaX=0.9, sigmaY=0.9)
            alpha_u8 = (alpha * 255.0).astype(np.uint8)

        overlay = np.zeros((h, w, 3), dtype=np.uint8)
        overlay[..., 0] = (alpha_u8.astype(np.uint16) * b0 // 255).astype(np.uint8)
        overlay[..., 1] = (alpha_u8.astype(np.uint16) * g0 // 255).astype(np.uint8)
        overlay[..., 2] = (alpha_u8.astype(np.uint16) * r0 // 255).astype(np.uint8)
        last_overlay = overlay
        writer.write(overlay)
        written += 1
        next_out_time += out_dt
        OVERLAY_JOBS[job_id]["frames_written"] = written
        OVERLAY_JOBS[job_id]["progress"] = min(1.0, written / float(expected))

    while written < expected:
        writer.write(last_overlay)
        written += 1
        OVERLAY_JOBS[job_id]["frames_written"] = written
        OVERLAY_JOBS[job_id]["progress"] = min(1.0, written / float(expected))

    cap.release()
    writer.release()
    OVERLAY_JOBS[job_id]["status"] = "done"


def _run_pose_overlay_job(job_id: str, tmp_in: str, arms_out: str, legs_out: str, arms_color: str, legs_color: str, fps: int) -> None:
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
        from ultralytics import YOLO  # type: ignore
    except Exception as exc:
        POSE_JOBS[job_id]["status"] = "error"
        POSE_JOBS[job_id]["error"] = f"Missing pose deps: {exc}"
        return

    weights = _weights_path("yolo26n-pose.pt")
    if not weights.exists():
        POSE_JOBS[job_id]["status"] = "error"
        POSE_JOBS[job_id]["error"] = f"YOLO pose weights not found at {weights}"
        return

    cap = cv2.VideoCapture(tmp_in)
    if not cap.isOpened():
        POSE_JOBS[job_id]["status"] = "error"
        POSE_JOBS[job_id]["error"] = "Failed to open video."
        return

    out_fps = max(1, int(fps))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 640)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 480)
    duration_sec = float((probe_video_metadata(tmp_in).get("duration_sec") or 0.0))
    expected = _expected_frames(duration_sec, out_fps)
    POSE_JOBS[job_id]["frames_expected"] = expected
    POSE_JOBS[job_id]["status"] = "processing"

    arms_writer = cv2.VideoWriter(arms_out, cv2.VideoWriter_fourcc(*"VP90"), out_fps, (w, h))
    legs_writer = cv2.VideoWriter(legs_out, cv2.VideoWriter_fourcc(*"VP90"), out_fps, (w, h))
    if not arms_writer.isOpened() or not legs_writer.isOpened():
        POSE_JOBS[job_id]["status"] = "error"
        POSE_JOBS[job_id]["error"] = "Failed to open VideoWriter."
        cap.release()
        return

    model = YOLO(str(weights))
    written = 0
    out_dt = 1.0 / float(out_fps)
    next_out_time = 0.0
    last_arms = np.zeros((h, w, 3), dtype=np.uint8)
    last_legs = np.zeros((h, w, 3), dtype=np.uint8)

    while written < expected:
        ok, frame = cap.read()
        if not ok:
            break
        rel_t = float(cap.get(cv2.CAP_PROP_POS_MSEC) or 0.0) / 1000.0
        if rel_t + (out_dt * 0.25) < next_out_time:
            continue

        arms_overlay = np.zeros((h, w, 3), dtype=np.uint8)
        legs_overlay = np.zeros((h, w, 3), dtype=np.uint8)
        result = model.predict(frame, imgsz=768, conf=0.2, iou=0.5, verbose=False)
        if result and getattr(result[0], "keypoints", None) is not None and len(result[0].keypoints.xy) > 0:
            kp = result[0].keypoints
            xy = kp.xy[0].detach().cpu().numpy()  # type: ignore[attr-defined]
            conf = kp.conf[0].detach().cpu().numpy() if getattr(kp, "conf", None) is not None else None  # type: ignore[attr-defined]
            arms_overlay, legs_overlay = _render_pose_layers(xy, conf, w, h, arms_color, legs_color)

        last_arms, last_legs = arms_overlay, legs_overlay
        arms_writer.write(arms_overlay)
        legs_writer.write(legs_overlay)
        written += 1
        next_out_time += out_dt
        POSE_JOBS[job_id]["frames_written"] = written
        POSE_JOBS[job_id]["progress"] = min(1.0, written / float(expected))

    while written < expected:
        arms_writer.write(last_arms)
        legs_writer.write(last_legs)
        written += 1
        POSE_JOBS[job_id]["frames_written"] = written
        POSE_JOBS[job_id]["progress"] = min(1.0, written / float(expected))

    cap.release()
    arms_writer.release()
    legs_writer.release()
    POSE_JOBS[job_id]["status"] = "done"


def _run_bodypx_job(job_id: str, tmp_in: str, out_path: str, arms_color: str, legs_color: str, torso_color: str, head_color: str, fps: int, start_sec: float | None, end_sec: float | None) -> None:
    # Reuse pose renderer and merge layers for a bodypix-like single overlay.
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
        from ultralytics import YOLO  # type: ignore
    except Exception as exc:
        BODYPX_JOBS[job_id]["status"] = "error"
        BODYPX_JOBS[job_id]["error"] = f"Missing bodypart deps: {exc}"
        return

    weights = _weights_path("yolo26n-pose.pt")
    if not weights.exists():
        BODYPX_JOBS[job_id]["status"] = "error"
        BODYPX_JOBS[job_id]["error"] = f"YOLO pose weights not found at {weights}"
        return

    cap = cv2.VideoCapture(tmp_in)
    if not cap.isOpened():
        BODYPX_JOBS[job_id]["status"] = "error"
        BODYPX_JOBS[job_id]["error"] = "Failed to open video."
        return

    out_fps = max(1, int(fps))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 640)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 480)
    duration_sec = float((probe_video_metadata(tmp_in).get("duration_sec") or 0.0))
    seg_start, seg_end = _resolve_segment_window(duration_sec, start_sec, end_sec)
    seg_duration = seg_end - seg_start
    if seg_duration <= 0:
        BODYPX_JOBS[job_id]["status"] = "error"
        BODYPX_JOBS[job_id]["error"] = "Body overlay segment duration must be greater than 0."
        cap.release()
        return

    cap.set(cv2.CAP_PROP_POS_MSEC, seg_start * 1000.0)
    expected = _expected_frames(seg_duration, out_fps)
    BODYPX_JOBS[job_id]["frames_expected"] = expected
    BODYPX_JOBS[job_id]["status"] = "processing"

    writer = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"VP90"), out_fps, (w, h))
    if not writer.isOpened():
        BODYPX_JOBS[job_id]["status"] = "error"
        BODYPX_JOBS[job_id]["error"] = "Failed to open VideoWriter."
        cap.release()
        return

    model = YOLO(str(weights))
    written = 0
    out_dt = 1.0 / float(out_fps)
    next_out_time = 0.0
    last_frame_time = 0.0
    last_overlay = None

    while True:
        ok, frame = cap.read()
        if not ok:
            break

        try:
            abs_t = float(cap.get(cv2.CAP_PROP_POS_MSEC) or 0.0) / 1000.0
        except Exception:
            abs_t = last_frame_time + out_dt
        last_frame_time = abs_t

        rel_t = max(0.0, abs_t - seg_start)
        if rel_t > seg_duration + (out_dt * 0.25):
            break
        if rel_t + (out_dt * 0.25) < next_out_time:
            continue

        overlay = np.zeros((h, w, 3), dtype=np.uint8)
        result = model.predict(frame, imgsz=768, conf=0.2, iou=0.5, verbose=False)
        if result and getattr(result[0], "keypoints", None) is not None and len(result[0].keypoints.xy) > 0:
            kp = result[0].keypoints
            xy = kp.xy[0].detach().cpu().numpy()  # type: ignore[attr-defined]
            conf = kp.conf[0].detach().cpu().numpy() if getattr(kp, "conf", None) is not None else None  # type: ignore[attr-defined]
            arms_overlay, legs_overlay = _render_pose_layers(xy, conf, w, h, arms_color, legs_color)
            overlay = np.maximum(arms_overlay, legs_overlay)
            shoulder_width = 60.0
            ls = _visible_pose_point(xy, conf, 5)
            rs = _visible_pose_point(xy, conf, 6)
            if ls and rs:
                shoulder_width = math.hypot(ls[0] - rs[0], ls[1] - rs[1])
            _draw_pose_torso_head(overlay, xy, conf, torso_color, shoulder_width, intensity=0.55)
            nose = _visible_pose_point(xy, conf, 0, threshold=0.2)
            if nose is not None:
                _draw_pose_circle(
                    overlay,
                    nose,
                    max(int(round(max(shoulder_width * 0.3, 18) * 0.9)), 10),
                    _scaled_bgr(head_color, 0.6),
                )

        last_overlay = overlay
        slack = out_dt * 0.25
        dup_count = 1
        if rel_t + slack > next_out_time:
            dup_count = int(math.floor((rel_t + slack - next_out_time) / out_dt)) + 1
            dup_count = max(1, dup_count)
        remaining = expected - written
        if remaining <= 0:
            break
        dup_count = min(dup_count, remaining)

        for _ in range(dup_count):
            writer.write(overlay)
            written += 1
            next_out_time += out_dt
            BODYPX_JOBS[job_id]["frames_written"] = written
            BODYPX_JOBS[job_id]["progress"] = min(1.0, written / float(expected))
            if written >= expected:
                break

        if written >= expected:
            break

    if written < expected and last_overlay is not None:
        for _ in range(expected - written):
            writer.write(last_overlay)
        written = expected
        BODYPX_JOBS[job_id]["frames_written"] = written
        BODYPX_JOBS[job_id]["progress"] = 1.0

    cap.release()
    writer.release()
    BODYPX_JOBS[job_id]["status"] = "done"


@router.post("/api/overlay/yolo/start")
async def overlay_yolo_start(
    video: UploadFile = File(...),
    color: str = Form(default="#38bdf8"),
    fps: int = Form(default=12),
    session_id: str | None = Form(default=None),
    side: str | None = Form(default=None),
    backend: str = Form(default="wasm"),
    start_sec: float | None = Form(default=None),
    end_sec: float | None = Form(default=None),
):
    _ = backend
    job_id = str(uuid.uuid4())
    tmp_in = save_upload(video, f"overlay_{(side or 'unknown')}_{job_id}")
    tmp_out = tempfile.NamedTemporaryFile(prefix=f"overlay_{job_id}_", suffix=".webm", delete=False).name
    OVERLAY_JOBS[job_id] = {
        "status": "queued",
        "progress": 0.0,
        "frames_written": 0,
        "frames_expected": None,
        "tmp_in": tmp_in,
        "tmp_out": tmp_out,
        "session_id": (session_id or "default"),
        "side": (side or "unknown"),
        "error": None,
    }
    threading.Thread(
        target=_run_yolo_overlay_job,
        args=(job_id, tmp_in, tmp_out, color, fps, start_sec, end_sec),
        daemon=True,
    ).start()
    return JSONResponse({"job_id": job_id}, status_code=200)


@router.get("/api/overlay/yolo/status")
async def overlay_yolo_status(job_id: str):
    job = OVERLAY_JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    return {
        "job_id": job_id,
        "status": job.get("status", "unknown"),
        "progress": float(job.get("progress", 0.0) or 0.0),
        "frames_written": job.get("frames_written"),
        "frames_expected": job.get("frames_expected"),
        "error": job.get("error"),
    }


@router.get("/api/overlay/yolo/result")
async def overlay_yolo_result(job_id: str, background_tasks: BackgroundTasks):
    job = OVERLAY_JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    if job.get("status") != "done":
        return JSONResponse({"error": "Job not ready"}, status_code=409)
    out_path = job.get("tmp_out")
    tmp_in = job.get("tmp_in")
    if not out_path:
        return JSONResponse({"error": "Missing output"}, status_code=500)
    background_tasks.add_task(lambda: Path(out_path).unlink(missing_ok=True))
    if tmp_in:
        background_tasks.add_task(lambda: Path(tmp_in).unlink(missing_ok=True))
    OVERLAY_JOBS.pop(job_id, None)
    return FileResponse(path=out_path, media_type="video/webm", filename=f"{job_id}_yolo_overlay.webm")


@router.post("/api/overlay/yolo-pose/start")
async def overlay_yolo_pose_start(
    video: UploadFile = File(...),
    arms_color: str = Form(default="#38bdf8"),
    legs_color: str = Form(default="#6366f1"),
    fps: int = Form(default=12),
    session_id: str | None = Form(default=None),
    side: str | None = Form(default=None),
):
    job_id = str(uuid.uuid4())
    tmp_in = save_upload(video, f"pose_{(side or 'unknown')}_{job_id}")
    arms_out = tempfile.NamedTemporaryFile(prefix=f"pose_arms_{job_id}_", suffix=".webm", delete=False).name
    legs_out = tempfile.NamedTemporaryFile(prefix=f"pose_legs_{job_id}_", suffix=".webm", delete=False).name
    POSE_JOBS[job_id] = {
        "status": "queued",
        "progress": 0.0,
        "frames_written": 0,
        "frames_expected": None,
        "tmp_in": tmp_in,
        "arms_out": arms_out,
        "legs_out": legs_out,
        "session_id": (session_id or "default"),
        "side": (side or "unknown"),
        "error": None,
        "served_layers": set(),
    }
    threading.Thread(
        target=_run_pose_overlay_job,
        args=(job_id, tmp_in, arms_out, legs_out, arms_color, legs_color, fps),
        daemon=True,
    ).start()
    return JSONResponse({"job_id": job_id}, status_code=200)


@router.get("/api/overlay/yolo-pose/status")
async def overlay_yolo_pose_status(job_id: str):
    job = POSE_JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    return {
        "job_id": job_id,
        "status": job.get("status", "unknown"),
        "progress": float(job.get("progress", 0.0) or 0.0),
        "frames_written": job.get("frames_written"),
        "frames_expected": job.get("frames_expected"),
        "error": job.get("error"),
    }


@router.get("/api/overlay/yolo-pose/result")
async def overlay_yolo_pose_result(job_id: str, layer: str, background_tasks: BackgroundTasks):
    job = POSE_JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    if job.get("status") != "done":
        return JSONResponse({"error": "Job not ready"}, status_code=409)
    if layer not in {"arms", "legs"}:
        return JSONResponse({"error": "Invalid layer"}, status_code=400)
    out_path = job.get("arms_out" if layer == "arms" else "legs_out")
    if not out_path:
        return JSONResponse({"error": "Missing output"}, status_code=500)
    served_layers = job.get("served_layers")
    if not isinstance(served_layers, set):
        served_layers = set()
        job["served_layers"] = served_layers
    served_layers.add(layer)
    background_tasks.add_task(lambda: Path(out_path).unlink(missing_ok=True))
    if served_layers == {"arms", "legs"}:
        if job.get("tmp_in"):
            background_tasks.add_task(lambda: Path(job["tmp_in"]).unlink(missing_ok=True))
        POSE_JOBS.pop(job_id, None)
    return FileResponse(path=out_path, media_type="video/webm", filename=f"{job_id}_{layer}_overlay.webm")


@router.post("/api/overlay/bodypix/start")
async def overlay_bodypix_start(
    video: UploadFile = File(...),
    arms_color: str = Form(default="#38bdf8"),
    legs_color: str = Form(default="#6366f1"),
    torso_color: str = Form(default="#22c55e"),
    head_color: str = Form(default="#f59e0b"),
    fps: int = Form(default=12),
    session_id: str | None = Form(default=None),
    side: str | None = Form(default=None),
    start_sec: float | None = Form(default=None),
    end_sec: float | None = Form(default=None),
):
    job_id = str(uuid.uuid4())
    tmp_in = save_upload(video, f"bodypx_{(side or 'unknown')}_{job_id}")
    out_path = tempfile.NamedTemporaryFile(prefix=f"bodypx_{job_id}_", suffix=".webm", delete=False).name
    BODYPX_JOBS[job_id] = {
        "status": "queued",
        "progress": 0.0,
        "frames_written": 0,
        "frames_expected": None,
        "tmp_in": tmp_in,
        "out_path": out_path,
        "session_id": (session_id or "default"),
        "side": (side or "unknown"),
        "error": None,
    }
    threading.Thread(
        target=_run_bodypx_job,
        args=(job_id, tmp_in, out_path, arms_color, legs_color, torso_color, head_color, fps, start_sec, end_sec),
        daemon=True,
    ).start()
    return JSONResponse({"job_id": job_id}, status_code=200)


@router.get("/api/overlay/bodypix/status")
async def overlay_bodypix_status(job_id: str):
    job = BODYPX_JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    return {
        "job_id": job_id,
        "status": job.get("status", "unknown"),
        "progress": float(job.get("progress", 0.0) or 0.0),
        "frames_written": job.get("frames_written"),
        "frames_expected": job.get("frames_expected"),
        "error": job.get("error"),
    }


@router.get("/api/overlay/bodypix/result")
async def overlay_bodypix_result(job_id: str, background_tasks: BackgroundTasks):
    job = BODYPX_JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    if job.get("status") != "done":
        return JSONResponse({"error": "Job not ready"}, status_code=409)
    out_path = job.get("out_path")
    tmp_in = job.get("tmp_in")
    if not out_path:
        return JSONResponse({"error": "Missing output"}, status_code=500)
    background_tasks.add_task(lambda: Path(out_path).unlink(missing_ok=True))
    if tmp_in:
        background_tasks.add_task(lambda: Path(tmp_in).unlink(missing_ok=True))
    BODYPX_JOBS.pop(job_id, None)
    return FileResponse(path=out_path, media_type="video/webm", filename=f"{job_id}_bodypix_overlay.webm")
