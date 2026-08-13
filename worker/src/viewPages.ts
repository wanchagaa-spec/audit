// Accounts summary page (PLAN.md 16.2) — the first /view page built, and
// still the simplest: readAllTransactions already existed, nothing new to
// fetch. See viewAuth.ts for the shared token/session/page-shell plumbing
// every /view/* page uses, and viewCalendarPage.ts/viewDiaryPage.ts/
// viewTripsPage.ts for the rest.

import { categoryLabel, formatBaht } from "./commands.ts";
import type { Env } from "./index.ts";
import { readAllTransactions, type TransactionRow } from "./sheets.ts";
import { bangkokMonthKey, formatThaiDateLabel, bangkokDateKey } from "./thaiDate.ts";
import { DATA_FETCH_FAILED_MESSAGE, html, escapeHtml, pageShell, renderErrorPage, resolveViewSession } from "./viewAuth.ts";

const RECENT_TRANSACTIONS_LIMIT = 20;

function totals(rows: TransactionRow[]): { income: number; expense: number } {
  return {
    income: rows.filter((r) => r.type === "income").reduce((s, r) => s + r.amount, 0),
    expense: rows.filter((r) => r.type === "expense").reduce((s, r) => s + r.amount, 0),
  };
}

function topCategories(rows: TransactionRow[], limit = 5): Array<{ categoryId: string; amount: number }> {
  const byCategory = new Map<string, number>();
  for (const r of rows) {
    if (r.type !== "expense") continue;
    byCategory.set(r.categoryId, (byCategory.get(r.categoryId) ?? 0) + r.amount);
  }
  return Array.from(byCategory.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([categoryId, amount]) => ({ categoryId, amount }));
}

function renderAccountsSummaryPage(token: string, monthLabel: string, monthTx: TransactionRow[]): string {
  const nav = { token, active: "accounts" as const };

  if (monthTx.length === 0) {
    return pageShell(
      "สรุปบัญชี",
      `<h1>สรุปบัญชี</h1><p class="subtitle">${escapeHtml(monthLabel)}</p>
<div class="card"><p class="empty">ยังไม่มีรายรับ-รายจ่ายเดือนนี้</p></div>
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
      nav
    );
  }

  const { income, expense } = totals(monthTx);
  const top = topCategories(monthTx);
  const recent = monthTx.slice(-RECENT_TRANSACTIONS_LIMIT).reverse();

  const totalsHtml = `<div class="card">
    <div class="totals">
      <div><div class="label">รายรับ</div><div class="amount income">${formatBaht(income)}</div></div>
      <div><div class="label">รายจ่าย</div><div class="amount expense">${formatBaht(expense)}</div></div>
      <div><div class="label">คงเหลือ</div><div class="amount">${formatBaht(income - expense)}</div></div>
    </div>
  </div>`;

  const topCategoriesHtml =
    top.length === 0
      ? ""
      : `<div class="card">
    <h2>หมวดที่จ่ายเยอะสุด</h2>
    ${top
      .map(
        (c) =>
          `<div class="row"><span>${escapeHtml(categoryLabel(c.categoryId))}</span><span>${formatBaht(c.amount)} บาท</span></div>`
      )
      .join("\n")}
  </div>`;

  const recentHtml = `<div class="card">
    <h2>รายการล่าสุด</h2>
    ${recent
      .map((r) => {
        const label = escapeHtml(r.note || r.rawText || categoryLabel(r.categoryId));
        const sign = r.type === "income" ? "+" : "-";
        const cls = r.type === "income" ? "income" : "expense";
        return `<div class="row"><span>${label}<br /><span class="meta">${escapeHtml(r.date)} · ${escapeHtml(categoryLabel(r.categoryId))}</span></span><span class="${cls}">${sign}${formatBaht(r.amount)}</span></div>`;
      })
      .join("\n")}
  </div>`;

  return pageShell(
    "สรุปบัญชี",
    `<h1>สรุปบัญชี</h1><p class="subtitle">${escapeHtml(monthLabel)}</p>
${totalsHtml}
${topCategoriesHtml}
${recentHtml}
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
    nav
  );
}

export async function handleViewAccountsRequest(request: Request, env: Env): Promise<Response> {
  const session = await resolveViewSession(request, env);
  if (session instanceof Response) return session;

  try {
    const allTx = await readAllTransactions(session.accessToken, session.spreadsheetId);
    const month = bangkokMonthKey();
    const monthTx = allTx.filter((r) => r.date?.startsWith(month));
    const monthLabel = `เดือน ${month} · ข้อมูลล่าสุด ณ ${formatThaiDateLabel(bangkokDateKey())}`;
    return html(renderAccountsSummaryPage(session.token, monthLabel, monthTx));
  } catch (err) {
    console.error("handleViewAccountsRequest: fetching account summary failed", err);
    return html(renderErrorPage("ดึงข้อมูลไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
  }
}
