# All commands run from: nanochat-exp-swiglu-activation/
# SFT base model: model-and-sft/sft-baseline/nano-p4-baseline (step 501)

===========================================================================
# SFT baseline eval (verify SFT model works)
===========================================================================

modal run nanochat_modal.py::stage_eval \
  --identity=sft \
  --task-name=GSM8K \
  --model-tag=model-and-sft/sft-baseline/nano-p4-baseline \
  --batch-size=4 \
  --num-samples=8

===========================================================================
# Baseline + Reward A (answer formatting)
===========================================================================

modal run nanochat_modal.py::stage_rl \
  --run=rl-reward-a \
  --model-tag=model-and-sft/sft-baseline/nano-p4-baseline \
  --save-tag=model-and-sft/reward-a \
  --reward-answer-format \
  --reward-environment=answer_format

modal run nanochat_modal.py::stage_eval \
  --identity=rl \
  --task-name=GSM8K \
  --model-tag=model-and-sft/reward-a \
  --batch-size=4 \
  --num-samples=8

===========================================================================
# Baseline + Reward B (depth alignment)
===========================================================================

modal run nanochat_modal.py::stage_rl \
  --run=rl-reward-b \
  --model-tag=model-and-sft/sft-baseline/nano-p4-baseline \
  --save-tag=model-and-sft/reward-b \
  --reward-depth-alignment \
  --reward-environment=depth_alignment

modal run nanochat_modal.py::stage_eval \
  --identity=rl \
  --task-name=GSM8K \
  --model-tag=model-and-sft/reward-b \
  --batch-size=4 \
  --num-samples=8

===========================================================================
# Reward A in its own environment
===========================================================================

modal run nanochat_modal.py::stage_rl \
  --run=rl-reward-a-env \
  --model-tag=model-and-sft/sft-baseline/nano-p4-baseline \
  --save-tag=model-and-sft/reward-a-env \
  --reward-answer-format \
  --reward-environment=answer_format_env

modal run nanochat_modal.py::stage_eval \
  --identity=rl \
  --task-name=GSM8K \
  --model-tag=model-and-sft/reward-a-env \
  --batch-size=4 \
  --num-samples=8

===========================================================================
# Reward B in its own environment
===========================================================================

modal run nanochat_modal.py::stage_rl \
  --run=rl-reward-b-env \
  --model-tag=model-and-sft/sft-baseline/nano-p4-baseline \
  --save-tag=model-and-sft/reward-b-env \
  --reward-depth-alignment \
  --reward-environment=depth_alignment_env

modal run nanochat_modal.py::stage_eval \
  --identity=rl \
  --task-name=GSM8K \
  --model-tag=model-and-sft/reward-b-env \
  --batch-size=4 \
  --num-samples=8