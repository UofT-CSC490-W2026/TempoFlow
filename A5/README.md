# Audio Alignment API

This project provides an API for aligning audio from video files and segmenting them based on musical beats.

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

### Endpoint: `/alignment`

-   **Method:** `POST`
-   **Description:** Uploads two video/audio files (`file_a` and `file_b`), aligns them, and returns segmentation timestamps.

## Testing

To run the tests with coverage:

```bash
pytest --cov=src -s
```
