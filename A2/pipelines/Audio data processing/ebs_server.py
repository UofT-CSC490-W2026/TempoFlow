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
import subprocess
import tempfile
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

# Import the EBS pipeline functions from the co-located module
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


def probe_video_metadata(video_path: str) -> dict:
    """Return fps, duration, and frame count for a video file."""
    cmd = [
        "ffprobe",
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
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
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

    def do_GET(self):
        # Browsers auto-request /favicon.ico. Return 204 to avoid noisy 404s.
        if self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()

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

            if not ref_field.file or not user_field.file:
                self._json_error(400, "Both ref_video and user_video are required")
                return

            logger.info("Received video files — running EBS pipeline")

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
                self._json_response(200, artifact)
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
            self._json_error(500, str(exc))

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
        body = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json_error(self, code, message):
        self._json_response(code, {"error": message})

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
