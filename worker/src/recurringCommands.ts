// Recurring monthly bills (PLAN.md 17.59) — the fixed costs that come round
// every month whether or not you think about them: rent, internet, phone,
// insurance, subscriptions.
//
// **A reference list, not an automation.** The bot never writes a
// transaction on its own here. It records what you said you pay each month,
// and the summary reports which of those are settled and which are still
// outstanding. Whether a bill is paid is answered by you saying so, not by
// the bot matching amounts against your transactions and guessing — two
// bills of the same size in the same category are indistinguishable that
// way, and a wrong guess in a money feature is worse than no answer.
//
// Marking one paid does offer to log the expense, in the same
// confirm-before-save step every other chat write goes through (PLAN.md
// 17.9), so settling a bill is one action rather than two.

import { categoryLabel, formatBaht } from "./format.ts";
import { resolveExpenseCategory } from "./budgetCommands.ts";
import { buildRecurringStatus, dueLabel, recurringTotals } from "./recurring.ts";
import {
  deleteRecurring,
  markRecurringPaid,
  readRecurringWithPaid,
  upsertRecurring,
} from "./sheets.ts";
import { setPendingConfirmation, type ActionCtx } from "./state.ts";
import { applyTransactionCreate } from "./transactionCommands.ts";
import { bangkokMonthKey } from "./thaiDate.ts";

type Handler = (ctx: ActionCtx) => Promise<string>;

/** Fallback category for a bill whose name matches none. "อื่นๆ" is a real
 * expense category in DEFAULT_CATEGORIES, so a bill always has somewhere to
 * be counted even when its name means nothing to the matcher. */
const FALLBACK_CATEGORY = "other-expense";

// ---- Answers ---------------------------------------------------------------

export async function answerRecurringList(ctx: ActionCtx): Promise<string> {
  const month = bangkokMonthKey();
  const { recurring, paid } = await readRecurringWithPaid(ctx.accessToken, ctx.spreadsheetId, ctx.kv);
  const status = buildRecurringStatus(recurring, paid, month);

  if (status.length === 0) {
    return 'ยังไม่ได้ตั้งค่าใช้จ่ายประจำไว้เลยนะ ตั้งได้เลยเช่น "ตั้งค่าใช้จ่ายประจำ ค่าเน็ต 599" หรือใส่วันครบกำหนดด้วยก็ได้ "ตั้งค่าใช้จ่ายประจำ ค่าเช่าบ้าน 6000 ทุกวันที่ 5"';
  }

  const { total, unpaid } = recurringTotals(status);
  const lines = status.map(
    (s) => `${s.paid ? "✅" : "⬜"} ${s.entry.name}${dueLabel(s.entry)}: ${formatBaht(s.entry.amount)} บาท`
  );
  return [
    `ค่าใช้จ่ายประจำทุกเดือน (รวม ${formatBaht(total)} บาท):`,
    ...lines,
    "",
    unpaid > 0 ? `เดือนนี้ยังไม่จ่าย ${formatBaht(unpaid)} บาท` : "เดือนนี้จ่ายครบแล้ว 🎉",
    'จ่ายแล้วพิมพ์ "จ่ายค่าเน็ตแล้ว" ได้เลย',
  ].join("\n");
}

// ---- Confirm-then-apply ----------------------------------------------------

export async function promptRecurringSet(
  ctx: ActionCtx,
  name: string,
  amount: number,
  dayOfMonth: number
): Promise<string> {
  const { recurring } = await readRecurringWithPaid(ctx.accessToken, ctx.spreadsheetId, ctx.kv);
  const existing = recurring.find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase());
  const categoryId = resolveExpenseCategory(name)?.id ?? FALLBACK_CATEGORY;

  await setPendingConfirmation(ctx.kv, ctx.lineUserId, {
    kind: "recurringSet",
    name,
    amount,
    dayOfMonth,
    categoryId,
  });
  // Says plainly that this replaces the old figure — otherwise setting
  // "ค่าเน็ต 699" over an existing 599 looks like it might add a second one.
  const changing = existing ? ` (เดิม ${formatBaht(existing.amount)} บาท จะทับของเดิม)` : "";
  const day = dayOfMonth > 0 ? ` ทุกวันที่ ${dayOfMonth}` : "";
  return `จะเพิ่ม "${name}" ${formatBaht(amount)} บาท${day} เป็นค่าใช้จ่ายประจำทุกเดือน${changing} ใช่ไหมคะ? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
}

export async function applyRecurringSet(
  ctx: ActionCtx,
  pending: { name: string; amount: number; dayOfMonth: number; categoryId: string }
): Promise<string> {
  const { replaced } = await upsertRecurring(ctx.accessToken, ctx.spreadsheetId, ctx.kv, pending);
  const verb = replaced ? "แก้" : "เพิ่ม";
  return `${verb} "${pending.name}" ${formatBaht(pending.amount)} บาท เป็นค่าใช้จ่ายประจำแล้วนะ (หมวด${categoryLabel(pending.categoryId)}) — จะโผล่ในสรุปเดือนนี้ด้วย`;
}

export async function promptRecurringDelete(ctx: ActionCtx, name: string): Promise<string> {
  const { recurring } = await readRecurringWithPaid(ctx.accessToken, ctx.spreadsheetId, ctx.kv);
  const existing = recurring.find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (!existing) return `ไม่เจอค่าใช้จ่ายประจำชื่อ "${name}" นะ พิมพ์ "ค่าใช้จ่ายประจำ" เพื่อดูรายการที่ตั้งไว้ได้`;
  await setPendingConfirmation(ctx.kv, ctx.lineUserId, { kind: "recurringDelete", name: existing.name });
  return `จะลบ "${existing.name}" (${formatBaht(existing.amount)} บาท) ออกจากค่าใช้จ่ายประจำ ใช่ไหมคะ? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
}

export async function applyRecurringDelete(ctx: ActionCtx, pending: { name: string }): Promise<string> {
  const deleted = await deleteRecurring(ctx.accessToken, ctx.spreadsheetId, ctx.kv, pending.name);
  return deleted
    ? `ลบ "${pending.name}" ออกจากค่าใช้จ่ายประจำแล้วนะ`
    : `ไม่เจอ "${pending.name}" แล้ว อาจถูกลบไปก่อนหน้านี้`;
}

/**
 * "จ่ายค่าเน็ตแล้ว" — marks the bill settled for this month **and** offers
 * to log the expense in one confirmation.
 *
 * Logging it is the point of the pairing: without it, settling a bill means
 * telling the bot twice (once as a transaction, once as a tick), and the two
 * would drift the moment someone forgets one. The confirmation names both
 * effects so nothing is written silently.
 */
export async function promptRecurringPaid(ctx: ActionCtx, name: string): Promise<string> {
  const month = bangkokMonthKey();
  const { recurring, paid } = await readRecurringWithPaid(ctx.accessToken, ctx.spreadsheetId, ctx.kv);
  const entry = recurring.find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (!entry) return `ไม่เจอค่าใช้จ่ายประจำชื่อ "${name}" นะ พิมพ์ "ค่าใช้จ่ายประจำ" เพื่อดูรายการที่ตั้งไว้ได้`;

  if (paid.some((p) => p.recurringId === entry.id && p.month === month)) {
    return `"${entry.name}" เดือนนี้ทำเครื่องหมายว่าจ่ายแล้วนะ ไม่ต้องจ่ายซ้ำ`;
  }

  await setPendingConfirmation(ctx.kv, ctx.lineUserId, {
    kind: "recurringPaid",
    recurringId: entry.id,
    name: entry.name,
    amount: entry.amount,
    categoryId: entry.categoryId || FALLBACK_CATEGORY,
    month,
  });
  return `จะบันทึก "${entry.name}" ${formatBaht(entry.amount)} บาท เป็นรายจ่าย และทำเครื่องหมายว่าจ่ายเดือนนี้แล้ว ใช่ไหมคะ? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
}

export async function applyRecurringPaid(
  ctx: ActionCtx,
  pending: { recurringId: string; name: string; amount: number; categoryId: string; month: string }
): Promise<string> {
  // The transaction goes through applyTransactionCreate rather than a
  // separate append: it is an ordinary expense and has to behave like one
  // everywhere afterwards — same id shape, same Bangkok date handling, same
  // budget warning if the category is over its limit.
  const saved = await applyTransactionCreate(ctx, {
    drafts: [{ amount: pending.amount, type: "expense", categoryId: pending.categoryId, note: pending.name }],
    rawText: `จ่าย${pending.name}แล้ว`,
    attribution: { addedBy: "unknown", addedByName: "" },
  });
  // Marked paid only after the money is actually saved. The other order
  // would tick a bill off on a save that then failed, and the summary would
  // report it settled with nothing behind it.
  await markRecurringPaid(ctx.accessToken, ctx.spreadsheetId, ctx.kv, pending.recurringId, pending.month);
  return `${saved}\n\nทำเครื่องหมายว่า "${pending.name}" จ่ายเดือนนี้แล้วนะ ✅`;
}

// ---- Matching -------------------------------------------------------------
//
// Fixed prefixes, like every other write command in this bot. "ประจำ" on its
// own is far too common a Thai word to key off — the same class of collision
// that "นัด", "ข่าว" and "ยา" have already caused here.

const SET_RE = /^(?:ตั้ง|เพิ่ม)ค่าใช้จ่ายประจำ\s*(.+)$/;
const DELETE_RE = /^(?:ลบ|ยกเลิก)ค่าใช้จ่ายประจำ\s*(.+)$/;
const PAID_RE = /^จ่าย\s*(.+?)\s*(?:แล้ว|เรียบร้อย)$/;

const LIST_PHRASES = [
  "ค่าใช้จ่ายประจำ",
  "ดูค่าใช้จ่ายประจำ",
  "รายจ่ายประจำ",
  "ค่าใช้จ่ายประจำเดือน",
  "บิลรายเดือน",
];

/** Pulls "ค่าเน็ต 599 ทุกวันที่ 5" apart into its three pieces. The amount is
 * the last bare number *before* any "ทุกวันที่" clause, so a due day can
 * never be mistaken for the price — which is exactly what happens if you
 * just take the last number in the string. */
export function parseRecurringInput(rest: string): { name: string; amount: number; dayOfMonth: number } | null {
  const dayMatch = rest.match(/\s*(?:ทุก)?วันที่\s*(\d{1,2})\s*$/);
  const dayOfMonth = dayMatch ? Number(dayMatch[1]) : 0;
  const withoutDay = dayMatch ? rest.slice(0, dayMatch.index).trim() : rest.trim();

  const amountMatch = withoutDay.match(/^(.*?)\s*([\d,]+(?:\.\d+)?)\s*(?:บาท)?$/);
  if (!amountMatch) return null;
  const name = amountMatch[1].trim();
  const amount = Number(amountMatch[2].replace(/,/g, ""));
  if (!name || !Number.isFinite(amount) || amount <= 0) return null;
  if (dayOfMonth > 31) return null;
  return { name, amount, dayOfMonth };
}

export function matchRecurringCommand(text: string): Handler | null {
  const trimmed = text.trim();
  const normalized = trimmed.replace(/[?？!]/g, "").trim();

  if (LIST_PHRASES.includes(normalized)) return (ctx) => answerRecurringList(ctx);

  const setMatch = trimmed.match(SET_RE);
  if (setMatch) {
    const parsed = parseRecurringInput(setMatch[1]);
    if (!parsed) {
      return async () =>
        'พิมพ์แบบนี้ได้เลยนะ "ตั้งค่าใช้จ่ายประจำ ค่าเน็ต 599" หรือใส่วันครบกำหนดด้วย "ตั้งค่าใช้จ่ายประจำ ค่าเช่าบ้าน 6000 ทุกวันที่ 5"';
    }
    return (ctx) => promptRecurringSet(ctx, parsed.name, parsed.amount, parsed.dayOfMonth);
  }

  const deleteMatch = trimmed.match(DELETE_RE);
  if (deleteMatch) {
    const name = deleteMatch[1].trim();
    if (name) return (ctx) => promptRecurringDelete(ctx, name);
  }

  // Checked last of the three. "จ่าย...แล้ว" is a looser shape than the
  // prefixes above, and promptRecurringPaid answers "I don't know that one"
  // for anything not on the list — so an ordinary sentence that happens to
  // fit gets a harmless reply rather than a wrong action.
  const paidMatch = trimmed.match(PAID_RE);
  if (paidMatch) {
    const name = paidMatch[1].trim();
    if (name) return (ctx) => promptRecurringPaid(ctx, name);
  }

  return null;
}
