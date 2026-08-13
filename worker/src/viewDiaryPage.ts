// /view/diary (PLAN.md 16.3) — "สมุดโน้ต" notebook view: entries grouped
// by day, newest day first within the month, with prev/next month links
// (`?month=YYYY-MM`) instead of dumping the whole diary history into one
// page every time. Reuses readAllDiaryEntries (already existed for the
// chat "ไดอารี่เดือนนี้มีอะไรบ้าง" command and the AI Q&A data source).

import type { Env } from "./index.ts";
import { readAllDiaryEntries, type DiaryRow } from "./sheets.ts";
import { bangkokMonthKey } from "./thaiDate.ts";
import { DATA_FETCH_FAILED_MESSAGE, escapeHtml, html, pageShell, renderErrorPage, resolveViewSession } from "./viewAuth.ts";

const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;

function shiftMonthKey(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function groupByDate(rows: DiaryRow[]): Map<string, DiaryRow[]> {
  const groups = new Map<string, DiaryRow[]>();
  for (const r of rows) {
    const list = groups.get(r.date) ?? [];
    list.push(r);
    groups.set(r.date, list);
  }
  return groups;
}

// Reused above both the month view and the search-results view — a plain
// GET form (no client JS needed, matches every other /view page's
// server-rendered-only approach) that re-submits whatever was typed as
// `?q=`. `month` is carried along as a hidden field so clearing the search
// box returns to the month the reader was actually looking at, not always
// the current one.
function renderSearchForm(token: string, month: string, query: string): string {
  return `<form class="search-form" method="get" action="/view/diary">
    <input type="hidden" name="token" value="${escapeHtml(token)}" />
    <input type="hidden" name="month" value="${escapeHtml(month)}" />
    <input type="text" name="q" value="${escapeHtml(query)}" placeholder="ค้นหาไดอารี่..." />
    <button type="submit">ค้นหา</button>
  </form>`;
}

function renderDiaryPage(token: string, month: string, monthRows: DiaryRow[]): string {
  const nav = { token, active: "diary" as const };
  const prevMonth = shiftMonthKey(month, -1);
  const nextMonth = shiftMonthKey(month, 1);
  const searchForm = renderSearchForm(token, month, "");
  const navLinks = `<div class="nav-links">
    <a href="/view/diary?token=${encodeURIComponent(token)}&month=${prevMonth}">‹ เดือนก่อน</a>
    <a href="/view/diary?token=${encodeURIComponent(token)}&month=${nextMonth}">เดือนถัดไป ›</a>
  </div>`;

  if (monthRows.length === 0) {
    return pageShell(
      "ไดอารี่",
      `<h1>ไดอารี่</h1><p class="subtitle">เดือน ${escapeHtml(month)}</p>
${searchForm}
${navLinks}
<div class="card"><p class="empty">ไม่มีบันทึกเดือนนี้</p></div>
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
      nav
    );
  }

  // Newest day first within the month, like flipping to the back of a notebook.
  const groups = Array.from(groupByDate(monthRows).entries()).sort((a, b) => b[0].localeCompare(a[0]));
  const dayGroupsHtml = groups
    .map(([date, entries]) => {
      const entriesHtml = entries
        .map(
          (e) =>
            `<div class="diary-entry"><span class="category">${escapeHtml(e.category)}</span>${escapeHtml(e.text)}</div>`
        )
        .join("\n");
      return `<div class="day-group"><h2>${escapeHtml(date)}</h2><div class="card">${entriesHtml}</div></div>`;
    })
    .join("\n");

  return pageShell(
    "ไดอารี่",
    `<h1>ไดอารี่</h1><p class="subtitle">เดือน ${escapeHtml(month)}</p>
${searchForm}
${navLinks}
${dayGroupsHtml}
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
    nav
  );
}

// Searches across every month at once (same substring match as the chat
// command "ค้นหาไดอารี่ <คำ>" in diaryCommands.ts), not just the month
// currently being viewed — a search restricted to one month would be
// surprising and mostly useless for finding something written a while ago.
function renderDiarySearchResults(token: string, month: string, query: string, matches: DiaryRow[]): string {
  const nav = { token, active: "diary" as const };
  const searchForm = renderSearchForm(token, month, query);
  const backLink = `<div class="nav-links"><a href="/view/diary?token=${encodeURIComponent(token)}&month=${encodeURIComponent(month)}">‹ กลับไปดูรายเดือน</a></div>`;

  if (matches.length === 0) {
    return pageShell(
      "ค้นหาไดอารี่",
      `<h1>ไดอารี่</h1>
${searchForm}
<div class="card"><p class="empty">ไม่พบบันทึกที่มีคำว่า "${escapeHtml(query)}"</p></div>
${backLink}
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
      nav
    );
  }

  // Newest first, same convention as the month view above.
  const sorted = [...matches].sort((a, b) => b.date.localeCompare(a.date));
  const resultsHtml = sorted
    .map(
      (e) =>
        `<div class="diary-entry"><span class="category">${escapeHtml(e.date)} · ${escapeHtml(e.category)}</span>${escapeHtml(e.text)}</div>`
    )
    .join("\n");

  return pageShell(
    "ค้นหาไดอารี่",
    `<h1>ไดอารี่</h1><p class="subtitle">พบ ${matches.length} รายการที่มีคำว่า "${escapeHtml(query)}"</p>
${searchForm}
<div class="card">${resultsHtml}</div>
${backLink}
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
    nav
  );
}

export async function handleViewDiaryRequest(request: Request, env: Env): Promise<Response> {
  const session = await resolveViewSession(request, env);
  if (session instanceof Response) return session;

  const url = new URL(request.url);
  const requestedMonth = url.searchParams.get("month");
  // A malformed month (bad copy-paste, hand-edited URL) would otherwise
  // flow straight into shiftMonthKey's Number() parsing and produce
  // "NaN-NaN" prev/next links that can never recover — falls back to the
  // current month instead of trusting the query param's shape.
  const month = requestedMonth && MONTH_KEY_PATTERN.test(requestedMonth) ? requestedMonth : bangkokMonthKey();
  const query = url.searchParams.get("q")?.trim() ?? "";

  try {
    const allRows = await readAllDiaryEntries(session.accessToken, session.spreadsheetId, env.ACCOUNTS);
    if (query) {
      const matches = allRows.filter((r) => r.text.includes(query));
      return html(renderDiarySearchResults(session.token, month, query, matches));
    }
    const monthRows = allRows.filter((r) => r.date?.startsWith(month));
    return html(renderDiaryPage(session.token, month, monthRows));
  } catch (err) {
    console.error("handleViewDiaryRequest: fetching diary entries failed", err);
    return html(renderErrorPage("ดึงข้อมูลไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
  }
}
