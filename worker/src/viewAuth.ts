// Shared plumbing for every /view/* page (PLAN.md 16): verifying the
// signed token, resolving it to a linked account's fresh Google access
// token, and the HTML page shell + nav all the pages render inside. Split
// out from viewPages.ts once calendar/diary/trips pages needed the exact
// same "verify token -> load account -> refresh access token, or show a
// friendly error" flow — this is that flow, written once.

import { groupIdFromSubject } from "./groupSubject.ts";
import { refreshAccessToken } from "./googleAuth.ts";
import type { Env } from "./index.ts";
import { verifyViewToken } from "./signedState.ts";
import { getAccountLink } from "./state.ts";

// Not imported from index.ts on purpose — index.ts imports handleViewRequest
// (and friends) from these view files, so importing index.ts's `html` helper
// back would make the modules circularly depend on each other at runtime
// (every other file that needs Env from index.ts only imports it as a type,
// which TypeScript erases and so never creates a real runtime cycle — this
// one-line helper is cheap enough to just duplicate instead).
//
// Every page rendered through here carries the session token in its own URL
// (see resolveViewSession) and shows one account's private data, so both
// extra headers are about that token and that data not travelling further
// than the tab they were opened in:
//   no-store       — keeps the rendered page (and the tokenised URL in it)
//                    out of any cache along the way, shared or local.
//   Referrer-Policy — a Referer header on anything the page reaches out to
//                    would carry ?token=... to that destination verbatim.
//                    Nothing on these pages links off-origin today; this is
//                    what keeps that true the first time something does.
export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/** decodeURIComponent throws on malformed percent-encoding (e.g. a lone
 * "%" or an invalid UTF-8 sequence) instead of returning something — used
 * for path segments taken straight from the URL (trip folder/photo ids),
 * where that input is untrusted and a bad link shouldn't crash the whole
 * request. */
export function decodeUrlSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type ViewNavKey = "accounts" | "budgets" | "calendar" | "diary" | "trips" | "shifts" | "tasks" | "settings";

const NAV_ITEMS: Array<{ key: ViewNavKey; path: string; label: string }> = [
  { key: "accounts", path: "/view", label: "บัญชี" },
  { key: "budgets", path: "/view/budgets", label: "งบ" },
  { key: "calendar", path: "/view/calendar", label: "ปฏิทิน" },
  { key: "diary", path: "/view/diary", label: "ไดอารี่" },
  { key: "trips", path: "/view/trips", label: "รูปทริป" },
  { key: "shifts", path: "/view/shifts", label: "ตารางเวร" },
  { key: "tasks", path: "/view/tasks", label: "สิ่งที่ต้องทำ" },
  { key: "settings", path: "/view/settings", label: "ตั้งค่า" },
];

function renderNav(token: string, active: ViewNavKey): string {
  return `<nav class="view-nav">${NAV_ITEMS.map(
    (item) =>
      `<a class="${item.key === active ? "active" : ""}" href="${item.path}?token=${encodeURIComponent(token)}">${escapeHtml(item.label)}</a>`
  ).join("")}</nav>`;
}

export function pageShell(title: string, bodyHtml: string, nav?: { token: string; active: ViewNavKey }): string {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0; padding: 1.25rem 1rem 3rem;
    max-width: 480px; margin-inline: auto;
    background: #f5f6f8; color: #1c1e21;
  }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
  .subtitle { color: #6b6f76; font-size: .85rem; margin: 0 0 1.25rem; }
  .view-nav { display: flex; gap: .4rem; margin-bottom: 1.1rem; overflow-x: auto; }
  .view-nav a {
    flex: none; padding: .45rem .9rem; border-radius: 999px; font-size: .82rem;
    text-decoration: none; color: #40444b; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.06);
  }
  .view-nav a.active { background: #16a34a; color: #fff; }
  .card { background: #fff; border-radius: 14px; padding: 1rem 1.1rem; margin-bottom: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .card h2 { font-size: .95rem; margin: 0 0 .75rem; color: #40444b; }
  .totals { display: flex; justify-content: space-between; gap: .5rem; }
  .totals div { flex: 1; text-align: center; }
  .totals .label { font-size: .75rem; color: #6b6f76; margin-bottom: .2rem; }
  .totals .amount { font-size: 1rem; font-weight: 600; }
  .income { color: #00875a; }
  .expense { color: #de350b; }
  .row { display: flex; justify-content: space-between; gap: .75rem; padding: .5rem 0; border-bottom: 1px solid #eee; font-size: .85rem; }
  .row:last-child { border-bottom: none; }
  .row .meta { color: #6b6f76; }
  .day-group { margin-bottom: 1rem; }
  .day-group h2 { font-size: .85rem; color: #16a34a; margin: 0 0 .5rem; }
  .diary-entry { padding: .5rem 0; border-bottom: 1px solid #eee; font-size: .9rem; }
  .diary-entry:last-child { border-bottom: none; }
  .diary-entry .category { color: #16a34a; font-weight: 600; font-size: .78rem; display: block; margin-bottom: .2rem; }
  .nav-links { display: flex; justify-content: space-between; margin: 1rem 0; font-size: .85rem; }
  .nav-links a { color: #16a34a; text-decoration: none; }
  .folder-list a {
    display: block; background: #fff; border-radius: 14px; padding: .9rem 1.1rem; margin-bottom: .7rem;
    text-decoration: none; color: #1c1e21; box-shadow: 0 1px 3px rgba(0,0,0,0.06); font-size: .95rem;
  }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: .6rem .4rem; }
  .grid a { display: block; aspect-ratio: 1; border-radius: 10px; overflow: hidden; background: #e5e7eb; }
  .grid img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .grid-caption { text-align: center; color: #9aa0a6; font-size: .68rem; margin-top: .25rem; }
  .empty { text-align: center; color: #6b6f76; padding: 1.5rem 0; font-size: .9rem; }
  .footnote { text-align: center; color: #9aa0a6; font-size: .75rem; margin-top: 1.5rem; }
  .footnote a { color: #16a34a; }
  .table-scroll { overflow-x: auto; }
  .data-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
  .data-table th, .data-table td { padding: .5rem .5rem; text-align: left; border-bottom: 1px solid #eee; white-space: nowrap; }
  .data-table th { color: #6b6f76; font-weight: 600; font-size: .72rem; text-transform: uppercase; letter-spacing: .02em; }
  .data-table tbody tr:last-child td { border-bottom: none; }
  .data-table td.note { white-space: normal; }
  .data-table td.num { text-align: right; font-weight: 600; }
  .search-form { display: flex; gap: .5rem; margin-bottom: 1.1rem; }
  .search-form input[type="text"] {
    flex: 1; min-width: 0; padding: .55rem .7rem; border-radius: 10px; border: 1px solid #d8dade;
    font-size: .9rem; font-family: inherit;
  }
  .search-form button {
    flex: none; padding: .55rem 1rem; border-radius: 10px; border: none; background: #16a34a;
    color: #fff; font-size: .85rem; font-family: inherit; cursor: pointer;
  }
  .shift-table th, .shift-table td { text-align: center; }
  .shift-table th:first-child, .shift-table td:first-child { text-align: left; white-space: nowrap; }
  .shift-table input[type="checkbox"] { width: 1.15rem; height: 1.15rem; }
  .save-button {
    display: block; width: 100%; margin-top: 1rem; padding: .65rem 1.2rem; border-radius: 10px; border: none;
    background: #16a34a; color: #fff; font-size: .92rem; font-family: inherit; font-weight: 600; cursor: pointer;
  }
  .save-notice { text-align: center; color: #16a34a; font-size: .85rem; margin: 0 0 1rem; }
  .diary-edit-form { margin-bottom: 0; }
  .diary-edit-row { display: flex; gap: .5rem; margin-bottom: .4rem; }
  .diary-edit-row input[type="date"] { flex: none; width: 9.5rem; }
  .diary-edit-row input[type="text"] { flex: 1; min-width: 0; }
  .diary-edit-form input, .diary-edit-form textarea {
    padding: .5rem .6rem; border-radius: 8px; border: 1px solid #d8dade; font-size: .85rem; font-family: inherit;
  }
  .diary-edit-form textarea { width: 100%; resize: vertical; margin-bottom: .5rem; }
  .diary-edit-actions { display: flex; gap: .5rem; }
  .diary-edit-actions button {
    flex: 1; padding: .5rem; border-radius: 8px; border: none; background: #16a34a; color: #fff;
    font-size: .82rem; font-family: inherit; cursor: pointer;
  }
  .diary-edit-actions a {
    flex: 1; text-align: center; padding: .5rem; border-radius: 8px; background: #fdecea; color: #de350b;
    text-decoration: none; font-size: .82rem;
  }
  .confirm-delete-text { background: #fff; border-radius: 10px; padding: .8rem 1rem; margin-bottom: 1rem; font-size: .88rem; }
  .confirm-actions { display: flex; gap: .6rem; }
  .confirm-actions button {
    flex: 1; background: #de350b; color: #fff; border: none; border-radius: 10px; padding: .6rem 1rem;
    font-size: .88rem; font-family: inherit; cursor: pointer;
  }
  .confirm-actions a {
    flex: 1; text-align: center; padding: .6rem 1rem; border-radius: 10px; background: #fff; color: #40444b;
    text-decoration: none; font-size: .88rem; box-shadow: 0 1px 2px rgba(0,0,0,0.06);
  }
  .search-answer p { margin: 0 0 .7rem; font-size: .92rem; line-height: 1.6; }
  .search-answer p:last-child { margin-bottom: 0; }
  .source-list { margin: 0; padding-left: 1.1rem; }
  .source-list li { margin-bottom: .45rem; font-size: .85rem; line-height: 1.45; }
  .source-list li:last-child { margin-bottom: 0; }
  .source-list a { color: #16a34a; word-break: break-word; }
  /* Google's Search Suggestions widget brings its own styling (see
     viewSearchPage.ts); this only gives it room and keeps it from forcing
     the page to scroll sideways on a phone. */
  .search-suggestions { overflow-x: auto; }
  .budget-table input[type="number"] {
    width: 6.5rem; padding: .45rem .5rem; border-radius: 8px; border: 1px solid #d8dade;
    font-size: .88rem; font-family: inherit; text-align: right;
  }
  .budget-table td { white-space: normal; vertical-align: middle; }
  .budget-spent { color: #6b6f76; font-size: .72rem; margin-top: .15rem; }
  .help-lead { font-size: .88rem; color: #40444b; margin: 0 0 1rem; line-height: 1.5; }
  .help-list { margin: 0; padding-left: 1.1rem; }
  .help-list li { margin-bottom: .5rem; font-size: .85rem; line-height: 1.55; }
  .help-list li:last-child { margin-bottom: 0; }
  .locale-switch { text-align: right; font-size: .78rem; margin: 0 0 .4rem; }
  .locale-switch a { color: #16a34a; text-decoration: none; }
  .legal-lead { font-size: .88rem; color: #40444b; line-height: 1.6; margin: 0 0 1.1rem; }
  .legal-p { font-size: .85rem; color: #40444b; line-height: 1.65; margin: 0 0 .7rem; }
  .legal-p:last-child { margin-bottom: 0; }
  .legal-list { margin: .2rem 0 0; padding-left: 1.1rem; }
  .legal-list li { font-size: .85rem; line-height: 1.6; margin-bottom: .5rem; }
  .legal-list li:last-child { margin-bottom: 0; }
  .legal-table td { white-space: normal; vertical-align: top; line-height: 1.55; }
  .legal-table td:first-child { font-weight: 600; }
  .field { display: block; margin-bottom: .9rem; }
  .field:last-child { margin-bottom: 0; }
  .field > span { display: block; font-size: .8rem; color: #40444b; font-weight: 600; margin-bottom: .3rem; }
  .field input[type="text"], .field textarea {
    width: 100%; padding: .55rem .7rem; border-radius: 10px; border: 1px solid #d8dade;
    font-size: .9rem; font-family: inherit; resize: vertical;
  }
  .check-field { display: flex; align-items: center; gap: .55rem; font-size: .88rem; }
  .check-field input[type="checkbox"] { width: 1.15rem; height: 1.15rem; flex: none; }
  .field-note { display: block; color: #6b6f76; font-size: .72rem; margin-top: .45rem; line-height: 1.5; }
  .field small { display: block; color: #6b6f76; font-size: .72rem; margin-top: .3rem; line-height: 1.45; }
  .danger-card { border: 1px solid #f6c9c0; }
  .danger-card h2 { color: #de350b; }
  .danger-text { font-size: .82rem; color: #40444b; line-height: 1.55; margin: 0 0 .8rem; }
  .danger-notice { text-align: center; color: #de350b; font-size: .85rem; margin: 0 0 1rem; }
  .danger-button {
    display: block; width: 100%; padding: .6rem 1rem; border-radius: 10px; border: none;
    background: #de350b; color: #fff; font-size: .88rem; font-family: inherit; font-weight: 600; cursor: pointer;
  }
  .danger-form { display: flex; flex-direction: column; gap: .5rem; }
  .danger-form input[type="text"] {
    width: 100%; padding: .55rem .7rem; border-radius: 10px; border: 1px solid #d8dade;
    font-size: 1.1rem; font-family: inherit; text-align: center; letter-spacing: .35em;
  }
  .danger-cancel button {
    width: 100%; margin-top: .5rem; padding: .5rem; border-radius: 10px; border: none;
    background: #fff; color: #40444b; font-size: .82rem; font-family: inherit; cursor: pointer;
    box-shadow: 0 1px 2px rgba(0,0,0,0.06);
  }
</style>
</head>
<body>
${nav ? renderNav(nav.token, nav.active) : ""}
${bodyHtml}
</body>
</html>`;
}

export function renderErrorPage(title: string, message: string): string {
  return pageShell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

export const TOKEN_INVALID_MESSAGE = 'ลิงก์หมดอายุหรือไม่ถูกต้อง กลับไปที่แชทแล้วพิมพ์ "เปิดเว็บดูข้อมูล" เพื่อขอลิงก์ใหม่';
export const DATA_FETCH_FAILED_MESSAGE = "ดึงข้อมูลไม่สำเร็จตอนนี้ ลองเปิดลิงก์ใหม่อีกครั้งสักครู่นะ";

// Practically unreachable (a view token only exists for a subject that was
// already linked when it was minted), but not impossible — a group could
// theoretically get unlinked in the narrow window before its token is
// used. Worded per mode since the fix is different: a group needs someone
// to @mention the bot, personal mode just needs any message at all.
function unlinkedMessage(isGroup: boolean): string {
  return isGroup
    ? "กลุ่มนี้ยังไม่ได้เชื่อมบัญชี Google เลย กลับไปที่กลุ่มแล้วแท็กบอทเพื่อเชื่อมบัญชีใหม่"
    : "ยังไม่ได้เชื่อมบัญชี Google เลย พิมพ์อะไรก็ได้หาบอทใน LINE ก่อนเพื่อเชื่อมบัญชี";
}

export interface ViewSession {
  lineUserId: string;
  accessToken: string;
  spreadsheetId: string;
  token: string;
}

/** Verifies the `token` query param and resolves it to a fresh Google
 * access token for the linked account, or an already-built error Response
 * if the token/account/refresh step fails — callers just need to check
 * `session instanceof Response` before using the rest. */
export async function resolveViewSession(request: Request, env: Env): Promise<ViewSession | Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return html(renderErrorPage("เปิดหน้านี้ไม่ได้", TOKEN_INVALID_MESSAGE), 400);

  const lineUserId = await verifyViewToken(token, env.STATE_SIGNING_SECRET);
  if (!lineUserId) return html(renderErrorPage("เปิดหน้านี้ไม่ได้", TOKEN_INVALID_MESSAGE), 400);

  const link = await getAccountLink(env.ACCOUNTS, lineUserId);
  if (!link) {
    return html(renderErrorPage("ยังไม่ได้เชื่อมบัญชี", unlinkedMessage(groupIdFromSubject(lineUserId) !== null)), 400);
  }

  try {
    const accessToken = await refreshAccessToken({
      refreshToken: link.refreshToken,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    });
    return { lineUserId, accessToken, spreadsheetId: link.spreadsheetId, token };
  } catch (err) {
    console.error("resolveViewSession: refreshing access token failed", err);
    return html(renderErrorPage("เข้าเว็บไม่ได้", DATA_FETCH_FAILED_MESSAGE), 502);
  }
}
