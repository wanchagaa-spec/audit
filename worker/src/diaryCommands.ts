// Diary chat commands (PLAN.md 15.4): "ไดอารี่ <ข้อความ>" (or "บันทึก ...") to
// write, with an optional "#หมวด" prefix; "ไดอารี่เดือนนี้มีอะไรบ้าง" and
// "ค้นหาไดอารี่ <คำ>" to read back. Entries always go to the personal
// spreadsheet passed in via ctx.spreadsheetId — never a shared group book
// (PLAN.md 15.5). Edit/delete aren't in scope for v1 (see worker/README.md).

import { appendDiaryEntry, readAllDiaryEntries } from "./sheets.ts";
import { setPendingConfirmation, type ActionCtx } from "./state.ts";

type Handler = (ctx: ActionCtx) => Promise<string>;

const DEFAULT_CATEGORY = "อื่นๆ";

function parseNewDiary(text: string): { category: string; text: string } | null {
  const m = text.trim().match(/^(?:ไดอารี่|บันทึก)\s+(.+)$/);
  if (!m) return null;
  const payload = m[1].trim();
  const withCategory = payload.match(/^#(\S+)\s+(.+)$/);
  if (withCategory) return { category: withCategory[1], text: withCategory[2].trim() };
  return { category: DEFAULT_CATEGORY, text: payload };
}

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

export async function matchDiaryCommand(text: string): Promise<Handler | null> {
  const trimmed = text.trim();

  const draft = parseNewDiary(trimmed);
  if (draft) {
    return async (ctx) => {
      await setPendingConfirmation(ctx.kv, ctx.lineUserId, { kind: "diaryCreate", ...draft });
      return `จะบันทึกไดอารี่ หมวด "${draft.category}": "${draft.text}" ใช่ไหม? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
    };
  }

  if (["ไดอารี่เดือนนี้มีอะไรบ้าง", "ไดอารี่เดือนนี้"].includes(trimmed)) {
    return async (ctx) => {
      const month = currentMonthKey();
      const all = await readAllDiaryEntries(ctx.accessToken, ctx.spreadsheetId);
      const rows = all.filter((r) => r.date?.startsWith(month));
      if (rows.length === 0) return "เดือนนี้ยังไม่มีบันทึกไดอารี่เลยนะ";
      const lines = rows.map((r) => `${r.date} [${r.category}] ${r.text}`);
      return [`ไดอารี่เดือนนี้ (${rows.length} รายการ):`, ...lines].join("\n");
    };
  }

  const searchMatch = trimmed.match(/^ค้นหาไดอารี่\s*(.+)$/);
  if (searchMatch) {
    const term = searchMatch[1].trim();
    return async (ctx) => {
      const all = await readAllDiaryEntries(ctx.accessToken, ctx.spreadsheetId);
      const matches = all.filter((r) => r.text.includes(term));
      if (matches.length === 0) return `ไม่พบบันทึกไดอารี่ที่มีคำว่า "${term}" เลยนะ`;
      const lines = matches
        .slice(-10)
        .reverse()
        .map((r) => `${r.date} [${r.category}] ${r.text}`);
      return [`พบ ${matches.length} รายการที่มีคำว่า "${term}"`, "", ...lines].join("\n");
    };
  }

  return null;
}

export async function applyDiaryCreate(
  ctx: ActionCtx,
  pending: { category: string; text: string }
): Promise<string> {
  const now = new Date().toISOString();
  await appendDiaryEntry(ctx.accessToken, ctx.spreadsheetId, {
    id: crypto.randomUUID(),
    date: now.slice(0, 10),
    category: pending.category,
    text: pending.text,
    createdAt: now,
  });
  return `บันทึกไดอารี่แล้ว หมวด "${pending.category}"`;
}
