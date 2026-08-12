import type { Category, EntryType } from "../types";
import { detectType, extractAmount, matchCategory, parseMessage } from "./parser";

export type PendingClarification =
  | { kind: "amount"; type: EntryType; categoryId?: string; note: string }
  | { kind: "category"; amount: number; type: EntryType; note: string };

export interface TransactionDraft {
  amount: number;
  type: EntryType;
  categoryId: string;
  note: string;
}

export interface ChatEngineResult {
  transactionDraft?: TransactionDraft;
  // Set instead of transactionDraft when one message contained several
  // separate items (see parseMultilineTransactions) — callers that don't
  // know about batches yet can keep checking transactionDraft alone and
  // just won't see these, but both worker/src/index.ts and AppContext.tsx
  // check this field too so nothing is silently dropped.
  transactionDrafts?: TransactionDraft[];
  botMessage: string;
  pending: PendingClarification | null;
  quickReplyCategories?: Category[];
}

const GREETINGS = new Set([
  "สวัสดี", "สวัสดีครับ", "สวัสดีค่ะ", "หวัดดี", "หวัดดีครับ", "หวัดดีค่ะ",
  "ดีครับ", "ดีค่ะ", "hello", "hi", "hey", "เริ่ม", "start", "วิธีใช้", "help", "ช่วยด้วย",
]);

const HELP_MESSAGE =
  "สวัสดีค่ะ พิมพ์รายการที่เกิดขึ้นได้เลย เช่น \"ซื้อกาแฟ 60\" หรือ \"เงินเดือนเข้า 25000\" ฉันจะช่วยจดให้อัตโนมัติ";

export function isGreeting(text: string): boolean {
  return GREETINGS.has(text.trim().toLowerCase());
}

function formatAmount(n: number): string {
  return n.toLocaleString("th-TH", { maximumFractionDigits: 2 });
}

function okResult(draft: TransactionDraft, categories: Category[]): ChatEngineResult {
  const category = categories.find((c) => c.id === draft.categoryId);
  const verb = draft.type === "income" ? "รายรับ" : "รายจ่าย";
  return {
    transactionDraft: draft,
    botMessage: `บันทึก${verb} ${formatAmount(draft.amount)} บาท หมวด ${category?.icon ?? ""} ${category?.name ?? ""} ให้แล้วนะ`,
    pending: null,
  };
}

function askAmount(type: EntryType, categoryId: string | undefined, note: string): ChatEngineResult {
  return {
    botMessage: "จำนวนเงินเท่าไหร่คะ",
    pending: { kind: "amount", type, categoryId, note },
  };
}

function askCategory(
  amount: number,
  type: EntryType,
  note: string,
  categories: Category[]
): ChatEngineResult {
  const options = categories.filter((c) => c.type === type);
  return {
    botMessage: "จัดเป็นหมวดไหนดี เลือกจากปุ่มด้านล่าง หรือพิมพ์ชื่อหมวดก็ได้",
    pending: { kind: "category", amount, type, note },
    quickReplyCategories: options,
  };
}

export function handleUserMessage(
  text: string,
  pending: PendingClarification | null,
  categories: Category[]
): ChatEngineResult {
  if (!pending) {
    return handleFreshMessage(text, categories);
  }

  if (pending.kind === "amount") {
    const amount = extractAmount(text);
    if (amount !== null) {
      // Re-detect type from the combined context instead of trusting the
      // guess from the first (possibly amount-less, ambiguous) message —
      // e.g. "สวัสดี" alone defaults to expense, but "สวัสดี" + "เงินเข้า
      // 16000" should resolve as income.
      const combinedNote = `${pending.note} ${text}`.trim();
      const type = detectType(combinedNote);
      const category = matchCategory(combinedNote, categories, type);
      if (!category) {
        return askCategory(amount, type, pending.note, categories);
      }
      return okResult({ amount, type, categoryId: category.id, note: pending.note }, categories);
    }
    // Reply didn't look like an amount answer — treat as a brand new message.
    return handleFreshMessage(text, categories);
  }

  // pending.kind === "category"
  const trimmed = text.trim();
  const found =
    categories.find((c) => c.type === pending.type && c.name.trim() === trimmed) ??
    matchCategory(text, categories, pending.type) ??
    // The reply might reveal this was actually the other type all along
    // (e.g. answering "เงินเดือน" to a question asked under "expense") —
    // check by exact name across all categories, then by keyword under the
    // opposite type, before giving up.
    categories.find((c) => c.name.trim() === trimmed) ??
    matchCategory(text, categories, pending.type === "income" ? "expense" : "income");

  if (found) {
    return okResult(
      { amount: pending.amount, type: found.type, categoryId: found.id, note: pending.note },
      categories
    );
  }

  // Doesn't match any category — try the reply combined with what's already
  // known (note + amount) as a brand new message, so progress isn't lost.
  return handleFreshMessage(`${pending.note} ${pending.amount} ${text}`.trim(), categories);
}

// A batch needs at least this many lines that each independently look like
// a money item before it's treated as several entries instead of one — a
// single expense whose note happens to wrap onto a second line (e.g. one
// amount plus a stray descriptive line) should still go through the normal
// single-item flow below, using the whole text as its note like before.
const MIN_MULTILINE_ITEMS = 2;

// "อื่น ๆ" is always seeded into every account's category list (PLAN.md 5) —
// falling back to the first category of the right type is defensive only,
// for the hypothetical case it's ever missing, so this never returns
// undefined and silently drops a whole line.
function otherCategoryId(categories: Category[], type: EntryType): string {
  const defaultOtherId = type === "income" ? "other-income" : "other-expense";
  if (categories.some((c) => c.id === defaultOtherId)) return defaultOtherId;
  return categories.find((c) => c.type === type)?.id ?? defaultOtherId;
}

// Regression fix for a real report: sending several items in one message,
// one per line (e.g. "อเมริกาโน่ 50\nลาเต้ 40\nเค้ก 80"), used to be logged
// as a *single* transaction — extractAmount only ever finds the first
// number in the whole text, and the rest of the lines just became part of
// that one transaction's note, silently dropping every amount after the
// first. Detects the common case (most lines each contain their own
// amount) and logs each qualifying line as its own transaction instead.
//
// There's no way to ask a per-line clarifying question here (only one
// PendingClarification slot exists at a time, and blocking a whole batch on
// one ambiguous line would bring back exactly the silent-loss problem this
// exists to fix) — so a line with an amount but no keyword-matched category
// gets filed under "อื่น ๆ" rather than asked about, and the summary reply
// says how many were filed that way so nothing is quietly miscategorized
// without at least a mention. Lines with no amount at all are skipped and
// listed separately, on the assumption they're stray text, not a purchase.
function parseMultilineTransactions(text: string, categories: Category[]): ChatEngineResult | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < MIN_MULTILINE_ITEMS) return null;

  const itemLines = lines.filter((l) => extractAmount(l) !== null);
  if (itemLines.length < MIN_MULTILINE_ITEMS) return null;

  const drafts: TransactionDraft[] = [];
  let uncategorizedCount = 0;
  for (const line of itemLines) {
    const result = parseMessage(line, categories);
    if (result.status === "need_amount") continue; // can't happen — itemLines was filtered by extractAmount above
    if (result.status === "ok") {
      drafts.push({ amount: result.amount, type: result.type, categoryId: result.categoryId, note: result.note });
    } else {
      uncategorizedCount++;
      drafts.push({
        amount: result.amount,
        type: result.type,
        categoryId: otherCategoryId(categories, result.type),
        note: result.note,
      });
    }
  }

  const skippedLines = lines.filter((l) => extractAmount(l) === null);

  const itemSummaries = drafts.map((d) => {
    const category = categories.find((c) => c.id === d.categoryId);
    const sign = d.type === "income" ? "+" : "-";
    return `${sign}${formatAmount(d.amount)} บาท ${category?.icon ?? ""} ${category?.name ?? ""} — ${d.note}`;
  });
  const totalExpense = drafts.filter((d) => d.type === "expense").reduce((s, d) => s + d.amount, 0);
  const totalIncome = drafts.filter((d) => d.type === "income").reduce((s, d) => s + d.amount, 0);
  const totalParts = [
    totalExpense > 0 ? `รายจ่ายรวม ${formatAmount(totalExpense)} บาท` : null,
    totalIncome > 0 ? `รายรับรวม ${formatAmount(totalIncome)} บาท` : null,
  ].filter((p): p is string => p !== null);

  const messageLines = [`บันทึกให้แล้ว ${drafts.length} รายการ:`, ...itemSummaries, totalParts.join(" / ")];
  if (uncategorizedCount > 0) {
    messageLines.push(`(${uncategorizedCount} รายการจัดหมวด "อื่น ๆ" ให้ก่อน แก้หมวดได้ทีหลังในแอป)`);
  }
  if (skippedLines.length > 0) {
    messageLines.push(`ข้ามไป ${skippedLines.length} บรรทัดที่ไม่มีจำนวนเงิน: ${skippedLines.join(", ")}`);
  }

  return { transactionDrafts: drafts, botMessage: messageLines.join("\n"), pending: null };
}

function handleFreshMessage(text: string, categories: Category[]): ChatEngineResult {
  if (isGreeting(text)) {
    return { botMessage: HELP_MESSAGE, pending: null };
  }

  const multiline = parseMultilineTransactions(text, categories);
  if (multiline) return multiline;

  const result = parseMessage(text, categories);
  if (result.status === "ok") {
    return okResult(
      {
        amount: result.amount,
        type: result.type,
        categoryId: result.categoryId,
        note: result.note,
      },
      categories
    );
  }
  if (result.status === "need_amount") {
    return askAmount(result.type, result.categoryId, result.note);
  }
  return askCategory(result.amount, result.type, result.note, categories);
}
