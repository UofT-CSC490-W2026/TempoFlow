# TempoFlow Web App

TempoFlow is a dance-practice web app that helps dancers compare a reference performance with their own recording and receive actionable feedback. The current prototype focuses on a simple user flow: upload two videos, synchronize playback, overlay pose estimation, and present feedback in a clean coaching-style interface.

## Project Overview

### Product goal

TempoFlow aims to help dancers learn choreography faster by surfacing mistakes that are hard to catch through a mirror or self-monitoring alone. The strongest positioning from user feedback is:

- help users learn dance quickly
- provide timely feedback users cannot easily notice themselves
- prioritize popular practice contexts such as jpop, jazz, and kpop
- focus first on timing and attack, then isolation and groove

### Why this matters

Survey feedback suggests:

- users are motivated by the app idea and see value in extra feedback
- most dancers currently rely on mirrors, self-review, or YouTube tutorials
- practice happens both solo and in groups, so group use should not be ignored
- feedback must be useful, not just point out obvious mistakes
- privacy and data leakage are real concerns
- limited space to record can reduce usefulness

These points shape both the product design and the technical roadmap.

## Assignment Context

The wider `TempoFlow` repo includes several course assignments, but they are not equally relevant to the web app.

### Most relevant

- `A1` defines the core product idea: an AI-assisted dance coach that compares a user clip against a reference clip and turns pose, timing, and movement differences into useful coaching
- `A1` emphasizes subtle dance feedback such as micro-timing, groove phase, attack and decay control, isolation, grounding, and visual coaching instead of raw numbers alone
- `A1` also highlights UX questions that still matter for this prototype, including overlay quality, synchronization logic, mobile performance, and useful visual feedback
- `A2` is somewhat related because it covers datasets, validation pipelines, and AWS infrastructure that can support storage and future analysis workflows

### Less relevant

- `A3` is a separate nanochat / LLM assignment track and is not directly linked to the web app
- `A4` is also a separate nanochat / RL assignment track and is not directly linked to the web app

For this README, the app should mainly be understood through the `A1` product vision, with limited supporting context from `A2`.

## Current Web App Scope

The current prototype includes:

- landing page with product positioning
- upload flow for one reference video and one practice video
- in-browser recording for the practice video
- local browser storage of uploaded videos using IndexedDB
- local session history for revisiting prior analyses
- analysis page with synchronized playback
- client-side pose overlay using TensorFlow.js MoveNet
- local pose-based baseline analysis for timing, positioning, smoothness, and energy
- optional hosted API coaching summaries when enabled
- optional real SAM 3 video segmentation through a Modal-hosted backend proxy
- AWS S3 upload route for later cloud integration

Current routes:

- `/`
- `/upload`
- `/analysis`
- `/dashboard`
- `/api/upload`
- `/api/coach`
- `/api/sam3/video`

## Product Requirements

### Core user requirements

- users can upload a reference dance video and a practice video
- users can compare both videos side by side
- users can replay and inspect timing and movement differences
- users receive clear, actionable feedback rather than raw metrics only
- users should feel safe uploading videos, with privacy handled carefully

### Technical requirements

- support modern browsers with WebGL for pose detection
- handle large video files more safely than in-memory state alone
- work locally even before AWS is fully configured
- keep a clean path for optional hosted API augmentation
- leave room for future integration with validation pipelines and cloud storage

### Feedback requirements

Based on dancer feedback, the app should prioritize:

- timing and beat alignment
- attack and movement sharpness
- feedback that notices mistakes the user might miss
- concise, high-value coaching suggestions
- visual guidance over metric-heavy displays whenever possible

## Tech Stack

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS 4
- TensorFlow.js
- MoveNet pose detection
- AWS SDK for S3 presigned uploads
- IndexedDB for local video persistence

## Local Development

### Prerequisites

- Node.js 20+
- npm
- a browser with WebGL enabled

### Install

```bash
cd web-app
npm install
```

### Run

```bash
npm run dev
```

Open `http://localhost:3000`.

## Environment Modes

Copy `web-app/.env.example` to `.env.local` and start from local mode.

### Local-only mode

Recommended default while iterating on the app UX.

```bash
NEXT_PUBLIC_APP_STORAGE_MODE=local
NEXT_PUBLIC_APP_ANALYSIS_MODE=local
```

Behavior:

- uploaded videos stay on the device
- sessions are saved locally
- analysis uses browser pose extraction and local scoring
- coaching text is generated locally

### Local app + hosted API coaching

Use this when you want better coaching language without changing the local video/session flow.

```bash
NEXT_PUBLIC_APP_STORAGE_MODE=local
NEXT_PUBLIC_APP_ANALYSIS_MODE=api
OPENAI_API_KEY=your-key
OPENAI_MODEL=gpt-4.1-mini
SAM3_BACKEND=modal
SAM3_MODAL_URL=https://your-modal-app.modal.run
SAM3_MODAL_TOKEN=your-modal-token
SAM3_PROMPT=person
NEXT_PUBLIC_SAM3_MAX_VIDEO_MB=40
NEXT_PUBLIC_SAM3_MAX_DURATION_SEC=12
```

Behavior:

- uploaded videos still stay local
- pose analysis still runs locally in the browser
- the app optionally calls `/api/coach` to turn analysis metrics into richer coaching text
- the app can also call `/api/sam3/video` to send short clips to Modal, then store the returned SAM 3 segmented videos locally per session

### Later AWS upload mode

Only enable this once cloud storage is ready.

```bash
NEXT_PUBLIC_APP_STORAGE_MODE=aws
NEXT_PUBLIC_APP_ANALYSIS_MODE=local
AWS_REGION=us-east-1
USER_VIDEO_BUCKET_NAME=your-bucket-name
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
```

## Environment Setup

The app is now designed around explicit environment modes instead of implicit mock uploads.

### Local mode

For local development, the recommended setup is:

- `NEXT_PUBLIC_APP_STORAGE_MODE=local`
- `NEXT_PUBLIC_APP_ANALYSIS_MODE=local`

This avoids AWS entirely while keeping the full upload -> analyze -> revisit workflow working.

### S3 upload mode

Set these environment variables only when you want real presigned uploads:

```bash
NEXT_PUBLIC_APP_STORAGE_MODE=aws
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
USER_VIDEO_BUCKET_NAME=your-bucket-name
```

Notes:

- the current API enforces a file size limit of 100 MB
- uploaded files are written to a `raw/` prefix in S3
- local mode is the recommended default while AWS is not part of the workflow

## Known Limitations

- local analysis is a lightweight baseline, not a production-grade dance model
- timing and body-area feedback are heuristic and should be validated with real dancers
- no authentication or user accounts yet
- sessions are local to one browser/device
- pose overlay is client-side only and depends on browser performance
- privacy, consent, and retention policies are not implemented yet
- API coaching currently improves wording, not the underlying motion comparison itself
- real SAM 3 support currently depends on a Modal-hosted service and should be kept to short clips for fast feedback

## Priority Tasks

### Near-term

- validate the local pose-based scoring against a small internal clip set
- improve feedback wording so it is useful instead of obvious
- add stronger segment replay and issue-highlighting controls
- test API-assisted coaching quality against local-only coaching
- add environment example docs for teammates
- measure whether Modal SAM 3 output is visibly better than the local pose-fill overlay for dancers

### Product-focused

- build timing-first feedback, since this was the clearest user need
- add attack, isolation, and groove analysis after timing is reliable
- support constrained recording conditions and imperfect camera setups
- think through solo versus group practice workflows
- prefer visual coaching cues such as overlays, highlights, arrows, and focused comparisons instead of showing only scores

### Infrastructure and privacy

- connect the web app cleanly to AWS resources from `A2`
- define storage retention and delete flows for uploaded videos
- reduce data leakage risk with safer upload and access patterns
- decide what should stay local versus what should be processed in the cloud

## Evaluation Baseline

For the final project, keep a small internal benchmark set and track:

- timing usefulness on a few known dance pairs
- score stability across repeated runs
- whether the top feedback point matches what a human reviewer notices
- whether dancers find the generated feedback actionable
- differences between local-only coaching and API-assisted coaching
- cold-start time, warm request time, and total click-to-play latency for Modal SAM 3

## Modal SAM 3 Service

The SAM 3 backend now lives outside the Next.js app under `modal-sam3/`.

Use this when you want real dense body masks without running a heavy model on-device:

1. Deploy the Modal service from `modal-sam3/modal_app.py`.
2. Copy the deployed URL into `SAM3_MODAL_URL`.
3. Keep clips short so the experience stays interactive.

TempoFlow currently optimizes this path for speed:

- single prompt class, default `person`
- warm Modal worker support
- short clips, default `12` second cap in the web app
- stricter file size cap, default `40 MB`
- local caching of segmented output after generation

## Suggested Team Workflow

1. Use mock mode for frontend and UX iteration.
2. Integrate real S3 uploads only when infra variables are available.
3. Validate analysis quality against the product goals from `A1` and any supporting pipeline work from `A2`.
4. Tune feedback based on dancer usefulness, not just technical correctness.

## Summary

TempoFlow should be treated as an AI dance coach, not just a video comparison tool. The current web app already demonstrates the intended interaction model, while the next major step is turning synchronized playback and pose overlays into feedback that matches the original `A1` vision and that dancers actually trust and want to use.
