import { NextResponse } from "next/server";

/**
 * POST /api/live-coach/session
 *
 * Returns the WebSocket URL for the Live Coach proxy on the A5 API (not the
 * Gemini API key). The browser opens a normal WebSocket to A5; A5 forwards
 * traffic to Google with GEMINI_API_KEY from its environment.
 *
 * Response shape:
 * - { wsUrl, model } when the processor URL is absolute (e.g. local dev).
 * - { wsPath, model } when using same-origin rewrites (NEXT_PUBLIC_EBS_PROXY);
 *   the client resolves wsPath against window.location with ws/wss.
 */
export async function POST() {
  const model =
    process.env.GEMINI_LIVE_MODEL ?? "models/gemini-3.1-flash-live-preview";

  const explicitWs = process.env.NEXT_PUBLIC_LIVE_COACH_WS_URL?.trim();
  if (explicitWs) {
    return NextResponse.json({ wsUrl: explicitWs, model });
  }

  const processorUrl =
    process.env.NEXT_PUBLIC_EBS_PROCESSOR_URL?.trim() ||
    (process.env.NEXT_PUBLIC_EBS_PROXY === "1"
      ? "/api/ebs-backend/api/process"
      : "http://127.0.0.1:8787/api/process");

  const wsSuffix = "/api/live-coach/ws";

  if (processorUrl.startsWith("/")) {
    const path = processorUrl.replace(/\/api\/process\/?$/, wsSuffix);
    return NextResponse.json({ wsPath: path, model });
  }

  try {
    const u = new URL(processorUrl);
    const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProto}//${u.host}${wsSuffix}`;
    return NextResponse.json({ wsUrl, model });
  } catch {
    return NextResponse.json(
      {
        error:
          "Invalid NEXT_PUBLIC_EBS_PROCESSOR_URL. Set NEXT_PUBLIC_LIVE_COACH_WS_URL to your A5 WebSocket URL (ws:// or wss://).",
      },
      { status: 500 },
    );
  }
}
