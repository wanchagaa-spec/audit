// "Undo my last entry" for money transactions: "ลบรายการล่าสุด" /
// "ยกเลิกรายการล่าสุด". Added after a real user tried "ยกเลิกรายการล่าสุด"
// expecting to undo a wrongly-recorded expense — no such command existed
// yet, and the phrase happened to contain "รายการล่าสุด" as a substring, so
// commands.ts's substring-matched "recent transactions" report handler fired
// instead and just showed a list, doing nothing. Checked ahead of that
// report handler in index.ts so this always wins for these exact phrases.

import { categoryLabel, formatBaht } from "./commands.ts";
import { deleteMostRecentTransaction, readAllTransactions } from "./sheets.ts";
import { setPendingConfirmation, type ActionCtx } from "./state.ts";

type Handler = (ctx: ActionCtx) => Promise<string>;

const DELETE_LAST_PHRASES = ["ลบรายการล่าสุด", "ยกเลิกรายการล่าสุด", "ลบรายการที่แล้ว", "ยกเลิกรายการที่แล้ว"];

export async function matchTransactionCommand(text: string): Promise<Handler | null> {
  const trimmed = text.trim();

  if (DELETE_LAST_PHRASES.includes(trimmed)) {
    return async (ctx) => {
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
