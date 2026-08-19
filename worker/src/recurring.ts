// Pure helpers for recurring monthly bills (PLAN.md 17.59): joining bills to
// this month's payment records, totalling them, and formatting the block the
// month summary appends.
//
// Separate from recurringCommands.ts so commands.ts can build that block
// without importing the command layer — which imports commands.ts back for
// its own replies. Nothing here reads or writes anything; it is all
// computation over rows the caller already has, which is also what makes it
// straightforward to test directly.

import { formatBaht } from "./format.ts";
import type { RecurringPaidRow, RecurringRow } from "./sheets.ts";

export interface RecurringStatus {
  entry: RecurringRow;
  paid: boolean;
}

/** Joins bills to this month's payment records. Kept separate from the
 * formatting so the chat summary, the list command and the web page all
 * answer from the same computation rather than three near-copies. */
export function buildRecurringStatus(
  recurring: RecurringRow[],
  paid: RecurringPaidRow[],
  month: string
): RecurringStatus[] {
  const paidIds = new Set(paid.filter((p) => p.month === month).map((p) => p.recurringId));
  return (
    recurring
      .map((entry) => ({ entry, paid: paidIds.has(entry.id) }))
      // Unpaid first, then by due day, then by name: the list exists to
      // answer "what do I still owe", so what is still owed goes at the top,
      // and within that the soonest due is the most urgent.
      .sort((a, b) => {
        if (a.paid !== b.paid) return a.paid ? 1 : -1;
        // Day 0 means "no day given" and sorts last among its group rather
        // than first, which is where a literal 0 would put it.
        const dayA = a.entry.dayOfMonth || 99;
        const dayB = b.entry.dayOfMonth || 99;
        if (dayA !== dayB) return dayA - dayB;
        return a.entry.name.localeCompare(b.entry.name, "th");
      })
  );
}

export function recurringTotals(status: RecurringStatus[]): { total: number; paid: number; unpaid: number } {
  let total = 0;
  let paid = 0;
  for (const s of status) {
    total += s.entry.amount;
    if (s.paid) paid += s.entry.amount;
  }
  return { total, paid, unpaid: total - paid };
}

export function dueLabel(entry: RecurringRow): string {
  return entry.dayOfMonth > 0 ? ` (ทุกวันที่ ${entry.dayOfMonth})` : "";
}

/**
 * The block appended to "สรุปเดือนนี้" (PLAN.md 17.59).
 *
 * Returns an empty array when nothing is set up, so the summary is byte-for
 * -byte what it always was for anyone not using this. That matters more than
 * it looks: the summary is the most-read message this bot sends, and a
 * feature nobody opted into should not change it at all.
 */
export function recurringSummaryBlock(status: RecurringStatus[]): string[] {
  if (status.length === 0) return [];
  const { total, unpaid } = recurringTotals(status);
  const outstanding = status.filter((s) => !s.paid);

  const lines = ["", `ค่าใช้จ่ายประจำเดือนนี้: ${formatBaht(total)} บาท`];
  if (outstanding.length === 0) {
    lines.push("จ่ายครบแล้วทุกรายการ 🎉");
    return lines;
  }
  // Names, not just a figure: "ยังไม่จ่าย 2,500" makes you go and look up
  // which two, which is the work this block exists to save.
  const names = outstanding.map((s) => `${s.entry.name}${dueLabel(s.entry)}`).join(", ");
  lines.push(`ยังไม่จ่าย ${formatBaht(unpaid)} บาท — ${names}`);
  return lines;
}
