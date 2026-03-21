
import os
import torch
import argparse
from nanochat.checkpoint_manager import load_model
from nanochat.engine import Engine
from nanochat.common import print0, autodetect_device_type, compute_init

def main():
    parser = argparse.ArgumentParser(description="Part 3 Evaluation: Compare Short vs Long Context Checkpoints")
    parser.add_argument('--model-tag', type=str, default='pico-part3', help='Model tag')
    parser.add_argument('--step1', type=int, default=1000, help='Step of Checkpoint 1 (Short Context)')
    parser.add_argument('--step2', type=int, default=2000, help='Step of Checkpoint 2 (Long Context)')
    parser.add_argument('--device-type', type=str, default='', help='cuda|cpu|mps')
    parser.add_argument('--modal', action='store_true', help='enable Modal-specific path configuration')
    args = parser.parse_args()

    device_type = autodetect_device_type() if args.device_type == '' else args.device_type
    _, _, _, _, device = compute_init(device_type)

    # Define a long-context test case (Needle in a Haystack style)
    # We want a context that is longer than 512 tokens but shorter than 2048.
    needle = "The secret password is: ALIBI_IS_AWESOME."
    filler = "The quick brown fox jumps over the lazy dog. " * 50 # roughly 450 tokens
    context = filler + needle + filler
    question = "\n\nBased on the text above, what is the secret password?"
    prompt = context + question

    checkpoints = [args.step1, args.step2]
    results = {}

    for step in checkpoints:
        print0(f"\n--- Evaluating Checkpoint at Step {step} ---")
        try:
            model, tokenizer, meta = load_model("base", device, phase="eval", model_tag=args.model_tag, step=step)
            engine = Engine(model, tokenizer)
            
            # Prepare prompt
            prompt_tokens = tokenizer.encode(prompt, prepend="<|bos|>")
            print0(f"Prompt length: {len(prompt_tokens)} tokens")
            
            # Generate
            generated_tokens = []
            stream = engine.generate(prompt_tokens, num_samples=1, max_tokens=20, temperature=0)
            
            output_str = ""
            for token_column, _ in stream:
                token = token_column[0]
                chunk = tokenizer.decode([token])
                output_str += chunk
            
            print0(f"Model Output: {output_str.strip()}")
            results[step] = output_str.strip()
            
            # Also check BPB on this specific prompt
            ids = torch.tensor([prompt_tokens], dtype=torch.long, device=device)
            targets = ids.clone()
            targets[:, :-1] = ids[:, 1:]
            targets[:, -1] = -1
            
            with torch.no_grad():
                loss = model(ids, targets=targets)
                bpb = loss.item() / 0.693147 # convert to bits per byte (approx)
            print0(f"BPB on this context: {bpb:.4f}")

        except Exception as e:
            print0(f"Error loading/evaluating step {step}: {e}")

    print0("\n" + "="*40)
    print0("FINAL COMPARISON")
    print0("="*40)
    for step, output in results.items():
        desc = "Short Context (512)" if step == args.step1 else "Long Context (2048)"
        print0(f"Step {step} ({desc}): {output}")

if __name__ == "__main__":
    main()
