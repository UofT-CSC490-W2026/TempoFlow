# TempoFlow: AI-Driven Dance Coaching
CSC490 26W Capstone Project, Group 8 

Team members: Isaac Abell, Thomas (Yehyun) Lee , Zeling (Zoey) Zhang , Jessica Zhang

# About
**TempoFlow** is a practice-oriented web application designed to bridge the gap between reproducing choreography and mastering professional-level execution. While traditional tools like mirrors provide visual feedback, they lack the temporal precision needed to diagnose subtle mismatches in timing, posture, and movement quality. TempoFlow automates this process by comparing a user's practice video against a reference choreography, providing segment-level, actionable feedback to help dancers refine their performance.

---

## Key Features

### 1. Intelligent Temporal Synchronization
* **Audio-Based Alignment**: Uses a custom, gapless modification of the Smith-Waterman algorithm to map the user’s performance to the reference video's timeline.
* **High Precision**: Successfully aligns 99.7% of samples within 1/60th of a second, ensuring frame-accurate visual comparisons.
* **Boundary Padding**: Includes a padding buffer on predicted start and end timestamps to ensure complete capture of the alignment window.

### 2. Structural Movement Segmentation
* **Downbeat Estimation**: Leverages acoustic intensity heuristics to identify "Count 1" downbeats within 8-count phrases.
* **Micro-Timing Analysis**: Divides choreography into "move-windows" (the transition between two consecutive beats) to provide granular feedback rather than generic global scores.

### 3. Advanced Computer Vision Pipeline
* **High-Speed Segmentation**: Utilizes YOLO for person and body-part segmentation, providing a superior balance of speed and accuracy.
* **Kinematic Grounding**: Passes structured pose data—including joint positions, body scale, and translation offsets—to the feedback engine to ensure diagnostics are based on motion evidence.

### 4. Multimodal Feedback System
* **Two-Layer Feedback**: Features a high-level summary for quick corrections and detailed coaching cards for granular diagnosis.
* **Micro-Level Diagnosis**: Generates specific timing labels (e.g., "early," "late," or "rushed") and identifies relevant limbs or weight shifts involved in a transition.
* **Adaptive Experience Levels**: Includes Beginner, Standard, and Advanced modes to tailor the technical depth of feedback to the user's expertise.

### 5. Practice-First User Interface
* **Review Panel**: Designed for studio settings with speed control, looping, and thumbnail-based navigation.
* **Comparison Modes**: Offers overlay and split-screen modes with beat-aligned playback to help dancers spot mismatches despite perspective differences.

---

## Technical Architecture

* **Frontend**: Hosted on AWS Amplify using TypeScript; utilizes local Browser Storage for a seamless, "local-first" MVP experience.
* **Backend Delivery**: Requests are routed through CloudFront to an Elastic Load Balancer within an AWS Elastic Beanstalk environment.
* **Compute Optimization**: Matrix-heavy alignment and segmentation modules are implemented as a separate Python/NumPy service to significantly reduce computation time.
* **AI Integration**: Leverages state-of-the-art external multimodal models to provide cost-effective, high-quality analysis.

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
For coverage report, run the following under web-app folder:
```
npx vitest run --coverage --reporter=default --coverage.reporter=text
```
