import { NextResponse } from 'next/server';

type RoboflowSam3Polygon = number[][];

interface RoboflowSam3Response {
  prompt_results?: Array<{
    echo?: { text?: string };
    predictions?: Array<{
      confidence?: number;
      masks?: RoboflowSam3Polygon[];
    }>;
  }>;
  time?: number;
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.ROBOFLOW_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Missing ROBOFLOW_API_KEY. Add it to enable Roboflow SAM 3 serverless.' },
        { status: 400 },
      );
    }

    const body = (await request.json()) as {
      imageBase64?: string;
      prompt?: string;
      outputProbThresh?: number;
    };

    const imageBase64 = body.imageBase64?.trim();
    if (!imageBase64) {
      return NextResponse.json({ error: 'Missing imageBase64.' }, { status: 400 });
    }

    const prompt = (body.prompt?.trim() || process.env.SAM3_PROMPT?.trim() || 'person').slice(0, 80);
    const outputProbThresh = typeof body.outputProbThresh === 'number' ? body.outputProbThresh : 0.5;

    const response = await fetch(`https://serverless.roboflow.com/sam3/concept_segment?api_key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: 'polygon',
        output_prob_thresh: outputProbThresh,
        image: { type: 'base64', value: imageBase64 },
        prompts: [{ text: prompt }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return NextResponse.json(
        { error: text || 'Roboflow SAM 3 request failed.' },
        { status: response.status },
      );
    }

    const data = (await response.json()) as RoboflowSam3Response;
    const polygons =
      data.prompt_results?.[0]?.predictions?.flatMap((prediction) => prediction.masks ?? []) ?? [];

    return NextResponse.json({
      provider: 'roboflow',
      prompt,
      polygons,
      time: data.time ?? null,
    });
  } catch (error) {
    console.error('Roboflow SAM 3 frame route failed:', error);
    return NextResponse.json({ error: 'Failed to run Roboflow SAM 3 segmentation.' }, { status: 500 });
  }
}

