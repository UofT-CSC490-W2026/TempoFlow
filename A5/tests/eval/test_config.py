"""Tests for `src.eval.config` module-level behavior."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_config_emits_warning_when_openai_key_missing_for_gpt_models():
    """The `logging.warning` branch runs at import when gpt-* models lack an API key."""
    env = os.environ.copy()
    env.pop("OPENAI_API_KEY", None)
    env["PYTHONPATH"] = str(ROOT)
    code = (
        "import logging\n"
        "logging.basicConfig(level=logging.WARNING)\n"
        "import importlib\n"
        "import src.eval.config\n"
        "importlib.reload(src.eval.config)\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0
    combined = proc.stdout + proc.stderr
    assert "OPENAI_API_KEY" in combined
