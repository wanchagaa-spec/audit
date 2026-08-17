// "Undo my last entry" for money transactions: "ลบรายการล่าสุด" /
// "ยกเลิกรายการล่าสุด". Added after a real user tried "ยกเลิกรายการล่าสุด"
// expecting to undo a wrongly-recorded expense — no such command existed
// yet, and the phrase happened to contain "รายการล่าสุด" as a substring, so
// commands.ts's substring-matched "recent transactions" report handler fired
// instead and just showed a list, doing nothing. Checked ahead of that
// report handler in index.ts so this always wins for these exact phrases.

import type { TransactionDraft } from "./chatEngine.ts";
import { buildBudgetStatusLines } from "./budgetCommands.ts";
import { categoryLabel, formatBaht } from "./commands.ts";
import { appendTransaction, deleteMostRecentTransaction, readAllTransactions } from "./sheets.ts";
import { setPendingConfirmation, type ActionCtx, type TransactionAttribution } from "./state.ts";
import { bangkokDateKey } from "./thaiDate.ts";

type Handler = (ctx: ActionCtx) => Promise<string>;

function formatDraftLine(d: TransactionDraft): string {
  const sign = d.type === "income" ? "+" : "-";
  return `${sign}${formatBaht(d.amount)} บาท ${categoryLabel(d.categoryId)}${d.note ? ` — ${d.note}` : ""}`;
}

const DELETE_LAST_PHRASES = ["ลบรายการล่าสุด", "ยกเลิกรายการล่าสุด", "ลบรายการที่แล้ว", "ยกเลิกรายการที่แล้ว"];

export async function matchTransactionCommand(text: string): Promise<Handler | null> {
  const trimmed = text.trim();

  if (DELETE_LAST_PHRASES.includes(trimmed)) {
    return async (ctx) => {
      // Whole tab on purpose (PLAN.md 17.47): the most recent row overall,
      // which on the 1st of a month is still last month's. It also has to
      // agree with deleteMostRecentTransaction, which reads the whole tab
      // too — a prompt naming a different row than the one deleted would be
      // the worst possible bug here.
      const all = await readAllTransactions(ctx.accessToken, ctx.spreadsheetId);
      if (all.length === 0) return "ยังไม่มีรายการเลยนะ ไม่มีอะไรให้ลบ";
      const mostRecent = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const sign = mostRecent.type === "income" ? "+" : "-";
      await setPendingConfirmation(ctx.kv, ctx.lineUserId, { kind: "transactionDeleteLast" });
      return `จะลบรายการล่าสุด: ${categoryLabel(mostRecent.categoryId)} ${sign}${formatBaht(mostRecent.amount)} บาท (${mostRecent.rawText || mostRecent.note}) ใช่ไหม? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
    };
  }

  return null;
}

export async function applyTransactionDeleteLast(ctx: ActionCtx): Promise<string> {
  const deleted = await deleteMostRecentTransaction(ctx.accessToken, ctx.spreadsheetId);
  if (!deleted) return "ไม่มีรายการให้ลบแล้วนะ";
  const sign = deleted.type === "income" ? "+" : "-";
  return `ลบรายการล่าสุดแล้ว: ${categoryLabel(deleted.categoryId)} ${sign}${formatBaht(deleted.amount)} บาท`;
}

// PLAN.md 17.9: money logging asks to confirm before saving now, even for a
// perfectly unambiguous message — requested explicitly (numbers, or
// anything about to be written, must always be confirmed first). Called
// from index.ts's handleTextMessage/handleGroupTextMessage right where
// chatEngine.ts hands back a ready-to-save draft, instead of appending it
// straight to the sheet the way it used to.
export async function promptTransactionCreate(
  ctx: { kv: KVNamespace; lineUserId: string },
  drafts: TransactionDraft[],
  rawText: string,
  attribution: TransactionAttribution
): Promise<string> {
  await setPendingConfirmation(ctx.kv, ctx.lineUserId, { kind: "transactionCreate", drafts, rawText, attribution });
  if (drafts.length === 1) {
    const d = drafts[0];
    const verb = d.type === "income" ? "รายรับ" : "รายจ่าย";
    const noteSuffix = d.note ? ` ("${d.note}")` : "";
    return `จะบันทึก${verb} ${formatBaht(d.amount)} บาท หมวด ${categoryLabel(d.categoryId)}${noteSuffix} ใช่ไหม? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
  }
  return [`จะบันทึก ${drafts.length} รายการนี้ ใช่ไหม?`, ...drafts.map(formatDraftLine), '(พิมพ์ "ใช่" เพื่อยืนยัน)'].join("\n");
}

export async function applyTransactionCreate(
  ctx: ActionCtx,
  pending: { drafts: TransactionDraft[]; rawText: string; attribution: TransactionAttribution }
): Promise<string> {
  const now = new Date().toISOString();
  // Bangkok-local, not `now.slice(0, 10)`. UTC is seven hours behind, so an
  // expense logged between midnight and 07:00 was stamped with yesterday's
  // date — and on the 1st of a month it landed in the *previous* month,
  // where it counted toward neither "สรุปเดือนนี้" nor this month's budget.
  // diaryCommands.ts already did this correctly; the money path, of all
  // things, was the one still on UTC.
  const dateKey = bangkokDateKey(new Date(now));
  // Ids are minted up front rather than inline in the append, because the
  // budget lookup below needs to know which rows this save is writing.
  const rows = pending.drafts.map((draft) => ({
    id: crypto.randomUUID(),
    date: dateKey,
    type: draft.type,
    amount: draft.amount,
    categoryId: draft.categoryId,
    note: draft.note,
    rawText: pending.rawText,
    addedBy: pending.attribution.addedBy,
    addedByName: pending.attribution.addedByName,
    createdAt: now,
  }));
  const saved = Promise.all(rows.map((row) => appendTransaction(ctx.accessToken, ctx.spreadsheetId, row)));

  // Where this leaves the budget, if there is one for the category just
  // spent in (PLAN.md 17.44). Started here, in parallel with the appends
  // above, instead of awaiting them first: it's a Sheets round trip of its
  // own, and running it after the save made logging an expense visibly
  // slower for the people who use budgets — the exact feature it exists to
  // serve. buildBudgetStatusLines takes the rows being written so it can
  // reconcile whichever side of the appends the read lands on (PLAN.md
  // 17.45).
  //
  // Best-effort on purpose: the money is saved either way, and a Sheets
  // hiccup while looking up a limit must never turn a successful save into
  // an error the user has to interpret.
  const budgetLinesPromise = buildBudgetStatusLines(
    ctx,
    rows.filter((r) => r.type === "expense")
  ).catch((err) => {
    console.error("applyTransactionCreate: budget status lookup failed, saved anyway", err);
    return [] as string[];
  });

  // Awaited first, and separately: a failed append must still throw, so
  // resolveConfirmation keeps the pending draft alive for a retry rather
  // than reporting a save that never happened.
  await saved;
  const budgetLines = await budgetLinesPromise;
  const withBudget = (text: string) => (budgetLines.length > 0 ? [text, ...budgetLines].join("\n") : text);

  if (pending.drafts.length === 1) {
    const d = pending.drafts[0];
    const verb = d.type === "income" ? "รายรับ" : "รายจ่าย";
    return withBudget(`บันทึก${verb} ${formatBaht(d.amount)} บาท หมวด ${categoryLabel(d.categoryId)} ให้แล้วนะ`);
  }
  const totalExpense = pending.drafts.filter((d) => d.type === "expense").reduce((s, d) => s + d.amount, 0);
  const totalIncome = pending.drafts.filter((d) => d.type === "income").reduce((s, d) => s + d.amount, 0);
  const totalParts = [
    totalExpense > 0 ? `รายจ่ายรวม ${formatBaht(totalExpense)} บาท` : null,
    totalIncome > 0 ? `รายรับรวม ${formatBaht(totalIncome)} บาท` : null,
  ].filter((p): p is string => p !== null);
  return withBudget(
    [
      `บันทึกให้แล้ว ${pending.drafts.length} รายการ:`,
      ...pending.drafts.map(formatDraftLine),
      totalParts.join(" / "),
    ].join("\n")
  );
}
