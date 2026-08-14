// Task ("สิ่งที่ต้องทำ") chat commands (PLAN.md 17.26): "เพิ่มสิ่งที่ต้องทำ ..." /
// "สิ่งที่ต้องทำ" / "ทำเสร็จแล้ว ..." / "ลบสิ่งที่ต้องทำ ...". Every create/
// complete/delete goes through the shared confirm-before-you-do-it flow in
// confirmations.ts before touching Google Tasks — same discipline as
// calendarCommands.ts, diaryCommands.ts.

import { completeTask, createTask, deleteTask, listIncompleteTasks, type TaskSummary } from "./tasks.ts";
import { setPendingConfirmation, type ActionCtx } from "./state.ts";
import { bangkokYear, extractDate, extractTime, formatThaiDateLabel } from "./thaiDate.ts";

type Handler = (ctx: ActionCtx) => Promise<string>;

export interface TaskDraft {
  title: string;
  dateKey?: string;
  time?: string;
}

// Unlike calendarCommands.ts's parseEventDraft (which requires both a date
// AND a time to even count as a match — an appointment without one doesn't
// make sense), a to-do's date/time are both optional: "เพิ่มสิ่งที่ต้องทำ
// จ่ายบิลค่าน้ำ" with no date at all is still a perfectly valid task.
function parseTaskDraft(payload: string): TaskDraft {
  const date = extractDate(payload, bangkokYear());
  const time = extractTime(payload);
  let title = payload;
  if (date) title = title.replace(date.matchedText, "");
  if (time) title = title.replace(time.matchedText, "");
  title = title.replace(/\s+/g, " ").trim();
  return { title: title || "สิ่งที่ต้องทำ", dateKey: date?.dateKey, time: time?.time };
}

function formatDueSuffix(dateKey?: string, time?: string): string {
  if (!dateKey) return "";
  return ` วันที่ ${formatThaiDateLabel(dateKey)}${time ? ` เวลา ${time}` : ""}`;
}

// Google Tasks has no server-side keyword search (unlike Calendar's events
// `q` param) — fetches the (short, incomplete-only) list and filters
// client-side, same shape as the "found exactly one, or ask to disambiguate"
// pattern calendarCommands.ts's findExactlyOne already uses for delete/edit.
async function findExactlyOneTask(
  ctx: ActionCtx,
  keyword: string
): Promise<{ task: TaskSummary } | { message: string }> {
  const tasks = await listIncompleteTasks(ctx.accessToken);
  const matches = tasks.filter((t) => t.title.includes(keyword));
  if (matches.length === 0) return { message: `ไม่พบสิ่งที่ต้องทำที่ตรงกับคำว่า "${keyword}" เลยนะ` };
  if (matches.length > 1) {
    const lines = matches.map((t) => `- ${t.title}`);
    return { message: [`พบหลายรายการที่ตรงกับ "${keyword}" พิมพ์ให้เจาะจงกว่านี้หน่อยนะ:`, ...lines].join("\n") };
  }
  return { task: matches[0] };
}

// The following prompt*/answer functions do the actual work, each shared by
// the regex matcher below and the AI interpreter's routing table
// (aiInterpreter.ts's runInterpretedIntent in index.ts) — same split as
// every other command module in this codebase.

export async function promptTaskCreate(ctx: ActionCtx, draft: TaskDraft): Promise<string> {
  await setPendingConfirmation(ctx.kv, ctx.lineUserId, {
    kind: "taskCreate",
    title: draft.title,
    dateKey: draft.dateKey,
    time: draft.time,
  });
  return `จะเพิ่มสิ่งที่ต้องทำ: "${draft.title}"${formatDueSuffix(draft.dateKey, draft.time)} ใช่ไหม? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
}

export async function promptTaskComplete(ctx: ActionCtx, keyword: string): Promise<string> {
  const found = await findExactlyOneTask(ctx, keyword);
  if ("message" in found) return found.message;
  const { task } = found;
  await setPendingConfirmation(ctx.kv, ctx.lineUserId, { kind: "taskComplete", taskId: task.id, title: task.title });
  return `จะทำเครื่องหมายว่าทำเสร็จแล้ว: "${task.title}" ใช่ไหม? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
}

export async function promptTaskDelete(ctx: ActionCtx, keyword: string): Promise<string> {
  const found = await findExactlyOneTask(ctx, keyword);
  if ("message" in found) return found.message;
  const { task } = found;
  await setPendingConfirmation(ctx.kv, ctx.lineUserId, { kind: "taskDelete", taskId: task.id, title: task.title });
  return `จะลบสิ่งที่ต้องทำ: "${task.title}" ใช่ไหม? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
}

export async function answerTaskList(ctx: ActionCtx): Promise<string> {
  const tasks = await listIncompleteTasks(ctx.accessToken);
  if (tasks.length === 0) return "ไม่มีสิ่งที่ต้องทำค้างอยู่เลยนะ";
  return [
    "สิ่งที่ต้องทำ:",
    ...tasks.map((t, i) => `${i + 1}. ${t.title}${formatDueSuffix(t.dueDateKey, t.dueTime)}`),
  ].join("\n");
}

const LIST_PHRASES = ["สิ่งที่ต้องทำ", "รายการที่ต้องทำ", "มีอะไรต้องทำบ้าง", "สิ่งที่ต้องทำมีอะไรบ้าง"];

export async function matchTaskCommand(text: string): Promise<Handler | null> {
  const trimmed = text.trim();

  // Fixed list phrases checked first, ahead of the "เพิ่ม.../ทำเสร็จแล้ว.../
  // ลบ..." prefixed commands below — none of those prefixes overlap with
  // the bare list phrases, but checking the exact-match list first keeps
  // this in the same order-of-precedence style as matchCalendarCommand.
  if (LIST_PHRASES.includes(trimmed)) {
    return (ctx) => answerTaskList(ctx);
  }

  const addMatch = trimmed.match(/^เพิ่มสิ่งที่ต้องทำ\s+(.+)$/s);
  if (addMatch) {
    const draft = parseTaskDraft(addMatch[1].trim());
    return (ctx) => promptTaskCreate(ctx, draft);
  }

  const completeMatch = trimmed.match(/^(?:ทำเสร็จแล้ว|เสร็จแล้ว)\s+(.+)$/s);
  if (completeMatch) {
    const keyword = completeMatch[1].trim();
    return (ctx) => promptTaskComplete(ctx, keyword);
  }

  const deleteMatch = trimmed.match(/^ลบสิ่งที่ต้องทำ\s+(.+)$/s);
  if (deleteMatch) {
    const keyword = deleteMatch[1].trim();
    return (ctx) => promptTaskDelete(ctx, keyword);
  }

  return null;
}

export async function applyTaskCreate(
  ctx: ActionCtx,
  pending: { title: string; dateKey?: string; time?: string }
): Promise<string> {
  const due = pending.dateKey ? { dateKey: pending.dateKey, time: pending.time } : undefined;
  await createTask(ctx.accessToken, pending.title, due);
  return `เพิ่มสิ่งที่ต้องทำแล้ว: "${pending.title}"${formatDueSuffix(pending.dateKey, pending.time)}`;
}

export async function applyTaskComplete(ctx: ActionCtx, pending: { taskId: string; title: string }): Promise<string> {
  await completeTask(ctx.accessToken, pending.taskId);
  return `ทำเครื่องหมาย "${pending.title}" ว่าทำเสร็จแล้วนะ 🎉`;
}

export async function applyTaskDelete(ctx: ActionCtx, pending: { taskId: string; title: string }): Promise<string> {
  await deleteTask(ctx.accessToken, pending.taskId);
  return `ลบสิ่งที่ต้องทำ "${pending.title}" แล้ว`;
}
