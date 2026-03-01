# CSC490 Assignment A3: Nanochat Pre-training Instructions

This guide provides commands for running the Part 3 Context Extension experiments either locally (on a Mac with MPS) or on Modal (GPU/H100). These instructions apply to **both** experimental branches: `nanochat-exp-alibi-attention` and `nanochat-exp-swiglu-activation`.

---

## 1. Local Execution (Mac/CPU/MPS)
Use these commands if you are running on your own machine. All commands should be run from the `nanochat` directory within your chosen experimental branch folder.

### Setup
```bash
pip install rustbpe datasets fastapi psutil python-dotenv regex scipy tabulate tiktoken tokenizers torch transformers uvicorn zstandard
```

### Training
**Phase 1: Short Context (512 tokens)**
*Note: Use a unique `--model-tag` for each branch (e.g., `pico-alibi` or `pico-swiglu`).*
```bash
python -m scripts.base_train \
    --depth=12 \
    --max-seq-len=512 \
    --model-tag=pico-part3 \
    --num-iterations=1000 \
    --save-every=500 \
    --run=dummy
```

**Phase 2: Long Context (2048 tokens)**
```bash
python -m scripts.base_train \
    --depth=12 \
    --max-seq-len=2048 \
    --model-tag=pico-part3 \
    --resume-from-step=1000 \
    --num-iterations=2000 \
    --run=dummy
```

### Evaluation
```bash
python -m scripts.part3_eval --model-tag=pico-part3 --step1=1000 --step2=2000
```

---

## 2. Modal Execution (Remote GPU)
Use these commands if you want to use Modal credits. All commands should be run from the experimental branch root (e.g., `nanochat-exp-alibi-attention/` or `nanochat-exp-swiglu-activation/`).

### Setup
```bash
# 1. Setup Modal
pip install modal
modal setup

# 2. Create Secrets (Replace with your actual keys)
modal secret create nanochat-secrets \
    WANDB_API_KEY="your_wandb_key" \
    HF_TOKEN="your_hf_token"
```

### Data & Tokenizer (Run once per branch)
```bash
# Download 40 shards (~10GB)
modal run nanochat_modal.py::stage_data --num-shards=40

# Train the tokenizer
modal run nanochat_modal.py::stage_tokenizer
```

### Training
**Phase 1: Short Context (512 tokens)**
*Note: If running both branches, change `--model-tag` in the `--extra` string to avoid overwriting files on the persistent volume.*
```bash
modal run nanochat_modal.py::stage_pretrain \
    --depth=12 \
    --device-batch-size=16 \
    --wandb-run=pico-512 \
    --extra="--max-seq-len=512 --num-iterations=1000 --save-every=500 --model-tag=pico-part3"
```

**Phase 2: Long Context (2048 tokens)**
```bash
modal run nanochat_modal.py::stage_pretrain \
    --depth=12 \
    --device-batch-size=16 \
    --wandb-run=pico-2048 \
    --extra="--max-seq-len=2048 --resume-from-step=1000 --num-iterations=2000 --model-tag=pico-part3"
```

### Inference & Custom Commands
You can run any script in the repo on Modal using the exposed `_python` helper. 

**Note for Base Models:** Since these models are pretrained but not yet instruction-tuned (SFT), you must use the `-i base` flag and should expect "text completion" behavior rather than a chat-like response.

#### 1. Single Prompt (Fast)
```bash
modal run nanochat_modal.py::_python \
    --module scripts.chat_cli \
    --args "-i base -p \"The capital of France is\" --model-tag pico-part3 --step 1000"
```

#### 2. Interactive Mode
This allows you to type multiple prompts in a row.
```bash
modal run nanochat_modal.py::_python \
    --module scripts.chat_cli \
    --args "-i base --model-tag pico-part3 --step 1000"
```

#### 3. Run Part 3 Evaluation
Compare the context handling of two different checkpoints:
```bash
modal run nanochat_modal.py::_python \
    --module scripts.part3_eval \
    --args "--model-tag pico-part3 --step1 1000 --step2 2000"
```

---

## Important Notes
- **Branch Specificity:** You must run these commands from the specific branch directory you want to test.
- **Persistence:** On Modal, all data (shards, tokenizer, checkpoints) is saved to the `/vol` persistent volume. **If you use the same `--model-tag` across different branches, they will overwrite each other.**
- **`--modal` flag:** The scripts automatically detect if they are running on Modal and adjust their paths accordingly. You do not need to manually change paths in the code.
- **WandB:** If you don't want to use Weights & Biases, set `--run=dummy` (Local) or `--wandb-run=dummy` (Modal).
