import { NextResponse } from "next/server";

const DEFAULT_EBS_PROCESSOR_URL = "http://127.0.0.1:8787/api/process";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

function getProbeUrl(upstreamUrl: string) {
  const url = new URL(upstreamUrl);
  url.pathname = "/ebs_viewer.html";
  url.search = "";
  return url.toString();
}

async function isProcessorReachable(upstreamUrl: string) {
  try {
    const response = await fetch(getProbeUrl(upstreamUrl), {
      method: "HEAD",
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const upstreamUrl = process.env.EBS_PROCESSOR_URL ?? DEFAULT_EBS_PROCESSOR_URL;

  try {
    const formData = await request.formData();
    const refVideo = formData.get("ref_video");
    const userVideo = formData.get("user_video");

    if (!(refVideo instanceof File) || !(userVideo instanceof File)) {
      return NextResponse.json(
        { error: "Both ref_video and user_video are required." },
        { status: 400 },
      );
    }

    const upstreamFormData = new FormData();
    upstreamFormData.append("ref_video", refVideo, refVideo.name);
    upstreamFormData.append("user_video", userVideo, userVideo.name);

    const response = await fetch(upstreamUrl, {
      method: "POST",
      body: upstreamFormData,
      cache: "no-store",
    });

    const contentType = response.headers.get("content-type") ?? "application/json";
    const bodyText = await response.text();

    return new Response(bodyText, {
      status: response.status,
      headers: {
        "Content-Type": contentType,
      },
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "";
    const reachable = await isProcessorReachable(upstreamUrl);
    const message = reachable
      ? "The EBS processor is running, but this request did not complete cleanly. Keep the analysis tab active, avoid laptop sleep, then retry once."
      : `Failed to reach the EBS processor at ${upstreamUrl}. Start the local Python service with: cd "A2/pipelines/Audio data processing" && python3 ebs_server.py`;

    return NextResponse.json(
      {
        error: message,
        processorUrl: upstreamUrl,
        processorReachable: reachable,
        detail: rawMessage || undefined,
      },
      { status: 502 },
    );
  }
}

