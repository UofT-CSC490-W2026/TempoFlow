"""
Cross-platform resolution for ffmpeg / ffprobe executables.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


def _candidate_from_env(env_name: str) -> str | None:
    raw = (os.environ.get(env_name) or "").strip()
    if not raw:
        return None
    expanded = Path(raw).expanduser()
    if expanded.is_file():
        return str(expanded.resolve())
    found = shutil.which(raw)
    if found:
        return found
    # Do not return a non-existent path (e.g. EB env set before first boot install).
    return None


def _common_windows_ffmpeg_dirs() -> list[Path]:
    out: list[Path] = []
    pf = os.environ.get("PROGRAMFILES")
    pfx86 = os.environ.get("PROGRAMFILES(X86)")
    if pf:
        out.append(Path(pf) / "ffmpeg" / "bin")
    if pfx86:
        out.append(Path(pfx86) / "ffmpeg" / "bin")
    out.append(Path(r"C:\ffmpeg\bin"))
    return out


def _first_existing_exe(dirs: list[Path], name: str) -> str | None:
    for directory in dirs:
        for fname in (name, f"{name}.exe"):
            p = directory / fname
            if p.is_file():
                return str(p.resolve())
    return None


def _common_unix_ffmpeg_dirs() -> list[Path]:
    """Elastic Beanstalk / Docker often install static ffmpeg under /usr/local/bin (not always on minimal PATH)."""
    return [Path("/usr/local/bin"), Path("/usr/bin"), Path("/bin")]


def resolve_ffmpeg_executable() -> str:
    c = _candidate_from_env("EBS_FFMPEG_PATH")
    if c:
        return c
    w = shutil.which("ffmpeg")
    if w:
        return w
    if sys.platform == "win32":
        hit = _first_existing_exe(_common_windows_ffmpeg_dirs(), "ffmpeg")
        if hit:
            return hit
    else:
        hit = _first_existing_exe(_common_unix_ffmpeg_dirs(), "ffmpeg")
        if hit:
            return hit
    return "ffmpeg"


def resolve_ffprobe_executable() -> str:
    c = _candidate_from_env("EBS_FFPROBE_PATH")
    if c:
        return c
    w = shutil.which("ffprobe")
    if w:
        return w
    if sys.platform == "win32":
        hit = _first_existing_exe(_common_windows_ffmpeg_dirs(), "ffprobe")
        if hit:
            return hit
    else:
        hit = _first_existing_exe(_common_unix_ffmpeg_dirs(), "ffprobe")
        if hit:
            return hit
    return "ffprobe"
