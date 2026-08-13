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
export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
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

export type ViewNavKey = "accounts" | "calendar" | "diary" | "trips";

const NAV_ITEMS: Array<{ key: ViewNavKey; path: string; label: string }> = [
  { key: "accounts", path: "/view", label: "บัญชี" },
  { key: "calendar", path: "/view/calendar", label: "ปฏิทิน" },
  { key: "diary", path: "/view/diary", label: "ไดอารี่" },
  { key: "trips", path: "/view/trips", label: "รูปทริป" },
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
