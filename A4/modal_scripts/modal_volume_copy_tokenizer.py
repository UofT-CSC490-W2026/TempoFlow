import os, shutil, modal

app = modal.App("copy-tokenizer-to-nano_p4")
src = modal.Volume.from_name("nanochat-vol")
dst = modal.Volume.from_name("nano_p4")

@app.function(volumes={"/src": src, "/dst": dst}, timeout=600)
def copy_tokenizer():
    src_dir = "/src/nanochat_cache/tokenizer"
    dst_dir = "/dst/nanochat_cache/tokenizer"
    shutil.copytree(src_dir, dst_dir, dirs_exist_ok=True)
    dst.commit()