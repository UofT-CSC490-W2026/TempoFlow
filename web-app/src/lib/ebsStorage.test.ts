import { describe, expect, it } from "vitest";

import { deleteSessionEbs, getSessionEbs, storeSessionEbs } from "./ebsStorage";

describe("ebsStorage", () => {
  it("stores and reads EBS artifacts by session id", async () => {
    const sessionId = "s-1";
    const data = {
      referenceClipName: "ref.mp4",
      userClipName: "user.mp4",
      segments: [{ seg_id: 0, shared_start_sec: 0, shared_end_sec: 1 }],
      metadata: { bpm: 120 },
    };

    await storeSessionEbs(sessionId, data as never);
    await expect(getSessionEbs(sessionId)).resolves.toMatchObject(data);
  });

  it("returns null after delete", async () => {
    const sessionId = "s-2";
    await storeSessionEbs(sessionId, { segments: [] } as never);
    await deleteSessionEbs(sessionId);
    await expect(getSessionEbs(sessionId)).resolves.toBeNull();
  });
});

