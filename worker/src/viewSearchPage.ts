// /view/search (PLAN.md 17.38) — the full text of a grounded answer, the
// pages it drew on, and Google's Search Suggestions widget.
//
// This page is why web search is shaped the way it is. Grounding with
// Google Search requires that a grounded answer be displayed together with
// the Search Suggestions returned alongside it, and those come back as HTML
// and CSS — which a LINE text message cannot render. So the chat gets a
// short preview plus a link, and the answer proper lives here, on a surface
// that can actually meet the requirement. Opening it doesn't take anyone out
// of LINE: links tapped in a chat open in LINE's own in-app browser, the
// same as every other /view page already does.
//
// Unlike every other page in this family, this one deliberately does NOT go
// through resolveViewSession. That helper's job is to trade the token for a
// fresh Google access token, and there is no Google data on this page —
// only a stored answer. Calling it would spend a token-refresh subrequest on
// something nothing here reads. The token is still verified, just directly.

import type { Env } from "./index.ts";
import { verifyViewToken } from "./signedState.ts";
import { escapeHtml, html, pageShell, renderErrorPage, TOKEN_INVALID_MESSAGE } from "./viewAuth.ts";
import { getSearchResult, type StoredSearchResult } from "./webSearch.ts";

const RESULT_GONE_MESSAGE =
  'ผลการค้นหานี้หมดอายุแล้ว (เก็บไว้ 1 ชั่วโมง) ลองถามคำถามเดิมในแชทอีกครั้งเพื่อค้นใหม่นะ';

/** Plain text with blank-line paragraph breaks — the shape Gemini answers
 * in — turned into escaped paragraphs. Escaped, unlike the Search
 * Suggestions block below, because this is model-generated text built partly
 * from web pages: exactly the sort of content that must never be able to
 * introduce markup of its own. */
function renderAnswerHtml(answer: string): string {
  return answer
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

function renderSourcesHtml(result: StoredSearchResult): string {
  if (result.sources.length === 0) return "";
  const items = result.sources
    .map(
      (source) =>
        `<li><a href="${escapeHtml(source.uri)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
          source.title || source.uri
        )}</a></li>`
    )
    .join("");
  return `<div class="card"><h2>แหล่งอ้างอิง</h2><ol class="source-list">${items}</ol></div>`;
}

/**
 * Google's Search Suggestions widget, injected verbatim.
 *
 * This is the one place in this codebase where a string reaches the page
 * without going through escapeHtml, so the reasoning needs to be explicit
 * rather than assumed. `renderedContent` is pre-built HTML+CSS that the
 * Gemini API returns for exactly this purpose — displaying it as given is
 * the requirement, and escaping it would render the markup as visible text,
 * satisfying nothing. It is not user input and never passes through a user:
 * it arrives over TLS in the same API response whose answer text this page
 * is already trusting, and is stored and read back untouched. Anything able
 * to tamper with it could equally have tampered with the answer itself.
 */
function renderSearchSuggestionsHtml(result: StoredSearchResult): string {
  if (!result.searchEntryPointHtml) return "";
  return `<div class="card search-suggestions">${result.searchEntryPointHtml}</div>`;
}

function renderSearchPage(result: StoredSearchResult): string {
  return pageShell(
    "ผลการค้นหา",
    `<h1>ผลการค้นหา</h1>
<p class="subtitle">${escapeHtml(result.question)}</p>
<div class="card search-answer">${renderAnswerHtml(result.answer)}</div>
${renderSourcesHtml(result)}
${renderSearchSuggestionsHtml(result)}
<p class="footnote">คำตอบนี้สรุปจากผลการค้นหาเว็บด้วย AI — กดดูแหล่งอ้างอิงข้างบนเพื่อตรวจสอบได้เสมอ</p>`
  );
}

export async function handleViewSearchRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  const token = url.searchParams.get("token");
  if (!token) return html(renderErrorPage("เปิดหน้านี้ไม่ได้", TOKEN_INVALID_MESSAGE), 400);
  const subjectId = await verifyViewToken(token, env.STATE_SIGNING_SECRET);
  if (!subjectId) return html(renderErrorPage("เปิดหน้านี้ไม่ได้", TOKEN_INVALID_MESSAGE), 400);

  const id = url.searchParams.get("id");
  if (!id) return html(renderErrorPage("ไม่พบผลการค้นหา", RESULT_GONE_MESSAGE), 404);

  try {
    // Read through the token's own subject, so an id only ever resolves for
    // the account that produced it — see webSearch.ts's key comment.
    const result = await getSearchResult(env.ACCOUNTS, subjectId, id);
    if (!result) return html(renderErrorPage("ไม่พบผลการค้นหา", RESULT_GONE_MESSAGE), 404);
    return html(renderSearchPage(result));
  } catch (err) {
    console.error("handleViewSearchRequest: loading the stored search result failed", err);
    return html(renderErrorPage("เปิดผลการค้นหาไม่ได้", RESULT_GONE_MESSAGE), 502);
  }
}
