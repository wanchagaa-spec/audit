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

function handleFreshMessage(text: string, categories: Category[]): ChatEngineResult {
  if (isGreeting(text)) {
    return { botMessage: HELP_MESSAGE, pending: null };
  }

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
