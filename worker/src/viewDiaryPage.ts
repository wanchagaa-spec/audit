// /view/diary (PLAN.md 16.3) — "สมุดโน้ต" notebook view: entries grouped
// by day, newest day first within the month, with prev/next month links
// (`?month=YYYY-MM`) instead of dumping the whole diary history into one
// page every time. Reuses readAllDiaryEntries (already existed for the
// chat "ไดอารี่เดือนนี้มีอะไรบ้าง" command and the AI Q&A data source).

import type { Env } from "./index.ts";
import { readAllDiaryEntries, type DiaryRow } from "./sheets.ts";
import { bangkokMonthKey } from "./thaiDate.ts";
import { DATA_FETCH_FAILED_MESSAGE, escapeHtml, html, pageShell, renderErrorPage, resolveViewSession } from "./viewAuth.ts";

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

function renderDiaryPage(token: string, month: string, monthRows: DiaryRow[]): string {
  const nav = { token, active: "diary" as const };
  const prevMonth = shiftMonthKey(month, -1);
  const nextMonth = shiftMonthKey(month, 1);
  const navLinks = `<div class="nav-links">
    <a href="/view/diary?token=${encodeURIComponent(token)}&month=${prevMonth}">‹ เดือนก่อน</a>
    <a href="/view/diary?token=${encodeURIComponent(token)}&month=${nextMonth}">เดือนถัดไป ›</a>
  </div>`;

  if (monthRows.length === 0) {
    return pageShell(
      "ไดอารี่",
      `<h1>ไดอารี่</h1><p class="subtitle">เดือน ${escapeHtml(month)}</p>
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
${navLinks}
${dayGroupsHtml}
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
    nav
  );
}

export async function handleViewDiaryRequest(request: Request, env: Env): Promise<Response> {
  const session = await resolveViewSession(request, env);
  if (session instanceof Response) return session;

  const url = new URL(request.url);
  const month = url.searchParams.get("month") || bangkokMonthKey();

  try {
    const allRows = await readAllDiaryEntries(session.accessToken, session.spreadsheetId, env.ACCOUNTS);
    const monthRows = allRows.filter((r) => r.date?.startsWith(month));
    return html(renderDiaryPage(session.token, month, monthRows));
  } catch (err) {
    console.error("handleViewDiaryRequest: fetching diary entries failed", err);
    return html(renderErrorPage("ดึงข้อมูลไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
  }
}
