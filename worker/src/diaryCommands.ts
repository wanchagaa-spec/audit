// Diary chat commands (PLAN.md 15.4): "ไดอารี่ <ข้อความ>" (or "บันทึก ...") to
// write, with an optional "#หมวด" prefix; "ไดอารี่เดือนนี้มีอะไรบ้าง" for a
// monthly summary, "ไดอารี่วันที่ <วันที่>" for one day's entries in full, and
// "ค้นหาไดอารี่ <คำ>" to search. Entries always go to the personal
// spreadsheet passed in via ctx.spreadsheetId — never a shared group book
// (PLAN.md 15.5). Edit/delete aren't in scope for v1 (see worker/README.md).

import { appendDiaryEntry, readAllDiaryEntries } from "./sheets.ts";
import { setPendingConfirmation, type ActionCtx } from "./state.ts";
import { bangkokDateKey, bangkokMonthKey, bangkokYear, extractDate, formatThaiDateLabel } from "./thaiDate.ts";

type Handler = (ctx: ActionCtx) => Promise<string>;

const DEFAULT_CATEGORY = "อื่นๆ";

function parseNewDiary(text: string): { category: string; text: string } | null {
  const m = text.trim().match(/^(?:ไดอารี่|บันทึก)\s+(.+)$/s);
  if (!m) return null;
  const payload = m[1].trim();
  const withCategory = payload.match(/^#(\S+)\s+(.+)$/s);
  if (withCategory) return { category: withCategory[1], text: withCategory[2].trim() };
  return { category: DEFAULT_CATEGORY, text: payload };
}

// Shared by the regex matcher below and the AI interpreter's routing table
// (aiInterpreter.ts's intents, dispatched in index.ts) — same reasoning as
// calendarCommands.ts's prompt*/answer* exports: one place decides what
// happens once arguments are known, regardless of whether a fixed phrase
// pattern or free-form AI extraction produced them.

export async function promptDiaryCreateFromDraft(ctx: ActionCtx, draft: { category: string; text: string }): Promise<string> {
  await setPendingConfirmation(ctx.kv, ctx.lineUserId, { kind: "diaryCreate", ...draft });
  return `จะบันทึกไดอารี่ หมวด "${draft.category}": "${draft.text}" ใช่ไหม? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
}

export async function answerDiaryByDate(ctx: ActionCtx, dateKey: string): Promise<string> {
  const all = await readAllDiaryEntries(ctx.accessToken, ctx.spreadsheetId, ctx.kv);
  const rows = all.filter((r) => r.date === dateKey);
  const label = formatThaiDateLabel(dateKey);
  if (rows.length === 0) return `วันที่ ${label} ยังไม่มีบันทึกไดอารี่เลยนะ`;
  const lines = rows.map((r) => `[${r.category}] ${r.text}`);
  return [`ไดอารี่วันที่ ${label} (${rows.length} รายการ):`, ...lines].join("\n");
}

export async function answerDiaryMonthSummary(ctx: ActionCtx): Promise<string> {
  const month = bangkokMonthKey();
  const all = await readAllDiaryEntries(ctx.accessToken, ctx.spreadsheetId, ctx.kv);
  const rows = all.filter((r) => r.date?.startsWith(month));
  if (rows.length === 0) return "เดือนนี้ยังไม่มีบันทึกไดอารี่เลยนะ";

  // A summary, not a full dump: writing a lot in a month used to produce
  // one giant reply that LINE's 5,000-character text limit would silently
  // cut off partway through, with no indication anything was missing.
  // Counts and a list of which days have entries stay small no matter how
  // much was written; "ไดอารี่วันที่ <วันที่>" gets the detail.
  const byCategory = new Map<string, number>();
  const dates = new Set<string>();
  for (const r of rows) {
    byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1);
    dates.add(r.date);
  }
  const categoryLines = Array.from(byCategory.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => `• ${category}: ${count} รายการ`);
  const dateLabels = Array.from(dates)
    .sort()
    .map((d) => formatThaiDateLabel(d));

  return [
    `ไดอารี่เดือนนี้ (${month}): ${rows.length} รายการ`,
    "",
    "แยกตามหมวด:",
    ...categoryLines,
    "",
    `มีบันทึกวันที่: ${dateLabels.join(", ")}`,
    "",
    'พิมพ์ "ไดอารี่วันที่ <วันที่>" เพื่อดูรายละเอียดวันนั้น เช่น "ไดอารี่วันที่ 1/1/2569"',
  ].join("\n");
}

export async function answerDiarySearch(ctx: ActionCtx, term: string): Promise<string> {
  const all = await readAllDiaryEntries(ctx.accessToken, ctx.spreadsheetId, ctx.kv);
  const matches = all.filter((r) => r.text.includes(term));
  if (matches.length === 0) return `ไม่พบบันทึกไดอารี่ที่มีคำว่า "${term}" เลยนะ`;
  const lines = matches
    .slice(-10)
    .reverse()
    .map((r) => `${r.date} [${r.category}] ${r.text}`);
  return [`พบ ${matches.length} รายการที่มีคำว่า "${term}"`, "", ...lines].join("\n");
}

export async function matchDiaryCommand(text: string): Promise<Handler | null> {
  const trimmed = text.trim();

  // Checked ahead of the create-command match below: "ไดอารี่วันที่ 1/1/2569"
  // would otherwise also match "ไดอารี่ <ข้อความ>" and get saved as a new
  // entry whose text is literally "วันที่ 1/1/2569".
  const viewDateMatch = trimmed.match(/^(?:แสดง|ดู)?ไดอารี่\s*วันที่\s*(.+)$/s);
  if (viewDateMatch) {
    const parsed = extractDate(viewDateMatch[1].trim(), bangkokYear());
    if (!parsed) {
      return async () =>
        'ไม่พบวันที่ในข้อความนะ ลองพิมพ์แบบ "ไดอารี่วันที่ 1/1/2569" หรือ "ไดอารี่วันที่ 1 ม.ค." ดู';
    }
    return (ctx) => answerDiaryByDate(ctx, parsed.dateKey);
  }

  const draft = parseNewDiary(trimmed);
  if (draft) {
    return (ctx) => promptDiaryCreateFromDraft(ctx, draft);
  }

  if (["ไดอารี่เดือนนี้มีอะไรบ้าง", "ไดอารี่เดือนนี้"].includes(trimmed)) {
    return (ctx) => answerDiaryMonthSummary(ctx);
  }

  const searchMatch = trimmed.match(/^ค้นหาไดอารี่\s*(.+)$/s);
  if (searchMatch) {
    const term = searchMatch[1].trim();
    return (ctx) => answerDiarySearch(ctx, term);
  }

  return null;
}

export async function applyDiaryCreate(
  ctx: ActionCtx,
  pending: { category: string; text: string }
): Promise<string> {
  const now = new Date();
  await appendDiaryEntry(ctx.accessToken, ctx.spreadsheetId, ctx.kv, {
    id: crypto.randomUUID(),
    date: bangkokDateKey(now), // Bangkok-local, not UTC — matches how it's queried back
    category: pending.category,
    text: pending.text,
    createdAt: now.toISOString(),
  });
  return `บันทึกไดอารี่แล้ว หมวด "${pending.category}"`;
}
