import { describe, expect, it, vi } from "vitest";

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class S3ClientMock {},
}));

vi.mock("@aws-sdk/s3-presigned-post", () => ({
  createPresignedPost: vi.fn(async () => ({ url: "https://s3.test", fields: { key: "k" } })),
}));

import { POST } from "./route";

describe("api/upload route", () => {
  it("returns 400 when cloud upload mode is disabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_STORAGE_MODE", "local");
    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: JSON.stringify({ filename: "a.mp4", contentType: "video/mp4" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 500 when bucket is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_STORAGE_MODE", "aws");
    vi.stubEnv("USER_VIDEO_BUCKET_NAME", "");
    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: JSON.stringify({ filename: "a.mp4", contentType: "video/mp4" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });

  it("returns presigned fields in aws mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_STORAGE_MODE", "aws");
    vi.stubEnv("USER_VIDEO_BUCKET_NAME", "bucket");
    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: JSON.stringify({ filename: "a.mp4", contentType: "video/mp4" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ url: "https://s3.test" });
  });
});

