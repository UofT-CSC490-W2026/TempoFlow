"""Evaluation configuration constants."""
from __future__ import annotations

import logging
import os
from pathlib import Path

EVAL_MODELS: list[str] = [
    "gemini-2.5-flash-lite",   # index 0 = baseline, returned to user
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gpt-5.2",
]

PROMPT_VERSION: str = "v1.0"

EVAL_DIR: Path = Path(
    os.environ.get("EVAL_DIR", str(Path(__file__).resolve().parents[3] / "evaluations"))
)

_openai_key = os.environ.get("OPENAI_API_KEY")
if not _openai_key and any(m.startswith("gpt-") for m in EVAL_MODELS):
    logging.warning("OPENAI_API_KEY not set — skipping gpt-* models")
