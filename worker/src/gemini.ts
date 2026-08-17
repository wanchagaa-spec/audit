// Thin wrapper around Google's Gemini API (generateContent) — the one place
// in this codebase that calls an external AI model. See PLAN.md 15.10 for why
// this exists and, more importantly, what it's deliberately NOT allowed to
// do: compute money. Every number in the prompt this file sends is computed
// by ordinary rule-based code first (same functions commands.ts uses for its
// own summaries) — Gemini only ever narrates numbers it's handed, it never
// sums a column itself, so a wrong total is structurally impossible here,
// not just unlikely.
//
// Default model: gemini-3.5-flash-lite. The 2.5 series (originally used
// here) got blocked for newly created API keys ahead of its official
// shutdown — Google returns a 404 "no longer available to new users" for
// every request from a fresh key, which is exactly the failure a real key
// hit right after this feature shipped. 3.5-flash-lite is the current
// free-tier-eligible, low-cost replacement Google points migrators to, and
// it serves the interpreter, the persona pass, the news summaries and the
// diary reflection perfectly well.
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";

// The one exception (PLAN.md 17.41). Grounded search runs on the full Flash
// model because Lite appears not to serve the google_search tool at all: the
// grounded call started failing in production the moment it shipped, while
// every other call — same key, same endpoint, no tools — kept working. Only
// this one call pays the difference; everything above stays on Lite, which
// is cheaper, faster, and was never the problem.
export const SEARCH_MODEL = "gemini-3.5-flash";

function endpointFor(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

/**
 * `status` is set only when the API answered with an HTTP error — i.e. it
 * refused the request as sent. It stays undefined for the failures where the
 * call was served and the *response* was unusable (cut off at the token
 * ceiling, empty, stopped for safety).
 *
 * The distinction matters to exactly one caller: aiCommands.ts retries
 * without the Google Search tool when the API rejects a request carrying it,
 * and must not do that when the request was fine and the answer simply came
 * back truncated.
 */
export class GeminiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
    groundingMetadata?: {
      searchEntryPoint?: { renderedContent?: string };
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      webSearchQueries?: string[];
    };
  }>;
}

/** One web page the grounded answer actually drew on. */
export interface GroundingSource {
  uri: string;
  title: string;
}

/**
 * Present only when the model actually ran a search for this request — the
 * `google_search` tool is a tool the model chooses to invoke, not a mode, so
 * a question it could answer from the data already in the prompt comes back
 * with no grounding at all (and, per Google's pricing, costs nothing extra).
 * Callers use exactly that to tell "answered from the user's own data" apart
 * from "answered from the web", which is the distinction that decides
 * whether a reply needs the /view/search page (see webSearch.ts).
 */
export interface GroundingInfo {
  /**
   * Google's own pre-rendered "Search Suggestions" widget: HTML + CSS that
   * Grounding with Google Search *requires* be displayed alongside any
   * grounded answer. It cannot be shown in a LINE text message, which is the
   * entire reason grounded answers get a web page instead of just a chat
   * reply (PLAN.md 17.38). Rendered verbatim, not escaped — see
   * viewSearchPage.ts, which is where that decision is documented.
   */
  searchEntryPointHtml: string | null;
  sources: GroundingSource[];
  queries: string[];
}

export interface GeminiResult {
  text: string;
  grounding: GroundingInfo | null;
}

function parseGrounding(candidate: NonNullable<GeminiResponse["candidates"]>[number]): GroundingInfo | null {
  const metadata = candidate.groundingMetadata;
  if (!metadata) return null;
  const sources: GroundingSource[] = (metadata.groundingChunks ?? [])
    .map((chunk) => ({ uri: chunk.web?.uri ?? "", title: chunk.web?.title ?? "" }))
    .filter((s) => s.uri !== "");
  const searchEntryPointHtml = metadata.searchEntryPoint?.renderedContent ?? null;
  const queries = (metadata.webSearchQueries ?? []).filter((q) => typeof q === "string" && q.trim() !== "");
  // Metadata with nothing usable in it is the same as no grounding — the
  // model didn't actually reach the web for this answer.
  if (!searchEntryPointHtml && sources.length === 0 && queries.length === 0) return null;
  return { searchEntryPointHtml, sources, queries };
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
// - SEARCH is the grounded AI Q&A call (PLAN.md 17.38). An answer built from
//   live web results carries more than one built from the user's own rows —
//   the summary itself plus whatever the model quotes from its sources — and
//   unlike the callers above there's no fixed input whose length bounds it.
export const INTERPRETER_MAX_OUTPUT_TOKENS = 800;
export const PERSONA_MAX_OUTPUT_TOKENS = 2000;
export const ANSWER_MAX_OUTPUT_TOKENS = 1200;
export const SEARCH_MAX_OUTPUT_TOKENS = 2000;

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
  // Hands the model the Google Search tool (PLAN.md 17.38). A tool, not a
  // mode: the model decides per request whether the prompt already contains
  // what it needs or whether it has to go and look, which is exactly the
  // "search only when there's no data to answer from" behaviour this feature
  // wanted — and why it's safe to leave switched on for every question,
  // since Gemini bills per search actually executed, not per request that
  // merely offered the tool. Never combined with jsonMode: the only JSON
  // caller is the interpreter, which has nothing to look up.
  googleSearch?: boolean;
  // Defaults to DEFAULT_MODEL. Only the grounded search call overrides it —
  // see SEARCH_MODEL above for why that one call needs a different model.
  model?: string;
}

/** Text only, for the callers that neither offer the search tool nor care
 * about grounding metadata — every caller that predates PLAN.md 17.38. */
export async function askGemini(
  apiKey: string,
  systemInstruction: string,
  userQuestion: string,
  options: AskGeminiOptions = {}
): Promise<string> {
  return (await callGemini(apiKey, systemInstruction, userQuestion, options)).text;
}

/** Same call with the Google Search tool offered, returning the grounding
 * metadata alongside the text. `grounding` is null when the model answered
 * without searching. */
export async function askGeminiWithSearch(
  apiKey: string,
  systemInstruction: string,
  userQuestion: string,
  options: Omit<AskGeminiOptions, "googleSearch" | "jsonMode"> = {}
): Promise<GeminiResult> {
  return callGemini(apiKey, systemInstruction, userQuestion, {
    model: SEARCH_MODEL,
    ...options,
    googleSearch: true,
  });
}

async function callGemini(
  apiKey: string,
  systemInstruction: string,
  userQuestion: string,
  options: AskGeminiOptions = {}
): Promise<GeminiResult> {
  const { signal, jsonMode, googleSearch, model = DEFAULT_MODEL, maxOutputTokens = INTERPRETER_MAX_OUTPUT_TOKENS } = options;
  const res = await fetch(endpointFor(model), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: userQuestion }] }],
      ...(googleSearch ? { tools: [{ google_search: {} }] } : {}),
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
    throw new GeminiError(`Gemini API error (${res.status}): ${await res.text()}`, res.status);
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
  return { text: text.trim(), grounding: candidate ? parseGrounding(candidate) : null };
}
