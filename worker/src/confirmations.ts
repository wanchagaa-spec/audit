// Single dispatcher for the "ใช่ / ยกเลิก" confirmation slot shared by trip
// switching, calendar create/edit/delete, and diary entries. The pending
// state is always cleared as soon as it's read — whether the reply confirms
// or cancels — so a stale question can never be re-triggered by an unrelated
// later "ใช่".

import { applyCalendarCreate, applyCalendarDelete, applyCalendarEdit } from "./calendarCommands.ts";
import { applyDiaryCreate } from "./diaryCommands.ts";
import { setPendingConfirmation, type ActionCtx, type PendingConfirmation } from "./state.ts";
import { applyTripSwitch } from "./tripCommands.ts";

const AFFIRMATIVE = ["ใช่", "ยืนยัน", "ตกลง", "โอเค", "ok", "yes", "y"];

export function isAffirmative(text: string): boolean {
  return AFFIRMATIVE.includes(text.trim().toLowerCase());
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
  }
}
