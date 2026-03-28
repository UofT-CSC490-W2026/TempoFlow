import { describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const payload = {
  frames: [
    {
      frameIndex: 0,
      microTimingOff: true,
      motion: { refIn: 0, userIn: 0, refOut: 0, userOut: 0 },
      prev: {},
      curr: {},
      next: {},
    },
  ],
};

describe("api/ebs-pose-feedback route", () => {
  it("returns 400 when payload is missing", async () => {
    const req = new Request("http://localhost/api/ebs-pose-feedback", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns local fallback when no LLM keys are set", async () => {
    vi.unstubAllEnvs();
    const req = new Request("http://localhost/api/ebs-pose-feedback", {
      method: "POST",
      body: JSON.stringify({ perFramePayload: payload }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ source: "local-fallback" });
  });

  it("uses groq when GROQ_API_KEY is set", async () => {
    vi.stubEnv("GROQ_API_KEY", "k");
    vi.stubEnv("GROQ_MODEL", "llama");
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    frames: [
                      {
                        frameIndex: 0,
                        microTimingOff: false,
                        attackDecay: "good attack",
                        transitionToNext: "smooth transition",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const req = new Request("http://localhost/api/ebs-pose-feedback", {
      method: "POST",
      body: JSON.stringify({ perFramePayload: payload }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ source: "groq" });
  });

  it("falls back to openai when groq fails", async () => {
    vi.stubEnv("GROQ_API_KEY", "k1");
    vi.stubEnv("OPENAI_API_KEY", "k2");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    frames: [
                      {
                        frameIndex: 0,
                        microTimingOff: true,
                        attackDecay: "ok",
                        transitionToNext: "next",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("http://localhost/api/ebs-pose-feedback", {
      method: "POST",
      body: JSON.stringify({ perFramePayload: payload }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ source: "openai" });
  });
});

