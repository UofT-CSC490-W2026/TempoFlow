import json
import pandas as pd
import matplotlib.pyplot as plt
import re
import numpy as np
from collections import Counter

# 1. Load Data
with open('gsm8k_results.json', 'r') as f:
    data = json.load(f)

FINAL_ANSWER_RE = re.compile(r"####\s*(-?\d[\d,]*(?:\.\d+)?)")
CALC_CALL_RE = re.compile(r"\[CALC\]", re.IGNORECASE)
ARITH_EXPR_RE = re.compile(r"^[\d\.\+\-\*\/\(\)\s,]+$")
TRAILING_OP_RE = re.compile(r"[\+\-\*\/=]$")
ARROW_LINE_RE = re.compile(r"\[CALC\]\s*([^\n\r]*?)\s*->\s*([^\n\r]+)", re.IGNORECASE)


def count_equation_signals(text):
    """Proxy for reasoning depth in reference question."""
    explicit_equations = len(re.findall(r'\d+\s*[\+\-\*/]\s*\d+\s*=', text))
    fallback_equals = text.count('=')
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


results = []
for item in data:
    idx = item.get('index')
    q = str(item.get('question', ''))
    a = str(item.get('completion', ''))
    corr = bool(item.get('is_correct', False))

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

    results.append({
        'index': idx,
        'question': q,
        'completion': a,
        'q_equations': q_eq_count,
        'a_steps': a_steps,
        'pred_step_count': pred_step_count,
        'is_correct': corr,
        'error_category': error_category,
    })

df = pd.DataFrame(results)

# 2. Setup Figure (2x2 Grid)
fig, axes = plt.subplots(2, 2, figsize=(20, 14))
ax1, ax2, ax3, ax4 = axes.flatten()

def plot_robust_bars(axis, groupby_col, title, xlabel):
    stats = {}
    for _, row in df.iterrows():
        val = row[groupby_col]
        res = row['is_correct']
        if val not in stats: stats[val] = {True: 0, False: 0}
        stats[val][res] += 1
    
    sorted_keys = sorted(stats.keys())
    correct = [stats[k][True] for k in sorted_keys]
    incorrect = [stats[k][False] for k in sorted_keys]
    totals = [c + i for c, i in zip(correct, incorrect)]
    
    axis.bar(sorted_keys, correct, color='#27ae60', label='Correct', alpha=0.8)
    axis.bar(sorted_keys, incorrect, bottom=correct, color='#c0392b', label='Incorrect', alpha=0.8)
    
    for i, k in enumerate(sorted_keys):
        acc = (correct[i] / totals[i] * 100) if totals[i] > 0 else 0
        axis.text(k, totals[i] + 0.5, f"{acc:.1f}%\n(n={totals[i]})", 
                  ha='center', fontweight='bold', fontsize=9)
    
    axis.set_title(title, fontweight='bold', fontsize=13)
    axis.set_xlabel(xlabel)
    axis.set_ylabel('Number of Problems')
    axis.legend()

# --- Plot 1: Model Effort ---
plot_robust_bars(ax1, 'a_steps', 'Accuracy by Answer Steps', 'Number of [CALC] steps')

# --- Plot 2: Question Complexity ---
plot_robust_bars(ax2, 'q_equations', 'Accuracy by Question Complexity', 'Number of Equations in Q')

# --- Plot 3: Alignment Scatter ---
jitter = 0.15
q_jitter = df['q_equations'] + np.random.uniform(-jitter, jitter, len(df))
a_jitter = df['a_steps'] + np.random.uniform(-jitter, jitter, len(df))

ax3.scatter(q_jitter[df['is_correct'] == True], a_jitter[df['is_correct'] == True], 
            color='#27ae60', alpha=0.4, label='Correct', edgecolors='white', linewidth=0.3)
ax3.scatter(q_jitter[df['is_correct'] == False], a_jitter[df['is_correct'] == False], 
            color='#c0392b', alpha=0.4, label='Incorrect', edgecolors='white', linewidth=0.3)

coord_stats = df.groupby(['q_equations', 'a_steps'])['is_correct'].agg(['mean']).reset_index()
for _, row in coord_stats.iterrows():
    ax3.text(row['q_equations'], row['a_steps'] + 0.2, f"{row['mean']*100:.0f}%", 
             ha='center', fontsize=8, fontweight='bold', bbox=dict(facecolor='white', alpha=0.7, edgecolor='none'))

max_val = max(df['q_equations'].max(), df['a_steps'].max())
ax3.plot([0, max_val], [0, max_val], 'k--', alpha=0.3, label='1:1 Alignment')
ax3.set_title('Complexity vs. Effort Alignment', fontweight='bold', fontsize=13)
ax3.set_xlabel('Equations in Question')
ax3.set_ylabel('Steps in Answer')
ax3.legend()

# --- Plot 4: Error Category Distribution ---
category_order = [
    "Correct",
    "Formatting failure",
    "Incomplete / unresolved calc",
    "Shallow reasoning",
    "Overlong / padded reasoning",
    "Arithmetic-consistency anomaly",
    "Wrong answer other",
]
counts = Counter(df["error_category"])
values = [counts.get(cat, 0) for cat in category_order]
total = sum(values) if values else 1
colors = ["#27ae60"] + ["#c0392b"] * (len(category_order) - 1)

bars = ax4.bar(range(len(category_order)), values, color=colors, alpha=0.85)
ax4.set_xticks(range(len(category_order)))
ax4.set_xticklabels(category_order, rotation=25, ha='right')
ax4.set_ylabel("Number of Problems")
ax4.set_title("Error Category Distribution", fontweight='bold', fontsize=13)

for bar, v in zip(bars, values):
    pct = 100.0 * v / total
    ax4.text(
        bar.get_x() + bar.get_width() / 2,
        bar.get_height() + 0.8,
        f"{v}\n({pct:.1f}%)",
        ha="center",
        va="bottom",
        fontsize=9,
        fontweight="bold",
    )

plt.tight_layout()
plt.savefig('gsm8k_visualizaion_4plots.png')
print("Saved to gsm8k_visualizaion_4plots.png")

# 3. Export per-sample audit artifacts
audit_csv_path = 'gsm8k_results_with_categories.csv'
audit_json_path = 'gsm8k_results_with_categories.json'
df.to_csv(audit_csv_path, index=False)
df.to_json(audit_json_path, orient='records', indent=2)
print(f"Saved audit CSV to {audit_csv_path}")
print(f"Saved audit JSON to {audit_json_path}")

# 4. Print general dataset stats
total_questions = len(df)
num_correct = int(df['is_correct'].sum())
num_incorrect = total_questions - num_correct
accuracy = (num_correct / total_questions * 100.0) if total_questions else 0.0
print(f"Total questions: {total_questions}")
print(f"Correct questions: {num_correct}")
print(f"Incorrect questions: {num_incorrect}")
print(f"Accuracy: {accuracy:.2f}%")