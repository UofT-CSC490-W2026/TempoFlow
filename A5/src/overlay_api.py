from __future__ import annotations

import base64
import json
import math
import tempfile
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, File, Form, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from src.ebs_web_adapter import probe_video_metadata, save_upload

router = APIRouter()

OVERLAY_JOBS: dict[str, dict[str, Any]] = {}
POSE_JOBS: dict[str, dict[str, Any]] = {}
HYBRID_JOBS: dict[str, dict[str, Any]] = {}
BODYPX_JOBS: dict[str, dict[str, Any]] = {}

POSE_KEYPOINT_NAMES = [
    "nose",
    "leftEye",
    "rightEye",
    "leftEar",
    "rightEar",
    "leftShoulder",
    "rightShoulder",
    "leftElbow",
    "rightElbow",
    "leftWrist",
    "rightWrist",
    "leftHip",
    "rightHip",
    "leftKnee",
    "rightKnee",
    "leftAnkle",
    "rightAnkle",
]

POSE_COVERAGE_GROUPS: dict[str, tuple[int, ...]] = {
    "head": (0, 1, 2, 3, 4),
    "arms": (5, 6, 7, 8, 9, 10),
    "torso": (5, 6, 11, 12),
    "legs": (11, 12, 13, 14, 15, 16),
    "full_body": tuple(range(len(POSE_KEYPOINT_NAMES))),
}


def _job_cancel_requested(job_store: dict[str, dict[str, Any]], job_id: str) -> bool:
    job = job_store.get(job_id)
    return bool(job and job.get("cancel_requested"))


def _cleanup_job_files(job: dict[str, Any], *path_keys: str) -> None:
    for key in path_keys:
        path = job.get(key)
        if not path:
            continue
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            pass


def _finalize_cancelled_job(job_store: dict[str, dict[str, Any]], job_id: str, *path_keys: str) -> None:
    job = job_store.get(job_id)
    if not job:
        return
    job["status"] = "cancelled"
    job["progress"] = 0.0
    job["error"] = None
    _cleanup_job_files(job, *path_keys)


def _request_job_cancel(job_store: dict[str, dict[str, Any]], job_id: str) -> JSONResponse:
    job = job_store.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    if job.get("status") in {"done", "error", "cancelled"}:
        return JSONResponse({"job_id": job_id, "status": job.get("status")}, status_code=200)
    job["cancel_requested"] = True
    job["status"] = "cancelled"
    return JSONResponse({"job_id": job_id, "status": "cancelled"}, status_code=200)


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


def _lifted_bgr(color_hex: str, lift: float) -> tuple[int, int, int]:
    r, g, b = _hex_to_rgb(color_hex)
    lift = max(0.0, min(1.0, lift))
    rr = int(round(r + (255 - r) * lift))
    gg = int(round(g + (255 - g) * lift))
    bb = int(round(b + (255 - b) * lift))
    return (bb, gg, rr)


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


def _iter_pose_instances(keypoints: Any) -> list[tuple[Any, Any | None]]:
    xy_tensor = getattr(keypoints, "xy", None)
    if xy_tensor is None:
        return []

    conf_tensor = getattr(keypoints, "conf", None)
    try:
        count = len(xy_tensor)
    except Exception:
        count = 0

    poses: list[tuple[Any, Any | None]] = []
    for idx in range(count):
        try:
            xy = xy_tensor[idx].detach().cpu().numpy()  # type: ignore[attr-defined]
            conf = (
                conf_tensor[idx].detach().cpu().numpy()  # type: ignore[attr-defined]
                if conf_tensor is not None and idx < len(conf_tensor)
                else None
            )
            poses.append((xy, conf))
        except Exception:
            continue
    return poses


def _summarize_pose_instances(instances: list[tuple[Any, Any | None]], w: int, h: int) -> list[dict[str, float]]:
    people: list[dict[str, float]] = []
    norm_w = float(max(1, w))
    norm_h = float(max(1, h))

    for xy, conf in instances:
        visible_points: list[tuple[float, float]] = []
        for idx in range(len(xy)):
            try:
                score = float(conf[idx]) if conf is not None and idx < len(conf) else 1.0
                if score < 0.25:
                    continue
                point = xy[idx]
                visible_points.append((float(point[0]), float(point[1])))
            except Exception:
                continue

        if not visible_points:
            continue

        min_x = min(point[0] for point in visible_points)
        max_x = max(point[0] for point in visible_points)
        min_y = min(point[1] for point in visible_points)
        max_y = max(point[1] for point in visible_points)

        ankle_points = [
            _visible_pose_point(xy, conf, 15),
            _visible_pose_point(xy, conf, 16),
        ]
        visible_ankles = [point for point in ankle_points if point is not None]
        if visible_ankles:
            anchor_x = sum(point[0] for point in visible_ankles) / len(visible_ankles)
            anchor_y = sum(point[1] for point in visible_ankles) / len(visible_ankles)
        else:
            lowest = max(visible_points, key=lambda point: point[1])
            anchor_x = lowest[0]
            anchor_y = lowest[1]

        center_x = (min_x + max_x) / 2.0
        center_y = (min_y + max_y) / 2.0
        height = max(1.0, max_y - min_y)
        width = max(1.0, max_x - min_x)

        people.append(
            {
                "anchor_x": anchor_x / norm_w,
                "anchor_y": anchor_y / norm_h,
                "center_x": center_x / norm_w,
                "center_y": center_y / norm_h,
                "width": width / norm_w,
                "height": height / norm_h,
                "min_x": min_x / norm_w,
                "max_x": max_x / norm_w,
                "min_y": min_y / norm_h,
                "max_y": max_y / norm_h,
            }
        )

    return sorted(people, key=lambda person: person["anchor_x"])


def _aggregate_pose_summaries(summary_frames: list[list[dict[str, float]]]) -> dict[str, Any] | None:
    if not summary_frames:
        return None

    slot_count = max(len(frame) for frame in summary_frames)
    people: list[dict[str, float]] = []
    keys = ("anchor_x", "anchor_y", "center_x", "center_y", "width", "height", "min_x", "max_x", "min_y", "max_y")

    for slot_index in range(slot_count):
        samples = [frame[slot_index] for frame in summary_frames if slot_index < len(frame)]
        if not samples:
            continue
        person = {
            key: sum(float(sample[key]) for sample in samples) / len(samples)
            for key in keys
        }
        people.append(person)

    if not people:
        return None

    people.sort(key=lambda person: person["anchor_x"])
    return {
        "person_count": len(people),
        "persons": people,
    }


def _pose_visible_points(xy: Any, conf: Any, threshold: float = 0.25) -> list[tuple[float, float]]:
    visible_points: list[tuple[float, float]] = []
    try:
        count = len(xy)
    except Exception:
        return visible_points

    for idx in range(count):
        try:
            score = float(conf[idx]) if conf is not None and idx < len(conf) else 1.0
            if score < threshold:
                continue
            point = xy[idx]
            visible_points.append((float(point[0]), float(point[1])))
        except Exception:
            continue
    return visible_points


def _pose_instance_area(xy: Any, conf: Any) -> float:
    visible_points = _pose_visible_points(xy, conf)
    if not visible_points:
        return 0.0
    min_x = min(point[0] for point in visible_points)
    max_x = max(point[0] for point in visible_points)
    min_y = min(point[1] for point in visible_points)
    max_y = max(point[1] for point in visible_points)
    return max(1.0, max_x - min_x) * max(1.0, max_y - min_y)


def _pose_instance_anchor_y(xy: Any, conf: Any) -> float:
    ankle_points = [
        _visible_pose_point(xy, conf, 15),
        _visible_pose_point(xy, conf, 16),
    ]
    visible_ankles = [point for point in ankle_points if point is not None]
    if visible_ankles:
        return sum(float(point[1]) for point in visible_ankles) / len(visible_ankles)

    visible_points = _pose_visible_points(xy, conf)
    if not visible_points:
        return 0.0
    return max(point[1] for point in visible_points)


def _select_primary_pose_instance(instances: list[tuple[Any, Any | None]]) -> tuple[Any, Any | None] | None:
    if not instances:
        return None
    return max(
        instances,
        key=lambda instance: (
            _pose_instance_area(instance[0], instance[1]),
            _pose_instance_anchor_y(instance[0], instance[1]),
        ),
    )


def _serialize_pose_keypoints(xy: Any, conf: Any) -> list[dict[str, Any]]:
    keypoints: list[dict[str, Any]] = []
    for idx, name in enumerate(POSE_KEYPOINT_NAMES):
        try:
            point = xy[idx]
            x = float(point[0])
            y = float(point[1])
            score = float(conf[idx]) if conf is not None and idx < len(conf) else 1.0
        except Exception:
            x = 0.0
            y = 0.0
            score = 0.0
        keypoints.append(
            {
                "name": name,
                "x": x,
                "y": y,
                "score": max(0.0, min(1.0, score)),
            }
        )
    return keypoints


def _compute_pose_part_coverage(conf: Any, threshold: float = 0.25) -> dict[str, float]:
    coverage: dict[str, float] = {}
    for name, indices in POSE_COVERAGE_GROUPS.items():
        visible = 0
        for idx in indices:
            try:
                score = float(conf[idx]) if conf is not None and idx < len(conf) else 1.0
            except Exception:
                score = 0.0
            if score >= threshold:
                visible += 1
        coverage[name] = visible / float(len(indices)) if indices else 0.0
    return coverage


def _serialize_pose_frame(instances: list[tuple[Any, Any | None]]) -> dict[str, Any] | None:
    if not instances:
        return None
    serialized_instances: list[dict[str, Any]] = []
    for xy, conf in instances:
        serialized_instances.append(
            {
                "keypoints": _serialize_pose_keypoints(xy, conf),
                "part_coverage": _compute_pose_part_coverage(conf),
            }
        )
    primary = serialized_instances[0]
    return {
        "keypoints": primary["keypoints"],
        "part_coverage": primary["part_coverage"],
        "instances": serialized_instances,
    }


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    sorted_values = sorted(float(value) for value in values)
    mid = len(sorted_values) // 2
    if len(sorted_values) % 2 == 1:
        return sorted_values[mid]
    return (sorted_values[mid - 1] + sorted_values[mid]) / 2.0


def _summarize_single_mask(mask_u8: Any, w: int, h: int) -> dict[str, float] | None:
    if mask_u8 is None:
        return None

    import numpy as np  # type: ignore

    try:
        ys, xs = np.where(mask_u8 > 16)
    except Exception:
        return None

    if len(xs) == 0 or len(ys) == 0:
        return None

    norm_w = float(max(1, w))
    norm_h = float(max(1, h))
    min_x = float(xs.min()) / norm_w
    max_x = float(xs.max()) / norm_w
    min_y = float(ys.min()) / norm_h
    max_y = float(ys.max()) / norm_h
    center_x = (min_x + max_x) / 2.0
    center_y = (min_y + max_y) / 2.0

    return {
        "min_x": min_x,
        "max_x": max_x,
        "min_y": min_y,
        "max_y": max_y,
        "center_x": center_x,
        "center_y": center_y,
        "width": max(1.0 / norm_w, max_x - min_x),
        "height": max(1.0 / norm_h, max_y - min_y),
        "anchor_x": center_x,
        "anchor_y": max_y,
    }


def _summarize_mask_bounds(mask_u8: Any, w: int, h: int) -> dict[str, float] | None:
    return _summarize_single_mask(mask_u8, w, h)


def _aggregate_bounds_summaries(summary_frames: list[dict[str, float] | None]) -> dict[str, float] | None:
    valid_frames = [summary for summary in summary_frames if summary is not None]
    if not valid_frames:
        return None

    min_x = _median([summary["min_x"] for summary in valid_frames])
    max_x = _median([summary["max_x"] for summary in valid_frames])
    min_y = _median([summary["min_y"] for summary in valid_frames])
    max_y = _median([summary["max_y"] for summary in valid_frames])
    center_x = (min_x + max_x) / 2.0
    center_y = (min_y + max_y) / 2.0

    return {
        "min_x": min_x,
        "max_x": max_x,
        "min_y": min_y,
        "max_y": max_y,
        "center_x": center_x,
        "center_y": center_y,
        "width": max(1e-6, max_x - min_x),
        "height": max(1e-6, max_y - min_y),
        "anchor_x": center_x,
        "anchor_y": max_y,
        "sample_count": float(len(valid_frames)),
    }


def _summarize_mask_instances_in_order(mask_data: Any, w: int, h: int) -> list[dict[str, float]]:
    import numpy as np  # type: ignore

    try:
        masks = np.asarray(mask_data)
    except Exception:
        return []

    if masks.ndim == 2:
        masks = masks[None, ...]
    if masks.ndim != 3 or masks.shape[0] <= 0:
        return []

    summaries: list[dict[str, float]] = []
    for idx in range(masks.shape[0]):
        mask = masks[idx]
        summary = _summarize_single_mask(mask, w, h)
        if summary is not None:
            summaries.append(summary)

    return summaries


def _summarize_mask_instances(mask_data: Any, w: int, h: int) -> list[dict[str, float]]:
    return sorted(_summarize_mask_instances_in_order(mask_data, w, h), key=lambda person: person["anchor_x"])


def _select_primary_mask_index(summaries: list[dict[str, float]]) -> int | None:
    if not summaries:
        return None

    def _score(summary: dict[str, float]) -> tuple[float, float]:
        return (
            float(summary.get("width", 0.0)) * float(summary.get("height", 0.0)),
            float(summary.get("anchor_y", 0.0)),
        )

    best_idx = 0
    best_score = _score(summaries[0])
    for idx in range(1, len(summaries)):
        score = _score(summaries[idx])
        if score > best_score:
            best_idx = idx
            best_score = score
    return best_idx


def _select_mask_index_for_anchor(
    summaries: list[dict[str, float]],
    anchor_x: float,
    anchor_y: float,
) -> int | None:
    if not summaries:
        return None

    best_idx = 0
    best_distance = float("inf")
    for idx, summary in enumerate(summaries):
        distance = (
            abs(float(summary.get("anchor_x", 0.5)) - anchor_x)
            + abs(float(summary.get("anchor_y", 0.5)) - anchor_y) * 0.45
        )
        if distance < best_distance:
            best_idx = idx
            best_distance = distance
    return best_idx


def _aggregate_mask_instance_summaries(summary_frames: list[list[dict[str, float]]]) -> dict[str, Any] | None:
    if not summary_frames:
        return None

    slot_count = max(len(frame) for frame in summary_frames)
    people: list[dict[str, float]] = []
    keys = ("anchor_x", "anchor_y", "center_x", "center_y", "width", "height", "min_x", "max_x", "min_y", "max_y")

    for slot_index in range(slot_count):
        samples = [frame[slot_index] for frame in summary_frames if slot_index < len(frame)]
        if not samples:
            continue
        person = {
            key: _median([float(sample[key]) for sample in samples])
            for key in keys
        }
        people.append(person)

    people.sort(key=lambda person: person["anchor_x"])
    union = _aggregate_bounds_summaries(
        [
            {
                "min_x": min(person["min_x"] for person in frame),
                "max_x": max(person["max_x"] for person in frame),
                "min_y": min(person["min_y"] for person in frame),
                "max_y": max(person["max_y"] for person in frame),
                "center_x": 0.0,
                "center_y": 0.0,
                "width": 0.0,
                "height": 0.0,
                "anchor_x": 0.0,
                "anchor_y": 0.0,
            }
            for frame in summary_frames
            if frame
        ]
    )
    if union is not None:
        union["center_x"] = (union["min_x"] + union["max_x"]) / 2.0
        union["center_y"] = (union["min_y"] + union["max_y"]) / 2.0
        union["width"] = max(1e-6, union["max_x"] - union["min_x"])
        union["height"] = max(1e-6, union["max_y"] - union["min_y"])
        union["anchor_x"] = union["center_x"]
        union["anchor_y"] = union["max_y"]

    if not people and union is None:
        return None

    return {
        "person_count": len(people),
        "persons": people,
        "union": union,
    }


def _encode_summary_header(summary: dict[str, Any] | None) -> str | None:
    if not summary:
        return None
    payload = json.dumps(summary, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii")


def _scale_points(points: Any, scale: float) -> Any:
    import numpy as np  # type: ignore

    pts = np.asarray(points, dtype=np.float32)
    if pts.size == 0:
        return pts.astype(np.int32)
    center = np.mean(pts, axis=0)
    scaled = center + (pts - center) * float(scale)
    return np.round(scaled).astype(np.int32)


def _segment_polygon_points(start: tuple[int, int], end: tuple[int, int], width: float) -> Any:
    import numpy as np  # type: ignore

    sx, sy = float(start[0]), float(start[1])
    ex, ey = float(end[0]), float(end[1])
    dx = ex - sx
    dy = ey - sy
    length = math.hypot(dx, dy)
    half = max(1.0, width / 2.0)
    if length <= 1e-6:
        return np.array(
            [
                [sx - half, sy - half],
                [sx + half, sy - half],
                [sx + half, sy + half],
                [sx - half, sy + half],
            ],
            dtype=np.int32,
        )

    ux = dx / length
    uy = dy / length
    px = -uy
    py = ux
    bevel = min(length * 0.22, half * 0.9)
    inner = half * 0.78
    pts = np.array(
        [
            [sx + ux * bevel + px * half, sy + uy * bevel + py * half],
            [sx + px * inner, sy + py * inner],
            [sx - px * inner, sy - py * inner],
            [sx + ux * bevel - px * half, sy + uy * bevel - py * half],
            [ex - ux * bevel - px * half, ey - uy * bevel - py * half],
            [ex - px * inner, ey - py * inner],
            [ex + px * inner, ey + py * inner],
            [ex - ux * bevel + px * half, ey - uy * bevel + py * half],
        ],
        dtype=np.int32,
    )
    return pts


def _draw_styled_pose_circle(
    overlay: Any,
    center: tuple[int, int] | None,
    radius: int,
    fill_color: tuple[int, int, int],
    outline_color: tuple[int, int, int],
    highlight_color: tuple[int, int, int] | None = None,
) -> None:
    if center is None or radius <= 0:
        return
    import cv2  # type: ignore

    outline_radius = max(radius + 1, int(round(radius * 1.08)))
    cv2.circle(overlay, center, outline_radius, outline_color, thickness=-1, lineType=cv2.LINE_AA)
    cv2.circle(overlay, center, radius, fill_color, thickness=-1, lineType=cv2.LINE_AA)
    if highlight_color is not None and radius >= 10:
        cv2.circle(
            overlay,
            center,
            max(1, int(round(radius * 0.24))),
            highlight_color,
            thickness=-1,
            lineType=cv2.LINE_AA,
        )


def _draw_pose_segment(overlay: Any, start: tuple[int, int] | None, end: tuple[int, int] | None, width: int, color: tuple[int, int, int]) -> None:
    if start is None or end is None or width <= 0:
        return
    import cv2  # type: ignore
    outer_pts = _segment_polygon_points(start, end, width)
    inner_pts = _scale_points(outer_pts, 0.88)
    outline = tuple(max(0, min(255, int(round(channel * 0.42)))) for channel in color)
    cv2.fillConvexPoly(overlay, outer_pts, outline, lineType=cv2.LINE_AA)
    cv2.fillConvexPoly(overlay, inner_pts, color, lineType=cv2.LINE_AA)


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

    fill = _scaled_bgr(color_hex, 0.36 * intensity + 0.16)
    edge = _scaled_bgr(color_hex, 0.24 * intensity + 0.14)
    highlight = _lifted_bgr(color_hex, 0.1 * intensity + 0.04)
    glow = _scaled_bgr(color_hex, 0.1 * intensity)

    if ls and rs and lh and rh:
        pts = np.array([ls, rs, rh, lh], dtype=np.int32)
        cv2.fillConvexPoly(overlay, pts, edge, lineType=cv2.LINE_AA)
        cv2.fillConvexPoly(overlay, _scale_points(pts, 0.93), fill, lineType=cv2.LINE_AA)

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
        _draw_styled_pose_circle(overlay, nose, head_radius, fill, edge, None)

    torso_r = max(int(round(max(shoulder_width * 0.17, 8) * intensity)), 5)
    _draw_styled_pose_circle(overlay, ls, torso_r, fill, edge, None)
    _draw_styled_pose_circle(overlay, rs, torso_r, fill, edge, None)
    _draw_styled_pose_circle(overlay, lh, torso_r, fill, edge, None)
    _draw_styled_pose_circle(overlay, rh, torso_r, fill, edge, None)


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

    limb_width = max(int(round(shoulder_width * 0.54)), 14)
    arm_fill = _lifted_bgr(arms_color, 0.08)
    leg_fill = _lifted_bgr(legs_color, 0.08)

    _draw_pose_torso_head(arms_overlay, xy, conf, arms_color, shoulder_width, intensity=0.5)
    _draw_pose_torso_head(legs_overlay, xy, conf, legs_color, shoulder_width, intensity=0.5)

    _draw_pose_segment(arms_overlay, ls, _visible_pose_point(xy, conf, 7), limb_width, arm_fill)
    _draw_pose_segment(
        arms_overlay,
        _visible_pose_point(xy, conf, 7),
        _visible_pose_point(xy, conf, 9),
        max(int(round(limb_width * 0.82)), 10),
        arm_fill,
    )
    _draw_pose_segment(arms_overlay, rs, _visible_pose_point(xy, conf, 8), limb_width, arm_fill)
    _draw_pose_segment(
        arms_overlay,
        _visible_pose_point(xy, conf, 8),
        _visible_pose_point(xy, conf, 10),
        max(int(round(limb_width * 0.82)), 10),
        arm_fill,
    )

    _draw_pose_segment(legs_overlay, lh, _visible_pose_point(xy, conf, 13), int(round(limb_width * 0.96)), leg_fill)
    _draw_pose_segment(
        legs_overlay,
        _visible_pose_point(xy, conf, 13),
        _visible_pose_point(xy, conf, 15),
        max(int(round(limb_width * 0.82)), 10),
        leg_fill,
    )
    _draw_pose_segment(legs_overlay, rh, _visible_pose_point(xy, conf, 14), int(round(limb_width * 0.96)), leg_fill)
    _draw_pose_segment(
        legs_overlay,
        _visible_pose_point(xy, conf, 14),
        _visible_pose_point(xy, conf, 16),
        max(int(round(limb_width * 0.82)), 10),
        leg_fill,
    )

    return arms_overlay, legs_overlay


def _predict_segmentation_mask(
    frame: Any,
    model: Any,
    w: int,
    h: int,
    *,
    match_anchor: tuple[float, float] | None = None,
) -> Any | None:
    import cv2  # type: ignore
    import numpy as np  # type: ignore

    result = model.predict(frame, imgsz=768, conf=0.12, iou=0.5, classes=[0], verbose=False)
    alpha_u8, summaries = _extract_segmentation_mask_data(
        result,
        w,
        h,
        blur_sigma=1.2,
        primary_only=match_anchor is None,
        match_anchor=match_anchor,
    )
    return alpha_u8 if summaries else None


def _extract_segmentation_mask_data(
    result: Any,
    w: int,
    h: int,
    *,
    blur_sigma: float,
    primary_only: bool = False,
    match_anchor: tuple[float, float] | None = None,
) -> tuple[Any, list[dict[str, float]]]:
    import cv2  # type: ignore
    import numpy as np  # type: ignore

    alpha_u8 = np.zeros((h, w), dtype=np.uint8)
    if not result or result[0].masks is None:
        return alpha_u8, []

    mask_tensor = result[0].masks.data
    mask_np = mask_tensor.detach().cpu().numpy()  # type: ignore[attr-defined]
    if mask_np.shape[1] != h or mask_np.shape[2] != w:
        resized_masks = [
            cv2.resize(mask.astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
            for mask in mask_np
        ]
        mask_np = np.stack(resized_masks, axis=0)

    summaries_in_order = _summarize_mask_instances_in_order(mask_np, w, h)
    if match_anchor is not None:
        matched_idx = _select_mask_index_for_anchor(summaries_in_order, match_anchor[0], match_anchor[1])
        if matched_idx is not None:
            mask_np = mask_np[matched_idx : matched_idx + 1]
            summaries = [summaries_in_order[matched_idx]]
        else:
            summaries = []
    elif primary_only:
        primary_idx = _select_primary_mask_index(summaries_in_order)
        if primary_idx is not None:
            mask_np = mask_np[primary_idx : primary_idx + 1]
            summaries = [summaries_in_order[primary_idx]]
        else:
            summaries = []
    else:
        summaries = sorted(summaries_in_order, key=lambda person: person["anchor_x"])

    alpha = np.max(mask_np, axis=0).astype(np.float32)
    alpha = np.clip(alpha, 0.0, 1.0)
    if alpha.shape[0] != h or alpha.shape[1] != w:
        alpha = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_CUBIC)
    alpha = cv2.GaussianBlur(alpha, (0, 0), sigmaX=blur_sigma, sigmaY=blur_sigma)

    return (alpha * 255.0).astype(np.uint8), summaries


def _build_segmentation_overlay(alpha_u8: Any, color: str) -> Any:
    import numpy as np  # type: ignore

    r0, g0, b0 = _hex_to_rgb(color)
    overlay = np.zeros((*alpha_u8.shape, 3), dtype=np.uint8)
    overlay[..., 0] = (alpha_u8.astype(np.uint16) * b0 // 255).astype(np.uint8)
    overlay[..., 1] = (alpha_u8.astype(np.uint16) * g0 // 255).astype(np.uint8)
    overlay[..., 2] = (alpha_u8.astype(np.uint16) * r0 // 255).astype(np.uint8)
    return overlay


def _clip_overlay_to_mask(overlay: Any, mask_u8: Any | None) -> Any:
    if mask_u8 is None:
        return overlay

    import numpy as np  # type: ignore

    alpha = (mask_u8.astype(np.float32) / 255.0)[..., None]
    clipped = overlay.astype(np.float32) * alpha
    return np.clip(clipped, 0, 255).astype(np.uint8)


def _weights_path(filename: str) -> Path:
    # Prefer weights bundled directly with A5 so the EB source bundle is self-contained.
    a5_bundled = (Path(__file__).resolve().parents[1] / "models" / filename).resolve()
    if a5_bundled.exists():
        return a5_bundled

    # Fallback for local monorepo layouts where models live under the web app.
    return (Path(__file__).resolve().parents[2] / "web-app" / "public" / "models" / filename).resolve()


def _run_yolo_overlay_job(job_id: str, tmp_in: str, tmp_out: str, color: str, fps: int, start_sec: float | None, end_sec: float | None) -> None:
    if _job_cancel_requested(OVERLAY_JOBS, job_id):
        _finalize_cancelled_job(OVERLAY_JOBS, job_id, "tmp_in", "tmp_out")
        return
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
    out_dt = 1.0 / float(out_fps)
    next_out_time = 0.0
    written = 0
    last_overlay = np.zeros((h, w, 3), dtype=np.uint8)
    overlay_summary_frames: list[list[dict[str, float]]] = []

    while written < expected:
        if _job_cancel_requested(OVERLAY_JOBS, job_id):
            cap.release()
            writer.release()
            _finalize_cancelled_job(OVERLAY_JOBS, job_id, "tmp_in", "tmp_out")
            return
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
        alpha_u8, summaries = _extract_segmentation_mask_data(result, w, h, blur_sigma=0.9, primary_only=True)
        overlay_summary_frames.append(summaries)
        overlay = _build_segmentation_overlay(alpha_u8, color)
        last_overlay = overlay
        writer.write(overlay)
        written += 1
        next_out_time += out_dt
        OVERLAY_JOBS[job_id]["frames_written"] = written
        OVERLAY_JOBS[job_id]["progress"] = min(1.0, written / float(expected))

    while written < expected:
        if _job_cancel_requested(OVERLAY_JOBS, job_id):
            cap.release()
            writer.release()
            _finalize_cancelled_job(OVERLAY_JOBS, job_id, "tmp_in", "tmp_out")
            return
        writer.write(last_overlay)
        written += 1
        OVERLAY_JOBS[job_id]["frames_written"] = written
        OVERLAY_JOBS[job_id]["progress"] = min(1.0, written / float(expected))

    cap.release()
    writer.release()
    if _job_cancel_requested(OVERLAY_JOBS, job_id):
        _finalize_cancelled_job(OVERLAY_JOBS, job_id, "tmp_in", "tmp_out")
        return
    OVERLAY_JOBS[job_id]["overlay_summary"] = _aggregate_mask_instance_summaries(overlay_summary_frames)
    OVERLAY_JOBS[job_id]["status"] = "done"


def _run_pose_overlay_job(
    job_id: str,
    tmp_in: str,
    arms_out: str,
    legs_out: str,
    arms_color: str,
    legs_color: str,
    fps: int,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> None:
    if _job_cancel_requested(POSE_JOBS, job_id):
        _finalize_cancelled_job(POSE_JOBS, job_id, "tmp_in", "arms_out", "legs_out")
        return
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
        from ultralytics import YOLO  # type: ignore
    except Exception as exc:
        POSE_JOBS[job_id]["status"] = "error"
        POSE_JOBS[job_id]["error"] = f"Missing pose deps: {exc}"
        return

    pose_weights = _weights_path("yolo26n-pose.pt")
    if not pose_weights.exists():
        POSE_JOBS[job_id]["status"] = "error"
        POSE_JOBS[job_id]["error"] = f"YOLO pose weights not found at {pose_weights}"
        return

    seg_weights = _weights_path("yolo26n-seg.pt")
    if not seg_weights.exists():
        POSE_JOBS[job_id]["status"] = "error"
        POSE_JOBS[job_id]["error"] = f"YOLO seg weights not found at {seg_weights}"
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
    seg_start, seg_end = _resolve_segment_window(duration_sec, start_sec, end_sec)
    seg_duration = seg_end - seg_start
    if seg_duration <= 0:
        POSE_JOBS[job_id]["status"] = "error"
        POSE_JOBS[job_id]["error"] = "Pose overlay segment duration must be greater than 0."
        cap.release()
        return

    cap.set(cv2.CAP_PROP_POS_MSEC, seg_start * 1000.0)
    expected = _expected_frames(seg_duration, out_fps)
    POSE_JOBS[job_id]["frames_expected"] = expected
    POSE_JOBS[job_id]["frames_written"] = 0
    POSE_JOBS[job_id]["progress"] = 0.0
    POSE_JOBS[job_id]["status"] = "processing"

    arms_writer = cv2.VideoWriter(arms_out, cv2.VideoWriter_fourcc(*"VP90"), out_fps, (w, h))
    legs_writer = cv2.VideoWriter(legs_out, cv2.VideoWriter_fourcc(*"VP90"), out_fps, (w, h))
    if not arms_writer.isOpened() or not legs_writer.isOpened():
        POSE_JOBS[job_id]["status"] = "error"
        POSE_JOBS[job_id]["error"] = "Failed to open VideoWriter."
        cap.release()
        return

    pose_model = YOLO(str(pose_weights))
    seg_model = YOLO(str(seg_weights))
    written = 0
    out_dt = 1.0 / float(out_fps)
    next_out_time = 0.0
    last_arms = np.zeros((h, w, 3), dtype=np.uint8)
    last_legs = np.zeros((h, w, 3), dtype=np.uint8)
    pose_summary_frames: list[list[dict[str, float]]] = []

    while written < expected:
        if _job_cancel_requested(POSE_JOBS, job_id):
            cap.release()
            arms_writer.release()
            legs_writer.release()
            _finalize_cancelled_job(POSE_JOBS, job_id, "tmp_in", "arms_out", "legs_out")
            return
        ok, frame = cap.read()
        if not ok:
            break
        abs_t = float(cap.get(cv2.CAP_PROP_POS_MSEC) or 0.0) / 1000.0
        rel_t = max(0.0, abs_t - seg_start)
        if rel_t > seg_duration + (out_dt * 0.25):
            break
        if rel_t + (out_dt * 0.25) < next_out_time:
            continue

        arms_overlay = np.zeros((h, w, 3), dtype=np.uint8)
        legs_overlay = np.zeros((h, w, 3), dtype=np.uint8)
        result = pose_model.predict(frame, imgsz=768, conf=0.2, iou=0.5, verbose=False)
        pose_anchor: tuple[float, float] | None = None
        if result and getattr(result[0], "keypoints", None) is not None and len(result[0].keypoints.xy) > 0:
            kp = result[0].keypoints
            instances = _iter_pose_instances(kp)
            primary_instance = _select_primary_pose_instance(instances)
            selected_instances = list(instances)
            pose_summaries = _summarize_pose_instances(selected_instances, w, h)
            pose_summary_frames.append(pose_summaries)
            if primary_instance is not None:
                primary_summary = _summarize_pose_instances([primary_instance], w, h)
            else:
                primary_summary = []
            if primary_summary:
                pose_anchor = (
                    float(primary_summary[0].get("anchor_x", 0.5)),
                    float(primary_summary[0].get("anchor_y", 0.5)),
                )
            for xy, conf in selected_instances:
                pose_arms_overlay, pose_legs_overlay = _render_pose_layers(xy, conf, w, h, arms_color, legs_color)
                arms_overlay = np.maximum(arms_overlay, pose_arms_overlay)
                legs_overlay = np.maximum(legs_overlay, pose_legs_overlay)
            seg_mask = _predict_segmentation_mask(frame, seg_model, w, h, match_anchor=pose_anchor)
            arms_overlay = _clip_overlay_to_mask(arms_overlay, seg_mask)
            legs_overlay = _clip_overlay_to_mask(legs_overlay, seg_mask)

        last_arms, last_legs = arms_overlay, legs_overlay
        arms_writer.write(arms_overlay)
        legs_writer.write(legs_overlay)
        written += 1
        next_out_time += out_dt
        POSE_JOBS[job_id]["frames_written"] = written
        POSE_JOBS[job_id]["progress"] = min(1.0, written / float(expected))

    while written < expected:
        if _job_cancel_requested(POSE_JOBS, job_id):
            cap.release()
            arms_writer.release()
            legs_writer.release()
            _finalize_cancelled_job(POSE_JOBS, job_id, "tmp_in", "arms_out", "legs_out")
            return
        arms_writer.write(last_arms)
        legs_writer.write(last_legs)
        written += 1
        POSE_JOBS[job_id]["frames_written"] = written
        POSE_JOBS[job_id]["progress"] = min(1.0, written / float(expected))

    cap.release()
    arms_writer.release()
    legs_writer.release()
    if _job_cancel_requested(POSE_JOBS, job_id):
        _finalize_cancelled_job(POSE_JOBS, job_id, "tmp_in", "arms_out", "legs_out")
        return
    POSE_JOBS[job_id]["pose_summary"] = _aggregate_pose_summaries(pose_summary_frames)
    POSE_JOBS[job_id]["status"] = "done"


def _run_hybrid_overlay_job(
    job_id: str,
    tmp_in: str,
    seg_out: str,
    arms_out: str,
    legs_out: str,
    color: str,
    arms_color: str,
    legs_color: str,
    fps: int,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> None:
    if _job_cancel_requested(HYBRID_JOBS, job_id):
        _finalize_cancelled_job(HYBRID_JOBS, job_id, "tmp_in", "seg_out", "arms_out", "legs_out")
        return
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
        from ultralytics import YOLO  # type: ignore
    except Exception as exc:
        HYBRID_JOBS[job_id]["status"] = "error"
        HYBRID_JOBS[job_id]["error"] = f"Missing hybrid deps: {exc}"
        return

    pose_weights = _weights_path("yolo26n-pose.pt")
    if not pose_weights.exists():
        HYBRID_JOBS[job_id]["status"] = "error"
        HYBRID_JOBS[job_id]["error"] = f"YOLO pose weights not found at {pose_weights}"
        return

    seg_weights = _weights_path("yolo26n-seg.pt")
    if not seg_weights.exists():
        HYBRID_JOBS[job_id]["status"] = "error"
        HYBRID_JOBS[job_id]["error"] = f"YOLO seg weights not found at {seg_weights}"
        return

    cap = cv2.VideoCapture(tmp_in)
    if not cap.isOpened():
        HYBRID_JOBS[job_id]["status"] = "error"
        HYBRID_JOBS[job_id]["error"] = "Failed to open video."
        return

    out_fps = max(1, int(fps))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 640)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 480)
    duration_sec = float((probe_video_metadata(tmp_in).get("duration_sec") or 0.0))
    seg_start, seg_end = _resolve_segment_window(duration_sec, start_sec, end_sec)
    seg_duration = seg_end - seg_start
    if seg_duration <= 0:
        HYBRID_JOBS[job_id]["status"] = "error"
        HYBRID_JOBS[job_id]["error"] = "Hybrid overlay segment duration must be greater than 0."
        cap.release()
        return

    cap.set(cv2.CAP_PROP_POS_MSEC, seg_start * 1000.0)
    expected = _expected_frames(seg_duration, out_fps)
    HYBRID_JOBS[job_id]["frames_expected"] = expected
    HYBRID_JOBS[job_id]["frames_written"] = 0
    HYBRID_JOBS[job_id]["progress"] = 0.0
    HYBRID_JOBS[job_id]["status"] = "processing"

    seg_writer = cv2.VideoWriter(seg_out, cv2.VideoWriter_fourcc(*"VP90"), out_fps, (w, h))
    arms_writer = cv2.VideoWriter(arms_out, cv2.VideoWriter_fourcc(*"VP90"), out_fps, (w, h))
    legs_writer = cv2.VideoWriter(legs_out, cv2.VideoWriter_fourcc(*"VP90"), out_fps, (w, h))
    if not seg_writer.isOpened() or not arms_writer.isOpened() or not legs_writer.isOpened():
        HYBRID_JOBS[job_id]["status"] = "error"
        HYBRID_JOBS[job_id]["error"] = "Failed to open VideoWriter."
        cap.release()
        return

    seg_model, pose_model = _get_shared_yolo_models()
    written = 0
    out_dt = 1.0 / float(out_fps)
    next_out_time = 0.0
    last_seg = np.zeros((h, w, 3), dtype=np.uint8)
    last_arms = np.zeros((h, w, 3), dtype=np.uint8)
    last_legs = np.zeros((h, w, 3), dtype=np.uint8)
    overlay_summary_frames: list[list[dict[str, float]]] = []
    pose_summary_frames: list[list[dict[str, float]]] = []
    pose_frames: list[dict[str, Any] | None] = []
    last_pose_frame: dict[str, Any] | None = None

    while written < expected:
        if _job_cancel_requested(HYBRID_JOBS, job_id):
            cap.release()
            seg_writer.release()
            arms_writer.release()
            legs_writer.release()
            _finalize_cancelled_job(HYBRID_JOBS, job_id, "tmp_in", "seg_out", "arms_out", "legs_out")
            return
        ok, frame = cap.read()
        if not ok:
            break
        abs_t = float(cap.get(cv2.CAP_PROP_POS_MSEC) or 0.0) / 1000.0
        rel_t = max(0.0, abs_t - seg_start)
        if rel_t > seg_duration + (out_dt * 0.25):
            break
        if rel_t + (out_dt * 0.25) < next_out_time:
            continue

        arms_overlay = np.zeros((h, w, 3), dtype=np.uint8)
        legs_overlay = np.zeros((h, w, 3), dtype=np.uint8)
        pose_result = pose_model.predict(frame, imgsz=768, conf=0.2, iou=0.5, verbose=False)
        pose_anchor: tuple[float, float] | None = None
        if pose_result and getattr(pose_result[0], "keypoints", None) is not None and len(pose_result[0].keypoints.xy) > 0:
            kp = pose_result[0].keypoints
            instances = _iter_pose_instances(kp)
            primary_instance = _select_primary_pose_instance(instances)
            selected_instances = list(instances)
            pose_summaries = _summarize_pose_instances(selected_instances, w, h)
            pose_summary_frames.append(pose_summaries)
            if primary_instance is not None:
                primary_summary = _summarize_pose_instances([primary_instance], w, h)
            else:
                primary_summary = []
            if primary_summary:
                pose_anchor = (
                    float(primary_summary[0].get("anchor_x", 0.5)),
                    float(primary_summary[0].get("anchor_y", 0.5)),
                )
            pose_frame = _serialize_pose_frame(selected_instances)
            for xy, conf in selected_instances:
                pose_arms_overlay, pose_legs_overlay = _render_pose_layers(xy, conf, w, h, arms_color, legs_color)
                arms_overlay = np.maximum(arms_overlay, pose_arms_overlay)
                legs_overlay = np.maximum(legs_overlay, pose_legs_overlay)
        else:
            pose_summary_frames.append([])
            pose_frame = None

        seg_result = seg_model.predict(frame, imgsz=768, conf=0.12, iou=0.5, classes=[0], verbose=False)
        alpha_u8, seg_summaries = _extract_segmentation_mask_data(
            seg_result,
            w,
            h,
            blur_sigma=0.9,
            primary_only=pose_anchor is None,
            match_anchor=pose_anchor,
        )
        seg_overlay = _build_segmentation_overlay(alpha_u8, color)
        overlay_summary_frames.append(seg_summaries)
        arms_overlay = _clip_overlay_to_mask(arms_overlay, alpha_u8)
        legs_overlay = _clip_overlay_to_mask(legs_overlay, alpha_u8)

        last_seg = seg_overlay
        last_arms = arms_overlay
        last_legs = legs_overlay
        last_pose_frame = pose_frame
        seg_writer.write(seg_overlay)
        arms_writer.write(arms_overlay)
        legs_writer.write(legs_overlay)
        pose_frames.append(pose_frame)
        written += 1
        next_out_time += out_dt
        HYBRID_JOBS[job_id]["frames_written"] = written
        HYBRID_JOBS[job_id]["progress"] = min(1.0, written / float(expected))

    while written < expected:
        if _job_cancel_requested(HYBRID_JOBS, job_id):
            cap.release()
            seg_writer.release()
            arms_writer.release()
            legs_writer.release()
            _finalize_cancelled_job(HYBRID_JOBS, job_id, "tmp_in", "seg_out", "arms_out", "legs_out")
            return
        seg_writer.write(last_seg)
        arms_writer.write(last_arms)
        legs_writer.write(last_legs)
        pose_frames.append(last_pose_frame)
        written += 1
        HYBRID_JOBS[job_id]["frames_written"] = written
        HYBRID_JOBS[job_id]["progress"] = min(1.0, written / float(expected))

    cap.release()
    seg_writer.release()
    arms_writer.release()
    legs_writer.release()
    if _job_cancel_requested(HYBRID_JOBS, job_id):
        _finalize_cancelled_job(HYBRID_JOBS, job_id, "tmp_in", "seg_out", "arms_out", "legs_out")
        return
    HYBRID_JOBS[job_id]["overlay_summary"] = _aggregate_mask_instance_summaries(overlay_summary_frames)
    HYBRID_JOBS[job_id]["pose_summary"] = _aggregate_pose_summaries(pose_summary_frames)
    HYBRID_JOBS[job_id]["pose_frames"] = pose_frames
    HYBRID_JOBS[job_id]["status"] = "done"


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
            for xy, conf in _iter_pose_instances(kp):
                arms_overlay, legs_overlay = _render_pose_layers(xy, conf, w, h, arms_color, legs_color)
                overlay = np.maximum(overlay, np.maximum(arms_overlay, legs_overlay))
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


@router.post("/api/overlay/yolo/cancel")
async def overlay_yolo_cancel(job_id: str = Form(...)):
    return _request_job_cancel(OVERLAY_JOBS, job_id)


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
    headers = {}
    encoded_summary = _encode_summary_header(job.get("overlay_summary"))
    if encoded_summary:
        headers["x-tempoflow-overlay-summary"] = encoded_summary
    OVERLAY_JOBS.pop(job_id, None)
    return FileResponse(
        path=out_path,
        media_type="video/webm",
        filename=f"{job_id}_yolo_overlay.webm",
        headers=headers,
    )


@router.post("/api/overlay/yolo-pose/start")
async def overlay_yolo_pose_start(
    video: UploadFile = File(...),
    arms_color: str = Form(default="#38bdf8"),
    legs_color: str = Form(default="#6366f1"),
    fps: int = Form(default=12),
    session_id: str | None = Form(default=None),
    side: str | None = Form(default=None),
    start_sec: float | None = Form(default=None),
    end_sec: float | None = Form(default=None),
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
        "start_sec": start_sec,
        "end_sec": end_sec,
        "error": None,
        "served_layers": set(),
    }
    threading.Thread(
        target=_run_pose_overlay_job,
        args=(job_id, tmp_in, arms_out, legs_out, arms_color, legs_color, fps, start_sec, end_sec),
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


@router.post("/api/overlay/yolo-pose/cancel")
async def overlay_yolo_pose_cancel(job_id: str = Form(...)):
    return _request_job_cancel(POSE_JOBS, job_id)


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
    headers = {}
    encoded_summary = _encode_summary_header(job.get("pose_summary"))
    if encoded_summary:
        headers["x-tempoflow-pose-summary"] = encoded_summary
    return FileResponse(
        path=out_path,
        media_type="video/webm",
        filename=f"{job_id}_{layer}_overlay.webm",
        headers=headers,
    )


# Use a shared executor to limit concurrent YOLO inference tasks
YOLO_EXECUTOR = ThreadPoolExecutor(max_workers=2)

# Global models cached to avoid reloading weights in every thread
_YOLO_SEG_MODEL_CACHE: Any = None
_YOLO_POSE_MODEL_CACHE: Any = None
_YOLO_MODEL_LOCK = threading.Lock()

def _get_shared_yolo_models():
    global _YOLO_SEG_MODEL_CACHE, _YOLO_POSE_MODEL_CACHE
    with _YOLO_MODEL_LOCK:
        if _YOLO_SEG_MODEL_CACHE is None:
            from ultralytics import YOLO
            _YOLO_SEG_MODEL_CACHE = YOLO(str(_weights_path("yolo26n-seg.pt")))
        if _YOLO_POSE_MODEL_CACHE is None:
            from ultralytics import YOLO
            _YOLO_POSE_MODEL_CACHE = YOLO(str(_weights_path("yolo26n-pose.pt")))
    return _YOLO_SEG_MODEL_CACHE, _YOLO_POSE_MODEL_CACHE

@router.post("/api/overlay/yolo-hybrid/start")
async def overlay_yolo_hybrid_start(
    video: UploadFile = File(...),
    color: str = Form(default="#38bdf8"),
    arms_color: str = Form(default="#38bdf8"),
    legs_color: str = Form(default="#6366f1"),
    fps: int = Form(default=12),
    session_id: str | None = Form(default=None),
    side: str | None = Form(default=None),
    start_sec: float | None = Form(default=None),
    end_sec: float | None = Form(default=None),
):
    job_id = str(uuid.uuid4())
    tmp_in = save_upload(video, f"hybrid_{(side or 'unknown')}_{job_id}")
    seg_out = tempfile.NamedTemporaryFile(prefix=f"hybrid_seg_{job_id}_", suffix=".webm", delete=False).name
    arms_out = tempfile.NamedTemporaryFile(prefix=f"hybrid_arms_{job_id}_", suffix=".webm", delete=False).name
    legs_out = tempfile.NamedTemporaryFile(prefix=f"hybrid_legs_{job_id}_", suffix=".webm", delete=False).name
    
    HYBRID_JOBS[job_id] = {
        "status": "queued",
        "progress": 0.0,
        "frames_written": 0,
        "frames_expected": None,
        "tmp_in": tmp_in,
        "seg_out": seg_out,
        "arms_out": arms_out,
        "legs_out": legs_out,
        "session_id": (session_id or "default"),
        "side": (side or "unknown"),
        "start_sec": start_sec,
        "end_sec": end_sec,
        "error": None,
        "served_layers": set(),
    }
    
    # Run in serialized executor to prevent CPU saturation
    YOLO_EXECUTOR.submit(
        _run_hybrid_overlay_job,
        job_id, tmp_in, seg_out, arms_out, legs_out, color, arms_color, legs_color, fps, start_sec, end_sec
    )
    
    return JSONResponse({"job_id": job_id}, status_code=200)


@router.get("/api/overlay/yolo-hybrid/status")
async def overlay_yolo_hybrid_status(job_id: str):
    job = HYBRID_JOBS.get(job_id)
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


@router.post("/api/overlay/yolo-hybrid/cancel")
async def overlay_yolo_hybrid_cancel(job_id: str = Form(...)):
    return _request_job_cancel(HYBRID_JOBS, job_id)


@router.get("/api/overlay/yolo-hybrid/pose-data")
async def overlay_yolo_hybrid_pose_data(job_id: str):
    job = HYBRID_JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    if job.get("status") != "done":
        return JSONResponse({"error": "Job not ready"}, status_code=409)
    return JSONResponse(
        {
            "frames": job.get("pose_frames") or [],
        },
        status_code=200,
    )


@router.get("/api/overlay/yolo-hybrid/result")
async def overlay_yolo_hybrid_result(job_id: str, layer: str, background_tasks: BackgroundTasks):
    job = HYBRID_JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    if job.get("status") != "done":
        return JSONResponse({"error": "Job not ready"}, status_code=409)
    if layer not in {"seg", "arms", "legs"}:
        return JSONResponse({"error": "Invalid layer"}, status_code=400)

    key = {"seg": "seg_out", "arms": "arms_out", "legs": "legs_out"}[layer]
    out_path = job.get(key)
    if not out_path:
        return JSONResponse({"error": "Missing output"}, status_code=500)

    served_layers = job.get("served_layers")
    if not isinstance(served_layers, set):
        served_layers = set()
        job["served_layers"] = served_layers
    served_layers.add(layer)

    background_tasks.add_task(lambda: Path(out_path).unlink(missing_ok=True))
    if served_layers == {"seg", "arms", "legs"}:
        if job.get("tmp_in"):
            background_tasks.add_task(lambda: Path(job["tmp_in"]).unlink(missing_ok=True))
        HYBRID_JOBS.pop(job_id, None)

    headers = {}
    encoded_overlay_summary = _encode_summary_header(job.get("overlay_summary"))
    if encoded_overlay_summary:
        headers["x-tempoflow-overlay-summary"] = encoded_overlay_summary
    encoded_pose_summary = _encode_summary_header(job.get("pose_summary"))
    if encoded_pose_summary:
        headers["x-tempoflow-pose-summary"] = encoded_pose_summary
    return FileResponse(
        path=out_path,
        media_type="video/webm",
        filename=f"{job_id}_{layer}_overlay.webm",
        headers=headers,
    )


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
