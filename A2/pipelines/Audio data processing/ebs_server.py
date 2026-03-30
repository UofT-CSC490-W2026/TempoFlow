#!/usr/bin/env python3
"""
EBS Viewer Server

Lightweight local HTTP server that:
  1. Serves the EBS viewer HTML at http://localhost:8787
  2. POST /api/process  — accepts two video files, runs the EBS pipeline,
     and returns the resulting JSON

Usage:
    python3 ebs_server.py                     # default port 8787
    python3 ebs_server.py --port 9000         # custom port

Then open http://localhost:8787 in your browser.
"""

import argparse
import cgi
import io
import json
import logging
import math
import subprocess
import tempfile
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

# Import the EBS pipeline functions from the co-located module
from ebs_ffmpeg_paths import resolve_ffprobe_executable
from ebs_segment import (
    auto_align,
    extract_audio_from_video,
    load_audio,
    run_ebs_pipeline,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("ebs-server")

SERVE_DIR = Path(__file__).resolve().parent

# Store latest results in-memory keyed by session_id.
# This allows the frontend to recover if the original long POST hangs client-side.
SESSION_STATUS: dict[str, str] = {}
SESSION_RESULTS: dict[str, dict] = {}


def probe_video_metadata(video_path: str) -> dict:
    """Return fps, duration, and frame count for a video file."""
    ffprobe_exe = resolve_ffprobe_executable()
    cmd = [
        ffprobe_exe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=avg_frame_rate,nb_frames,duration",
        "-of",
        "json",
        video_path,
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"ffprobe not found ({ffprobe_exe}). Install FFmpeg, add to PATH, "
            "or set EBS_FFPROBE_PATH."
        ) from exc
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr.strip()}")

    payload = json.loads(result.stdout or "{}")
    streams = payload.get("streams", [])
    if not streams:
        raise RuntimeError("No video stream found")

    stream = streams[0]
    fps_raw = stream.get("avg_frame_rate", "0/1")
    num, den = fps_raw.split("/")
    fps = float(num) / float(den) if float(den) != 0 else 0.0
    duration_sec = float(stream.get("duration") or 0.0)

    nb_frames_raw = stream.get("nb_frames")
    if nb_frames_raw and str(nb_frames_raw).isdigit():
        frame_count = int(nb_frames_raw)
    else:
        frame_count = int(round(duration_sec * fps)) if fps > 0 else 0

    return {
        "fps": fps,
        "duration_sec": duration_sec,
        "frame_count": frame_count,
    }


class EBSHandler(SimpleHTTPRequestHandler):
    """Serve static files + handle the /api/process endpoint."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SERVE_DIR), **kwargs)

    # ----- API route -------------------------------------------------------

    def do_POST(self):
        if self.path == "/api/process":
            self._handle_process()
        else:
            self.send_error(404, "Not found")

    def do_OPTIONS(self):
        if self.path.startswith("/api/"):
            self.send_response(204)
            self.end_headers()
            return
        self.send_error(404, "Not found")

    def do_GET(self):
        # Browsers auto-request /favicon.ico. Return 204 to avoid noisy 404s.
        if self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if self.path.startswith("/api/status"):
            self._handle_status()
            return
        if self.path.startswith("/api/result"):
            self._handle_result()
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def _handle_process(self):
        """Accept ref_video + user_video, run EBS, return JSON."""
        try:
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                self._json_error(400, "Expected multipart/form-data")
                return

            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={
                    "REQUEST_METHOD": "POST",
                    "CONTENT_TYPE": content_type,
                },
            )

            ref_field = form["ref_video"]
            user_field = form["user_video"]
            session_id = None
            try:
                session_id = form.getfirst("session_id")
            except Exception:
                session_id = None
            session_id = (session_id or "").strip() or "default"

            if not ref_field.file or not user_field.file:
                self._json_error(400, "Both ref_video and user_video are required")
                return

            logger.info("Received video files — running EBS pipeline (session=%s)", session_id)
            SESSION_STATUS[session_id] = "processing"

            # Write uploads to temp files
            ref_tmp = self._save_upload(ref_field, "ref")
            user_tmp = self._save_upload(user_field, "user")

            try:
                # Extract audio
                logger.info("Extracting audio from reference video…")
                ref_wav = extract_audio_from_video(ref_tmp)
                logger.info("Extracting audio from user video…")
                user_wav = extract_audio_from_video(user_tmp)

                # Auto-align
                logger.info("Computing auto-alignment…")
                ref_audio = load_audio(ref_wav)
                user_audio = load_audio(user_wav)
                alignment = auto_align(ref_audio, user_audio)

                # Run EBS
                logger.info("Running EBS segmentation…")
                artifact = run_ebs_pipeline(
                    ref_audio_path=ref_wav,
                    alignment=alignment,
                    user_audio_path=user_wav,
                )

                # Probe uploaded videos for frame-accurate playback metadata
                try:
                    artifact["video_meta"] = {
                        "clip_1": probe_video_metadata(ref_tmp),
                        "clip_2": probe_video_metadata(user_tmp),
                    }
                except Exception as probe_exc:
                    logger.warning("Video probe failed: %s", probe_exc)

                # Return JSON
                SESSION_RESULTS[session_id] = self._sanitize_json(artifact)
                SESSION_STATUS[session_id] = "done"
                self._json_response(200, SESSION_RESULTS[session_id])
                logger.info(
                    "Done — %d segments (%s)",
                    len(artifact["segments"]),
                    artifact["segmentation_mode"],
                )

            finally:
                # Cleanup temp files
                for p in [ref_tmp, user_tmp]:
                    try:
                        Path(p).unlink(missing_ok=True)
                    except OSError:
                        pass
                for p in [ref_wav, user_wav]:
                    try:
                        Path(p).unlink(missing_ok=True)
                    except OSError:
                        pass

        except Exception as exc:
            logger.exception("Pipeline error")
            if "session_id" in locals():
                SESSION_STATUS[session_id] = "error"
            self._json_error(500, str(exc))

    def _handle_status(self):
        # /api/status?session=<id>
        try:
            session_id = self._get_query_param("session") or "default"
            status = SESSION_STATUS.get(session_id, "idle")
            has_result = session_id in SESSION_RESULTS
            segment_count = None
            if has_result:
                try:
                    segment_count = len(SESSION_RESULTS[session_id].get("segments") or [])
                except Exception:
                    segment_count = None
            self._json_response(
                200,
                {
                    "session": session_id,
                    "status": status,
                    "has_result": has_result,
                    "segment_count": segment_count,
                },
            )
        except Exception as exc:
            self._json_error(500, str(exc))

    def _handle_result(self):
        # /api/result?session=<id>
        try:
            session_id = self._get_query_param("session") or "default"
            if session_id not in SESSION_RESULTS:
                self._json_error(404, "No result for this session yet.")
                return
            self._json_response(200, SESSION_RESULTS[session_id])
        except Exception as exc:
            self._json_error(500, str(exc))

    def _get_query_param(self, key: str) -> str | None:
        # Avoid importing urllib at top-level; tiny helper here.
        from urllib.parse import parse_qs, urlparse

        parsed = urlparse(self.path)
        params = parse_qs(parsed.query or "")
        values = params.get(key)
        if not values:
            return None
        return values[0]

    # ----- Helpers ---------------------------------------------------------

    @staticmethod
    def _save_upload(field, prefix):
        """Write an uploaded file to a temp path and return the path."""
        suffix = Path(field.filename or "video.mp4").suffix or ".mp4"
        tmp = tempfile.NamedTemporaryFile(
            prefix=f"ebs_{prefix}_", suffix=suffix, delete=False
        )
        tmp.write(field.file.read())
        tmp.close()
        return tmp.name

    def _json_response(self, code, data):
        body = json.dumps(self._sanitize_json(data), indent=2, allow_nan=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json_error(self, code, message):
        self._json_response(code, {"error": message})

    @staticmethod
    def _sanitize_json(obj):
        """Recursively replace NaN/Infinity with None so output is valid JSON."""
        if isinstance(obj, float):
            return obj if math.isfinite(obj) else None
        if isinstance(obj, dict):
            return {k: EBSHandler._sanitize_json(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [EBSHandler._sanitize_json(v) for v in obj]
        return obj

    # Suppress noisy access logs for static files
    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            logger.info(fmt, *args)


# -----------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="EBS Viewer Server")
    parser.add_argument(
        "--port", type=int, default=8787,
        help="Port to serve on (default: 8787)",
    )
    args = parser.parse_args()

    server = HTTPServer(("127.0.0.1", args.port), EBSHandler)
    url = f"http://localhost:{args.port}/ebs_viewer.html"
    logger.info("EBS Viewer Server running at %s", url)
    logger.info("Press Ctrl+C to stop")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
