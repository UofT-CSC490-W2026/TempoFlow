"""Unit tests for `src/eval/visualization.py` (full line coverage)."""

from __future__ import annotations

import runpy
import sys
from pathlib import Path
from unittest.mock import patch

import matplotlib

matplotlib.use("Agg")

import numpy as np
import pytest

from src.eval import visualization as viz


def test_parse_scores_comma_separated():
    out = viz.parse_scores("2,2,2,3")
    np.testing.assert_array_equal(out, np.array([2.0, 2.0, 2.0, 3.0]))


def test_parse_scores_fallback_when_literal_eval_invalid():
    """`ast.literal_eval` accepts `a,b,c` as a tuple; `1,,2` is invalid and uses split path."""
    out = viz.parse_scores("1,,2")
    np.testing.assert_array_equal(out, np.array([1.0, 2.0]))


def test_parse_scores_literal_eval_list_string():
    out = viz.parse_scores("[1.0, 2.0, 3.0]")
    np.testing.assert_array_equal(out, np.array([1.0, 2.0, 3.0]))


def test_parse_scores_strips_whitespace():
    out = viz.parse_scores("  1, 2 , 3 ")
    np.testing.assert_array_equal(out, np.array([1.0, 2.0, 3.0]))


def test_mean_sem_multiple():
    m, s = viz.mean_sem(np.array([1.0, 3.0]))
    assert m == 2.0
    assert s == pytest.approx(np.std([1.0, 3.0], ddof=1) / np.sqrt(2))


def test_mean_sem_single():
    m, s = viz.mean_sem(np.array([4.0]))
    assert m == 4.0
    assert s == 0.0


def test_load_data_inline():
    df = viz.load_data(None)
    assert list(df.columns) == ["model", *viz.METRICS]
    assert len(df) == 4


def test_load_data_from_csv(tmp_path):
    csv = tmp_path / "data.csv"
    csv.write_text(
        "model,Label Accuracy,Body Specificity,Coaching Actionability,Confidence Calibration\n"
        'M1,"1,2,3","1,1,1","1,1,1","1,1,1"\n',
        encoding="utf-8",
    )
    df = viz.load_data(str(csv))
    assert df["model"].iloc[0] == "M1"
    assert list(df.columns) == [
        "model",
        "Label Accuracy",
        "Body Specificity",
        "Coaching Actionability",
        "Confidence Calibration",
    ]


def test_compute_stats_matches_inline():
    df = viz.load_data(None)
    stats = viz.compute_stats(df)
    assert set(stats) == set(viz.INLINE_DATA["model"])
    for model in stats:
        for metric in viz.METRICS:
            m, s = stats[model][metric]
            assert isinstance(m, float) and isinstance(s, float)


def test_plot_writes_png(tmp_path, capsys):
    df = viz.load_data(None)
    stats = viz.compute_stats(df)
    out = tmp_path / "chart.png"
    viz.plot(stats, str(out))
    assert out.is_file() and out.stat().st_size > 0
    captured = capsys.readouterr()
    assert "Saved →" in captured.out and str(out) in captured.out


def test_main_default_inline(tmp_path, monkeypatch):
    out = tmp_path / "out.png"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["visualization", "--out", str(out)])
    viz.main()
    assert out.is_file()


def test_main_with_csv(tmp_path, monkeypatch):
    csv = tmp_path / "in.csv"
    csv.write_text(
        "model,Label Accuracy,Body Specificity,Coaching Actionability,Confidence Calibration\n"
        'X,"1,2","2,2","2,2","2,2"\n',
        encoding="utf-8",
    )
    out = tmp_path / "from_csv.png"
    monkeypatch.setattr(
        sys,
        "argv",
        ["visualization", "--csv", str(csv), "--out", str(out)],
    )
    viz.main()
    assert out.is_file()


def test_script_main_guard(tmp_path, monkeypatch):
    """Covers `if __name__ == "__main__": main()`."""
    viz_path = Path(__file__).resolve().parent.parent / "src" / "eval" / "visualization.py"
    out = tmp_path / "runpy.png"
    monkeypatch.setattr(sys, "argv", ["visualization.py", "--out", str(out)])
    runpy.run_path(str(viz_path), run_name="__main__")
    assert out.is_file()


def test_argparse_help_exits_zero():
    viz_path = Path(__file__).resolve().parent.parent / "src" / "eval" / "visualization.py"
    with patch.object(sys, "argv", ["visualization.py", "--help"]):
        with pytest.raises(SystemExit) as exc:
            runpy.run_path(str(viz_path), run_name="__main__")
        assert exc.value.code == 0
