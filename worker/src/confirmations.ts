// Single dispatcher for the "ใช่ / ยกเลิก" confirmation slot shared by trip
// switching, calendar create/edit/delete, and diary entries. The pending
// state is always cleared as soon as it's read — whether the reply confirms
// or cancels — so a stale question can never be re-triggered by an unrelated
// later "ใช่".

import { applyCalendarCreate, applyCalendarDelete, applyCalendarEdit } from "./calendarCommands.ts";
import { applyDiaryCreate } from "./diaryCommands.ts";
import { setPendingConfirmation, type ActionCtx, type PendingConfirmation } from "./state.ts";
import { applyTransactionCreate, applyTransactionDeleteLast } from "./transactionCommands.ts";
import { applyTripSwitch } from "./tripCommands.ts";

const AFFIRMATIVE = ["ใช่", "ยืนยัน", "ตกลง", "โอเค", "ok", "yes", "y"];

// Longest first, so "นะครับ" strips as one suffix instead of leaving a
// dangling "ครับ" unstripped by a shorter match found first.
const POLITE_SUFFIXES = ["นะครับ", "นะคะ", "ครับผม", "ครับ", "ค่ะ", "คะ", "จ้า", "จ้ะ", "นะ"].sort(
  (a, b) => b.length - a.length
);

// A bare exact-match list used to reject "ใช่" outright for real replies
// like "ใช่ครับ"/"ใช่ค่ะ"/"โอเคจ้า" — natural Thai almost always carries a
// politeness particle, and a real user answering the bot's own "ใช่ไหม?"
// question with one of these got silently treated as a decline, quietly
// discarding whatever they'd just confirmed (money, a calendar event, a
// diary entry — PLAN.md 17.9 made this matter far more, since it's now on
// the path of every transaction, not just calendar/diary/delete). Strips
// one trailing particle before the exact-match check, rather than a looser
// substring/startsWith match, so unrelated text that happens to merely
// *contain* an affirmative word doesn't get misread as a confirmation.
export function isAffirmative(text: string): boolean {
  let trimmed = text.trim().toLowerCase();
  for (const suffix of POLITE_SUFFIXES) {
    if (trimmed.endsWith(suffix)) {
      trimmed = trimmed.slice(0, -suffix.length).trim();
      break;
    }
  }
  return AFFIRMATIVE.includes(trimmed);
}

/**
 * Resolves a pending confirmation. Returns null when the reply wasn't
 * affirmative, so the caller falls through and handles `text` as an ordinary
 * message instead (same convention as chatEngine's clarification flow).
 */
export async function resolveConfirmation(
  ctx: ActionCtx,
  text: string,
  pending: PendingConfirmation
): Promise<string | null> {
  await setPendingConfirmation(ctx.kv, ctx.lineUserId, null);
  if (!isAffirmative(text)) return null;

  switch (pending.kind) {
    case "tripSwitch":
      return applyTripSwitch(ctx, pending);
    case "calendarCreate":
      return applyCalendarCreate(ctx, pending);
    case "calendarDelete":
      return applyCalendarDelete(ctx, pending);
    case "calendarEdit":
      return applyCalendarEdit(ctx, pending);
    case "diaryCreate":
      return applyDiaryCreate(ctx, pending);
    case "transactionDeleteLast":
      return applyTransactionDeleteLast(ctx);
    case "transactionCreate":
      return applyTransactionCreate(ctx, pending);
  }
}
