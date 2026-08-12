// Thin wrapper around Google's Gemini API (generateContent) — the one place
// in this codebase that calls an external AI model. See PLAN.md 15.10 for why
// this exists and, more importantly, what it's deliberately NOT allowed to
// do: compute money. Every number in the prompt this file sends is computed
// by ordinary rule-based code first (same functions commands.ts uses for its
// own summaries) — Gemini only ever narrates numbers it's handed, it never
// sums a column itself, so a wrong total is structurally impossible here,
// not just unlikely.
//
// Model: gemini-2.5-flash-lite — of the three models on Gemini's free tier
// (flash-lite, flash, pro), it has the most generous daily quota, which
// matters more than raw quality for a single-user chat bot's Q&A feature.
// Swapping models later only means changing this one constant.
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export class GeminiError extends Error {}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

export async function askGemini(
  apiKey: string,
  systemInstruction: string,
  userQuestion: string
): Promise<string> {
  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: userQuestion }] }],
      // Keeps replies within LINE's comfortable message length without
      // relying on the model to police its own length.
      generationConfig: { maxOutputTokens: 800 },
    }),
  });
  if (!res.ok) {
    throw new GeminiError(`Gemini API error (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as GeminiResponse;
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!text.trim()) {
    throw new GeminiError("Gemini returned an empty response");
  }
  return text.trim();
}
