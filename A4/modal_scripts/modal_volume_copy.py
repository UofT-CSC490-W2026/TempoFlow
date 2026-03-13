import os, shutil, modal

app = modal.App("copy-sft-to-nano_p4")
src = modal.Volume.from_name("nanochat-vol")
dst = modal.Volume.from_name("nano_p4")

@app.function(volumes={"/src": src, "/dst": dst}, timeout=600)
def copy_sft_checkpoint():
    src_dir = "/src/nanochat_cache/chatsft_checkpoints/model-and-sft"
    dst_dir = "/dst/nanochat_cache/chatsft_checkpoints/model-and-sft"
    os.makedirs(dst_dir, exist_ok=True)
    for entry in os.listdir(src_dir):
        shutil.copytree(os.path.join(src_dir, entry),
                        os.path.join(dst_dir, entry),
                        dirs_exist_ok=True)
    dst.commit()