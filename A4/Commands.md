# Baseline + Reward A (answer formatting)
modal run nanochat_modal.py::stage_rl \
  --run=rl-reward-a \
  --model-tag=model-and-sft/d24 \
  --save-tag=model-and-sft/d24-reward-a \
  --reward-answer-format \
  --reward-environment=answer_format

modal run nanochat_modal.py::stage_eval \
  --identity=rl \
  --task-name=GSM8K \
  --model-tag=model-and-sft/d24-reward-a \
  --step=466 \
  --batch-size=4 \
  --num-samples=8




===========================================================================

# Baseline + Reward B (depth alignment) (latest one I ran)
modal run nanochat_modal.py::stage_rl \
  --run=rl-reward-b \
  --model-tag=model-and-sft/d24 \
  --reward-depth-alignment \
  --reward-environment=depth_alignment

modal run nanochat_modal.py::stage_rl \
  --run=rl-reward-b \
  --model-tag=model-and-sft/d24 \
  --reward-depth-alignment \
  --reward-environment=depth_alignment \
  --resume \
  --resume-step=466 \
  --wandb-run-id=74zvadnj \
  --wandb-resume=must

# Eval (run from parent folder: nanochat-exp-swiglu-activation)
modal run nanochat_modal.py::stage_eval \
  --identity=rl \
  --task-name=GSM8K \
  --model-tag=model-and-sft/d24 \
  --step=466 \
  --batch-size=4 \
  --num-samples=8



===========================================================================







# Reward A in its own environment
modal run nanochat_modal.py::stage_rl \
  --run=rl-reward-a-env \
  --model-tag=model-and-sft/d24 \
  --save-tag=model-and-sft/d24-reward-a-env \
  --reward-answer-format \
  --reward-environment=answer_format_env

# Reward B in its own environment
modal run nanochat_modal.py::stage_rl \
  --run=rl-reward-b-env \
  --model-tag=model-and-sft/d24 \
  --save-tag=model-and-sft/d24-reward-b-env \
  --reward-depth-alignment \
  --reward-environment=depth_alignment_env

# Eval for env variants (run from parent folder)
# Reward A env
modal run nanochat_modal.py::stage_eval \
  --identity=rl \
  --task-name=GSM8K \
  --model-tag=model-and-sft/d24-reward-a-env \
  --step=466 \
  --batch-size=4 \
  --num-samples=8

# Reward B env
modal run nanochat_modal.py::stage_eval \
  --identity=rl \
  --task-name=GSM8K \
  --model-tag=model-and-sft/d24-reward-b-env \
  --step=466 \
  --batch-size=4 \
  --num-samples=8