# TempoFlow Modal SAM 3

This folder contains the fast-first SAM 3 inference service for TempoFlow.

It is designed to keep AWS out of the critical path for now:

- the `web-app` sends short dance clips to Modal
- Modal runs SAM 3 on a warm GPU worker
- the `web-app` stores the returned segmented videos locally per session

## API Contract

Endpoint:

- `POST /segment-video`

Multipart form fields:

- `video`: input clip
- `prompt`: optional text prompt, default `person`
- `alpha`: optional overlay fill alpha, default `0.52`

Response:

- `200 video/mp4`
- headers:
  - `X-SAM3-Provider: modal`
  - `X-SAM3-Prompt: <prompt>`
  - `X-SAM3-Model: facebook/sam3`

Health check:

- `GET /health`

## Fast-First Defaults

- GPU: `A10G`
- keep one warm container with `min_containers=1`
- keep workers warm for 5 minutes with `scaledown_window=300`
- file size cap inside the service: `40 MB`
- prompt scope: single object class, default `person`

For TempoFlow v1, keep clips short. The web app also enforces a separate duration cap before sending requests.

## Deploy

1. Install Modal locally.
2. Authenticate with `modal token new`.
3. Optionally create a token secret for the endpoint:

```bash
modal secret create tempoflow-sam3-auth SAM3_MODAL_TOKEN=replace-me
```

3b. Create a Hugging Face token secret (needed because `facebook/sam3` is gated on the Hub):

```bash
modal secret create tempoflow-hf-auth HF_TOKEN=hf_your_read_token
```

4. Serve locally while iterating:

```bash
cd modal-sam3
modal serve modal_app.py
```

5. Deploy a persistent endpoint:

```bash
cd modal-sam3
modal deploy modal_app.py
```

After deploy, copy the generated `/segment-video` base URL into `web-app/.env.local` as `SAM3_MODAL_URL`.

## Example Request

```bash
curl -X POST "$SAM3_MODAL_URL/segment-video" \
  -H "Authorization: Bearer $SAM3_MODAL_TOKEN" \
  -F "prompt=person" \
  -F "video=@./short-dance-clip.mp4" \
  --output segmented.mp4
```

## Notes

- The service uses the Hugging Face `Sam3VideoModel` / `Sam3VideoProcessor` interface instead of repo-internal research scripts.
- The service returns rendered overlay video bytes directly so the web app can stay local-first and cache outputs in IndexedDB.
