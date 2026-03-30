from pathlib import Path
from tempfile import TemporaryDirectory

import modal

APP_NAME = "tempoflow-sam3"
MODEL_ID = "facebook/sam3"
CACHE_DIR = "/cache"
MAX_VIDEO_MB = 40
GPU_TYPE = "A10G"

app = modal.App(APP_NAME)

cache_volume = modal.Volume.from_name("tempoflow-sam3-cache", create_if_missing=True)
auth_secret = modal.Secret.from_name("tempoflow-sam3-auth")
hf_secret = modal.Secret.from_name("tempoflow-hf-auth")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git")
    .pip_install(
        "fastapi[standard]==0.115.12",
        "python-multipart==0.0.20",
        "torch==2.7.1",
        "torchvision==0.22.1",
        # SAM 3 landed after older 4.x releases. Modal's PyPI mirror may not resolve
        # transformers==5.0.0 cleanly due to hub pinning, so we install from source.
        "git+https://github.com/huggingface/transformers.git@v5.0.0rc0",
        "accelerate",
        "huggingface_hub",
        "imageio==2.37.0",
        "imageio-ffmpeg==0.6.0",
        "av==15.0.0",
        "numpy==2.2.6",
        "pillow==11.3.0",
    )
    .env({"HF_HOME": CACHE_DIR, "TRANSFORMERS_CACHE": CACHE_DIR})
)


@app.cls(
    image=image,
    gpu=GPU_TYPE,
    timeout=60 * 20,
    min_containers=0,
    scaledown_window=60 * 5,
    volumes={CACHE_DIR: cache_volume},
    secrets=[auth_secret, hf_secret],
)
class Sam3VideoService:
    @modal.enter()
    def load(self):
        import os
        import torch
        from transformers import Sam3VideoModel, Sam3VideoProcessor

        self.torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.dtype = torch.bfloat16 if self.device == "cuda" else torch.float32
        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")
        self.model = Sam3VideoModel.from_pretrained(MODEL_ID, torch_dtype=self.dtype, token=token).to(self.device)
        self.processor = Sam3VideoProcessor.from_pretrained(MODEL_ID, token=token)
        self.model.eval()

    @modal.method()
    def segment_video(self, video_bytes: bytes, prompt: str, alpha: float = 0.52) -> bytes:
        import imageio.v3 as iio

        if len(video_bytes) > MAX_VIDEO_MB * 1024 * 1024:
            raise ValueError(f"Video exceeds {MAX_VIDEO_MB} MB limit for fast SAM 3 mode.")

        with TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            input_path = tmp_path / "input.mp4"
            output_path = tmp_path / "output.mp4"
            input_path.write_bytes(video_bytes)

            frames = [frame for frame in iio.imiter(input_path)]
            if not frames:
                raise ValueError("No frames could be decoded from the video.")

            metadata = iio.immeta(input_path)
            fps = int(round(metadata.get("fps", 24))) if metadata.get("fps") else 24

            inference_session = self.processor.init_video_session(
                video=frames,
                inference_device=self.device,
                processing_device="cpu",
                video_storage_device="cpu",
                dtype=self.dtype,
            )
            inference_session = self.processor.add_text_prompt(
                inference_session=inference_session,
                text=prompt,
            )

            outputs_per_frame: dict[int, dict] = {}
            autocast_enabled = self.device == "cuda"

            with self.torch.inference_mode():
                autocast_context = (
                    self.torch.autocast("cuda", dtype=self.dtype)
                    if autocast_enabled
                    else self.torch.autocast("cpu", enabled=False)
                )
                with autocast_context:
                    for model_outputs in self.model.propagate_in_video_iterator(
                        inference_session=inference_session,
                        max_frame_num_to_track=len(frames),
                    ):
                        processed_outputs = self.processor.postprocess_outputs(
                            inference_session,
                            model_outputs,
                        )
                        outputs_per_frame[model_outputs.frame_idx] = processed_outputs

            segmented_frames = [
                _render_frame(frame, outputs_per_frame.get(index), alpha)
                for index, frame in enumerate(frames)
            ]

            iio.imwrite(
                output_path,
                segmented_frames,
                fps=fps,
                codec="libx264",
            )

            return output_path.read_bytes()


def _merge_masks(mask_data) -> "object":
    import numpy as np

    if mask_data is None:
        return None

    mask_array = np.asarray(mask_data)
    if mask_array.size == 0:
        return None

    if mask_array.ndim >= 4:
        mask_array = mask_array.reshape((-1, mask_array.shape[-2], mask_array.shape[-1]))
    elif mask_array.ndim == 3:
        pass
    elif mask_array.ndim == 2:
        mask_array = mask_array[None, ...]
    else:
        return None

    merged = np.any(mask_array > 0, axis=0)
    return merged


def _render_frame(frame, processed_outputs, alpha: float):
    import numpy as np

    frame_array = np.asarray(frame).copy()
    merged_mask = _merge_masks(processed_outputs.get("masks") if processed_outputs else None)
    if merged_mask is None:
        return frame_array

    mask = merged_mask.astype(bool)
    if mask.shape[:2] != frame_array.shape[:2]:
        return frame_array

    overlay_color = np.array([168, 85, 247], dtype=np.float32)
    frame_array = frame_array.astype(np.float32)
    frame_array[mask] = frame_array[mask] * (1 - alpha) + overlay_color * alpha

    edge_mask = np.logical_xor(mask, np.pad(mask[1:, :], ((0, 1), (0, 0)), mode="constant"))
    edge_mask |= np.logical_xor(mask, np.pad(mask[:, 1:], ((0, 0), (0, 1)), mode="constant"))
    frame_array[edge_mask] = np.array([236, 72, 153], dtype=np.float32)

    return np.clip(frame_array, 0, 255).astype(np.uint8)


@app.function(image=image, secrets=[auth_secret])
@modal.asgi_app()
def fastapi_app():
    import os
    from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile, status
    from fastapi.responses import Response
    from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

    web_app = FastAPI(title="TempoFlow SAM 3 Modal API")
    auth_scheme = HTTPBearer(auto_error=False)
    service = Sam3VideoService()

    def require_token(
        credentials: HTTPAuthorizationCredentials | None = Depends(auth_scheme),
        modal_secret: str | None = Header(default=None, alias="Modal-Secret"),
    ) -> None:
        expected = os.environ.get("SAM3_MODAL_TOKEN", "").strip()
        if not expected:
            return

        provided = credentials.credentials if credentials else None
        if provided == expected or modal_secret == expected:
            return

        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid SAM 3 Modal token.",
        )

    @web_app.get("/health")
    async def health():
        return {
            "ok": True,
            "model": MODEL_ID,
            "gpu": GPU_TYPE,
            "max_video_mb": MAX_VIDEO_MB,
        }

    @web_app.post("/segment-video")
    async def segment_video(
        video: UploadFile = File(...),
        prompt: str = Form("person"),
        alpha: float = Form(0.52),
        _auth: None = Depends(require_token),
    ):
        video_bytes = await video.read()
        if not video_bytes:
            raise HTTPException(status_code=400, detail="Missing video payload.")

        output_bytes = await service.segment_video.remote.aio(video_bytes=video_bytes, prompt=prompt, alpha=alpha)

        headers = {
            "X-SAM3-Provider": "modal",
            "X-SAM3-Prompt": prompt,
            "X-SAM3-Model": MODEL_ID,
        }
        return Response(content=output_bytes, media_type="video/mp4", headers=headers)

    return web_app
