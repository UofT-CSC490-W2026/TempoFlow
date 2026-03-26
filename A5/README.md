# Audio Alignment + EBS Web API

This project provides:
- A tested assignment API surface for alignment/segmentation logic.
- A web-app compatible EBS processor API used by `web-app` (`/api/process`, `/api/status`, `/api/result`).

## Prerequisites

- Python 3.8+
- [FFmpeg](https://ffmpeg.org/download.html) (Required by `librosa` / `audioread` for processing audio files)

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
    pip install -r requirements.txt
    ```

## Running the API

Once the environment is set up and activated, you can launch the API server using `uvicorn`.

The server will start on `http://localhost:8787`

```bash
uvicorn src.main:app --host 127.0.0.1 --port 8787 --reload
```

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

## Testing

To run the tests with coverage:

```bash
pytest --cov=src -s
```
