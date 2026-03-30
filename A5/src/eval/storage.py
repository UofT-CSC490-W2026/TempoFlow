"""Filesystem + SQLite evaluation storage.

Filesystem is the source of truth; SQLite is the query layer.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import EVAL_DIR

MAX_EXPERTS = 7
EXPERT_IDS = [f"expert_{i}" for i in range(1, MAX_EXPERTS + 1)]

logger = logging.getLogger("eval-storage")

_LOCAL = threading.local()

# ---------------------------------------------------------------------------
# SQLite helpers
# ---------------------------------------------------------------------------

_CREATE_EVALUATIONS = """\
CREATE TABLE IF NOT EXISTS evaluations (
    id TEXT PRIMARY KEY,
    video_id TEXT,
    segment_id TEXT,
    model_id TEXT,
    prompt_version TEXT,
    latency_ms INTEGER,
    created_at TEXT,
    output JSON
);
"""

_CREATE_EXPERT_RATINGS = """\
CREATE TABLE IF NOT EXISTS expert_ratings (
    id TEXT PRIMARY KEY,
    evaluation_id TEXT REFERENCES evaluations(id),
    expert_id TEXT,
    move_index INTEGER,
    label_accuracy INT,
    body_part_specificity INT,
    timing_granularity INT,
    coaching_actionability INT,
    confidence_calibration INT,
    occlusion_handling INT,
    notes TEXT,
    preferred BOOLEAN DEFAULT 0,
    rated_at TEXT
);
"""


def _db_path() -> Path:
    return EVAL_DIR / "eval.db"


def init_db() -> None:
    conn = _get_conn()
    conn.execute(_CREATE_EVALUATIONS)
    conn.execute(_CREATE_EXPERT_RATINGS)
    conn.commit()


def _get_conn() -> sqlite3.Connection:
    conn: sqlite3.Connection | None = getattr(_LOCAL, "conn", None)
    if conn is not None:
        return conn
    EVAL_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(_db_path()), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    _LOCAL.conn = conn
    init_db()
    return conn


# ---------------------------------------------------------------------------
# Video ID generation
# ---------------------------------------------------------------------------

_VIDEO_ID_CACHE: dict[str, str] = {}


def video_id_from_filename(filepath: str) -> str:
    resolved = str(Path(filepath).resolve())
    cached = _VIDEO_ID_CACHE.get(resolved)
    if cached:
        return cached

    name = Path(filepath).stem
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "video"
    ts_hash = hashlib.sha256(str(time.time()).encode()).hexdigest()[:8]
    vid = f"{slug}-{ts_hash}"
    _VIDEO_ID_CACHE[resolved] = vid
    return vid


# ---------------------------------------------------------------------------
# Evaluation writes
# ---------------------------------------------------------------------------


def _eval_id(video_id: str, segment_id: str, model_id: str) -> str:
    return f"{video_id}__{segment_id}__{model_id}"


def write_evaluation(
    video_id: str,
    segment_id: str,
    model_id: str,
    prompt_version: str,
    latency_ms: int,
    output: dict[str, Any],
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    eid = _eval_id(video_id, segment_id, model_id)

    record = {
        "id": eid,
        "model_id": model_id,
        "video_id": video_id,
        "segment_id": segment_id,
        "prompt_version": prompt_version,
        "latency_ms": latency_ms,
        "created_at": now,
        "output": output,
    }

    # Filesystem write
    try:
        out_dir = EVAL_DIR / video_id / segment_id
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{model_id}.json"
        out_path.write_text(json.dumps(record, indent=2, default=str))
    except Exception:
        logger.exception("Failed to write evaluation JSON for %s", eid)

    # SQLite upsert
    try:
        conn = _get_conn()
        conn.execute(
            """INSERT INTO evaluations (id, video_id, segment_id, model_id,
                   prompt_version, latency_ms, created_at, output)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                   prompt_version=excluded.prompt_version,
                   latency_ms=excluded.latency_ms,
                   created_at=excluded.created_at,
                   output=excluded.output""",
            (eid, video_id, segment_id, model_id, prompt_version, latency_ms, now, json.dumps(output, default=str)),
        )
        conn.commit()
    except Exception:
        logger.exception("Failed to upsert evaluation to SQLite for %s", eid)


# ---------------------------------------------------------------------------
# Evaluation reads (filesystem-first)
# ---------------------------------------------------------------------------


def list_videos() -> list[dict[str, Any]]:
    videos: list[dict[str, Any]] = []
    if not EVAL_DIR.exists():
        return videos

    for vdir in sorted(EVAL_DIR.iterdir()):
        if not vdir.is_dir() or vdir.name.endswith(".db"):
            continue
        seg_dirs = sorted([d for d in vdir.iterdir() if d.is_dir()])
        models_present: set[str] = set()
        first_created: str | None = None
        rated_segs = 0

        total_experts: set[str] = set()

        for sdir in seg_dirs:
            ratings_file = sdir / "expert_ratings.json"
            if ratings_file.exists():
                try:
                    all_ratings = json.loads(ratings_file.read_text())
                    seg_experts = {r.get("expert_id", "") for r in all_ratings if r.get("expert_id")}
                    total_experts |= seg_experts
                    if seg_experts:
                        rated_segs += 1
                except Exception:
                    pass
            for f in sdir.glob("*.json"):
                if f.stem == "expert_ratings":
                    continue
                models_present.add(f.stem)
                if first_created is None:
                    try:
                        data = json.loads(f.read_text())
                        first_created = data.get("created_at", "")
                    except Exception:
                        pass

        videos.append(
            {
                "video_id": vdir.name,
                "date": (first_created or "")[:19].replace("T", " "),
                "segments": len(seg_dirs),
                "models": sorted(models_present),
                "rated": rated_segs,
                "total": len(seg_dirs),
                "experts_done": len(total_experts),
                "experts_max": MAX_EXPERTS,
            }
        )
    return videos


def load_segment_evaluations(video_id: str, segment_id: str) -> dict[str, dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    seg_dir = EVAL_DIR / video_id / segment_id
    if not seg_dir.exists():
        return results
    for f in sorted(seg_dir.glob("*.json")):
        if f.stem == "expert_ratings":
            continue
        try:
            data = json.loads(f.read_text())
            results[f.stem] = data
        except Exception:
            logger.exception("Failed to read %s", f)
    return results


def load_expert_ratings(
    video_id: str, segment_id: str, expert_id: str | None = None,
) -> list[dict[str, Any]]:
    path = EVAL_DIR / video_id / segment_id / "expert_ratings.json"
    if not path.exists():
        return []
    try:
        all_ratings: list[dict[str, Any]] = json.loads(path.read_text())
        if expert_id:
            return [r for r in all_ratings if r.get("expert_id") == expert_id]
        return all_ratings
    except Exception:
        logger.exception("Failed to read expert ratings from %s", path)
        return []


def experts_who_rated(video_id: str, segment_id: str) -> set[str]:
    all_ratings = load_expert_ratings(video_id, segment_id)
    return {r["expert_id"] for r in all_ratings if r.get("expert_id")}


def segment_ids_for_video(video_id: str) -> list[str]:
    vdir = EVAL_DIR / video_id
    if not vdir.exists():
        return []
    return sorted(d.name for d in vdir.iterdir() if d.is_dir())


# ---------------------------------------------------------------------------
# Expert rating writes
# ---------------------------------------------------------------------------

_METRIC_FIELDS = (
    "label_accuracy",
    "body_part_specificity",
    "timing_granularity",
    "coaching_actionability",
    "confidence_calibration",
    "occlusion_handling",
)


def validate_ratings(ratings: list[dict[str, Any]]) -> str | None:
    for r in ratings:
        for field in _METRIC_FIELDS:
            val = r.get(field)
            if not isinstance(val, int) or val < 1 or val > 5:
                return f"Invalid {field}: must be int 1–5 (got {val!r})"
    return None


def write_expert_ratings(
    video_id: str,
    segment_id: str,
    ratings: list[dict[str, Any]],
    expert_id: str = "expert_1",
) -> None:
    if expert_id not in EXPERT_IDS:
        raise ValueError(f"expert_id must be one of {EXPERT_IDS}")

    now = datetime.now(timezone.utc).isoformat()

    for r in ratings:
        r["expert_id"] = expert_id

    # Filesystem write — merge: keep other experts' ratings, replace this expert's
    try:
        out_dir = EVAL_DIR / video_id / segment_id
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / "expert_ratings.json"
        existing: list[dict[str, Any]] = []
        if path.exists():
            try:
                existing = json.loads(path.read_text())
            except Exception:
                pass
        merged = [r for r in existing if r.get("expert_id") != expert_id] + ratings
        path.write_text(json.dumps(merged, indent=2, default=str))
    except Exception:
        logger.exception("Failed to write expert_ratings JSON")

    # SQLite upserts
    try:
        conn = _get_conn()
        for r in ratings:
            model_id = r["model_id"]
            move_index = r["move_index"]
            eval_id = _eval_id(video_id, segment_id, model_id)
            rating_id = f"{eval_id}__{expert_id}__{move_index}"
            conn.execute(
                """INSERT INTO expert_ratings
                       (id, evaluation_id, expert_id, move_index,
                        label_accuracy, body_part_specificity, timing_granularity,
                        coaching_actionability, confidence_calibration, occlusion_handling,
                        notes, preferred, rated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                       label_accuracy=excluded.label_accuracy,
                       body_part_specificity=excluded.body_part_specificity,
                       timing_granularity=excluded.timing_granularity,
                       coaching_actionability=excluded.coaching_actionability,
                       confidence_calibration=excluded.confidence_calibration,
                       occlusion_handling=excluded.occlusion_handling,
                       notes=excluded.notes,
                       preferred=excluded.preferred,
                       rated_at=excluded.rated_at""",
                (
                    rating_id, eval_id, expert_id, move_index,
                    r["label_accuracy"], r["body_part_specificity"], r["timing_granularity"],
                    r["coaching_actionability"], r["confidence_calibration"], r["occlusion_handling"],
                    r.get("notes", ""), 1 if r.get("preferred") else 0, now,
                ),
            )
        conn.commit()
    except Exception:
        logger.exception("Failed to upsert expert_ratings to SQLite")


# ---------------------------------------------------------------------------
# Dashboard queries (SQLite only)
# ---------------------------------------------------------------------------


def query_model_aggregates(prompt_version: str | None = None) -> list[dict[str, Any]]:
    conn = _get_conn()
    where = "WHERE e.prompt_version = ?" if prompt_version else ""
    params: tuple[Any, ...] = (prompt_version,) if prompt_version else ()
    rows = conn.execute(
        f"""
        SELECT
            e.model_id,
            COUNT(DISTINCT e.video_id || '/' || e.segment_id) AS segments_rated,
            AVG(er.label_accuracy)           AS avg_label_accuracy,
            AVG(er.body_part_specificity)    AS avg_body_part_specificity,
            AVG(er.timing_granularity)       AS avg_timing_granularity,
            AVG(er.coaching_actionability)   AS avg_coaching_actionability,
            AVG(er.confidence_calibration)   AS avg_confidence_calibration,
            AVG(er.occlusion_handling)       AS avg_occlusion_handling,
            (AVG(er.label_accuracy) + AVG(er.body_part_specificity) +
             AVG(er.timing_granularity) + AVG(er.coaching_actionability) +
             AVG(er.confidence_calibration) + AVG(er.occlusion_handling)) / 6.0 AS overall_avg,
            SUM(CASE WHEN er.preferred THEN 1 ELSE 0 END) * 100.0 / MAX(COUNT(*), 1) AS win_rate,
            AVG(e.latency_ms)               AS avg_latency
        FROM expert_ratings er
        JOIN evaluations e ON er.evaluation_id = e.id
        {where}
        GROUP BY e.model_id
        ORDER BY overall_avg DESC
        """,
        params,
    ).fetchall()
    return [dict(r) for r in rows]


def query_per_video_scores(prompt_version: str | None = None) -> list[dict[str, Any]]:
    conn = _get_conn()
    where = "WHERE e.prompt_version = ?" if prompt_version else ""
    params: tuple[Any, ...] = (prompt_version,) if prompt_version else ()
    rows = conn.execute(
        f"""
        SELECT
            e.video_id,
            e.segment_id,
            e.model_id,
            AVG(er.label_accuracy)           AS avg_label_accuracy,
            AVG(er.body_part_specificity)    AS avg_body_part_specificity,
            AVG(er.timing_granularity)       AS avg_timing_granularity,
            AVG(er.coaching_actionability)   AS avg_coaching_actionability,
            AVG(er.confidence_calibration)   AS avg_confidence_calibration,
            AVG(er.occlusion_handling)       AS avg_occlusion_handling
        FROM expert_ratings er
        JOIN evaluations e ON er.evaluation_id = e.id
        {where}
        GROUP BY e.video_id, e.segment_id, e.model_id
        ORDER BY e.video_id, e.segment_id, e.model_id
        """,
        params,
    ).fetchall()
    return [dict(r) for r in rows]


def query_prompt_versions() -> list[str]:
    conn = _get_conn()
    rows = conn.execute(
        "SELECT DISTINCT prompt_version FROM evaluations ORDER BY prompt_version"
    ).fetchall()
    return [r["prompt_version"] for r in rows]
