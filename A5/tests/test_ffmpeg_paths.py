"""Unit tests for `src/ffmpeg_paths.py`."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import src.ffmpeg_paths as fp


def test_candidate_from_env_empty():
    assert fp._candidate_from_env("EBS_FFMPEG_PATH___UNSET_XYZ") is None


def test_candidate_from_env_existing_file(tmp_path, monkeypatch):
    exe = tmp_path / "myffmpeg"
    exe.write_text("#!/bin/sh\necho ok\n")
    monkeypatch.setenv("EBS_FFMPEG_PATH", str(exe))
    out = fp._candidate_from_env("EBS_FFMPEG_PATH")
    assert out is not None
    assert Path(out).resolve() == exe.resolve()


def test_candidate_from_env_which(monkeypatch):
    monkeypatch.setenv("EBS_FFMPEG_PATH", "ffmpeg")
    with patch.object(fp.shutil, "which", return_value="/usr/bin/ffmpeg"):
        assert fp._candidate_from_env("EBS_FFMPEG_PATH") == "/usr/bin/ffmpeg"


def test_candidate_from_env_missing_path_returns_none(monkeypatch):
    monkeypatch.setenv("EBS_FFMPEG_PATH", "/no/such/file")
    with patch.object(fp.shutil, "which", return_value=None):
        assert fp._candidate_from_env("EBS_FFMPEG_PATH") is None


def test_resolve_ffmpeg_prefers_env(tmp_path, monkeypatch):
    exe = tmp_path / "ff"
    exe.write_text("x")
    monkeypatch.setenv("EBS_FFMPEG_PATH", str(exe))
    with patch.object(fp.shutil, "which", return_value="/bin/ffmpeg"):
        assert fp.resolve_ffmpeg_executable() == str(exe.resolve())


def test_resolve_ffmpeg_uses_which(monkeypatch):
    monkeypatch.delenv("EBS_FFMPEG_PATH", raising=False)
    with patch.object(fp.shutil, "which", return_value="/opt/ffmpeg"):
        assert fp.resolve_ffmpeg_executable() == "/opt/ffmpeg"


def test_resolve_ffmpeg_windows_fallback(tmp_path, monkeypatch):
    monkeypatch.delenv("EBS_FFMPEG_PATH", raising=False)
    bindir = tmp_path / "ffmpeg" / "bin"
    bindir.mkdir(parents=True)
    exe = bindir / "ffmpeg.exe"
    exe.write_text("x")
    monkeypatch.setenv("PROGRAMFILES", str(tmp_path))
    with patch.object(fp.sys, "platform", "win32"):
        with patch.object(fp.shutil, "which", return_value=None):
            with patch.object(fp, "_common_windows_ffmpeg_dirs", return_value=[bindir]):
                assert fp.resolve_ffmpeg_executable() == str(exe.resolve())


def test_resolve_ffmpeg_default_when_no_hit(monkeypatch):
    monkeypatch.delenv("EBS_FFMPEG_PATH", raising=False)
    with patch.object(fp.sys, "platform", "linux"):
        with patch.object(fp.shutil, "which", return_value=None):
            assert fp.resolve_ffmpeg_executable() == "ffmpeg"


def test_resolve_ffprobe_prefers_env(monkeypatch, tmp_path):
    exe = tmp_path / "fp"
    exe.write_text("x")
    monkeypatch.setenv("EBS_FFPROBE_PATH", str(exe))
    assert fp.resolve_ffprobe_executable() == str(exe.resolve())


def test_resolve_ffprobe_uses_which(monkeypatch):
    monkeypatch.delenv("EBS_FFPROBE_PATH", raising=False)
    with patch.object(fp.shutil, "which", return_value="/usr/bin/ffprobe"):
        assert fp.resolve_ffprobe_executable() == "/usr/bin/ffprobe"


def test_resolve_ffprobe_windows_fallback(tmp_path, monkeypatch):
    monkeypatch.delenv("EBS_FFPROBE_PATH", raising=False)
    bindir = tmp_path / "ffmpeg" / "bin"
    bindir.mkdir(parents=True)
    exe = bindir / "ffprobe.exe"
    exe.write_text("x")
    monkeypatch.setenv("PROGRAMFILES", str(tmp_path))
    with patch.object(fp.sys, "platform", "win32"):
        with patch.object(fp.shutil, "which", return_value=None):
            with patch.object(fp, "_common_windows_ffmpeg_dirs", return_value=[bindir]):
                assert fp.resolve_ffprobe_executable() == str(exe.resolve())


def test_resolve_ffprobe_default_when_no_hit(monkeypatch):
    monkeypatch.delenv("EBS_FFPROBE_PATH", raising=False)
    with patch.object(fp.sys, "platform", "linux"):
        with patch.object(fp.shutil, "which", return_value=None):
            assert fp.resolve_ffprobe_executable() == "ffprobe"


def test_first_existing_exe_none():
    assert fp._first_existing_exe([], "ffmpeg") is None


def test_common_windows_ffmpeg_dirs_structure(monkeypatch):
    monkeypatch.setenv("PROGRAMFILES", r"C:\Program Files")
    monkeypatch.setenv("PROGRAMFILES(X86)", r"C:\Program Files (x86)")
    dirs = fp._common_windows_ffmpeg_dirs()
    assert any("Program Files" in str(p) for p in dirs)
    assert Path(r"C:\ffmpeg\bin") in dirs
