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
//
// The month being viewed comes from `?month=YYYY-MM` (PLAN.md 17.65), the
// same as the diary and shift pages. Before that this page was pinned to the
// current month, which quietly capped the editing above: on the 1st of a
// month, yesterday's mistyped entry became unreachable — the one time you
// are most likely to still be fixing it.

import { DEFAULT_CATEGORIES } from "./categories.ts";
import { categoryLabel, formatBaht } from "./commands.ts";
import type { Env } from "./index.ts";
import {
  deleteTransactionById,
  readTransactionsForMonth,
  updateTransaction,
  type TransactionRow,
} from "./sheets.ts";
import { formatThaiDateLabel, bangkokDateKey } from "./thaiDate.ts";
import {
  DATA_FETCH_FAILED_MESSAGE,
  escapeHtml,
  html,
  pageShell,
  renderErrorPage,
  resolveMonthKey,
  resolveViewSession,
  shiftMonthKey,
} from "./viewAuth.ts";

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Every link and form action on this page goes through here, so the month
 * being viewed survives the whole edit round-trip. Drop it from one of them
 * — the form's action, say — and saving a row in March silently returns you
 * to the current month with the edit apparently vanished. */
function accountsUrl(token: string, month: string): string {
  return `/view?token=${encodeURIComponent(token)}&month=${encodeURIComponent(month)}`;
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
  month: string,
  monthLabel: string,
  monthTx: TransactionRow[],
  notice?: string,
  editId?: string | null
): string {
  const nav = { token, active: "accounts" as const };
  // No upper bound on "next": a month ahead is empty rather than wrong, and
  // the diary page reached the same conclusion. Guessing where the data ends
  // would mean a read per click to find out.
  const navLinks = `<div class="nav-links">
    <a href="${accountsUrl(token, shiftMonthKey(month, -1))}">‹ เดือนก่อน</a>
    <a href="${accountsUrl(token, shiftMonthKey(month, 1))}">เดือนถัดไป ›</a>
  </div>`;
  const noticeHtml = notice ? `<p class="save-notice">${escapeHtml(notice)}</p>` : "";

  if (monthTx.length === 0) {
    return pageShell(
      "สรุปบัญชี",
      `<h1>สรุปบัญชี</h1><p class="subtitle">${escapeHtml(monthLabel)}</p>
${navLinks}
${noticeHtml}
<div class="card"><p class="empty">ไม่มีรายรับ-รายจ่ายเดือนนี้</p></div>
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

  const dayGroupsHtml = groupByDate(recent)
    .map((day) => {
      const { income: dayIncome, expense: dayExpense } = totals(day.rows);
      // What the day cost, next to the day itself. The month totals above
      // answer "how is the month going"; this answers "what did today (or
      // that Saturday) come to", which is the question someone scrolling a
      // list of individual rows is actually adding up in their head.
      const parts: string[] = [];
      if (dayExpense > 0) parts.push(`<span class="expense">-${formatBaht(dayExpense)}</span>`);
      if (dayIncome > 0) parts.push(`<span class="income">+${formatBaht(dayIncome)}</span>`);
      return `<div class="day-heading"><span>${escapeHtml(formatThaiDateLabel(day.date))}</span><span class="day-total">${parts.join(" ")}</span></div>
    <div class="table-scroll"><table class="data-table tx-table">
      <tbody>
        ${day.rows.map((r) => (r.id === editId ? renderEditingRow(token, month, r) : renderReadOnlyRow(token, month, r))).join("\n")}
      </tbody>
    </table></div>`;
    })
    .join("\n");

  const recentHtml = `<div class="card">
    <h2>รายการเดือน ${escapeHtml(month)}</h2>
    <p class="subtitle">${editId ? 'แก้ไขแถวที่เลือกแล้วกด "บันทึก"' : 'กด "แก้" ท้ายแถวเพื่อแก้ไข'}</p>
    ${editId ? `<form id="tx-edit" method="post" action="${accountsUrl(token, month)}"><input type="hidden" name="op" value="update" /><input type="hidden" name="id" value="${escapeHtml(editId)}" /></form>` : ""}
    ${dayGroupsHtml}
  </div>`;

  return pageShell(
    "สรุปบัญชี",
    `<h1>สรุปบัญชี</h1><p class="subtitle">${escapeHtml(monthLabel)}</p>
${navLinks}
${noticeHtml}
${totalsHtml}
${topCategoriesHtml}
${recentHtml}
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
    nav
  );
}

/**
 * The month's rows split into days, newest day first (PLAN.md 17.86).
 *
 * Grouped from the list rather than sorted into it: `rows` arrives in the
 * order the caller wants entries to read *within* a day (newest first), and
 * only the days themselves need ordering. Days are sorted by their own key
 * rather than trusting sheet order, because editing a row's date moves it
 * between days without moving it in the sheet — the same mismatch that
 * PLAN.md 17.85 was about.
 */
function groupByDate(rows: TransactionRow[]): Array<{ date: string; rows: TransactionRow[] }> {
  const byDate = new Map<string, TransactionRow[]>();
  for (const row of rows) {
    const existing = byDate.get(row.date);
    if (existing) existing.push(row);
    else byDate.set(row.date, [row]);
  }
  return [...byDate.entries()]
    .map(([date, dayRows]) => ({ date, rows: dayRows }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** A normal row: values, then the two actions at the end of the line.
 *
 * Read-only until "แก้" is pressed, rather than every row being a live input
 * at once (PLAN.md 17.64). A month of always-editable rows is a wall of
 * form controls to scroll past when all anyone came to do is look, and it
 * makes an accidental tap on a phone a silent change to a figure — the whole
 * page becomes a hazard to read. */
function renderReadOnlyRow(token: string, month: string, r: TransactionRow): string {
  const label = escapeHtml(r.note || r.rawText || categoryLabel(r.categoryId));
  const sign = r.type === "income" ? "+" : "-";
  const cls = r.type === "income" ? "income" : "expense";
  const editUrl = `${accountsUrl(token, month)}&edit=${encodeURIComponent(r.id)}`;
  const confirmUrl = `${accountsUrl(token, month)}&confirmDelete=${encodeURIComponent(r.id)}`;
  // No date cell: the day heading above the table carries it (PLAN.md
  // 17.86), and repeating it on every row spent a column that a phone does
  // not have to spare on saying the same thing twenty times.
  return `<tr>
    <td>${escapeHtml(categoryLabel(r.categoryId))}</td>
    <td class="note">${label}</td>
    <td class="num ${cls}">${sign}${formatBaht(r.amount)}</td>
    <td class="tx-actions"><a class="tx-edit-link" href="${editUrl}">แก้</a><a class="tx-delete-link" href="${confirmUrl}">ลบ</a></td>
  </tr>`;
}

/**
 * The one row being edited, as inputs in place.
 *
 * The inputs carry `form="tx-edit"` and the form itself sits above the
 * table: HTML does not allow a <form> to wrap a group of <td>s, and putting
 * one inside a single cell would collapse the row's alignment with every
 * other row — which is the entire point of using a table here.
 *
 * The amount is a number input so a phone offers the numeric keypad, but it
 * is still validated server-side on the way in: a browser hint is not a
 * check, and this is money.
 */
function renderEditingRow(token: string, month: string, r: TransactionRow): string {
  const cls = r.type === "income" ? "income" : "expense";
  // The date input moves in with the note rather than disappearing with the
  // date column: moving a row to another day is a real correction (a receipt
  // logged the morning after), and the whole point of the row being editable
  // is that every field it shows can be wrong.
  return `<tr class="tx-editing">
    <td><select form="tx-edit" name="categoryId">${categoryOptions(r.categoryId, r.type)}</select></td>
    <td class="note"><input form="tx-edit" type="date" name="date" value="${escapeHtml(r.date)}" /><input form="tx-edit" type="text" name="note" value="${escapeHtml(r.note)}" placeholder="รายละเอียด" /></td>
    <td class="num"><input form="tx-edit" class="tx-amount ${cls}" type="number" name="amount" step="0.01" min="0" value="${r.amount}" inputmode="decimal" /></td>
    <td class="tx-actions">
      <input form="tx-edit" type="hidden" name="type" value="${escapeHtml(r.type)}" />
      <button form="tx-edit" type="submit">บันทึก</button>
      <a class="tx-cancel-link" href="${accountsUrl(token, month)}">ยกเลิก</a>
    </td>
  </tr>`;
}

/** Deleting is the one irreversible action here, so it gets its own page —
 * the row is shown in full before it goes, the same shape as the diary
 * page's confirm step. */
function renderConfirmDeletePage(token: string, month: string, r: TransactionRow): string {
  const sign = r.type === "income" ? "+" : "-";
  return pageShell(
    "ยืนยันการลบ",
    `<h1>ลบรายการนี้?</h1>
<div class="confirm-delete-text">
  <strong>${escapeHtml(r.date)} · ${escapeHtml(categoryLabel(r.categoryId))}</strong>
  <p>${escapeHtml(r.note || r.rawText || "(ไม่มีรายละเอียด)")}</p>
  <p class="${r.type === "income" ? "income" : "expense"}">${sign}${formatBaht(r.amount)} บาท</p>
</div>
<form method="post" action="${accountsUrl(token, month)}" class="confirm-actions">
  <input type="hidden" name="op" value="delete" />
  <input type="hidden" name="id" value="${escapeHtml(r.id)}" />
  <button type="submit">ลบเลย</button>
  <a href="${accountsUrl(token, month)}">ยกเลิก</a>
</form>`,
    { token, active: "accounts" as const }
  );
}

export async function handleViewAccountsRequest(request: Request, env: Env): Promise<Response> {
  const session = await resolveViewSession(request, env);
  if (session instanceof Response) return session;

  // Read from the request on POST too, not just GET: the form's action
  // carries the month, so saving an edit in a past month re-renders that
  // month rather than jumping back to today's.
  const url = new URL(request.url);
  const month = resolveMonthKey(url);
  const monthLabel = `เดือน ${month} · ข้อมูลล่าสุด ณ ${formatThaiDateLabel(bangkokDateKey())}`;
  const renderMonth = async (notice?: string, editId?: string | null) => {
    const monthTx = await readTransactionsForMonth(session.accessToken, session.spreadsheetId, env.ACCOUNTS, month);
    // A row asked for by ?edit= that is no longer in the month falls back to
    // the plain list — a stale link should not leave a row half-open.
    const openId = editId && monthTx.some((r) => r.id === editId) ? editId : null;
    return html(renderAccountsSummaryPage(session.token, month, monthLabel, monthTx, notice, openId));
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

        const updated = await updateTransaction(
          session.accessToken,
          session.spreadsheetId,
          id,
          { date, type, amount, categoryId, note },
          env.ACCOUNTS
        );
        if (!updated) return renderMonth("ไม่พบรายการนี้แล้ว อาจถูกลบไปก่อนหน้านี้ เลยไม่ได้บันทึก");
        // Changing the date can move a row out of the month being viewed, and
        // it then disappears from this list. Saying where it went beats a
        // bare "saved" next to a row that is no longer there.
        const movedTo = date.slice(0, 7);
        return renderMonth(
          movedTo === month ? "บันทึกการแก้ไขแล้ว" : `บันทึกแล้ว — รายการนี้ย้ายไปเดือน ${movedTo} แล้ว`
        );
      }

      return html(renderErrorPage("เกิดข้อผิดพลาด", "ไม่รู้จักคำสั่งนี้ ลองกลับไปหน้าบัญชีแล้วลองใหม่นะ"), 400);
    } catch (err) {
      console.error("handleViewAccountsRequest: saving a transaction edit failed", err);
      return html(renderErrorPage("บันทึกไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
    }
  }

  try {
    const confirmDeleteId = url.searchParams.get("confirmDelete");
    if (confirmDeleteId) {
      const monthTx = await readTransactionsForMonth(session.accessToken, session.spreadsheetId, env.ACCOUNTS, month);
      const target = monthTx.find((r) => r.id === confirmDeleteId);
      // A stale link (already deleted, or from a different month) falls back
      // to the list rather than a dead end.
      if (target) return html(renderConfirmDeletePage(session.token, month, target));
      return renderMonth("ไม่พบรายการนี้แล้ว อาจถูกลบไปก่อนหน้านี้");
    }
    return renderMonth(undefined, url.searchParams.get("edit"));
  } catch (err) {
    console.error("handleViewAccountsRequest: fetching account summary failed", err);
    return html(renderErrorPage("ดึงข้อมูลไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
  }
}
