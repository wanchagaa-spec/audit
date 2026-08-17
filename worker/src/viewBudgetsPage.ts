// /view/budgets (PLAN.md 17.43) — set this month's spending limits, one
// figure per expense category.
//
// The second write-capable page in the /view family, after ตารางเวร. It
// borrows that page's shape deliberately: one form holding the whole month's
// state, submitted in a single POST that overwrites what was there. That
// suits budgets for the same reason it suited shifts — you set several at
// once, and per-row save buttons would mean a request per category and a
// half-saved page if one failed.
//
// Setting a budget from chat exists too ("ตั้งงบ อาหาร 5000",
// budgetCommands.ts). This page is for doing several in one sitting, and for
// seeing what's already set next to what's been spent.

import { categoryLabel, formatBaht } from "./commands.ts";
import { DEFAULT_CATEGORIES } from "../../app/src/data/defaultCategories.ts";
import type { Env } from "./index.ts";
import { deleteBudget, readAllTransactions, readBudgets, upsertBudget } from "./sheets.ts";
import { bangkokMonthKey } from "./thaiDate.ts";
import {
  DATA_FETCH_FAILED_MESSAGE,
  escapeHtml,
  html,
  pageShell,
  renderErrorPage,
  resolveViewSession,
} from "./viewAuth.ts";

const EXPENSE_CATEGORIES = DEFAULT_CATEGORIES.filter((c) => c.type === "expense");

interface BudgetRowView {
  categoryId: string;
  limitAmount: number | null;
  spent: number;
}

function buildRows(
  budgets: Array<{ categoryId: string; month: string; limitAmount: number }>,
  spentByCategory: Map<string, number>,
  month: string
): BudgetRowView[] {
  return EXPENSE_CATEGORIES.map((category) => {
    const budget = budgets.find((b) => b.categoryId === category.id && b.month === month);
    return {
      categoryId: category.id,
      limitAmount: budget ? budget.limitAmount : null,
      spent: spentByCategory.get(category.id) ?? 0,
    };
  });
}

function renderBudgetRow(row: BudgetRowView): string {
  const value = row.limitAmount === null ? "" : String(row.limitAmount);
  const over = row.limitAmount !== null && row.spent > row.limitAmount;
  // Spending is shown next to the input because a limit is only meaningful
  // against what's actually going out — picking a number with last month's
  // reality in front of you beats guessing.
  const spentLabel =
    row.limitAmount === null
      ? `ใช้ไปแล้ว ${formatBaht(row.spent)}`
      : `ใช้ไปแล้ว ${formatBaht(row.spent)} จาก ${formatBaht(row.limitAmount)}${over ? " ⚠️ เกินงบ" : ""}`;
  return `<tr>
    <td>${escapeHtml(categoryLabel(row.categoryId))}<div class="budget-spent${over ? " expense" : ""}">${escapeHtml(spentLabel)}</div></td>
    <td class="num"><input type="number" inputmode="decimal" min="0" step="1" name="budget-${escapeHtml(row.categoryId)}" value="${escapeHtml(value)}" placeholder="ไม่ตั้ง" /></td>
  </tr>`;
}

function renderBudgetsPage(token: string, month: string, rows: BudgetRowView[], justSaved: boolean): string {
  const nav = { token, active: "budgets" as const };
  const savedNotice = justSaved ? `<p class="save-notice">บันทึกงบแล้ว ✓</p>` : "";
  const body = rows.map(renderBudgetRow).join("");
  return pageShell(
    "งบประมาณ",
    `<h1>งบเดือนนี้</h1><p class="subtitle">เดือน ${escapeHtml(month)}</p>
${savedNotice}
<form method="post" action="/view/budgets?token=${encodeURIComponent(token)}">
  <div class="card">
    <div class="table-scroll"><table class="data-table budget-table">
      <thead><tr><th>หมวด</th><th class="num">งบ (บาท)</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <button type="submit" class="save-button">บันทึกงบ</button>
  </div>
</form>
<p class="footnote">เว้นว่าง = ไม่ตั้งงบหมวดนั้น · ตั้งจากแชทก็ได้ เช่น "ตั้งงบ อาหาร 5000"</p>`,
    nav
  );
}

/** Reads the submitted figure for one category: a number > 0 means set it, a
 * blank means clear it, and anything unparseable is treated as blank rather
 * than saved as NaN. */
function parseSubmittedLimit(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === "") return null;
  const value = Number(text.replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

async function loadRows(
  accessToken: string,
  spreadsheetId: string,
  month: string
): Promise<BudgetRowView[]> {
  const [budgets, transactions] = await Promise.all([
    readBudgets(accessToken, spreadsheetId),
    readAllTransactions(accessToken, spreadsheetId),
  ]);
  const spentByCategory = new Map<string, number>();
  for (const row of transactions) {
    if (row.type !== "expense" || !row.date?.startsWith(month)) continue;
    spentByCategory.set(row.categoryId, (spentByCategory.get(row.categoryId) ?? 0) + row.amount);
  }
  return buildRows(budgets, spentByCategory, month);
}

export async function handleViewBudgetsRequest(request: Request, env: Env): Promise<Response> {
  const session = await resolveViewSession(request, env);
  if (session instanceof Response) return session;

  // Always the current Bangkok month — unlike ตารางเวร there's no ?month
  // navigation here, because a budget you can no longer act on isn't useful
  // to edit. Past months stay readable through "งบเหลือเท่าไหร่".
  const month = bangkokMonthKey();

  if (request.method === "POST") {
    try {
      const formData = await request.formData();
      // Sequential, not Promise.all: every one of these reads and rewrites
      // the same Budgets sheet, and the Sheets API has no transactions —
      // firing them together would race on row indices and could drop or
      // duplicate a row. A handful of categories makes this cheap enough.
      for (const category of EXPENSE_CATEGORIES) {
        const limitAmount = parseSubmittedLimit(formData.get(`budget-${category.id}`));
        if (limitAmount === null) {
          await deleteBudget(session.accessToken, session.spreadsheetId, env.ACCOUNTS, category.id, month);
        } else {
          await upsertBudget(session.accessToken, session.spreadsheetId, env.ACCOUNTS, {
            categoryId: category.id,
            month,
            limitAmount,
          });
        }
      }
      const rows = await loadRows(session.accessToken, session.spreadsheetId, month);
      return html(renderBudgetsPage(session.token, month, rows, true));
    } catch (err) {
      console.error("handleViewBudgetsRequest: saving budgets failed", err);
      return html(renderErrorPage("บันทึกไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
    }
  }

  try {
    const rows = await loadRows(session.accessToken, session.spreadsheetId, month);
    return html(renderBudgetsPage(session.token, month, rows, false));
  } catch (err) {
    console.error("handleViewBudgetsRequest: loading budgets failed", err);
    return html(renderErrorPage("ดึงข้อมูลไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
  }
}
