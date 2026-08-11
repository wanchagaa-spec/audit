import type { Category, Transaction } from "../types";

export function monthsBack(count: number, from = new Date()): string[] {
  const result: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(from.getFullYear(), from.getMonth() - i, 1);
    result.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return result;
}

export function monthOf(dateKey: string): string {
  return dateKey.slice(0, 7);
}

export interface CategorySlice {
  categoryId: string;
  name: string;
  icon: string;
  total: number;
}

export function expenseByCategory(
  transactions: Transaction[],
  categories: Category[],
  month: string
): CategorySlice[] {
  const totals = new Map<string, number>();
  for (const t of transactions) {
    if (t.type !== "expense" || monthOf(t.date) !== month) continue;
    totals.set(t.categoryId, (totals.get(t.categoryId) ?? 0) + t.amount);
  }
  return Array.from(totals.entries())
    .map(([categoryId, total]) => {
      const cat = categories.find((c) => c.id === categoryId);
      return { categoryId, name: cat?.name ?? "อื่น ๆ", icon: cat?.icon ?? "📦", total };
    })
    .sort((a, b) => b.total - a.total);
}

export interface MonthTotals {
  month: string;
  income: number;
  expense: number;
}

export function incomeExpenseByMonth(transactions: Transaction[], months: string[]): MonthTotals[] {
  return months.map((month) => {
    const income = transactions
      .filter((t) => t.type === "income" && monthOf(t.date) === month)
      .reduce((s, t) => s + t.amount, 0);
    const expense = transactions
      .filter((t) => t.type === "expense" && monthOf(t.date) === month)
      .reduce((s, t) => s + t.amount, 0);
    return { month, income, expense };
  });
}

export interface BalancePoint {
  date: string;
  balance: number;
}

export function cumulativeBalance(transactions: Transaction[]): BalancePoint[] {
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  let running = 0;
  const byDate = new Map<string, number>();
  for (const t of sorted) {
    running += t.type === "income" ? t.amount : -t.amount;
    byDate.set(t.date, running);
  }
  return Array.from(byDate.entries()).map(([date, balance]) => ({ date, balance }));
}
