// The buttons LINE shows above the keyboard (PLAN.md 17.82).
//
// This existed as a promise and nothing else. chatEngine.ts's askCategory has
// always said "เลือกจากปุ่มด้านล่าง" and always set `quickReplyCategories`,
// and nothing in the codebase ever read that field or sent a `quickReply` to
// LINE — grep found the declaration, the assignment, and no third line. The
// bot has been telling people to press buttons that were never rendered.
//
// **Derived from state, never from the reply text.** The tempting shortcut is
// to look at the outgoing message and attach ใช่/ยกเลิก when it ends in
// `(พิมพ์ "ใช่" เพื่อยืนยัน)`. That would be a matcher on prose that
// applyPersona is allowed to rewrite, and this codebase has already paid for
// that kind of coupling twice (PLAN.md 17.11, 17.72). What is actually being
// asked is recorded in KV by the handler that asked it, so that is what
// decides.

import { DEFAULT_CATEGORIES } from "./categories.ts";
import type { PendingClarification } from "./chatEngine.ts";
import type { PendingConfirmation } from "./state.ts";

export interface QuickReplyItem {
  /** What the button says. */
  label: string;
  /** What gets sent when it is pressed. */
  text: string;
}

/** LINE renders at most 13 buttons and truncates a label past 20 characters.
 * Both are enforced here rather than trusted: a 14th item makes LINE reject
 * the whole message, which would turn a cosmetic feature into silence. */
const MAX_ITEMS = 13;
const MAX_LABEL = 20;

export function clampItems(items: QuickReplyItem[]): QuickReplyItem[] {
  return items.slice(0, MAX_ITEMS).map((item) => ({
    label: item.label.length > MAX_LABEL ? item.label.slice(0, MAX_LABEL) : item.label,
    text: item.text,
  }));
}

const YES_NO: QuickReplyItem[] = [
  { label: "✅ ใช่", text: "ใช่" },
  { label: "❌ ยกเลิก", text: "ยกเลิก" },
];

function categoryItems(type: "income" | "expense"): QuickReplyItem[] {
  return DEFAULT_CATEGORIES.filter((c) => c.type === type).map((c) => ({
    // The label carries the icon because that is what makes a list of eleven
    // Thai category names scannable at a glance; the text does not, because
    // the category matcher works on names.
    label: `${c.icon} ${c.name}`,
    text: c.name,
  }));
}

/**
 * The buttons for whatever the bot is currently waiting on, or none.
 *
 * A pending confirmation wins over a pending clarification: the two share no
 * slot, but a confirmation is the more recent question whenever both exist,
 * and "ใช่/ยกเลิก" answers it while a category name does not.
 *
 * `amount` and `appointmentTime` deliberately get nothing. Both want a number
 * that only the person knows, and a row of guesses ("100? 200?") is worse
 * than an empty keyboard — it invites a wrong tap on the one thing this bot
 * makes people confirm precisely because getting it wrong is expensive.
 */
export function quickRepliesFor(
  confirmation: PendingConfirmation | null,
  clarification: PendingClarification | null
): QuickReplyItem[] | undefined {
  if (confirmation) return YES_NO;
  if (clarification?.kind === "category") return clampItems(categoryItems(clarification.type));
  return undefined;
}
