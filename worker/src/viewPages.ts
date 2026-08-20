// Accounts summary page (PLAN.md 16.2), write-capable since 17.63. See
// viewAuth.ts for the shared token/session/page-shell plumbing every
// /view/* page uses, and viewCalendarPage.ts/viewDiaryPage.ts/
// viewTripsPage.ts for the rest.
//
// Editing lives here rather than in chat for one reason: the hard part of
// correcting an entry is saying *which* one, and a list you can see answers
// that by itself. In chat it would mean matching on a keyword or an amount,
// and picking the wrong row is a silent, wrong change to somebody's money.
//
// Same two-speed shape the diary page settled on (PLAN.md 17.36): an edit
// saves immediately, because it is reversible by editing again; a delete
// goes through a confirm page first, because it is not.

import { DEFAULT_CATEGORIES } from "./categories.ts";
import { categoryLabel, formatBaht } from "./commands.ts";
import type { Env } from "./index.ts";
import {
  deleteTransactionById,
  readTransactionsForMonth,
  updateTransaction,
  type TransactionRow,
} from "./sheets.ts";
import { bangkokMonthKey, formatThaiDateLabel, bangkokDateKey } from "./thaiDate.ts";
import { DATA_FETCH_FAILED_MESSAGE, html, escapeHtml, pageShell, renderErrorPage, resolveViewSession } from "./viewAuth.ts";

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function accountsUrl(token: string): string {
  return `/view?token=${encodeURIComponent(token)}`;
}

/** Only the categories that match the row's own type are offered. A row
 * cannot be an expense filed under a salary category, and letting the form
 * produce one would put a value in the sheet that every reader downstream
 * treats as impossible. */
function categoryOptions(selectedId: string, type: "income" | "expense"): string {
  return DEFAULT_CATEGORIES.filter((c) => c.type === type)
    .map(
      (c) =>
        `<option value="${escapeHtml(c.id)}"${c.id === selectedId ? " selected" : ""}>${escapeHtml(c.icon)} ${escapeHtml(c.name)}</option>`
    )
    .join("");
}



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

function renderAccountsSummaryPage(
  token: string,
  monthLabel: string,
  monthTx: TransactionRow[],
  notice?: string
): string {
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
  // The whole month, newest first — no cap (PLAN.md 17.49). It was 20, then
  // briefly 5 to match the chat command, which was the wrong lesson: the two
  // are answering different questions. Chat is a glance at what you just
  // spent and has a 5,000-character ceiling to respect; the web page is
  // where you go to actually look through the month, and truncating it there
  // leaves no way to see the rest at all.
  const recent = [...monthTx].reverse();

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
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>หมวด</th><th class="num">รวม</th></tr></thead>
      <tbody>
        ${top
          .map(
            (c) =>
              `<tr><td>${escapeHtml(categoryLabel(c.categoryId))}</td><td class="num expense">${formatBaht(c.amount)}</td></tr>`
          )
          .join("\n")}
      </tbody>
    </table></div>
  </div>`;

  const recentHtml = `<div class="card">
    <h2>รายการเดือนนี้</h2>
    <p class="subtitle">แตะแก้ตัวเลข หมวด หรือวันที่ได้เลย แล้วกด "บันทึก"</p>
    ${recent.map((r) => renderTransactionForm(token, r)).join("\n")}
  </div>`;

  return pageShell(
    "สรุปบัญชี",
    `<h1>สรุปบัญชี</h1><p class="subtitle">${escapeHtml(monthLabel)}</p>
${notice ? `<p class="save-notice">${escapeHtml(notice)}</p>` : ""}
${totalsHtml}
${topCategoriesHtml}
${recentHtml}
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
    nav
  );
}

/** One row, as a form. The amount is a number input rather than free text so
 * a phone offers the numeric keypad, but the value is still validated on the
 * way in — a browser hint is not a check. */
function renderTransactionForm(token: string, r: TransactionRow): string {
  const confirmUrl = `${accountsUrl(token)}&confirmDelete=${encodeURIComponent(r.id)}`;
  const cls = r.type === "income" ? "income" : "expense";
  return `<form method="post" action="${accountsUrl(token)}" class="tx-edit-form">
    <input type="hidden" name="op" value="update" />
    <input type="hidden" name="id" value="${escapeHtml(r.id)}" />
    <input type="hidden" name="type" value="${escapeHtml(r.type)}" />
    <div class="tx-edit-row">
      <input type="date" name="date" value="${escapeHtml(r.date)}" />
      <select name="categoryId">${categoryOptions(r.categoryId, r.type)}</select>
      <input class="tx-amount ${cls}" type="number" name="amount" step="0.01" min="0" value="${r.amount}" inputmode="decimal" />
    </div>
    <input type="text" name="note" value="${escapeHtml(r.note)}" placeholder="รายละเอียด" />
    <div class="tx-edit-actions">
      <button type="submit">บันทึก</button>
      <a href="${confirmUrl}">ลบ</a>
    </div>
  </form>`;
}

/** Deleting is the one irreversible action here, so it gets its own page —
 * the row is shown in full before it goes, the same shape as the diary
 * page's confirm step. */
function renderConfirmDeletePage(token: string, r: TransactionRow): string {
  const sign = r.type === "income" ? "+" : "-";
  return pageShell(
    "ยืนยันการลบ",
    `<h1>ลบรายการนี้?</h1>
<div class="confirm-delete-text">
  <strong>${escapeHtml(r.date)} · ${escapeHtml(categoryLabel(r.categoryId))}</strong>
  <p>${escapeHtml(r.note || r.rawText || "(ไม่มีรายละเอียด)")}</p>
  <p class="${r.type === "income" ? "income" : "expense"}">${sign}${formatBaht(r.amount)} บาท</p>
</div>
<form method="post" action="${accountsUrl(token)}" class="confirm-actions">
  <input type="hidden" name="op" value="delete" />
  <input type="hidden" name="id" value="${escapeHtml(r.id)}" />
  <button type="submit">ลบเลย</button>
  <a href="${accountsUrl(token)}">ยกเลิก</a>
</form>`,
    { token, active: "accounts" as const }
  );
}

export async function handleViewAccountsRequest(request: Request, env: Env): Promise<Response> {
  const session = await resolveViewSession(request, env);
  if (session instanceof Response) return session;

  const month = bangkokMonthKey();
  const monthLabel = `เดือน ${month} · ข้อมูลล่าสุด ณ ${formatThaiDateLabel(bangkokDateKey())}`;
  const renderMonth = async (notice?: string) => {
    const monthTx = await readTransactionsForMonth(session.accessToken, session.spreadsheetId, env.ACCOUNTS, month);
    return html(renderAccountsSummaryPage(session.token, monthLabel, monthTx, notice));
  };

  if (request.method === "POST") {
    try {
      const formData = await request.formData();
      const op = String(formData.get("op") ?? "");
      const id = String(formData.get("id") ?? "");

      if (op === "delete") {
        // Null means the id was already gone — deleted from another tab, or
        // a stale page. Say so rather than claiming this request did it.
        const deleted = await deleteTransactionById(session.accessToken, session.spreadsheetId, id);
        return renderMonth(deleted ? "ลบรายการแล้ว" : "ไม่พบรายการนี้แล้ว อาจถูกลบไปก่อนหน้านี้");
      }

      if (op === "update") {
        const date = String(formData.get("date") ?? "");
        const type = String(formData.get("type") ?? "");
        const categoryId = String(formData.get("categoryId") ?? "");
        const note = String(formData.get("note") ?? "").trim();
        const amount = Number(String(formData.get("amount") ?? "").replace(/,/g, ""));

        // Every rejection below re-renders with the row's *stored* values
        // untouched. This is money: refusing an edit costs one retry, while
        // writing a substituted or zeroed figure is a wrong number in
        // somebody's accounts that nothing downstream can tell from a real
        // one.
        if (!DATE_KEY_RE.test(date)) return renderMonth("วันที่ไม่ถูกต้อง ยังไม่ได้บันทึกนะ");
        if (type !== "income" && type !== "expense") return renderMonth("ประเภทรายการไม่ถูกต้อง ยังไม่ได้บันทึกนะ");
        if (!Number.isFinite(amount) || amount <= 0) {
          return renderMonth('จำนวนเงินต้องมากกว่า 0 ยังไม่ได้บันทึกนะ ถ้าต้องการลบรายการนี้ให้กดปุ่ม "ลบ" แทน');
        }
        // The select only ever offers matching categories, but a form post
        // is not a promise — checked here against the same rule the AI
        // interpreter's validateIntent uses.
        if (!DEFAULT_CATEGORIES.some((c) => c.id === categoryId && c.type === type)) {
          return renderMonth("หมวดไม่ตรงกับประเภทรายการ ยังไม่ได้บันทึกนะ");
        }

        const updated = await updateTransaction(session.accessToken, session.spreadsheetId, id, {
          date,
          type,
          amount,
          categoryId,
          note,
        });
        return renderMonth(updated ? "บันทึกการแก้ไขแล้ว" : "ไม่พบรายการนี้แล้ว อาจถูกลบไปก่อนหน้านี้ เลยไม่ได้บันทึก");
      }

      return html(renderErrorPage("เกิดข้อผิดพลาด", "ไม่รู้จักคำสั่งนี้ ลองกลับไปหน้าบัญชีแล้วลองใหม่นะ"), 400);
    } catch (err) {
      console.error("handleViewAccountsRequest: saving a transaction edit failed", err);
      return html(renderErrorPage("บันทึกไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
    }
  }

  try {
    const confirmDeleteId = new URL(request.url).searchParams.get("confirmDelete");
    if (confirmDeleteId) {
      const monthTx = await readTransactionsForMonth(session.accessToken, session.spreadsheetId, env.ACCOUNTS, month);
      const target = monthTx.find((r) => r.id === confirmDeleteId);
      // A stale link (already deleted, or from a different month) falls back
      // to the list rather than a dead end.
      if (target) return html(renderConfirmDeletePage(session.token, target));
      return renderMonth("ไม่พบรายการนี้แล้ว อาจถูกลบไปก่อนหน้านี้");
    }
    return renderMonth();
  } catch (err) {
    console.error("handleViewAccountsRequest: fetching account summary failed", err);
    return html(renderErrorPage("ดึงข้อมูลไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
  }
}
