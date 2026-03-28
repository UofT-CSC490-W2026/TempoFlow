import { describe, expect, it, vi } from "vitest";

import { POST } from "./route";

function makeRequestWithFormData(fd: FormData): Request {
  return {
    formData: async () => fd,
  } as unknown as Request;
}

describe("api/process route", () => {
  it("returns 400 when ref/user files are missing", async () => {
    const req = new Request("http://localhost/api/process", {
      method: "POST",
      body: new FormData(),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Both ref_video and user_video are required.",
    });
  });

  it("forwards files and session_id to upstream and mirrors response", async () => {
    vi.stubEnv("EBS_PROCESSOR_URL", "http://127.0.0.1:8787/api/process");
    const upstreamJson = JSON.stringify({ ok: true, segments: [] });
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const body = init?.body as FormData;
      expect(body.get("session_id")).toBe("session-1");
      expect(body.get("ref_video")).toBeInstanceOf(File);
      expect(body.get("user_video")).toBeInstanceOf(File);
      return new Response(upstreamJson, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const fd = new FormData();
    fd.append("ref_video", new File(["a"], "a.mp4", { type: "video/mp4" }));
    fd.append("user_video", new File(["b"], "b.mp4", { type: "video/mp4" }));
    fd.append("session_id", " session-1 ");
    const req = makeRequestWithFormData(fd);

    const res = await POST(req);
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe(upstreamJson);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns 502 with startup message when upstream is unreachable", async () => {
    vi.stubEnv("EBS_PROCESSOR_URL", "http://127.0.0.1:8787/api/process");
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      // First call is POST /api/process -> throw
      if (init?.method === "POST") {
        throw new Error("network down");
      }
      // Reachability probe HEAD -> false
      return new Response("", { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const fd = new FormData();
    fd.append("ref_video", new File(["a"], "a.mp4", { type: "video/mp4" }));
    fd.append("user_video", new File(["b"], "b.mp4", { type: "video/mp4" }));
    const req = makeRequestWithFormData(fd);
    const res = await POST(req);

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      processorReachable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

