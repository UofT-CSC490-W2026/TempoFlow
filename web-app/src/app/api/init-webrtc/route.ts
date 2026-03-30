import { NextResponse } from 'next/server';

/**
 * WebRTC proxy for Roboflow Video Streaming API.
 *
 * When the frontend uses connectors.withProxyUrl('/api/init-webrtc'), the
 * @roboflow/inference-sdk posts { offer, wrtcParams } here.  We call
 * InferenceHTTPClient.initializeWebrtcWorker() with the real API key and
 * server-side workspace/workflow IDs so nothing sensitive is exposed to the
 * browser.
 *
 * Docs: https://docs.roboflow.com/deploy/serverless-video-streaming-api
 */
export async function POST(request: Request) {
  try {
    const apiKey        = process.env.ROBOFLOW_API_KEY?.trim();
    const workspaceName = (process.env.ROBOFLOW_WORKSPACE_NAME ?? '').trim();
    const workflowId    = (process.env.ROBOFLOW_WORKFLOW_ID ?? '').trim();

    if (!apiKey) {
      return NextResponse.json(
        { error: 'ROBOFLOW_API_KEY is not set. Add it to .env.local.' },
        { status: 400 },
      );
    }
    if (!workspaceName || !workflowId) {
      return NextResponse.json(
        { error: 'ROBOFLOW_WORKSPACE_NAME and ROBOFLOW_WORKFLOW_ID must be set in .env.local.' },
        { status: 400 },
      );
    }

    const body = (await request.json()) as {
      offer?: { sdp: string; type: string };
      wrtcParams?: {
        streamOutputNames?: string[];
        dataOutputNames?: string[];
        realtimeProcessing?: boolean;
        [key: string]: unknown;
      };
    };

    if (!body.offer?.sdp || !body.offer?.type) {
      return NextResponse.json({ error: 'Missing or invalid WebRTC offer (need sdp + type).' }, { status: 400 });
    }

    // Use the official SDK client so we hit the correct Roboflow endpoint
    const { InferenceHTTPClient } = await import('@roboflow/inference-sdk');
    const client = InferenceHTTPClient.init({
      apiKey,
      serverUrl: 'https://serverless.roboflow.com',
    });

    const answer = await client.initializeWebrtcWorker({
      offer: body.offer,
      workspaceName,
      workflowId,
      config: {
        streamOutputNames: body.wrtcParams?.streamOutputNames ?? [],
        dataOutputNames:   body.wrtcParams?.dataOutputNames   ?? ['label_visualization'],
        workflowsParameters: {
          className: process.env.SAM3_PROMPT?.trim() ?? 'person',
        },
        requestedPlan:      process.env.ROBOFLOW_WEBRTC_PLAN?.trim()   ?? 'webrtc-gpu-large',
        requestedRegion:    process.env.ROBOFLOW_WEBRTC_REGION?.trim() ?? 'us',
        realtimeProcessing: body.wrtcParams?.realtimeProcessing ?? false,
      },
    });

    return NextResponse.json(answer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[init-webrtc] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
