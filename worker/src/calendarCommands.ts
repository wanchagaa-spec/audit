// Calendar chat commands (PLAN.md 15.3): "นัด ..." / "มีนัดอะไร..." / "ลบนัด ..."
// / "แก้นัด ... เป็น ...". Every create/edit/delete goes through the shared
// confirm-before-you-do-it flow in confirmations.ts before touching Calendar.

import {
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
  patchCalendarEvent,
  searchUpcomingEvents,
} from "./calendar.ts";
import { setPendingConfirmation, type ActionCtx } from "./state.ts";
import {
  addDaysToDateKey,
  bangkokDateKey,
  bangkokStartOfDayIso,
  bangkokWeekdayIndex,
  extractDate,
  extractTime,
  formatThaiDateLabel,
} from "./thaiDate.ts";

type Handler = (ctx: ActionCtx) => Promise<string>;

interface EventDraft {
  title: string;
  dateKey: string;
  time: string;
}

function parseEventDraft(payload: string): EventDraft | null {
  const currentYear = new Date().getUTCFullYear();
  const dateMatch = extractDate(payload, currentYear);
  const timeMatch = extractTime(payload);
  if (!dateMatch || !timeMatch) return null;
  const title = payload
    .replace(dateMatch.matchedText, "")
    .replace(timeMatch.matchedText, "")
    .replace(/\s+/g, " ")
    .trim();
  return { title: title || "นัด", dateKey: dateMatch.dateKey, time: timeMatch.time };
}

function formatEventLines(events: Array<{ dateKey: string; time: string; title: string }>): string[] {
  return events.map((e) => `${e.time || "-"} ${e.title}`);
}

async function listRange(ctx: ActionCtx, fromKey: string, toKeyExclusive: string, label: string): Promise<string> {
  const events = await listCalendarEvents(
    ctx.accessToken,
    bangkokStartOfDayIso(fromKey),
    bangkokStartOfDayIso(toKeyExclusive)
  );
  if (events.length === 0) return `ไม่มีนัดช่วง${label}เลยนะ`;
  return [`นัดช่วง${label}:`, ...formatEventLines(events)].join("\n");
}

async function findExactlyOne(
  ctx: ActionCtx,
  keyword: string
): Promise<{ event: Awaited<ReturnType<typeof searchUpcomingEvents>>[number] } | { message: string }> {
  const matches = await searchUpcomingEvents(ctx.accessToken, keyword);
  if (matches.length === 0) return { message: `ไม่พบนัดที่ตรงกับคำว่า "${keyword}" ในช่วงนี้เลยนะ` };
  if (matches.length > 1) {
    const lines = matches.map((e) => `${formatThaiDateLabel(e.dateKey)} ${e.time} ${e.title}`);
    return { message: [`พบหลายนัดที่ตรงกับ "${keyword}" พิมพ์ให้เจาะจงกว่านี้หน่อยนะ:`, ...lines].join("\n") };
  }
  return { event: matches[0] };
}

export async function matchCalendarCommand(text: string): Promise<Handler | null> {
  const trimmed = text.trim();

  const newEventMatch = trimmed.match(/^นัด\s+(.+)$/);
  if (newEventMatch) {
    const draft = parseEventDraft(newEventMatch[1]);
    if (!draft) {
      return async () =>
        'ไม่พบวันที่/เวลาในข้อความนะ ลองพิมพ์แบบ "นัด ประชุมทีม 12/1/2569 13:00" หรือ "นัด ประชุมทีม 12 ม.ค. 13:00" ดู';
    }
    return async (ctx) => {
      await setPendingConfirmation(ctx.kv, ctx.lineUserId, { kind: "calendarCreate", ...draft });
      return `จะสร้างนัด: "${draft.title}" วันที่ ${formatThaiDateLabel(draft.dateKey)} เวลา ${draft.time} ใช่ไหม? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
    };
  }

  if (["มีนัดอะไรวันนี้", "นัดวันนี้", "วันนี้มีนัดอะไร"].includes(trimmed)) {
    return async (ctx) => {
      const today = bangkokDateKey();
      return listRange(ctx, today, addDaysToDateKey(today, 1), "วันนี้");
    };
  }

  if (["มีนัดอะไรพรุ่งนี้", "นัดพรุ่งนี้", "พรุ่งนี้มีนัดอะไร"].includes(trimmed)) {
    return async (ctx) => {
      const tomorrow = addDaysToDateKey(bangkokDateKey(), 1);
      return listRange(ctx, tomorrow, addDaysToDateKey(tomorrow, 1), "พรุ่งนี้");
    };
  }

  if (["มีนัดอะไรสัปดาห์นี้", "นัดสัปดาห์นี้", "สัปดาห์นี้มีนัดอะไร"].includes(trimmed)) {
    return async (ctx) => {
      const today = bangkokDateKey();
      const startOfWeek = addDaysToDateKey(today, -bangkokWeekdayIndex());
      return listRange(ctx, startOfWeek, addDaysToDateKey(startOfWeek, 7), "สัปดาห์นี้");
    };
  }

  const deleteMatch = trimmed.match(/^ลบนัด\s+(.+)$/);
  if (deleteMatch) {
    const keyword = deleteMatch[1].trim();
    return async (ctx) => {
      const found = await findExactlyOne(ctx, keyword);
      if ("message" in found) return found.message;
      const { event } = found;
      await setPendingConfirmation(ctx.kv, ctx.lineUserId, {
        kind: "calendarDelete",
        eventId: event.id,
        title: event.title,
        dateKey: event.dateKey,
        time: event.time,
      });
      return `จะลบนัด "${event.title}" วันที่ ${formatThaiDateLabel(event.dateKey)} เวลา ${event.time} ใช่ไหม? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
    };
  }

  const editMatch = trimmed.match(/^แก้นัด\s+(.+?)\s+เป็น\s+(.+)$/);
  if (editMatch) {
    const keyword = editMatch[1].trim();
    const newInfoText = editMatch[2].trim();
    return async (ctx) => {
      const found = await findExactlyOne(ctx, keyword);
      if ("message" in found) return found.message;
      const { event } = found;
      const currentYear = new Date().getUTCFullYear();
      const newDate = extractDate(newInfoText, currentYear);
      const newTime = extractTime(newInfoText);
      if (!newDate && !newTime) {
        return 'ไม่พบวันที่หรือเวลาใหม่เลยนะ ลองพิมพ์แบบ "แก้นัด ประชุมทีม เป็น 13/1/2569 14:00" ดู';
      }
      const draft = {
        title: event.title,
        dateKey: newDate ? newDate.dateKey : event.dateKey,
        time: newTime ? newTime.time : event.time,
      };
      await setPendingConfirmation(ctx.kv, ctx.lineUserId, { kind: "calendarEdit", eventId: event.id, ...draft });
      return `จะแก้นัด "${event.title}" เป็นวันที่ ${formatThaiDateLabel(draft.dateKey)} เวลา ${draft.time} ใช่ไหม? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
    };
  }

  return null;
}

export async function applyCalendarCreate(
  ctx: ActionCtx,
  pending: { title: string; dateKey: string; time: string }
): Promise<string> {
  await createCalendarEvent(ctx.accessToken, pending);
  return `จดนัดแล้ว: "${pending.title}" วันที่ ${formatThaiDateLabel(pending.dateKey)} เวลา ${pending.time} ปฏิทิน Google จะเตือนให้อัตโนมัติ`;
}

export async function applyCalendarDelete(
  ctx: ActionCtx,
  pending: { eventId: string; title: string; dateKey: string }
): Promise<string> {
  await deleteCalendarEvent(ctx.accessToken, pending.eventId);
  return `ลบนัด "${pending.title}" วันที่ ${formatThaiDateLabel(pending.dateKey)} แล้ว`;
}

export async function applyCalendarEdit(
  ctx: ActionCtx,
  pending: { eventId: string; title: string; dateKey: string; time: string }
): Promise<string> {
  await patchCalendarEvent(ctx.accessToken, pending.eventId, pending);
  return `แก้นัด "${pending.title}" เป็นวันที่ ${formatThaiDateLabel(pending.dateKey)} เวลา ${pending.time} แล้ว`;
}
