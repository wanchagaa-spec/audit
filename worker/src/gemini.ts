// Thin wrapper around Google's Gemini API (generateContent) — the one place
// in this codebase that calls an external AI model. See PLAN.md 15.10 for why
// this exists and, more importantly, what it's deliberately NOT allowed to
// do: compute money. Every number in the prompt this file sends is computed
// by ordinary rule-based code first (same functions commands.ts uses for its
// own summaries) — Gemini only ever narrates numbers it's handed, it never
// sums a column itself, so a wrong total is structurally impossible here,
// not just unlikely.
//
// Model: gemini-3.5-flash-lite. The 2.5 series (originally used here) got
// blocked for newly created API keys ahead of its official shutdown —
// Google returns a 404 "no longer available to new users" for every request
// from a fresh key, which is exactly the failure a real key hit right after
// this feature shipped. 3.5-flash-lite is the current free-tier-eligible,
// low-cost replacement Google points migrators to. Swapping models later
// (Google's lineup moves fast) only means changing this one constant.
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export class GeminiError extends Error {}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
}

// One shared ceiling used to serve every call here, which meant it had to
// suit the longest one and the shortest one at once — so it fit neither.
// Thai is expensive to tokenize (roughly a token per one or two
// characters, far worse than English), which makes the difference between
// these callers matter more than the raw numbers suggest:
//
// - INTERPRETER emits a single small JSON object, never prose. The old
//   shared 800 was always generous here and stays as-is.
// - PERSONA is the demanding one: it doesn't answer a question, it
//   *rewrites an existing reply*, so its output is at least as long as its
//   input and usually a little longer once the character's emoji and
//   softeners go in. The longest replies the bot sends (a five-offer
//   flight search runs ~600 characters of mostly Thai) sat close enough to
//   800 that restyling them risked being cut off mid-link.
// - ANSWER covers the free-form prose callers (AI Q&A, the news summaries,
//   the diary reflection). Their own system instructions already ask for a
//   few short paragraphs, so this is headroom for that instruction being
//   loosely followed, not licence to ramble.
//
// Raising a ceiling doesn't cost anything by itself — output tokens are
// billed on what's actually generated, and a cap is not a reservation, so
// a short answer stays exactly as cheap as it was.
export const INTERPRETER_MAX_OUTPUT_TOKENS = 800;
export const PERSONA_MAX_OUTPUT_TOKENS = 2000;
export const ANSWER_MAX_OUTPUT_TOKENS = 1200;

export interface AskGeminiOptions {
  signal?: AbortSignal;
  // Set by aiInterpreter.ts: constrains Gemini to emit valid JSON syntax
  // (still no guarantee it matches *our* schema — validateIntent there
  // checks that separately, the same "verify, don't just trust" pattern as
  // every other AI-touching file in this codebase).
  jsonMode?: boolean;
  // Every caller passes its own — see the constants above for why they
  // differ. The default only exists so the option stays optional; nothing
  // in this codebase relies on it.
  maxOutputTokens?: number;
}

export async function askGemini(
  apiKey: string,
  systemInstruction: string,
  userQuestion: string,
  options: AskGeminiOptions = {}
): Promise<string> {
  const { signal, jsonMode, maxOutputTokens = INTERPRETER_MAX_OUTPUT_TOKENS } = options;
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
      generationConfig: {
        maxOutputTokens,
        ...(jsonMode ? { responseMimeType: "application/json" } : {}),
      },
    }),
    signal,
  });
  if (!res.ok) {
    throw new GeminiError(`Gemini API error (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as GeminiResponse;
  const candidate = data.candidates?.[0];

  // A response cut off at maxOutputTokens still arrives as a perfectly
  // ordinary 200 with text in it — just text that stops mid-sentence, or
  // mid-URL. Reading only `parts` (as this used to) cannot tell that apart
  // from a complete answer, so a truncated reply went out looking finished:
  // an AI answer ending mid-thought, a restyled reply whose booking link
  // lost its tail. `finishReason` is what distinguishes them, so anything
  // other than a clean STOP is an error here — including SAFETY/RECITATION,
  // where a partial answer is equally not the answer. Every caller already
  // has a fallback for a failed Gemini call (persona sends the original text
  // unstyled, the interpreter drops to the deterministic matcher chain, AI
  // Q&A shows FALLBACK_MESSAGE), so this turns a silent corruption into the
  // degraded-but-honest path those fallbacks were written for.
  //
  // Only checked when the field is actually present: it always is on a real
  // completed candidate, and not requiring it keeps this from tripping over
  // a response shape that merely omits it.
  if (candidate?.finishReason && candidate.finishReason !== "STOP") {
    throw new GeminiError(`Gemini stopped early (finishReason: ${candidate.finishReason})`);
  }

  const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!text.trim()) {
    throw new GeminiError("Gemini returned an empty response");
  }
  return text.trim();
}
