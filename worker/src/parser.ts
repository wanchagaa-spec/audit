// Turns a line of Thai chat into an amount, a direction and a category.
// Moved here from the React PWA (app/src/lib/parser.ts) when the PWA was
// removed (PLAN.md 17.46); the Worker was always its main caller.
import { INCOME_SIGNAL_WORDS, type Category, type EntryType } from "./categories.ts";

const AMOUNT_PATTERN = /\d+(?:,\d{3})*(?:\.\d+)?/;

export function detectType(text: string): EntryType {
  const lower = text.toLowerCase();
  return INCOME_SIGNAL_WORDS.some((w) => lower.includes(w.toLowerCase()))
    ? "income"
    : "expense";
}

export function extractAmount(text: string): number | null {
  const match = text.match(AMOUNT_PATTERN);
  if (!match) return null;
  const value = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function matchCategory(
  text: string,
  categories: Category[],
  type: EntryType
): Category | undefined {
  const lower = text.toLowerCase();
  const candidates = categories.filter((c) => c.type === type && c.keywords.length > 0);
  return candidates.find((c) => c.keywords.some((k) => lower.includes(k.toLowerCase())));
}

export type ParseResult =
  | {
      status: "ok";
      amount: number;
      type: EntryType;
      categoryId: string;
      note: string;
    }
  | {
      status: "need_amount";
      type: EntryType;
      categoryId?: string;
      note: string;
    }
  | {
      status: "need_category";
      amount: number;
      type: EntryType;
      note: string;
    }
  | {
      /** Not about money at all, as far as this parser can tell (PLAN.md
       * 17.55). Distinct from need_amount, which means "clearly a purchase,
       * just missing the figure". */
      status: "unknown";
    };

// Words that mark a message as a question or a request rather than a record
// of something bought (PLAN.md 17.55). Kept deliberately narrow: these are
// the ones that essentially never appear in a note someone writes while
// logging an expense.
//
// "อะไร", "กี่" and "เท่าไหร่" are *excluded* on purpose despite being
// obvious interrogatives — they turn up inside real notes ("ซื้ออะไรไม่รู้
// 200") and inside the report phrasings that matchCommand handles before
// this is ever reached. A guard that swallows genuine entries would be a
// worse bug than the one it fixes.
const QUESTION_MARKERS = ["ไหม", "มั้ย", "หรือเปล่า", "รึเปล่า", "ยังไง", "อย่างไร", "ทำไม", "ที่ไหน", "เมื่อไหร่", "ใคร", "?", "？"];

/** A request phrased as one. "ขอ"/"ช่วย" need "หน่อย" alongside them, since
 * either word alone turns up in ordinary notes; "แนะนำ" and "อยาก" are
 * request words on their own — "แนะนำร้านอาหารหน่อย" and "อยากกินข้าว" both
 * match a food category and neither is a purchase.
 *
 * This is a heuristic and will never be exact. It errs toward "I don't
 * understand", which the user can fix by rephrasing, over "how much?", which
 * is the confusing answer this whole guard exists to stop. */
function looksLikeRequest(lower: string): boolean {
  const trimmed = lower.trim();
  if (/^(?:ขอ|ช่วย)/.test(trimmed) && lower.includes("หน่อย")) return true;
  return lower.includes("แนะนำ") || trimmed.startsWith("อยาก");
}

// Words that say a message is about money even when it matches no category.
// "ฝากเงิน" and "ซื้อของ" are the cases that forced this: both are plainly
// spending intents, neither lands on a category keyword, and both should
// still be asked for a figure rather than told the bot doesn't understand.
const MONEY_WORDS = ["เงิน", "บาท", "จ่าย", "ซื้อ", "ค่า", "ฝาก", "ถอน", "โอน", "รายรับ", "รายจ่าย", "ผ่อน", "ค่าใช้จ่าย"];

function mentionsMoney(lower: string): boolean {
  return MONEY_WORDS.some((w) => lower.includes(w));
}

function looksLikeQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  return QUESTION_MARKERS.some((m) => lower.includes(m)) || looksLikeRequest(lower);
}

export function parseMessage(text: string, categories: Category[]): ParseResult {
  const type = detectType(text);
  const amount = extractAmount(text);
  const category = matchCategory(text, categories, type);

  if (amount === null) {
    // No figure *and* nothing that looks like a thing you spend money on.
    // This used to fall through to need_amount, which made "how much?" the
    // bot's answer to every message it didn't otherwise understand — a real
    // user asked for their contacts and was asked for an amount (PLAN.md
    // 17.55). Asking the price of a question the bot simply didn't follow is
    // worse than admitting it didn't follow it.
    //
    // `type` alone isn't enough of a signal to keep: detectType returns
    // "expense" for anything without an income word in it, which is almost
    // every sentence in the language.
    // A question or a request is never a purchase, whatever words it
    // contains — "ช่วยแนะนำหนังหน่อย" matches the entertainment category on
    // "หนัง" and is plainly not spending.
    if (looksLikeQuestion(text)) return { status: "unknown" };
    // Otherwise it needs *some* reason to be read as money: a category
    // keyword, or a money word for the intents that match no category
    // ("ฝากเงิน", "ซื้อของ"). Without either, "how much?" would be the
    // bot's answer to every sentence it didn't understand, which is the bug
    // this exists to stop.
    if (!category && !mentionsMoney(text.toLowerCase())) return { status: "unknown" };
    return { status: "need_amount", type, categoryId: category?.id, note: text };
  }
  if (!category) {
    // A figure with no category, in something worded as a question:
    // "หาค่าเฉลี่ยของ 4,5,9,3 ได้มั้ย" is arithmetic, not spending. Asking
    // which category to file it under is a dead end nobody can answer.
    if (looksLikeQuestion(text)) return { status: "unknown" };
    return { status: "need_category", amount, type, note: text };
  }
  return { status: "ok", amount, type, categoryId: category.id, note: text };
}
