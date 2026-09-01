// Single dispatcher for the "ใช่ / ยกเลิก" confirmation slot shared by trip
// switching, calendar create/edit/delete, diary entries, and transaction
// create/delete. A decline (anything not affirmative) clears the pending
// state immediately, so a stale question can never be re-triggered by an
// unrelated later "ใช่". A confirmation only clears it after the apply step
// actually succeeds — see resolveConfirmation's own comment for why.

import { applyBudgetDelete, applyBudgetSet } from "./budgetCommands.ts";
import { applyCalendarCreate, applyCalendarDelete, applyCalendarEdit } from "./calendarCommands.ts";
import { applyDiaryCreate } from "./diaryCommands.ts";
import { applyEmailSend } from "./gmailCommands.ts";
import { applyRecurringDelete, applyRecurringPaid, applyRecurringSet } from "./recurringCommands.ts";
import { setPendingConfirmation, type ActionCtx, type PendingConfirmation } from "./state.ts";
import { applyTaskComplete, applyTaskCreate, applyTaskDelete } from "./taskCommands.ts";
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
/**
 * An explicit "no", as opposed to merely not saying yes.
 *
 * Both clear the pending question — resolveConfirmation already does that
 * for anything non-affirmative. The difference is what the user is told
 * afterwards: answering "ยกเลิก" to a confirmation used to clear the draft
 * and then hand the word to the interpreter as a fresh message, which
 * replied "ยกเลิกอะไรคะ" (PLAN.md 17.75). The cancel had worked; the answer
 * said it had not, which is the one thing worse than not cancelling.
 *
 * Same particle-stripping as isAffirmative, for the same reason: real Thai
 * carries "ครับ"/"ค่ะ" and an exact-match list without it rejects most
 * genuine replies.
 */
const NEGATIVE = ["ไม่", "ไม่ใช่", "ยกเลิก", "ไม่เอา", "ไม่ต้อง", "no", "cancel", "ยัง"];

export function isExplicitCancel(text: string): boolean {
  let trimmed = text.trim().toLowerCase();
  for (const suffix of POLITE_SUFFIXES) {
    if (trimmed.endsWith(suffix)) {
      trimmed = trimmed.slice(0, -suffix.length).trim();
      break;
    }
  }
  // "แล้ว" rides on the end of nearly every spoken refusal —
  // "ไม่ต้องแล้วค่ะ", "ไม่เอาแล้ว" — so it is stripped as well rather than
  // listing each combination. Safe to be looser here than isAffirmative is:
  // a non-affirmative reply has already cleared the draft by this point, so
  // this decides only what the user is *told*. Reading a cancel where there
  // was none costs a slightly wrong sentence; missing one costs the
  // "ยกเลิกอะไรคะ" that started this.
  if (trimmed.endsWith("แล้ว")) trimmed = trimmed.slice(0, -"แล้ว".length).trim();
  return NEGATIVE.includes(trimmed);
}

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
  pending: PendingConfirmation,
  // Filled in with the draft this function chose to leave in place, so the
  // caller can finish the job. Recorded here rather than by the caller
  // because this is where the choice is made — a second copy of the rule
  // there drifted out of step with this one within a single phase
  // (PLAN.md 17.88).
  deferred?: { pending: PendingConfirmation | null }
): Promise<string | null> {
  if (!isAffirmative(text)) {
    // A money draft is *not* dropped here (PLAN.md 17.84). Two expenses
    // typed one after the other used to lose the first one silently: the
    // second message is not an answer, so this cleared the draft before
    // promptTransactionCreate could merge it (17.83), and "ใช่" saved only
    // the newer one. The same loss the two-slips report was about, reached
    // by typing — and by voice, which arrives here as text.
    //
    // Left in place instead, so the money path downstream can absorb it.
    // Whoever asked for it is responsible for clearing it if the message
    // turns out to be about something else — see finalizeDeferredDraft in
    // index.ts, which is what stops a forgotten draft from being confirmed
    // by a later stray "ใช่".
    //
    // An explicit "ยกเลิก" is still a real answer and still clears: the
    // person said no.
    if (pending.kind === "transactionCreate" && !isExplicitCancel(text)) {
      if (deferred) deferred.pending = pending;
      return null;
    }
    await setPendingConfirmation(ctx.kv, ctx.lineUserId, null);
    return null;
  }

  // Only cleared *after* the apply step succeeds (below), not before —
  // found in review: clearing it first meant a transient failure while
  // actually saving (a Sheets/Calendar API hiccup, a token issue) threw
  // away the pending draft along with the error, forcing the user to
  // retype the whole entry to try again. Leaving it in place on failure
  // means a retried "ใช่" self-heals: it re-enters this same function and
  // just tries the apply step again, using the TTL in state.ts to expire
  // it naturally if nobody ever retries.
  const result = await applyPendingConfirmation(ctx, pending);
  await setPendingConfirmation(ctx.kv, ctx.lineUserId, null);
  return result;
}

function applyPendingConfirmation(ctx: ActionCtx, pending: PendingConfirmation): Promise<string> {
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
    case "taskCreate":
      return applyTaskCreate(ctx, pending);
    case "taskComplete":
      return applyTaskComplete(ctx, pending);
    case "taskDelete":
      return applyTaskDelete(ctx, pending);
    case "emailSend":
      return applyEmailSend(ctx, pending);
    case "budgetSet":
      return applyBudgetSet(ctx, pending);
    case "budgetDelete":
      return applyBudgetDelete(ctx, pending);
    case "recurringSet":
      return applyRecurringSet(ctx, pending);
    case "recurringDelete":
      return applyRecurringDelete(ctx, pending);
    case "recurringPaid":
      return applyRecurringPaid(ctx, pending);
    case "transactionDeleteLast":
      return applyTransactionDeleteLast(ctx);
    case "transactionCreate":
      return applyTransactionCreate(ctx, pending);
  }
}
