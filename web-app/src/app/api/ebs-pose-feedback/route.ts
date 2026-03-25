import { NextResponse } from "next/server";

import {
  buildFallbackPerFrameOutputs,
  type PerFrameCoachPayload,
  type PerFrameLlmOutput,
} from "../../../lib/ebsTemporalLlm";

function buildPerFramePrompt(payload: PerFrameCoachPayload): string {
  return [
    "You are a professional dance and movement coach. Output is concise, precise, studio language—no filler.",
    "Each item in `frames` is one sampled instant (aligned reference vs practice). Fields include prev / curr / next joint states and motion into/out of the current pose.",
    "For EVERY frame, produce:",
    "- microTimingOff: copy the boolean from input (you may set true only if the motion context clearly contradicts false).",
    "- attackDecay: one or two short sentences on onset sharpness, clean stops, and controlled release at THIS instant vs the reference. Do NOT mention degrees or joint angle numbers.",
    "- transitionToNext: one short sentence on how the dancer should move from THIS pose toward the NEXT sampled pose, informed by reference vs practice prev→curr→next and the motion.refOut / motion.userOut contrast.",
    "If this is the last frame, transitionToNext should describe finishing or the decay into the end of the phrase.",
    'Return strict JSON only: {"frames":[{"frameIndex":number,"microTimingOff":boolean,"attackDecay":string,"transitionToNext":string},...]}',
    "The output `frames` array MUST have the same length and frameIndex values as input `frames`.",
    "",
    JSON.stringify(payload),
  ].join("\n");
}

function normalizeLlmJson(text: string): string {
  const t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(t);
  if (fence) return fence[1].trim();
  return t;
}

function mergePerFrameWithFallback(
  parsed: PerFrameLlmOutput[] | undefined,
  payload: PerFrameCoachPayload,
  fallback: PerFrameLlmOutput[],
): PerFrameLlmOutput[] {
  const byIndex = new Map<number, PerFrameLlmOutput>();
  if (Array.isArray(parsed)) {
    for (const row of parsed) {
      if (
        typeof row.frameIndex !== "number" ||
        typeof row.attackDecay !== "string" ||
        typeof row.transitionToNext !== "string"
      ) {
        continue;
      }
      const micro =
        typeof row.microTimingOff === "boolean"
          ? row.microTimingOff
          : payload.frames.find((x) => x.frameIndex === row.frameIndex)?.microTimingOff ?? false;
      byIndex.set(row.frameIndex, {
        frameIndex: row.frameIndex,
        microTimingOff: micro,
        attackDecay: row.attackDecay.trim(),
        transitionToNext: row.transitionToNext.trim(),
      });
    }
  }
  return payload.frames.map((f, i) => {
    const got = byIndex.get(f.frameIndex);
    if (got) return got;
    return fallback[i] ?? fallback[0];
  });
}

function tryParsePerFrameResponse(
  raw: string,
  payload: PerFrameCoachPayload,
  fallback: PerFrameLlmOutput[],
): PerFrameLlmOutput[] {
  try {
    const normalized = normalizeLlmJson(raw);
    const parsed = JSON.parse(normalized) as { frames?: PerFrameLlmOutput[] };
    return mergePerFrameWithFallback(parsed.frames, payload, fallback);
  } catch {
    return fallback;
  }
}

async function callGroq(prompt: string): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const model = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.35,
      max_tokens: 8192,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("ebs-pose-feedback Groq request failed:", errorText);
    return null;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : null;
}

async function callOpenAIChat(prompt: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.35,
      max_tokens: 8192,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("ebs-pose-feedback OpenAI chat failed:", errorText);
    return null;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : null;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { perFramePayload?: PerFrameCoachPayload };
    const perFramePayload = body.perFramePayload;

    if (!perFramePayload?.frames?.length) {
      return NextResponse.json({ error: "Missing perFramePayload.frames." }, { status: 400 });
    }

    const fallback = buildFallbackPerFrameOutputs(perFramePayload);
    const prompt = buildPerFramePrompt(perFramePayload);

    const hasGroq = Boolean(process.env.GROQ_API_KEY);
    const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);

    if (!hasGroq && !hasOpenAI) {
      return NextResponse.json({ frames: fallback, source: "local-fallback" });
    }

    let raw: string | null = null;
    let source: "groq" | "openai" | "local-fallback" = "local-fallback";

    if (hasGroq) {
      raw = await callGroq(prompt);
      if (raw) source = "groq";
    }

    if (!raw && hasOpenAI) {
      raw = await callOpenAIChat(prompt);
      if (raw) source = "openai";
    }

    if (!raw) {
      return NextResponse.json({ frames: fallback, source: "local-fallback" });
    }

    const merged = tryParsePerFrameResponse(raw, perFramePayload, fallback);
    return NextResponse.json({ frames: merged, source });
  } catch (error) {
    console.error("ebs-pose-feedback route failed:", error);
    return NextResponse.json({ error: "Failed to generate coaching text." }, { status: 500 });
  }
}
