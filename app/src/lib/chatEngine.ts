import type { Category, EntryType } from "../types";
import { extractAmount, matchCategory, parseMessage } from "./parser";

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

function isPureNumericReply(text: string): boolean {
  return /^\s*\d{1,3}(,\d{3})*(\.\d+)?\s*(บาท)?\s*$/.test(text.trim());
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
    if (isPureNumericReply(text) || extractAmount(text) !== null) {
      const amount = extractAmount(text);
      if (amount !== null) {
        const combinedNote = `${pending.note} ${text}`.trim();
        const categoryId =
          pending.categoryId ?? matchCategory(combinedNote, categories, pending.type)?.id;
        if (!categoryId) {
          return askCategory(amount, pending.type, pending.note, categories);
        }
        return okResult(
          { amount, type: pending.type, categoryId, note: pending.note },
          categories
        );
      }
    }
    // Reply didn't look like an amount answer — treat as a brand new message.
    return handleFreshMessage(text, categories);
  }

  // pending.kind === "category"
  const trimmed = text.trim();
  const exact = categories.find(
    (c) => c.type === pending.type && c.name.trim() === trimmed
  );
  const byKeyword = exact ?? matchCategory(text, categories, pending.type);

  if (byKeyword) {
    return okResult(
      {
        amount: pending.amount,
        type: pending.type,
        categoryId: byKeyword.id,
        note: pending.note,
      },
      categories
    );
  }

  // Doesn't match any category — treat as a brand new message instead.
  return handleFreshMessage(text, categories);
}

function handleFreshMessage(text: string, categories: Category[]): ChatEngineResult {
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
