// Budget commands (PLAN.md 17.43) — setting and clearing the monthly limits
// that "งบเหลือเท่าไหร่" (commands.ts) has been reading since day one.
//
// The read side and the over-budget warning were built long ago; only the
// write side was missing, and it lived in the separate React PWA, which
// signs into Google independently and creates its own spreadsheet. So the
// budgets a LINE user set there frequently weren't in the book the bot
// reads. This closes that: budgets are set from the chat, or from
// /view/budgets, both writing to the account's own book.
//
// Writes from chat confirm first, like every other chat write in this bot
// (PLAN.md 17.9). The web page saves directly — pressing Save on a form is
// itself the confirmation, the same call viewShiftsPage.ts makes.

import { DEFAULT_CATEGORIES } from "./categories.ts";
import { categoryLabel, formatBaht } from "./commands.ts";
import { deleteBudget, readBudgets, readTransactionsAndBudgets, upsertBudget } from "./sheets.ts";
import { setPendingConfirmation, type ActionCtx } from "./state.ts";
import { bangkokMonthKey } from "./thaiDate.ts";

type Handler = (ctx: ActionCtx) => Promise<string>;

/** Thai text -> an expense category id. Tries the category's own name first
 * (what someone reading the guide would type), then its keyword list — the
 * same list parser.ts uses to categorise a transaction, so "ข้าว" lands on
 * the food category here exactly as it does when logging an expense.
 *
 * Expense categories only: a budget is a spending limit, and offering to cap
 * your salary would be nonsense. */
export function resolveExpenseCategory(text: string): { id: string; name: string } | null {
  const needle = text.trim().toLowerCase();
  if (!needle) return null;
  const expenses = DEFAULT_CATEGORIES.filter((c) => c.type === "expense");

  const byName = expenses.find((c) => c.name.toLowerCase() === needle);
  if (byName) return { id: byName.id, name: byName.name };

  const byKeyword = expenses.find((c) => c.keywords.some((k) => k.toLowerCase() === needle));
  if (byKeyword) return { id: byKeyword.id, name: byKeyword.name };

  // Last and loosest: the typed text as a substring of the category *name*,
  // so "อาหาร" finds "อาหาร/เครื่องดื่ม". Deliberately one-directional — the
  // mirror check ("does the typed text contain a keyword") was tried and
  // removed, because Thai keywords are short enough to hit constantly by
  // accident: "ยานอวกาศ" contains "ยา" and so resolved to the health
  // category. That's the same shape as the "นัด" and "ข่าว" collisions this
  // codebase has already been bitten by twice. Better to say "I don't know
  // that category" and list the real ones than to silently budget the wrong
  // one.
  const byPartialName = expenses.find((c) => c.name.toLowerCase().includes(needle));
  return byPartialName ? { id: byPartialName.id, name: byPartialName.name } : null;
}

function unknownCategoryReply(typed: string): string {
  const names = DEFAULT_CATEGORIES.filter((c) => c.type === "expense")
    .map((c) => c.name)
    .join(", ");
  return `ไม่รู้จักหมวด "${typed}" นะ ลองใช้ชื่อหมวดพวกนี้ดู: ${names}`;
}

// ---- Answers ---------------------------------------------------------------

export async function answerBudgetList(ctx: ActionCtx): Promise<string> {
  const month = bangkokMonthKey();
  const budgets = (await readBudgets(ctx.accessToken, ctx.spreadsheetId)).filter((b) => b.month === month);
  if (budgets.length === 0) {
    return 'ยังไม่ได้ตั้งงบเดือนนี้เลยนะ ตั้งได้เลยเช่น "ตั้งงบ อาหาร 5000" หรือตั้งหลายหมวดพร้อมกันในหน้าเว็บ (พิมพ์ "เปิดเว็บดูข้อมูล" แล้วไปแท็บ "งบ")';
  }
  const lines = budgets.map((b) => `${categoryLabel(b.categoryId)}: ${formatBaht(b.limitAmount)} บาท`);
  return [`งบเดือนนี้ที่ตั้งไว้:`, ...lines, "", 'อยากรู้ว่าเหลือเท่าไหร่พิมพ์ "งบเหลือเท่าไหร่" ได้เลย'].join("\n");
}

// ---- Confirm-then-apply ----------------------------------------------------

export async function promptBudgetSet(ctx: ActionCtx, categoryId: string, limitAmount: number): Promise<string> {
  const month = bangkokMonthKey();
  const existing = (await readBudgets(ctx.accessToken, ctx.spreadsheetId)).find(
    (b) => b.categoryId === categoryId && b.month === month
  );
  await setPendingConfirmation(ctx.kv, ctx.lineUserId, { kind: "budgetSet", categoryId, month, limitAmount });
  // Says plainly that this replaces an existing figure — otherwise "ตั้งงบ
  // อาหาร 3000" on top of an existing 5,000 looks like it might add up.
  const changing = existing ? ` (เดิมตั้งไว้ ${formatBaht(existing.limitAmount)} บาท จะทับของเดิม)` : "";
  return `จะตั้งงบ ${categoryLabel(categoryId)} เดือนนี้เป็น ${formatBaht(limitAmount)} บาท${changing} ใช่ไหมคะ? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
}

export async function applyBudgetSet(
  ctx: ActionCtx,
  pending: { categoryId: string; month: string; limitAmount: number }
): Promise<string> {
  await upsertBudget(ctx.accessToken, ctx.spreadsheetId, ctx.kv, pending);
  return `ตั้งงบ ${categoryLabel(pending.categoryId)} เดือนนี้เป็น ${formatBaht(pending.limitAmount)} บาท แล้วนะ`;
}

export async function promptBudgetDelete(ctx: ActionCtx, categoryId: string): Promise<string> {
  const month = bangkokMonthKey();
  const existing = (await readBudgets(ctx.accessToken, ctx.spreadsheetId)).find(
    (b) => b.categoryId === categoryId && b.month === month
  );
  if (!existing) return `ยังไม่ได้ตั้งงบ ${categoryLabel(categoryId)} ไว้เดือนนี้เลยนะ เลยไม่มีอะไรให้ลบ`;
  await setPendingConfirmation(ctx.kv, ctx.lineUserId, { kind: "budgetDelete", categoryId, month });
  return `จะลบงบ ${categoryLabel(categoryId)} เดือนนี้ (${formatBaht(existing.limitAmount)} บาท) ใช่ไหมคะ? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
}

export async function applyBudgetDelete(
  ctx: ActionCtx,
  pending: { categoryId: string; month: string }
): Promise<string> {
  const deleted = await deleteBudget(ctx.accessToken, ctx.spreadsheetId, ctx.kv, pending.categoryId, pending.month);
  return deleted
    ? `ลบงบ ${categoryLabel(pending.categoryId)} เดือนนี้แล้วนะ`
    : `ไม่เจองบ ${categoryLabel(pending.categoryId)} เดือนนี้แล้ว อาจถูกลบไปก่อนหน้านี้`;
}

// ---- Budget status after a save (PLAN.md 17.44) ----------------------------
// The gap a real user found immediately: they set a 5,000 shopping budget,
// then logged 4,500 and 800 against it, and the bot said nothing either
// time. A limit that only speaks when you ask "งบเหลือเท่าไหร่" isn't doing
// the job a limit exists for — you find out you've overspent by going and
// checking, which is exactly what having a budget was supposed to save you
// from. So every expense in a budgeted category now reports where it leaves
// you, right in the save confirmation.
//
// This costs one Sheets request, and it is deliberately issued *alongside*
// the appends that save the money rather than after them (see
// applyTransactionCreate), so it adds no waiting to a save at all. That
// overlap is why it takes the rows being saved as an argument: the read can
// legitimately come back from either side of those appends, so the totals
// are reconciled by id below rather than assumed.
//
// It reads both tabs in one request now instead of checking Budgets first
// and only then paying for Transactions. That gives up a small saving for
// books with no budgets — they now fetch transactions they won't use — in
// exchange for one round trip instead of two for books that do. Since the
// whole thing overlaps the save either way, one request is the right trade.

/** A row applyTransactionCreate is in the middle of writing. */
export interface SavedExpense {
  id: string;
  categoryId: string;
  amount: number;
  date: string;
}

export async function buildBudgetStatusLines(ctx: ActionCtx, justSaved: SavedExpense[]): Promise<string[]> {
  if (justSaved.length === 0) return [];
  const categoryIds = new Set(justSaved.map((e) => e.categoryId));

  const month = bangkokMonthKey();
  const { transactions, budgets: allBudgets } = await readTransactionsAndBudgets(
    ctx.accessToken,
    ctx.spreadsheetId
  );
  const budgets = allBudgets.filter((b) => b.month === month && categoryIds.has(b.categoryId));
  if (budgets.length === 0) return [];

  const spentByCategory = new Map<string, number>();
  const alreadyCounted = new Set<string>();
  for (const row of transactions) {
    if (row.type !== "expense" || !row.date?.startsWith(month)) continue;
    alreadyCounted.add(row.id);
    spentByCategory.set(row.categoryId, (spentByCategory.get(row.categoryId) ?? 0) + row.amount);
  }
  // Add the rows being saved right now, but only the ones the read didn't
  // already see. Racing the appends means either outcome is possible and
  // neither is an error — what would be an error is guessing: counting
  // blindly double-charges the budget, skipping entirely under-reports it.
  // Matching on the id we generated for each row settles it exactly.
  for (const expense of justSaved) {
    if (alreadyCounted.has(expense.id) || !expense.date.startsWith(month)) continue;
    spentByCategory.set(expense.categoryId, (spentByCategory.get(expense.categoryId) ?? 0) + expense.amount);
  }

  return budgets.map((budget) => {
    const spent = spentByCategory.get(budget.categoryId) ?? 0;
    const remaining = budget.limitAmount - spent;
    if (remaining < 0) {
      return `⚠️ งบ ${categoryLabel(budget.categoryId)} เกินแล้ว ${formatBaht(-remaining)} บาท (ใช้ไป ${formatBaht(spent)} จากงบ ${formatBaht(budget.limitAmount)})`;
    }
    return `งบ ${categoryLabel(budget.categoryId)} เหลือ ${formatBaht(remaining)} บาท (ใช้ไป ${formatBaht(spent)} จากงบ ${formatBaht(budget.limitAmount)})`;
  });
}

// ---- Matcher ---------------------------------------------------------------
// Fixed prefixes, checked before commands.ts's report matcher — its
// "งบเหลือเท่าไหร่" test is a substring check, and its search regex
// ("^(?:ค้นหา|หา)...") would take anything starting with หา. Neither
// overlaps with these prefixes, which is why this can safely run first.

export async function matchBudgetCommand(text: string): Promise<Handler | null> {
  const trimmed = text.trim();

  const setMatch = trimmed.match(/^ตั้งงบ\s+(.+?)\s+([\d,]+(?:\.\d+)?)\s*(?:บาท)?$/s);
  if (setMatch) {
    const typed = setMatch[1].trim();
    const amount = Number(setMatch[2].replace(/,/g, ""));
    const category = resolveExpenseCategory(typed);
    if (!category) return async () => unknownCategoryReply(typed);
    if (!Number.isFinite(amount) || amount <= 0) {
      return async () => 'จำนวนงบต้องมากกว่า 0 นะ ลองพิมพ์แบบ "ตั้งงบ อาหาร 5000" ดู';
    }
    return (ctx) => promptBudgetSet(ctx, category.id, amount);
  }

  // Caught separately from the pattern above so a missing amount explains
  // itself instead of falling through to "I don't understand".
  if (/^ตั้งงบ(\s|$)/.test(trimmed)) {
    return async () => 'พิมพ์แบบ "ตั้งงบ <หมวด> <จำนวน>" นะ เช่น "ตั้งงบ อาหาร 5000"';
  }

  const deleteMatch = trimmed.match(/^(?:ลบงบ|ยกเลิกงบ)\s+(.+)$/s);
  if (deleteMatch) {
    const typed = deleteMatch[1].trim();
    const category = resolveExpenseCategory(typed);
    if (!category) return async () => unknownCategoryReply(typed);
    return (ctx) => promptBudgetDelete(ctx, category.id);
  }

  if (["ดูงบ", "งบเดือนนี้", "งบที่ตั้งไว้", "ตั้งงบอะไรไว้บ้าง"].includes(trimmed)) {
    return (ctx) => answerBudgetList(ctx);
  }

  return null;
}
