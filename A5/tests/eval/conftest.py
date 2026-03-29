"""Shared fixtures for `src.eval` tests."""

from __future__ import annotations

import pytest

import src.eval.runner as runner_mod
import src.eval.storage as storage_mod


@pytest.fixture
def eval_dir(tmp_path, monkeypatch):
    """Isolated evaluations root + fresh SQLite connection per test."""
    root = tmp_path / "evaluations"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(storage_mod, "EVAL_DIR", root)
    monkeypatch.setattr(runner_mod, "EVAL_DIR", root)
    monkeypatch.setattr("src.eval.review_ui.EVAL_DIR", root)
    monkeypatch.setattr("src.eval.config.EVAL_DIR", root)

    if getattr(storage_mod._LOCAL, "conn", None) is not None:
        try:
            storage_mod._LOCAL.conn.close()
        except Exception:
            pass
        delattr(storage_mod._LOCAL, "conn")

    storage_mod._VIDEO_ID_CACHE.clear()
    yield root
