import { DEFAULT_CATEGORIES } from "../../app/src/data/defaultCategories.ts";
import { readAllTransactions, readBudgets, type TransactionRow } from "./sheets.ts";

export function formatBaht(n: number): string {
  return n.toLocaleString("th-TH", { maximumFractionDigits: 2 });
}

export function categoryLabel(categoryId: string): string {
  const cat = DEFAULT_CATEGORIES.find((c) => c.id === categoryId);
  return `${cat?.icon ?? "📦"} ${cat?.name ?? "อื่น ๆ"}`;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

function lastMonthKey(): string {
  const d = new Date();
  d.setUTCDate(1); // avoid month-length overflow when subtracting a month
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

function startOfWeekKey(): string {
  const d = new Date();
  const day = d.getUTCDay(); // 0 = Sunday
  const diffToMonday = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d.toISOString().slice(0, 10);
}

function daysElapsedInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  const today = new Date();
  const isCurrentMonth = today.toISOString().slice(0, 7) === month;
  if (isCurrentMonth) return today.getUTCDate();
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // days in that month
}

function totals(rows: TransactionRow[]): { income: number; expense: number } {
  return {
    income: rows.filter((r) => r.type === "income").reduce((s, r) => s + r.amount, 0),
    expense: rows.filter((r) => r.type === "expense").reduce((s, r) => s + r.amount, 0),
  };
}

function summaryText(label: string, rows: TransactionRow[]): string {
  if (rows.length === 0) return `${label}ยังไม่มีรายการเลยนะ`;
  const { income, expense } = totals(rows);
  return [
    label,
    `รายรับ: ${formatBaht(income)} บาท`,
    `รายจ่าย: ${formatBaht(expense)} บาท`,
    `คงเหลือ: ${formatBaht(income - expense)} บาท`,
  ].join("\n");
}

function topCategoriesBlock(rows: TransactionRow[]): string[] {
  const byCategory = new Map<string, number>();
  for (const r of rows) {
    if (r.type !== "expense") continue;
    byCategory.set(r.categoryId, (byCategory.get(r.categoryId) ?? 0) + r.amount);
  }
  const top5 = Array.from(byCategory.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([categoryId, total]) => `${categoryLabel(categoryId)}: ${formatBaht(total)} บาท`);
  return top5.length > 0 ? ["", "5 หมวดที่จ่ายเยอะสุด:", ...top5] : [];
}

// ---- Command matching -------------------------------------------------

type Handler = (accessToken: string, spreadsheetId: string) => Promise<string>;

function includesAny(text: string, phrases: string[]): boolean {
  const t = text.trim();
  return phrases.some((p) => t.includes(p));
}

function searchMatch(text: string): string | null {
  const m = text.trim().match(/^(?:ค้นหา|หา)\s*(.+)$/s);
  return m ? m[1].trim() : null;
}

const COMMANDS: Array<{ test: (text: string) => boolean; handle: Handler }> = [
  {
    test: (t) => includesAny(t, ["วิธีใช้", "คำสั่ง", "help", "ช่วยเหลือ"]),
    handle: async () =>
      [
        "ฉันช่วยได้ 4 เรื่อง — พิมพ์คำสั่งด้านล่าง หรือแตะเมนูใต้ช่องพิมพ์ก็ได้:",
        "",
        "💰 จดเงิน",
        "• พิมพ์รายการตรงๆ เช่น \"ซื้อกาแฟ 60\" หรือ \"เงินเดือนเข้า 25000\" (ถ้าข้อมูลไม่ครบ ฉันจะถามกลับเอง)",
        "",
        "📊 ดูรายงาน",
        "• สรุปวันนี้ / สรุปสัปดาห์นี้ / สรุปเดือนนี้ / สรุปเดือนที่แล้ว",
        "• เหลือเงินเท่าไหร่ / รายรับเดือนนี้เท่าไหร่ / รายจ่ายเดือนนี้เท่าไหร่",
        "• วันไหนใช้เงินเยอะที่สุด / หมวดไหนใช้เงินเยอะที่สุด / ซื้ออะไรบ่อยที่สุด / เฉลี่ยใช้เงินต่อวันเท่าไหร่ / งบเหลือเท่าไหร่",
        "• ค้นหา <คำ> เช่น \"ค้นหากาแฟ\" / รายการล่าสุด",
        "• ลบรายการล่าสุด (หรือ ยกเลิกรายการล่าสุด) ถ้าจดผิด",
        "",
        "📸 อัลบั้มรูปทริป",
        "• เริ่มทริป <ชื่อ> แล้วส่งรูป/คลิปวิดีโอเข้ามาได้เลย เก็บขึ้น Google Drive ให้อัตโนมัติ แยกโฟลเดอร์ตามวันที่ / จบทริป / ทริปตอนนี้",
        "",
        "📅 ปฏิทิน (เตือนผ่าน Google Calendar)",
        "• นัด <เรื่อง> <วันที่> <เวลา> เช่น \"นัด ประชุมทีม 12/1/2569 13:00\"",
        "• มีนัดอะไรวันนี้ (หรือพรุ่งนี้/สัปดาห์นี้) / ลบนัด <คำ> / แก้นัด <คำ> เป็น <วันเวลาใหม่>",
        "",
        "📔 ไดอารี่",
        "• ไดอารี่ <ข้อความ> เช่น \"ไดอารี่ #งาน วันนี้ประชุมเสร็จเร็ว\" (ใส่ #หมวด ก็ได้ ไม่ใส่ก็ได้)",
        "• ไดอารี่เดือนนี้มีอะไรบ้าง / ค้นหาไดอารี่ <คำ>",
      ].join("\n"),
  },
  {
    test: (t) => includesAny(t, ["สรุปวันนี้", "วันนี้ใช้ไปเท่าไหร่", "วันนี้จ่ายไปเท่าไหร่", "ยอดวันนี้"]),
    handle: async (accessToken, spreadsheetId) => {
      const all = await readAllTransactions(accessToken, spreadsheetId);
      const rows = all.filter((r) => r.date === todayKey());
      return summaryText("สรุปวันนี้", rows);
    },
  },
  {
    test: (t) => includesAny(t, ["สรุปสัปดาห์นี้", "อาทิตย์นี้ใช้ไปเท่าไหร่", "สัปดาห์นี้ใช้ไปเท่าไหร่"]),
    handle: async (accessToken, spreadsheetId) => {
      const all = await readAllTransactions(accessToken, spreadsheetId);
      const start = startOfWeekKey();
      const rows = all.filter((r) => r.date >= start);
      return summaryText("สรุปสัปดาห์นี้", rows);
    },
  },
  {
    test: (t) => includesAny(t, ["สรุปเดือนที่แล้ว", "เดือนที่แล้วใช้ไปเท่าไหร่", "เดือนก่อนใช้ไปเท่าไหร่"]),
    handle: async (accessToken, spreadsheetId) => {
      const month = lastMonthKey();
      const all = await readAllTransactions(accessToken, spreadsheetId);
      const rows = all.filter((r) => r.date?.startsWith(month));
      return summaryText(`สรุปเดือนที่แล้ว (${month})`, rows) + topCategoriesBlock(rows).join("\n");
    },
  },
  {
    test: (t) => includesAny(t, ["สรุปเดือนนี้", "สรุป"]),
    handle: async (accessToken, spreadsheetId) => {
      const month = currentMonthKey();
      const all = await readAllTransactions(accessToken, spreadsheetId);
      const rows = all.filter((r) => r.date?.startsWith(month));
      return summaryText(`สรุปเดือนนี้ (${month})`, rows) + topCategoriesBlock(rows).join("\n");
    },
  },
  {
    test: (t) => includesAny(t, ["เหลือเงินเท่าไหร่", "ยอดคงเหลือ", "คงเหลือเท่าไหร่", "มีเงินเหลือเท่าไหร่"]),
    handle: async (accessToken, spreadsheetId) => {
      const all = await readAllTransactions(accessToken, spreadsheetId);
      if (all.length === 0) return "ยังไม่มีรายการเลยนะ";
      const { income, expense } = totals(all);
      return `ยอดคงเหลือสะสมทั้งหมด: ${formatBaht(income - expense)} บาท\n(รายรับรวม ${formatBaht(income)} / รายจ่ายรวม ${formatBaht(expense)} บาท)`;
    },
  },
  {
    test: (t) => includesAny(t, ["รายรับเดือนนี้"]),
    handle: async (accessToken, spreadsheetId) => {
      const month = currentMonthKey();
      const all = await readAllTransactions(accessToken, spreadsheetId);
      const income = all
        .filter((r) => r.type === "income" && r.date?.startsWith(month))
        .reduce((s, r) => s + r.amount, 0);
      return `รายรับเดือนนี้: ${formatBaht(income)} บาท`;
    },
  },
  {
    test: (t) => includesAny(t, ["รายจ่ายเดือนนี้"]),
    handle: async (accessToken, spreadsheetId) => {
      const month = currentMonthKey();
      const all = await readAllTransactions(accessToken, spreadsheetId);
      const expense = all
        .filter((r) => r.type === "expense" && r.date?.startsWith(month))
        .reduce((s, r) => s + r.amount, 0);
      return `รายจ่ายเดือนนี้: ${formatBaht(expense)} บาท`;
    },
  },
  {
    test: (t) => includesAny(t, ["วันไหนใช้เงินเยอะที่สุด", "วันไหนจ่ายเยอะสุด", "วันที่ใช้เงินเยอะที่สุด"]),
    handle: async (accessToken, spreadsheetId) => {
      const month = currentMonthKey();
      const all = await readAllTransactions(accessToken, spreadsheetId);
      const byDay = new Map<string, number>();
      for (const r of all) {
        if (r.type !== "expense" || !r.date?.startsWith(month)) continue;
        byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.amount);
      }
      if (byDay.size === 0) return "เดือนนี้ยังไม่มีรายจ่ายเลยนะ";
      const [date, amount] = Array.from(byDay.entries()).sort((a, b) => b[1] - a[1])[0];
      return `วันที่ใช้เงินเยอะที่สุดเดือนนี้คือ ${date} ใช้ไป ${formatBaht(amount)} บาท`;
    },
  },
  {
    test: (t) => includesAny(t, ["ซื้ออะไรบ่อยที่สุด", "หมวดไหนใช้บ่อยที่สุด", "จ่ายอะไรบ่อยสุด"]),
    handle: async (accessToken, spreadsheetId) => {
      const month = currentMonthKey();
      const all = await readAllTransactions(accessToken, spreadsheetId);
      const counts = new Map<string, number>();
      for (const r of all) {
        if (r.type !== "expense" || !r.date?.startsWith(month)) continue;
        counts.set(r.categoryId, (counts.get(r.categoryId) ?? 0) + 1);
      }
      if (counts.size === 0) return "เดือนนี้ยังไม่มีรายจ่ายเลยนะ";
      const [categoryId, count] = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
      return `หมวดที่ใช้บ่อยที่สุดเดือนนี้คือ ${categoryLabel(categoryId)} (${count} ครั้ง)`;
    },
  },
  {
    test: (t) => includesAny(t, ["หมวดไหนใช้เงินเยอะที่สุด", "จ่ายหมวดไหนเยอะสุด", "ใช้เงินหมวดไหนมากที่สุด"]),
    handle: async (accessToken, spreadsheetId) => {
      const month = currentMonthKey();
      const all = await readAllTransactions(accessToken, spreadsheetId);
      const byCategory = new Map<string, number>();
      for (const r of all) {
        if (r.type !== "expense" || !r.date?.startsWith(month)) continue;
        byCategory.set(r.categoryId, (byCategory.get(r.categoryId) ?? 0) + r.amount);
      }
      if (byCategory.size === 0) return "เดือนนี้ยังไม่มีรายจ่ายเลยนะ";
      const [categoryId, amount] = Array.from(byCategory.entries()).sort((a, b) => b[1] - a[1])[0];
      return `หมวดที่ใช้เงินเยอะที่สุดเดือนนี้คือ ${categoryLabel(categoryId)} รวม ${formatBaht(amount)} บาท`;
    },
  },
  {
    test: (t) => includesAny(t, ["เฉลี่ยวันละเท่าไหร่", "ใช้เงินเฉลี่ยต่อวันเท่าไหร่", "เฉลี่ยใช้จ่ายต่อวัน"]),
    handle: async (accessToken, spreadsheetId) => {
      const month = currentMonthKey();
      const all = await readAllTransactions(accessToken, spreadsheetId);
      const expense = all
        .filter((r) => r.type === "expense" && r.date?.startsWith(month))
        .reduce((s, r) => s + r.amount, 0);
      const days = daysElapsedInMonth(month);
      return `เฉลี่ยใช้จ่ายวันละ ${formatBaht(expense / days)} บาท (จากรายจ่ายรวม ${formatBaht(expense)} บาท ใน ${days} วัน)`;
    },
  },
  {
    test: (t) => includesAny(t, ["งบเหลือเท่าไหร่", "งบที่ตั้งไว้เหลือเท่าไหร่", "ใช้งบไปเท่าไหร่แล้ว"]),
    handle: async (accessToken, spreadsheetId) => {
      const month = currentMonthKey();
      const [all, budgets] = await Promise.all([
        readAllTransactions(accessToken, spreadsheetId),
        readBudgets(accessToken, spreadsheetId),
      ]);
      const monthBudgets = budgets.filter((b) => b.month === month);
      if (monthBudgets.length === 0) {
        return "ยังไม่ได้ตั้งงบไว้เลยนะ ตั้งได้จากหน้าตั้งค่าในเว็บแอป";
      }
      const spentByCategory = new Map<string, number>();
      for (const r of all) {
        if (r.type !== "expense" || !r.date?.startsWith(month)) continue;
        spentByCategory.set(r.categoryId, (spentByCategory.get(r.categoryId) ?? 0) + r.amount);
      }
      const lines = monthBudgets.map((b) => {
        const spent = spentByCategory.get(b.categoryId) ?? 0;
        const remaining = b.limitAmount - spent;
        const flag = remaining < 0 ? " ⚠️ เกินงบแล้ว" : "";
        return `${categoryLabel(b.categoryId)}: เหลือ ${formatBaht(remaining)} บาท (ใช้ไป ${formatBaht(spent)} จาก ${formatBaht(b.limitAmount)}${flag})`;
      });
      return lines.join("\n");
    },
  },
  {
    test: (t) => includesAny(t, ["รายการล่าสุด"]),
    handle: async (accessToken, spreadsheetId) => {
      const all = await readAllTransactions(accessToken, spreadsheetId);
      if (all.length === 0) return "ยังไม่มีรายการเลยนะ";
      const recent = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
      const lines = recent.map((r) => {
        const sign = r.type === "income" ? "+" : "-";
        return `${r.date} ${categoryLabel(r.categoryId)} ${sign}${formatBaht(r.amount)} บาท`;
      });
      return ["5 รายการล่าสุด:", ...lines].join("\n");
    },
  },
];

export async function matchCommand(text: string): Promise<Handler | null> {
  const searchTerm = searchMatch(text);
  if (searchTerm) {
    return async (accessToken, spreadsheetId) => {
      const all = await readAllTransactions(accessToken, spreadsheetId);
      const matches = all.filter(
        (r) => r.note.includes(searchTerm) || r.rawText.includes(searchTerm)
      );
      if (matches.length === 0) return `ไม่พบรายการที่มีคำว่า "${searchTerm}" เลยนะ`;
      const total = matches.reduce((s, r) => s + (r.type === "expense" ? r.amount : 0), 0);
      const lines = matches
        .slice(-10)
        .reverse()
        .map((r) => {
          const sign = r.type === "income" ? "+" : "-";
          return `${r.date} ${categoryLabel(r.categoryId)} ${sign}${formatBaht(r.amount)} บาท — ${r.note}`;
        });
      return [
        `พบ ${matches.length} รายการที่มีคำว่า "${searchTerm}" รวมรายจ่าย ${formatBaht(total)} บาท`,
        "",
        ...lines,
      ].join("\n");
    };
  }

  const found = COMMANDS.find((c) => c.test(text));
  return found ? found.handle : null;
}
