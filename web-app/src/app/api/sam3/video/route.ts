import { NextResponse } from 'next/server';

type VideoKind = 'reference' | 'practice';
const DEFAULT_MAX_VIDEO_MB = 40;

function getPrompt(kind: VideoKind) {
  const basePrompt = process.env.SAM3_PROMPT?.trim() || 'person';
  const kindPrompt = kind === 'reference'
    ? process.env.SAM3_REFERENCE_PROMPT?.trim()
    : process.env.SAM3_PRACTICE_PROMPT?.trim();

  return kindPrompt || basePrompt;
}

function getMaxVideoBytes() {
  const value = Number.parseInt(process.env.SAM3_MAX_VIDEO_MB ?? `${DEFAULT_MAX_VIDEO_MB}`, 10);
  const maxMb = Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_VIDEO_MB;
  return maxMb * 1024 * 1024;
}

export async function POST(request: Request) {
  try {
    const backend = process.env.SAM3_BACKEND?.trim() || 'roboflow';
    if (backend !== 'modal') {
      return NextResponse.json(
        { error: 'TempoFlow is currently configured for Roboflow SAM 3 frame overlay. Use /api/sam3/frame.' },
        { status: 400 },
      );
    }

    const formData = await request.formData();
    const video = formData.get('video');
    const kind = (formData.get('kind') as VideoKind | null) ?? 'reference';

    if (!(video instanceof File)) {
      return NextResponse.json({ error: 'Missing video file.' }, { status: 400 });
    }

    if (video.size > getMaxVideoBytes()) {
      return NextResponse.json(
        {
          error: `This clip is too large for fast SAM 3 mode. Keep it under ${
            process.env.SAM3_MAX_VIDEO_MB ?? DEFAULT_MAX_VIDEO_MB
          } MB.`,
        },
        { status: 400 },
      );
    }

    const modalUrl = process.env.SAM3_MODAL_URL?.trim();
    if (!modalUrl) {
      return NextResponse.json(
        { error: 'Missing SAM3_MODAL_URL. Deploy the Modal service and add its URL.' },
        { status: 400 },
      );
    }

    const prompt = getPrompt(kind);
    const modalForm = new FormData();
    modalForm.append('video', video);
    modalForm.append('prompt', prompt);
    modalForm.append('alpha', process.env.SAM3_MODAL_ALPHA?.trim() || '0.52');

    const response = await fetch(`${modalUrl.replace(/\/$/, '')}/segment-video`, {
      method: 'POST',
      headers: process.env.SAM3_MODAL_TOKEN?.trim()
        ? {
            Authorization: `Bearer ${process.env.SAM3_MODAL_TOKEN.trim()}`,
          }
        : undefined,
      body: modalForm,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: errorText || 'Modal SAM 3 service failed to generate a segmented video.' },
        { status: response.status === 401 ? 502 : response.status },
      );
    }

    const outputBytes = await response.arrayBuffer();
    if (outputBytes.byteLength === 0) {
      return NextResponse.json({ error: 'Modal SAM 3 returned an empty video response.' }, { status: 502 });
    }

    return new Response(outputBytes, {
      status: 200,
      headers: {
        'Content-Type': response.headers.get('content-type') || 'video/mp4',
        'Cache-Control': 'no-store',
        'X-SAM3-Provider': response.headers.get('x-sam3-provider') || 'modal',
        'X-SAM3-Prompt': response.headers.get('x-sam3-prompt') || prompt,
        'X-SAM3-Model': response.headers.get('x-sam3-model') || 'facebook/sam3',
      },
    });
  } catch (error) {
    console.error('SAM 3 video route failed:', error);
    return NextResponse.json({ error: 'Failed to generate SAM 3 video overlay.' }, { status: 500 });
  }
}
