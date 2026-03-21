# CS490 Nanochat Tutorial 
*Author: Angela Sha*

Tutorial to familiarize students with PyTorch code surrounding nanochat, transformers, and attention mechanism, as well as the LLM training pipeline.

Not intended as an in depth tutorial on the modeling itself; see resources section for good resources on these topics!

## Files

```
├── nanochat_modal.py       # modal run
├── ng-lecture/             # clone ng-lecture (local)
├── nanochat/               # clone nanochat (local)
├── attention_walkthrough.ipynb
├── attention_diagram.png
├── transformer_arch.png
└── README.md
```

## Setup 

Requires Python 3.10+ and `uv` package manager
```
requires-python = ">=3.10"
```

### Modal Setup 
```
uv pip install modal    # install Modal
modal setup             # authenticate with Modal
```

pass API keys as a Modal secret
- W&B key:  https://wandb.ai/authorize
- HF token: https://huggingface.co/settings/tokens
- HF token is needed to download the FineWeb-EDU dataset
```
modal secret create nanochat-secrets \
           WANDB_API_KEY=your_wandb_key \
           HF_TOKEN=hf_your_huggingface_token
```

### Nanochat Github clone
```
git clone https://github.com/karpathy/nanochat.git
cd nanochat
```

### Installing `uv`
```
# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# Or via pip
pip install uv
```

### Installing dependencies via `uv`

For GPU training (H100/A100 with CUDA 12.8):
```
uv sync --extra gpu
```
For CPU-only (development/testing):
```
uv sync --extra cpu
```

Full installation documentation [here](https://deepwiki.com/karpathy/nanochat/2.1-installation-and-setup)!

## nanochat vs. nanoGPT 
**nanochat**: ~8000 lines of Python (+Rust) covering following training pipeline sequences 

**nanoGPT**: predecessor; does not contain SFT, RL, inference, and web UI


## LLM Pipeline Stages
- Training pipeline
    - **Stage 1**: Tokenization 
        - `python -m scripts.tok_train`
    - **Stage 2**: Pretraining (FineWeb-EDU)
        - `python -m scripts.base_train`
        - `python -m scripts.base_eval`
    - **Stage 3**: Mid-training (conversations, MCQ, math problems)
        - `scripts.base_train` with dataset mixture
    - **Stage 4**: Supervised fine-tuning (SFT)
        - user/assistant conversation pairs
        - `python -m scripts.chat_sft`
    - **Stage 5** (optional): Reinforcement learning (RL)
        - GRPO, PPO e.g. math (further covered in next tutorial)
        - `python -m scripts.chat_rl`

- Inference pipeline 
    - Custom inference engine with KV-caching
        - `nanochat/engine.py`
    - Web UI for chatGPT style conversation
        - `python -m scripts.chat_web`

## Training Practices 
- Gradient accumulation for hardware constraints `scripts/base_train #L389`
- Optimizer selection (AdamW, Muon for nanochat) `nanochat/optim.py`
- Logging, checkpointing `nanochat/checkpoint_manager.py`

## Architecture 
### Github clone
```
git clone https://github.com/karpathy/ng-video-lecture.git 
cd ng-video-lecture
```

- 2017 style transformer (encoder/decoder models)
    - Masked causal self-attention
    - Query, key, value matrices (Q, K, V) attention mechanism 
- nanochat uses Llama style transformer
    - RoPE embeddings, RMSNorm, QKNormalization 
- `--depth` flag for sizing of layers, dimensions, n heads 

## ML Engineering Takeaways
- Minimal codebase 
- Compute optimal training -> optimal model size for compute budget
- Benchmarking machine learning models (leaderboard)
- e2e ML engineering -> data pipelines, tokenization, serving, eval

## Resources 

### nanochat/nanoGPT Resources
- [nanochat Github Repository](https://github.com/karpathy/nanochat)
- [nanoGPT Github Repository](https://github.com/karpathy/nanoGPT?tab=readme-ov-file)
- [nanoGPT Lecture Github Repository](https://github.com/karpathy/ng-video-lecture/tree/master)
- [nanochat DeepWiki](https://deepwiki.com/karpathy/nanochat)
- [Training nanochat on Modal Engineering Guide](https://aiengineering.academy/LLM/ServerLessFinetuning/TrainNanochatModalTutorial/) (not fully up to date)

### Transformers, Attention Resources
- Andrej Karpathy's [Zero To Hero Series](https://karpathy.ai/zero-to-hero.html)
    - [Build GPT from scratch tutorial](https://www.youtube.com/watch?v=kCc8FmEb1nY)
- [2017 Attention Is All You Need](https://arxiv.org/pdf/1706.03762) paper
- 3Blue1Brown series on Deep Learning
    - [Chapter 5, Transformers](https://www.youtube.com/watch?v=wjZofJX0v4M)
    - [Chapter 6, Attention](https://www.youtube.com/watch?v=eMlx5fFNoYc)
    - [Chapter 7, How might LLMs store facts](https://www.youtube.com/watch?v=9-Jl0dxWQs8)