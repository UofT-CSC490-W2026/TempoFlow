# Audio Alignment + EBS Web API

This project provides:
- A tested assignment API surface for alignment/segmentation logic.
- A web-app compatible EBS processor API used by `web-app` (`/api/process`, `/api/status`, `/api/result`).

## Prerequisites

- Python 3.8+
- [FFmpeg](https://ffmpeg.org/download.html) (Required by `librosa` / `audioread` for processing audio files)
- Optional: Gemini micro-timing move feedback requires one of:
  - `GEMINI_API_KEY`, or
  - `GOOGLE_API_KEY`

## Setup

1.  **Create a virtual environment:**

    ```bash
    # Windows
    python -m venv venv

    # macOS/Linux
    python3 -m venv venv
    ```

2.  **Activate the virtual environment:**

    ```bash
    # Windows (PowerShell)
    .\venv\Scripts\Activate.ps1

    # Windows (Command Prompt)
    .\venv\Scripts\activate.bat

    # macOS/Linux
    source venv/bin/activate
    ```

3.  **Install dependencies:**

    ```bash
    pip install -r requirements-dev.txt
    ```

    (Use `requirements.txt` only for a minimal runtime install; `requirements-dev.txt` adds pytest for local tests.)

## Running the API

Once the environment is set up and activated, you can launch the API server using `uvicorn`.

The server will start on `http://localhost:8787`

```bash
uvicorn src.main:app --host 127.0.0.1 --port 8787 --reload
```

If you plan to use Gemini move-feedback endpoints, set one of these **in the same shell** before starting `uvicorn`:
- `GEMINI_API_KEY`
- `GOOGLE_API_KEY`

## Usage

You can access the automatic interactive API documentation at:

-   **Swagger UI:** [http://localhost:8787/docs](http://localhost:8787/docs)
-   **ReDoc:** [http://localhost:8787/redoc](http://localhost:8787/redoc)

### Endpoint: `/a5/api/process`

-   **Method:** `POST`
-   **Description:** Original A5 router endpoint (tested module path). Accepts `file_a` and `file_b`.

### Endpoint: `/api/process`

-   **Method:** `POST`
-   **Description:** Web-app compatible EBS endpoint. Accepts `ref_video` + `user_video` (also supports `file_a` + `file_b` for compatibility).
-   **Returns:** EBS JSON payload with `alignment`, `segments`, `beats_shared_sec`, `beat_tracking`, and `video_meta`.

### Additional web-app compatibility endpoints

- `GET /api/status?session=<id>`
- `GET /api/result?session=<id>`
- `HEAD/GET /ebs_viewer.html` (health probe)
- Overlay jobs for session overlays:
  - `POST /api/overlay/yolo/start`, `GET /api/overlay/yolo/status`, `GET /api/overlay/yolo/result`
  - `POST /api/overlay/yolo-pose/start`, `GET /api/overlay/yolo-pose/status`, `GET /api/overlay/yolo-pose/result`
  - `POST /api/overlay/bodypix/start`, `GET /api/overlay/bodypix/status`, `GET /api/overlay/bodypix/result`

### Gemini Move Feedback (Micro-timing)

These endpoints provide Gemini-based “micro-timing move feedback” for one EBS segment.

- `POST /api/move-feedback/start`
  - Starts an async job and returns `{ "job_id": "..." }`
- `POST /api/move-feedback`
  - Synchronous variant (waits for Gemini and returns feedback JSON)
- `GET /api/move-feedback/status?job_id=<id>`
- `GET /api/move-feedback/result?job_id=<id>`

POST fields (multipart):
- `ref_video` (file), `user_video` (file)
- `segment_index` (0-based int)
- optional: `session_id` (reuse stored `/api/process` output) or `ebs_data_json` (full artifact JSON string)

## Testing

To run the A5 tests with coverage:

```bash
pytest --cov=src -s
```

### Running both A5 + web-app tests

The repo contains two separate test suites:
- **A5 (Python)**: `pytest`
- **web-app (Next.js)**: `npm test` (and optionally `npm run coverage`)

If you want a single “run everything” command locally, run these from repo root:

```bash
./A5/venv/bin/python -m pytest A5/tests -q
cd web-app && npm test
```
