import { DEFAULT_CATEGORIES } from "../../app/src/data/defaultCategories.ts";
import { readTransactionsForMonth } from "./sheets.ts";

function formatBaht(n: number): string {
  return n.toLocaleString("th-TH", { maximumFractionDigits: 2 });
}

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

export function isSummaryCommand(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "สรุปเดือนนี้" || trimmed === "สรุป";
}

export async function buildMonthlySummaryText(accessToken: string, spreadsheetId: string): Promise<string> {
  const month = currentMonthKey();
  const rows = await readTransactionsForMonth(accessToken, spreadsheetId, month);
  if (rows.length === 0) {
    return "เดือนนี้ยังไม่มีรายการเลยนะ ลองพิมพ์รายการแรกดูสิ";
  }

  const income = rows.filter((r) => r.type === "income").reduce((s, r) => s + r.amount, 0);
  const expense = rows.filter((r) => r.type === "expense").reduce((s, r) => s + r.amount, 0);

  const byCategory = new Map<string, number>();
  for (const r of rows) {
    if (r.type !== "expense") continue;
    byCategory.set(r.categoryId, (byCategory.get(r.categoryId) ?? 0) + r.amount);
  }
  const top5 = Array.from(byCategory.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([categoryId, total]) => {
      const cat = DEFAULT_CATEGORIES.find((c) => c.id === categoryId);
      return `${cat?.icon ?? "📦"} ${cat?.name ?? "อื่น ๆ"}: ${formatBaht(total)} บาท`;
    });

  const lines = [
    `สรุปเดือนนี้ (${month})`,
    `รายรับ: ${formatBaht(income)} บาท`,
    `รายจ่าย: ${formatBaht(expense)} บาท`,
    `คงเหลือ: ${formatBaht(income - expense)} บาท`,
  ];
  if (top5.length > 0) {
    lines.push("", "5 หมวดที่จ่ายเยอะสุด:", ...top5);
  }
  return lines.join("\n");
}
