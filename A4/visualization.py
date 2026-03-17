import json
import re

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

FINAL_ANSWER_RE = re.compile(r"####\s*(-?\d[\d,]*(?:\.\d+)?)")
CALC_CALL_RE = re.compile(r"\[CALC\]", re.IGNORECASE)
ARITH_EXPR_RE = re.compile(r"^[\d\.\+\-\*\/\(\)\s,]+$")
TRAILING_OP_RE = re.compile(r"[\+\-\*\/=]$")
ARROW_LINE_RE = re.compile(r"\[CALC\]\s*([^\n\r]*?)\s*->\s*([^\n\r]+)", re.IGNORECASE)

RUN_INPUTS = [
    ("baseline.json", "baseline_rl", "Baseline"),
    ("reward_a (1).json", "baseline_plus_reward_a", "baseline_plus_reward_a"),
    ("reward_b (1).json", "baseline_plus_reward_b", "baseline_plus_reward_b"),
]

CATEGORY_ORDER = [
    "Correct",
    "Formatting failure",
    "Incomplete / unresolved calc",
    "Shallow reasoning",
    "Overlong / padded reasoning",
    "Arithmetic-consistency anomaly",
    "Wrong answer other",
]
ERROR_CATEGORY_ORDER = [c for c in CATEGORY_ORDER if c != "Correct"]

RUN_COLORS = {
    "baseline_rl": "#1f77b4",
    "baseline_plus_reward_a": "#ff7f0e",
    "baseline_plus_reward_b": "#9467bd",
}
ERROR_COLORS = {
    "Formatting failure": "#f1c40f",
    "Incomplete / unresolved calc": "#e67e22",
    "Shallow reasoning": "#c0392b",
    "Overlong / padded reasoning": "#9b59b6",
    "Arithmetic-consistency anomaly": "#16a085",
    "Wrong answer other": "#7f8c8d",
}


def count_equation_signals(text):
    """Proxy for reasoning depth in reference question."""
    explicit_equations = len(re.findall(r"\d+\s*[\+\-\*/]\s*\d+\s*=", text))
    fallback_equals = text.count("=")
    return max(explicit_equations, fallback_equals)


def count_steps(text):
    return len([line for line in text.splitlines() if line.strip()])


def has_formatting_failure(completion):
    has_marker = "####" in completion
    valid_marker = FINAL_ANSWER_RE.search(completion) is not None
    return (not has_marker) or (has_marker and not valid_marker)


def has_incomplete_calc(completion):
    calc_calls = len(CALC_CALL_RE.findall(completion))
    arrow_count = completion.count("->")
    if calc_calls > arrow_count:
        return True
    if completion.count("[") != completion.count("]"):
        return True

    stripped = completion.strip()
    if stripped.endswith("->") or stripped.endswith("[CALC]") or TRAILING_OP_RE.search(stripped):
        return True

    # A [CALC] marker appears but no arrow before line break/end.
    if re.search(r"\[CALC\](?![^\n\r]{0,120}->)", completion, flags=re.IGNORECASE):
        return True
    return False


def safe_eval_expr(expr):
    cleaned = expr.replace("$", "").replace("%", "").replace("x", "*").replace("X", "*").replace("×", "*")
    cleaned = cleaned.replace(",", "").strip()
    if not cleaned or not ARITH_EXPR_RE.match(cleaned):
        return None
    try:
        return float(eval(cleaned, {"__builtins__": {}}, {}))
    except Exception:
        return None


def parse_reported_number(text):
    match = re.search(r"-?\d[\d,]*(?:\.\d+)?", text)
    if not match:
        return None
    try:
        return float(match.group(0).replace(",", ""))
    except Exception:
        return None


def has_arithmetic_anomaly(completion):
    for expr, reported in ARROW_LINE_RE.findall(completion):
        expr_val = safe_eval_expr(expr)
        rep_val = parse_reported_number(reported)
        if expr_val is None or rep_val is None:
            continue
        if abs(expr_val - rep_val) > 1e-6:
            return True
    return False


def categorize_error(is_correct, completion, ref_depth, pred_calc_calls, pred_step_count):
    # Priority order:
    # Correct -> Formatting failure -> Incomplete / unresolved calc ->
    # Shallow reasoning -> Overlong / padded reasoning ->
    # Arithmetic-consistency anomaly -> Wrong answer other
    if is_correct:
        return "Correct"
    if has_formatting_failure(completion):
        return "Formatting failure"
    if has_incomplete_calc(completion):
        return "Incomplete / unresolved calc"
    if pred_calc_calls < max(0, ref_depth - 1) or pred_step_count < max(0, ref_depth - 1):
        return "Shallow reasoning"
    if pred_calc_calls > (ref_depth + 1) or len(completion) > 450:
        return "Overlong / padded reasoning"
    if has_arithmetic_anomaly(completion):
        return "Arithmetic-consistency anomaly"
    return "Wrong answer other"


def build_rows(raw_data, run_name):
    rows = []
    for item in raw_data:
        idx = item.get("index")
        q = str(item.get("question", ""))
        a = str(item.get("completion", ""))
        corr = bool(item.get("is_correct", False))

        q_eq_count = count_equation_signals(q)
        a_steps = len(CALC_CALL_RE.findall(a))
        pred_step_count = count_steps(a)
        error_category = categorize_error(
            corr,
            a,
            ref_depth=q_eq_count,
            pred_calc_calls=a_steps,
            pred_step_count=pred_step_count,
        )

        rows.append(
            {
                "run": run_name,
                "index": idx,
                "question": q,
                "completion": a,
                "q_equations": q_eq_count,
                "a_steps": a_steps,
                "pred_step_count": pred_step_count,
                "is_correct": corr,
                "error_category": error_category,
            }
        )
    return rows


def complexity_bin(q_equations):
    if q_equations <= 1:
        return "1 step"
    if q_equations == 2:
        return "2 steps"
    if q_equations == 3:
        return "3 steps"
    if q_equations == 4:
        return "4 steps"
    return "5+ steps"


# 1) Load and combine all runs with explicit run labels.
all_rows = []
run_display_map = {}
for file_name, run_name, run_label in RUN_INPUTS:
    run_display_map[run_name] = run_label
    with open(file_name, "r", encoding="utf-8") as f:
        raw = json.load(f)
    all_rows.extend(build_rows(raw, run_name))

df = pd.DataFrame(all_rows)
df["run_label"] = df["run"].map(run_display_map)
df["complexity_bin"] = df["q_equations"].apply(complexity_bin)

# 2) Export combined per-sample audit artifacts.
audit_csv_path = "gsm8k_results_with_categories_by_run.csv"
audit_json_path = "gsm8k_results_with_categories_by_run.json"
df.to_csv(audit_csv_path, index=False)
df.to_json(audit_json_path, orient="records", indent=2)
print(f"Saved audit CSV to {audit_csv_path}")
print(f"Saved audit JSON to {audit_json_path}")

# 3) Print general stats (overall + per run).
total_questions = len(df)
num_correct = int(df["is_correct"].sum())
num_incorrect = total_questions - num_correct
accuracy = (num_correct / total_questions * 100.0) if total_questions else 0.0
print(f"Overall total questions: {total_questions}")
print(f"Overall correct questions: {num_correct}")
print(f"Overall incorrect questions: {num_incorrect}")
print(f"Overall accuracy: {accuracy:.2f}%")

for run_name, run_df in df.groupby("run", sort=False):
    run_total = len(run_df)
    run_correct = int(run_df["is_correct"].sum())
    run_incorrect = run_total - run_correct
    run_acc = (run_correct / run_total * 100.0) if run_total else 0.0
    print(f"[{run_display_map[run_name]}] total={run_total}, correct={run_correct}, incorrect={run_incorrect}, accuracy={run_acc:.2f}%")

runs = [run_name for _, run_name, _ in RUN_INPUTS]
run_labels = [run_display_map[r] for r in runs]
overall_acc = df.groupby("run")["is_correct"].mean().reindex(runs).fillna(0) * 100

# Original comparison error distribution chart (counts by run x category)
pivot_counts = (
    df.groupby(["error_category", "run"])
    .size()
    .unstack(fill_value=0)
    .reindex(CATEGORY_ORDER)
)

x = np.arange(len(CATEGORY_ORDER))
width = 0.24
fig1, ax1 = plt.subplots(figsize=(18, 8))
for i, run_name in enumerate(runs):
    vals = [int(pivot_counts.loc[cat, run_name]) for cat in CATEGORY_ORDER]
    x_shifted = x + (i - 1) * width
    bars = ax1.bar(
        x_shifted,
        vals,
        width=width,
        label=run_display_map[run_name],
        color=RUN_COLORS[run_name],
        alpha=0.85,
    )
    for bar, v in zip(bars, vals):
        ax1.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + 3,
            str(v),
            ha="center",
            va="bottom",
            fontsize=8,
        )

ax1.set_xticks(x)
ax1.set_xticklabels(CATEGORY_ORDER, rotation=25, ha="right")
ax1.set_ylabel("Number of Questions")
ax1.set_title("GSM8K Error Category Distribution Comparison by Run", fontweight="bold", fontsize=14)
ax1.legend(title="Run")
ax1.grid(axis="y", linestyle="--", color="#cfcfcf", alpha=0.7)
fig1.tight_layout()
fig1.savefig("gsm8k_error_distribution_comparison.png")
print("Saved chart: gsm8k_error_distribution_comparison.png")

# Chart 2: GSM8K Accuracy by Problem Complexity
complexity_order = ["1 step", "2 steps", "3 steps", "4 steps", "5+ steps"]
complexity_stats = (
    df.groupby(["complexity_bin", "run"])["is_correct"]
    .agg(["mean", "count"])
    .reindex(pd.MultiIndex.from_product([complexity_order, runs], names=["complexity_bin", "run"]))
    .fillna(0)
    .reset_index()
)

fig2, ax2 = plt.subplots(figsize=(13, 7))
x = np.arange(len(complexity_order))
width = 0.24
for i, run in enumerate(runs):
    run_df = complexity_stats[complexity_stats["run"] == run]
    vals = run_df["mean"].values * 100
    ns = run_df["count"].astype(int).values
    offset = (i - 1) * width
    bars = ax2.bar(
        x + offset,
        vals,
        width=width,
        label=run_display_map[run],
        color=RUN_COLORS[run],
        alpha=0.9,
    )
    for j, bar in enumerate(bars):
        ax2.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + 1.2,
            f"n={ns[j]}",
            ha="center",
            va="bottom",
            fontsize=8,
        )
    ax2.axhline(overall_acc[run], linestyle="--", linewidth=1.3, color=RUN_COLORS[run], alpha=0.85)

ax2.set_xticks(x)
ax2.set_xticklabels(complexity_order)
ax2.set_ylim(0, 60)
ax2.set_ylabel("Accuracy (%)")
ax2.set_title("GSM8K Accuracy by Problem Complexity", fontweight="bold")
ax2.grid(axis="y", linestyle="--", color="#cfcfcf", alpha=0.7)
ax2.legend(loc="upper right")
fig2.tight_layout()
fig2.savefig("gsm8k_chart2_accuracy_by_complexity.png")
print("Saved chart: gsm8k_chart2_accuracy_by_complexity.png")