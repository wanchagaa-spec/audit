import type { Category, EntryType } from "../types";
import { INCOME_SIGNAL_WORDS } from "../data/defaultCategories";

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
    };

export function parseMessage(text: string, categories: Category[]): ParseResult {
  const type = detectType(text);
  const amount = extractAmount(text);
  const category = matchCategory(text, categories, type);

  if (amount === null) {
    return { status: "need_amount", type, categoryId: category?.id, note: text };
  }
  if (!category) {
    return { status: "need_category", amount, type, note: text };
  }
  return { status: "ok", amount, type, categoryId: category.id, note: text };
}
