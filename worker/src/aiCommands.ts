// AI-assisted Q&A / analysis (PLAN.md 15.10): "ถาม <คำถาม>" answers an
// open-ended question about this month's spending and diary; "วิเคราะห์"
// (with or without extra text) asks for a freeform read of the same data.
// This is the one feature in the whole bot that calls an external AI model
// (Google Gemini) — every other feature is deliberately rule-based (PLAN.md
// 3, 12, 15.2) to stay free and predictable. The guardrail that makes this
// an acceptable exception rather than a step back: Gemini is only ever
// handed numbers this file already computed with the same plain arithmetic
// commands.ts uses, labeled as authoritative — it narrates and reasons in
// natural language, it never sums a column itself. See gemini.ts for the
// other half of that guarantee.

import { categoryLabel, formatBaht } from "./commands.ts";
import { askGemini, GeminiError } from "./gemini.ts";
import { readAllDiaryEntries, readAllTransactions, type DiaryRow, type TransactionRow } from "./sheets.ts";
import { bangkokMonthKey } from "./thaiDate.ts";
import type { ActionCtx } from "./state.ts";

type Handler = (ctx: ActionCtx) => Promise<string>;

const USAGE_HINT = 'พิมพ์คำถามต่อท้ายด้วยนะ เช่น "ถาม เดือนนี้ใช้เงินหมวดไหนเยอะสุด"';
const FALLBACK_MESSAGE =
  "ขอโทษด้วย ตอนนี้ระบบ AI ขัดข้องหรือโควตาฟรีเต็มพอดี ลองใหม่อีกครั้งในอีกสักครู่นะ";

// Caps how many individual rows go into the prompt — a month's worth of
// transactions/diary entries is normally well under this, but an unusually
// active month shouldn't be allowed to blow up the request size or cost.
// The precomputed totals/top-categories below stay accurate regardless,
// since those are computed from the full month's data, not the capped list.
const MAX_ROWS_IN_PROMPT = 200;

function parseAiRequest(text: string): { question: string } | null {
  const trimmed = text.trim();

  const askMatch = trimmed.match(/^ถาม\s*(.*)$/s);
  if (askMatch) {
    const question = askMatch[1].trim();
    return { question }; // empty question handled by the caller with USAGE_HINT
  }

  const analyzeMatch = trimmed.match(/^วิเคราะห์(?:การใช้จ่าย)?(?:เดือนนี้)?\s*(.*)$/s);
  if (analyzeMatch) {
    const extra = analyzeMatch[1].trim();
    return { question: extra || "ช่วยวิเคราะห์พฤติกรรมการใช้จ่ายและไดอารี่เดือนนี้ให้หน่อย มีอะไรน่าสังเกตบ้าง" };
  }

  return null;
}

function totals(rows: TransactionRow[]): { income: number; expense: number } {
  return {
    income: rows.filter((r) => r.type === "income").reduce((s, r) => s + r.amount, 0),
    expense: rows.filter((r) => r.type === "expense").reduce((s, r) => s + r.amount, 0),
  };
}

function topCategories(rows: TransactionRow[], limit = 5): string[] {
  const byCategory = new Map<string, number>();
  for (const r of rows) {
    if (r.type !== "expense") continue;
    byCategory.set(r.categoryId, (byCategory.get(r.categoryId) ?? 0) + r.amount);
  }
  return Array.from(byCategory.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([categoryId, amount]) => `${categoryLabel(categoryId)}: ${formatBaht(amount)} บาท`);
}

// Builds the whole prompt Gemini sees: authoritative precomputed numbers
// first (explicitly labeled as the only numbers it should quote back), then
// a capped raw row list for pattern/qualitative questions the totals alone
// can't answer (e.g. "ซื้อกาแฟกี่ครั้งแล้ว", "ช่วงนี้อารมณ์เป็นยังไงบ้าง").
function buildSystemInstruction(month: string, txRows: TransactionRow[], diaryRows: DiaryRow[]): string {
  const { income, expense } = totals(txRows);
  const top = topCategories(txRows);
  const txLines = txRows
    .slice(-MAX_ROWS_IN_PROMPT)
    .map((r) => `${r.date} ${r.type === "income" ? "รับ" : "จ่าย"} ${formatBaht(r.amount)} ${categoryLabel(r.categoryId)} — ${r.note || r.rawText}`);
  const diaryLines = diaryRows
    .slice(-MAX_ROWS_IN_PROMPT)
    .map((r) => `${r.date} [${r.category}] ${r.text}`);

  return [
    "คุณเป็นผู้ช่วยส่วนตัวในแชท LINE ที่ช่วยตอบคำถามเกี่ยวกับการเงินและไดอารี่ของผู้ใช้คนเดียว",
    "ตอบเป็นภาษาไทย น้ำเสียงเป็นกันเอง กระชับ ความยาวพอเหมาะสำหรับข้อความแชท (ไม่เกินสองสามย่อหน้าสั้นๆ)",
    "",
    `ตัวเลขที่คำนวณไว้แล้วสำหรับเดือน ${month} (ใช้ตัวเลขชุดนี้เท่านั้นเวลาตอบคำถามเกี่ยวกับยอดเงิน ห้ามคำนวณหรือเดาตัวเลขเอง):`,
    `- รายรับรวม: ${formatBaht(income)} บาท`,
    `- รายจ่ายรวม: ${formatBaht(expense)} บาท`,
    `- คงเหลือ: ${formatBaht(income - expense)} บาท`,
    top.length > 0 ? `- หมวดที่จ่ายเยอะสุด: ${top.join(", ")}` : "- ยังไม่มีรายจ่ายเดือนนี้",
    "",
    `รายการรายรับ-รายจ่ายเดือนนี้ (ล่าสุด ${txLines.length} รายการ ใช้ดูรูปแบบ/พฤติกรรม ไม่ใช่ใช้คำนวณยอดรวมเอง):`,
    txLines.length > 0 ? txLines.join("\n") : "(ไม่มีรายการ)",
    "",
    `บันทึกไดอารี่เดือนนี้ (ล่าสุด ${diaryLines.length} รายการ):`,
    diaryLines.length > 0 ? diaryLines.join("\n") : "(ไม่มีบันทึก)",
    "",
    "ถ้าคำถามต้องการข้อมูลที่ไม่มีในนี้ ให้บอกตรงๆ ว่าไม่มีข้อมูลพอจะตอบ แทนที่จะเดา",
  ].join("\n");
}

export async function matchAiCommand(text: string): Promise<Handler | null> {
  const request = parseAiRequest(text);
  if (!request) return null;

  if (!request.question) {
    return async () => USAGE_HINT;
  }

  return async (ctx) => {
    const month = bangkokMonthKey();
    const [allTx, allDiary] = await Promise.all([
      readAllTransactions(ctx.accessToken, ctx.spreadsheetId),
      readAllDiaryEntries(ctx.accessToken, ctx.spreadsheetId, ctx.kv),
    ]);
    const monthTx = allTx.filter((r) => r.date?.startsWith(month));
    const monthDiary = allDiary.filter((r) => r.date?.startsWith(month));
    const systemInstruction = buildSystemInstruction(month, monthTx, monthDiary);

    try {
      return await askGemini(ctx.geminiApiKey, systemInstruction, request.question);
    } catch (err) {
      console.error("askGemini failed", err);
      if (err instanceof GeminiError) return FALLBACK_MESSAGE;
      throw err;
    }
  };
}
