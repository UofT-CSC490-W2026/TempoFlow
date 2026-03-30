"""
plot_eval_metrics.py
Generates a grouped bar chart of Mean ± SEM for all evaluation metrics,
saved as a high-resolution PNG.

Usage:
    python plot_eval_metrics.py
    python plot_eval_metrics.py --csv Feedback_Eval_-_Sheet1.csv
    python plot_eval_metrics.py --out my_chart.png

Requirements:
    pip install matplotlib numpy pandas
"""

import argparse
import ast
import numpy as np
import pandas as pd
import matplotlib
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.ticker import MultipleLocator

# ── Inline data (matches your CSV exactly) ───────────────────────────────────

INLINE_DATA = {
    "model": [
        "Gemini 2.5 Flash-Lite",
        "Gemini 2.5 Flash",
        "Gemini 2.5 Pro",
        "GPT-5.2",
    ],
    "Label Accuracy":           ["2,2,2,2,2,3,2", "1,1,1,1,1,1,1", "1,1,1,1,1,1,1", "1,1,1,1,1,1,1"],
    "Body Specificity":         ["1,1,1,1,1,1,1", "1,1,2,1,1,2,1", "1,1,2,1,1,2,1", "2,3,2,3,3,2,3"],
    "Coaching Actionability":   ["1,2,1,1,2,3,1", "1,2,1,1,2,3,1", "1,2,1,1,2,3,1", "2,2,2,3,2,2,3"],
    "Confidence Calibration":   ["2,2,2,2,2,3,2", "1,1,1,1,1,1,1", "1,1,1,1,1,1,1", "1,1,1,1,1,1,1"],
}

METRICS = [
    "Label Accuracy",
    "Body Specificity",
    "Coaching Actionability",
    "Confidence Calibration",
]

METRIC_LABELS = [
    "Label\naccuracy",
    "Body\nspecificity",
    "Coaching\nactionability",
    "Confidence\ncalibration",
]

MODEL_COLORS = ["#7F77DD", "#1D9E75", "#D85A30", "#378ADD"]
MODEL_COLORS_LIGHT = [
    "#CECBF6",   # purple-100
    "#9FE1CB",   # teal-100
    "#F5C4B3",   # coral-100
    "#B5D4F4",   # blue-100
]


# ── Stats helpers ─────────────────────────────────────────────────────────────

def parse_scores(cell: str) -> np.ndarray:
    """Parse a comma-separated string or Python list string into a float array."""
    cell = str(cell).strip()
    try:
        parsed = ast.literal_eval(cell)
        return np.array(parsed, dtype=float)
    except Exception:
        return np.array([float(x.strip()) for x in cell.split(",") if x.strip()])


def mean_sem(arr: np.ndarray) -> tuple[float, float]:
    n = len(arr)
    m = arr.mean()
    s = arr.std(ddof=1) / np.sqrt(n) if n > 1 else 0.0
    return float(m), float(s)


# ── Data loading ──────────────────────────────────────────────────────────────

def load_data(csv_path: str | None) -> pd.DataFrame:
    if csv_path:
        df = pd.read_csv(csv_path)
        df.columns = [c.strip() for c in df.columns]
        df["model"] = df["model"].str.strip()
    else:
        df = pd.DataFrame(INLINE_DATA)
    return df


def compute_stats(df: pd.DataFrame) -> dict:
    """
    Returns { model: { metric: (mean, sem) } }
    """
    result = {}
    for _, row in df.iterrows():
        model = row["model"]
        result[model] = {}
        for metric in METRICS:
            arr = parse_scores(row[metric])
            result[model][metric] = mean_sem(arr)
    return result


# ── Chart ─────────────────────────────────────────────────────────────────────

def plot(stats: dict, out_path: str) -> None:
    models = list(stats.keys())
    n_models = len(models)
    n_metrics = len(METRICS)

    x = np.arange(n_metrics)
    total_width = 0.72
    bar_w = total_width / n_models
    offsets = np.linspace(
        -(total_width - bar_w) / 2,
        (total_width - bar_w) / 2,
        n_models,
    )

    matplotlib.rcParams.update({
        "font.family": "sans-serif",
        "font.size": 11,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.spines.left": True,
        "axes.spines.bottom": False,
    })

    fig, ax = plt.subplots(figsize=(10, 5.5))
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    for mi, (model, offset) in enumerate(zip(models, offsets)):
        means = [stats[model][m][0] for m in METRICS]
        sems  = [stats[model][m][1] for m in METRICS]
        xpos  = x + offset

        bars = ax.bar(
            xpos, means,
            width=bar_w * 0.88,
            color=MODEL_COLORS_LIGHT[mi],
            edgecolor=MODEL_COLORS[mi],
            linewidth=1.2,
            zorder=3,
        )

        # Error bars
        ax.errorbar(
            xpos, means,
            yerr=sems,
            fmt="none",
            ecolor=MODEL_COLORS[mi],
            elinewidth=1.5,
            capsize=4,
            capthick=1.5,
            zorder=4,
        )

        # Value labels above each bar
        for xp, mean, sem in zip(xpos, means, sems):
            ax.text(
                xp, mean + sem + 0.06,
                f"{mean:.2f}",
                ha="center", va="bottom",
                fontsize=8,
                color=MODEL_COLORS[mi],
                fontweight="500",
            )

    # Axes formatting
    ax.set_xticks(x)
    ax.set_xticklabels(METRIC_LABELS, fontsize=11, color="#444441", linespacing=1.4)
    ax.set_xlim(-0.55, n_metrics - 0.45)
    ax.set_ylim(0, 5.2)
    ax.yaxis.set_major_locator(MultipleLocator(1))
    ax.set_ylabel("Score (1–5)", fontsize=11, color="#5F5E5A", labelpad=8)
    ax.tick_params(axis="y", colors="#888780", length=0)
    ax.tick_params(axis="x", length=0, pad=8)
    ax.yaxis.set_tick_params(labelcolor="#888780")

    # Subtle horizontal grid
    ax.yaxis.grid(True, color="#D3D1C7", linewidth=0.5, zorder=0)
    ax.set_axisbelow(True)

    # Left spine style
    ax.spines["left"].set_color("#D3D1C7")
    ax.spines["left"].set_linewidth(0.5)

    # Legend
    handles = [
        mpatches.Patch(
            facecolor=MODEL_COLORS_LIGHT[i],
            edgecolor=MODEL_COLORS[i],
            linewidth=1.2,
            label=model,
        )
        for i, model in enumerate(models)
    ]
    ax.legend(
        handles=handles,
        loc="upper right",
        bbox_to_anchor=(1.0, 0.98),
        frameon=False,
        fontsize=10,
        handlelength=1.2,
        handleheight=0.9,
        handletextpad=0.5,
        labelcolor="#444441",
    )

    fig.text(
        0.5, 0.97,
        "All metrics — mean ± SEM",
        ha="center", va="top",
        fontsize=13, fontweight="500", color="#2C2C2A",
    )
    fig.text(
        0.5, 0.91,
        f"n = {7} ratings per model per metric",
        ha="center", va="top",
        fontsize=10, color="#888780",
    )

    plt.tight_layout(rect=[0, 0, 1, 0.90])
    fig.savefig(out_path, dpi=180, bbox_inches="tight", facecolor="white")
    print(f"Saved → {out_path}")


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Plot eval metrics mean ± SEM chart.")
    parser.add_argument("--csv", default=None, help="Path to your CSV file (optional)")
    parser.add_argument("--out", default="eval_metrics_chart.png", help="Output PNG path")
    args = parser.parse_args()

    df    = load_data(args.csv)
    stats = compute_stats(df)
    plot(stats, args.out)


if __name__ == "__main__":
    main()