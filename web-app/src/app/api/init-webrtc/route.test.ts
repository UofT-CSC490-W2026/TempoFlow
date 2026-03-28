import { describe, expect, it, vi } from "vitest";

vi.mock("@roboflow/inference-sdk", () => ({
  InferenceHTTPClient: {
    init: vi.fn(() => ({
      initializeWebrtcWorker: vi.fn(async () => ({ answer: { type: "answer", sdp: "ok" } })),
    })),
  },
}));

import { POST } from "./route";

describe("api/init-webrtc route", () => {
  it("returns 400 when ROBOFLOW_API_KEY is missing", async () => {
    vi.unstubAllEnvs();
    const req = new Request("http://localhost/api/init-webrtc", {
      method: "POST",
      body: JSON.stringify({ offer: { sdp: "s", type: "offer" } }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when workspace/workflow are missing", async () => {
    vi.stubEnv("ROBOFLOW_API_KEY", "k");
    vi.stubEnv("ROBOFLOW_WORKSPACE_NAME", "");
    vi.stubEnv("ROBOFLOW_WORKFLOW_ID", "");
    const req = new Request("http://localhost/api/init-webrtc", {
      method: "POST",
      body: JSON.stringify({ offer: { sdp: "s", type: "offer" } }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when offer is invalid", async () => {
    vi.stubEnv("ROBOFLOW_API_KEY", "k");
    vi.stubEnv("ROBOFLOW_WORKSPACE_NAME", "ws");
    vi.stubEnv("ROBOFLOW_WORKFLOW_ID", "wf");
    const req = new Request("http://localhost/api/init-webrtc", {
      method: "POST",
      body: JSON.stringify({ offer: { type: "offer" } }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns SDK answer on success", async () => {
    vi.stubEnv("ROBOFLOW_API_KEY", "k");
    vi.stubEnv("ROBOFLOW_WORKSPACE_NAME", "ws");
    vi.stubEnv("ROBOFLOW_WORKFLOW_ID", "wf");
    const req = new Request("http://localhost/api/init-webrtc", {
      method: "POST",
      body: JSON.stringify({
        offer: { sdp: "s", type: "offer" },
        wrtcParams: { streamOutputNames: ["a"], realtimeProcessing: true },
      }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ answer: { type: "answer" } });
  });
});

