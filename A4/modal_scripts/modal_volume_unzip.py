import modal
import zipfile
import os

app = modal.App("volume-helper")
volume = modal.Volume.from_name("nanochat-vol")

@app.function(volumes={"/vol": volume}, timeout=600)
def unzip_checkpoint():
    base = "/vol/nanochat_cache"
    uploads_zip = os.path.join(base, "uploads", "model-and-sft.zip")
    target_dir = os.path.join(base, "chatsft_checkpoints")
    os.makedirs(target_dir, exist_ok=True)
    with zipfile.ZipFile(uploads_zip) as zf:
        zf.extractall(target_dir)
    volume.commit()