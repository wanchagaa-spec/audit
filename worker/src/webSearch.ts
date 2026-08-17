// Web search (PLAN.md 17.38) — the plumbing between a grounded Gemini
// answer and the two places it gets shown: a short reply in the chat, and
// the /view/search page that carries the full answer, its sources, and
// Google's required Search Suggestions widget (viewSearchPage.ts).
//
// Why an answer needs a page at all: Grounding with Google Search obliges
// whoever displays a grounded answer to display the Search Suggestions that
// come back with it, and those arrive as HTML + CSS. A LINE text message
// can't render that. Everything else in this file exists to make the
// two-surface split work — the chat keeps the immediacy, the page carries
// what the chat physically cannot.
//
// Nothing here decides *whether* to search. That's the model's call, taken
// per question via the google_search tool (see gemini.ts), and this module
// only ever runs when it did.

import type { GroundingSource } from "./gemini.ts";

// Matched to the view token's own hour-long lifetime (MAX_VIEW_TOKEN_AGE_MS
// in signedState.ts) rather than picked independently: the link carries a
// view token, so it stops working at the one-hour mark no matter how long
// the stored result outlives it. Storing past that point would only keep
// unreachable rows around.
const SEARCH_RESULT_TTL_SECONDS = 60 * 60;

export interface StoredSearchResult {
  question: string;
  answer: string;
  sources: GroundingSource[];
  searchEntryPointHtml: string | null;
  createdAtIso: string;
}

// Scoped by subject, not just by id: /view/search resolves the subject from
// the signed token in the URL and reads through this same key, so one
// account's result id is meaningless against another's token — guessing an
// id gets you nothing without also holding a valid token for the account
// that produced it.
function searchResultKey(subjectId: string, id: string): string {
  return `search-result:${subjectId}:${id}`;
}

export async function saveSearchResult(
  kv: KVNamespace,
  subjectId: string,
  result: StoredSearchResult
): Promise<string> {
  const id = crypto.randomUUID();
  await kv.put(searchResultKey(subjectId, id), JSON.stringify(result), {
    expirationTtl: SEARCH_RESULT_TTL_SECONDS,
  });
  return id;
}

export async function getSearchResult(
  kv: KVNamespace,
  subjectId: string,
  id: string
): Promise<StoredSearchResult | null> {
  const raw = await kv.get(searchResultKey(subjectId, id));
  return raw ? (JSON.parse(raw) as StoredSearchResult) : null;
}

// Long enough for a real answer to a real question, short enough that the
// chat stays a chat. Anything past this lives on the page.
const CHAT_PREVIEW_MAX_CHARS = 300;

/** The part of a grounded answer that goes in the chat message. Takes the
 * first paragraph — the system instruction asks for a self-contained one —
 * and caps it, rather than trusting that instruction to have been followed.
 * Same verify-don't-trust habit as persona.ts's quoted-span and link checks:
 * a model told to be brief usually is, and this is what happens when it
 * isn't. */
export function buildAnswerPreview(answer: string): string {
  const firstParagraph = answer.split(/\n\s*\n/)[0].trim() || answer.trim();
  if (firstParagraph.length <= CHAT_PREVIEW_MAX_CHARS) return firstParagraph;
  // A hard cut, not a word-boundary one: Thai doesn't put spaces between
  // words, so there's no boundary to find for the text this mostly handles.
  // The ellipsis plus the link below it makes the truncation obvious rather
  // than something the reader has to notice.
  return `${firstParagraph.slice(0, CHAT_PREVIEW_MAX_CHARS).trimEnd()}…`;
}

/** The whole chat reply for a grounded answer: the preview, then the link to
 * the full thing. The link is not optional decoration — it is where the
 * sources and Google's Search Suggestions live, which is what makes showing
 * this answer permitted at all. */
export function buildSearchChatReply(answer: string, pageUrl: string): string {
  return [
    `🔎 ${buildAnswerPreview(answer)}`,
    "",
    `อ่านคำตอบเต็มๆ พร้อมแหล่งอ้างอิงที่นี่ (ลิงก์ใช้ได้ 1 ชั่วโมง):\n${pageUrl}`,
  ].join("\n");
}
