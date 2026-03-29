"use client";

/**
 * Bidirectional WebSocket session with Gemini Multimodal Live API.
 *
 * Handles three input streams to the model:
 *   1. Audio  — PCM 16 kHz from the microphone  (continuous)
 *   2. Video  — JPEG frames from the webcam      (1 FPS)
 *   3. Pose   — skeletal JSON from PoseExtractor  (5 Hz via client_content)
 *
 * And one output stream from the model:
 *   - Audio   — PCM 24 kHz voice feedback (played via Web Audio)
 *   - Text    — transcript of the voice feedback
 *
 * Barge-in: sending mic audio while the model speaks causes it to stop.
 * On the client side we also flush the playback queue on "interrupted".
 *
 * The WebSocket URL points at the A5 backend proxy (or another server) so the
 * Gemini API key is never exposed to the browser.
 */

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const AUDIO_FLUSH_MS = 100;
const VIDEO_SEND_MS = 1000;
const POSE_SEND_MS = 200;

// ── Types ──────────────────────────────────────────────────────────────

export type LiveCoachStatus =
  | "idle"
  | "connecting"
  | "setup"
  | "active"
  | "error"
  | "closed";

export interface LiveCoachEvents {
  onStatus: (status: LiveCoachStatus) => void;
  onTranscript: (text: string, isFinal: boolean) => void;
  onError: (message: string) => void;
  onAudioLevel: (level: number) => void;
}

export interface SessionConfig {
  /** e.g. ws://127.0.0.1:8787/api/live-coach/ws (A5 proxy, not Google). */
  wsUrl: string;
  model: string;
  systemInstruction: string;
  referenceFileUri?: string;
  events: LiveCoachEvents;
}

// ── Helpers ────────────────────────────────────────────────────────────

function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x2000) {
    parts.push(
      String.fromCharCode(
        ...bytes.subarray(i, Math.min(i + 0x2000, bytes.length)),
      ),
    );
  }
  return btoa(parts.join(""));
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Session Class ──────────────────────────────────────────────────────

export class GeminiLiveSession {
  private ws: WebSocket | null = null;
  private cfg: SessionConfig;
  private status: LiveCoachStatus = "idle";

  /* audio input */
  private audioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private pcmQueue: Int16Array[] = [];
  private audioTimer: number | null = null;

  /* audio output */
  private outCtx: AudioContext | null = null;
  private scheduledEnd = 0;

  /* video + pose */
  private videoEl: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private videoTimer: number | null = null;
  private poseTimer: number | null = null;
  private pendingPose: string | null = null;

  private setupDone = false;

  constructor(cfg: SessionConfig) {
    this.cfg = cfg;
  }

  // ── Public API ─────────────────────────────────────────────────────

  async start(): Promise<HTMLVideoElement> {
    this.setStatus("connecting");

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: "user",
      },
      audio: true,
    });

    this.videoEl = document.createElement("video");
    this.videoEl.srcObject = this.mediaStream;
    this.videoEl.muted = true;
    this.videoEl.playsInline = true;
    await this.videoEl.play();

    this.canvas = document.createElement("canvas");

    await this.initAudioCapture(this.mediaStream);
    this.outCtx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });

    await this.openSocket();
    return this.videoEl;
  }

  getVideoElement(): HTMLVideoElement | null {
    return this.videoEl;
  }

  getStatus(): LiveCoachStatus {
    return this.status;
  }

  /** Feed latest pose JSON (called externally at ~30 FPS). */
  setPoseData(json: string): void {
    this.pendingPose = json;
  }

  stop(): void {
    [this.audioTimer, this.videoTimer, this.poseTimer].forEach((t) => {
      if (t != null) clearInterval(t);
    });
    this.audioTimer = this.videoTimer = this.poseTimer = null;

    this.flushPlayback();

    this.ws?.close();
    this.ws = null;

    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;

    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.outCtx?.close().catch(() => {});
    this.outCtx = null;

    this.videoEl = null;
    this.canvas = null;
    this.pcmQueue = [];
    this.setupDone = false;
    this.setStatus("closed");
  }

  // ── Audio Capture ──────────────────────────────────────────────────

  private async initAudioCapture(stream: MediaStream) {
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;

    const audioOnly = new MediaStream([audioTrack]);

    try {
      this.audioCtx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
    } catch {
      this.audioCtx = new AudioContext();
    }

    const src = this.audioCtx.createMediaStreamSource(audioOnly);

    // ScriptProcessorNode is deprecated but reliable under COOP/COEP
    // headers that this app already uses (blob: AudioWorklet URLs can fail).
    const proc = this.audioCtx.createScriptProcessor(4096, 1, 1);
    src.connect(proc);
    proc.connect(this.audioCtx.destination);
    proc.onaudioprocess = (e: AudioProcessingEvent) => {
      this.ingestAudio(e.inputBuffer.getChannelData(0), this.audioCtx!.sampleRate);
    };
  }

  private ingestAudio(samples: Float32Array, nativeSR: number) {
    // Resample to INPUT_SAMPLE_RATE if the context didn't honour it
    const ratio = INPUT_SAMPLE_RATE / nativeSR;
    let data: Float32Array;

    if (Math.abs(ratio - 1) < 0.02) {
      data = samples;
    } else {
      const outLen = Math.max(1, Math.floor(samples.length * ratio));
      data = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const srcIdx = i / ratio;
        const lo = Math.floor(srcIdx);
        const hi = Math.min(lo + 1, samples.length - 1);
        const frac = srcIdx - lo;
        data[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
      }
    }

    // Float32 → Int16
    const int16 = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const s = Math.max(-1, Math.min(1, data[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.pcmQueue.push(int16);

    // RMS for audio level UI
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    this.cfg.events.onAudioLevel(
      Math.min(1, Math.sqrt(sum / data.length) * 5),
    );
  }

  // ── WebSocket ──────────────────────────────────────────────────────

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.cfg.wsUrl);

      const timeout = setTimeout(() => {
        this.cfg.events.onError("Connection timed out.");
        this.setStatus("error");
        reject(new Error("timeout"));
      }, 15_000);

      this.ws.onopen = () => {
        this.setStatus("setup");
        this.sendSetup();
      };

      this.ws.onmessage = (ev) =>
        this.handleMsg(ev.data as string, () => {
          clearTimeout(timeout);
          resolve();
        });

      this.ws.onerror = () => {
        clearTimeout(timeout);
        this.cfg.events.onError(
          "WebSocket connection failed. Ensure the A5 API is running and GEMINI_API_KEY is set on the server.",
        );
        this.setStatus("error");
        reject(new Error("ws error"));
      };

      this.ws.onclose = () => {
        if (this.status === "active") this.setStatus("closed");
      };
    });
  }

  private sendSetup() {
    this.ws!.send(
      JSON.stringify({
        setup: {
          model: this.cfg.model,
          generation_config: {
            response_modalities: ["AUDIO", "TEXT"],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: { voice_name: "Aoede" },
              },
            },
          },
          system_instruction: {
            parts: [{ text: this.cfg.systemInstruction }],
          },
        },
      }),
    );
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private handleMsg(raw: string, onReady: () => void) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if ("setupComplete" in msg) {
      this.setupDone = true;
      this.setStatus("active");
      this.beginStreaming();
      if (this.cfg.referenceFileUri) this.sendFileContext();
      onReady();
      return;
    }

    const sc = msg.serverContent as
      | {
          modelTurn?: {
            parts?: Array<{
              text?: string;
              inlineData?: { data: string; mimeType: string };
            }>;
          };
          turnComplete?: boolean;
          interrupted?: boolean;
        }
      | undefined;
    if (!sc) return;

    if (sc.interrupted) {
      this.flushPlayback();
      return;
    }

    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.mimeType?.startsWith("audio/")) {
        this.enqueueAudio(part.inlineData.data);
      }
      if (part.text) {
        this.cfg.events.onTranscript(part.text, false);
      }
    }

    if (sc.turnComplete) {
      this.cfg.events.onTranscript("", true);
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  private sendFileContext() {
    this.ws?.send(
      JSON.stringify({
        client_content: {
          turns: [
            {
              role: "user",
              parts: [
                {
                  file_data: {
                    file_uri: this.cfg.referenceFileUri,
                    mime_type: "video/mp4",
                  },
                },
                {
                  text: "This is the reference dance video. Compare the live dancer to this choreography.",
                },
              ],
            },
          ],
          turn_complete: true,
        },
      }),
    );
  }

  // ── Streaming Loops ────────────────────────────────────────────────

  private beginStreaming() {
    this.audioTimer = window.setInterval(
      () => this.flushAudioInput(),
      AUDIO_FLUSH_MS,
    );
    this.videoTimer = window.setInterval(
      () => this.sendFrame(),
      VIDEO_SEND_MS,
    );
    this.poseTimer = window.setInterval(
      () => this.sendPose(),
      POSE_SEND_MS,
    );
  }

  private flushAudioInput() {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.pcmQueue.length
    )
      return;

    let len = 0;
    for (const c of this.pcmQueue) len += c.length;
    const merged = new Int16Array(len);
    let off = 0;
    for (const c of this.pcmQueue) {
      merged.set(c, off);
      off += c.length;
    }
    this.pcmQueue = [];

    this.ws.send(
      JSON.stringify({
        realtime_input: {
          media_chunks: [
            {
              data: toBase64(new Uint8Array(merged.buffer)),
              mime_type: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
            },
          ],
        },
      }),
    );
  }

  private sendFrame() {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.videoEl ||
      !this.canvas
    )
      return;

    const vw = this.videoEl.videoWidth || 640;
    const vh = this.videoEl.videoHeight || 480;
    const scale = Math.min(1, 640 / vw);
    this.canvas.width = Math.round(vw * scale);
    this.canvas.height = Math.round(vh * scale);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(this.videoEl, 0, 0, this.canvas.width, this.canvas.height);
    const dataUrl = this.canvas.toDataURL("image/jpeg", 0.6);
    const b64 = dataUrl.split(",")[1];
    if (!b64) return;

    this.ws.send(
      JSON.stringify({
        realtime_input: {
          media_chunks: [{ data: b64, mime_type: "image/jpeg" }],
        },
      }),
    );
  }

  private sendPose() {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.pendingPose
    )
      return;

    this.ws.send(
      JSON.stringify({
        client_content: {
          turns: [
            {
              role: "user",
              parts: [{ text: `POSE: ${this.pendingPose}` }],
            },
          ],
          turn_complete: true,
        },
      }),
    );
    this.pendingPose = null;
  }

  // ── Audio Output ───────────────────────────────────────────────────

  private enqueueAudio(b64: string) {
    if (!this.outCtx) return;

    const bytes = fromBase64(b64);
    const int16 = new Int16Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength >> 1,
    );
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
    }

    const buf = this.outCtx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    buf.getChannelData(0).set(float32);

    const node = this.outCtx.createBufferSource();
    node.buffer = buf;
    node.connect(this.outCtx.destination);

    const startAt = Math.max(this.outCtx.currentTime, this.scheduledEnd);
    node.start(startAt);
    this.scheduledEnd = startAt + buf.duration;
  }

  /** Stop all queued and in-flight audio playback (barge-in). */
  private flushPlayback() {
    this.scheduledEnd = 0;
    if (this.outCtx) {
      this.outCtx.close().catch(() => {});
      this.outCtx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    }
  }

  // ── Misc ───────────────────────────────────────────────────────────

  private setStatus(s: LiveCoachStatus) {
    this.status = s;
    this.cfg.events.onStatus(s);
  }
}
