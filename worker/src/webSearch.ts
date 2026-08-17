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

/**
 * The chat reply for a grounded answer: the link, and nothing of the answer
 * itself.
 *
 * An earlier version led with a short preview of the answer. Chosen against
 * (by the user, and it's the better call on the merits too): a preview *is*
 * grounded output, and showing grounded output without the Search
 * Suggestions that came with it is exactly what Grounding with Google Search
 * doesn't allow. Keeping every word of the answer on the one surface that
 * can display the widget makes the rule easy to hold rather than something
 * to reason about case by case — and it removes the question of what a
 * half-shown answer does to a reader who never taps through.
 *
 * Nothing here is derived from the model's output, so there is nothing to
 * verify: the URL is built from an id this codebase generated.
 */
export function buildSearchChatReply(pageUrl: string): string {
  return [
    "🔎 ค้นหาให้แล้ว กดดูคำตอบพร้อมแหล่งอ้างอิงได้เลย (ลิงก์ใช้ได้ 1 ชั่วโมง):",
    pageUrl,
  ].join("\n");
}
