import os, modal

app = modal.App("volume-ls")
vol_p4 = modal.Volume.from_name("nano_p4")
vol_orig = modal.Volume.from_name("nanochat-vol")

@app.function(volumes={"/p4": vol_p4, "/orig": vol_orig}, timeout=120)
def ls():
    # Only list checkpoint and tokenizer dirs
    targets = ["chatsft_checkpoints", "chatrl_checkpoints", "base_checkpoints", "tokenizer"]
    for label, base in [("nano_p4", "/p4"), ("nanochat-vol", "/orig")]:
        print(f"\n{'='*60}")
        print(f"  VOLUME: {label}")
        print(f"{'='*60}")
        cache = os.path.join(base, "nanochat_cache")
        if not os.path.isdir(cache):
            print(f"  [no nanochat_cache directory]")
            continue
        for t in targets:
            tdir = os.path.join(cache, t)
            if not os.path.isdir(tdir):
                print(f"  {t}/  [does not exist]")
                continue
            for dirpath, dirnames, filenames in os.walk(tdir):
                rel = os.path.relpath(dirpath, cache)
                for f in sorted(filenames):
                    fpath = os.path.join(dirpath, f)
                    size_mb = os.path.getsize(fpath) / (1024 * 1024)
                    print(f"  {os.path.join(rel, f)}  ({size_mb:.1f} MB)")
