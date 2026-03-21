## Changes from a3

- **Added `opencoder.py` and `autoif.py` to `nanochat/tasks/`**
  - These new task modules expand the available tasks for the project.
- **Integrated `opencoder` and `autoif` into the training loop for `chat_sft`**
  - The supervised fine-tuning script now supports these new tasks, allowing them to be used during SFT training.

For more details, see the code in `nanochat/tasks/` and the training script in `nanochat/scripts/chat_sft.py`.