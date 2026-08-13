// Read-only web viewer (PLAN.md 16) — "เปิดเว็บดูข้อมูล" in chat mints a
// signed link (viewCommands.ts) to /view, which renders this month's
// accounts summary as plain server-rendered HTML. Deliberately not a
// separate SPA/JSON-API pair: a single Worker-rendered page is fully
// exercisable by the same fetch-mocked test-flow.mjs harness every other
// feature here is tested with, and needs no new build tooling. Every field
// pulled from a transaction row (note, rawText) is raw user-typed chat
// text, never trusted as HTML — see escapeHtml.

import { categoryLabel, formatBaht } from "./commands.ts";
import { refreshAccessToken } from "./googleAuth.ts";
import type { Env } from "./index.ts";
import { readAllTransactions, type TransactionRow } from "./sheets.ts";
import { verifyViewToken } from "./signedState.ts";
import { getAccountLink } from "./state.ts";
import { bangkokMonthKey, formatThaiDateLabel, bangkokDateKey } from "./thaiDate.ts";

const RECENT_TRANSACTIONS_LIMIT = 20;

// Not imported from index.ts on purpose — index.ts imports handleViewRequest
// from this file, so importing its `html` helper back would make the two
// modules circularly depend on each other at runtime (every other file that
// needs Env from index.ts only imports it as a type, which TypeScript erases
// and so never creates a real runtime cycle — this one-line helper is cheap
// enough to just duplicate instead).
function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pageShell(title: string, bodyHtml: string): string {
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
  .empty { text-align: center; color: #6b6f76; padding: 1.5rem 0; font-size: .9rem; }
  .footnote { text-align: center; color: #9aa0a6; font-size: .75rem; margin-top: 1.5rem; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function renderErrorPage(title: string, message: string): string {
  return pageShell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

const TOKEN_INVALID_MESSAGE = 'ลิงก์หมดอายุหรือไม่ถูกต้อง กลับไปที่แชทแล้วพิมพ์ "เปิดเว็บดูข้อมูล" เพื่อขอลิงก์ใหม่';
const UNLINKED_MESSAGE = "ยังไม่ได้เชื่อมบัญชี Google เลย พิมพ์อะไรก็ได้หาบอทใน LINE ก่อนเพื่อเชื่อมบัญชี";
const DATA_FETCH_FAILED_MESSAGE = "ดึงข้อมูลไม่สำเร็จตอนนี้ ลองเปิดลิงก์ใหม่อีกครั้งสักครู่นะ";

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

function renderAccountsSummaryPage(monthLabel: string, monthTx: TransactionRow[]): string {
  if (monthTx.length === 0) {
    return pageShell(
      "สรุปบัญชี",
      `<h1>สรุปบัญชี</h1><p class="subtitle">${escapeHtml(monthLabel)}</p>
<div class="card"><p class="empty">ยังไม่มีรายรับ-รายจ่ายเดือนนี้</p></div>
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`
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
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`
  );
}

export async function handleViewRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return html(renderErrorPage("เปิดหน้านี้ไม่ได้", TOKEN_INVALID_MESSAGE), 400);

  const lineUserId = await verifyViewToken(token, env.STATE_SIGNING_SECRET);
  if (!lineUserId) return html(renderErrorPage("เปิดหน้านี้ไม่ได้", TOKEN_INVALID_MESSAGE), 400);

  const link = await getAccountLink(env.ACCOUNTS, lineUserId);
  if (!link) return html(renderErrorPage("ยังไม่ได้เชื่อมบัญชี", UNLINKED_MESSAGE), 400);

  try {
    const accessToken = await refreshAccessToken({
      refreshToken: link.refreshToken,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    });
    const allTx = await readAllTransactions(accessToken, link.spreadsheetId);
    const month = bangkokMonthKey();
    const monthTx = allTx.filter((r) => r.date?.startsWith(month));
    const monthLabel = `เดือน ${month} · ข้อมูลล่าสุด ณ ${formatThaiDateLabel(bangkokDateKey())}`;
    return html(renderAccountsSummaryPage(monthLabel, monthTx));
  } catch (err) {
    console.error("handleViewRequest: fetching account summary failed", err);
    return html(renderErrorPage("ดึงข้อมูลไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
  }
}
