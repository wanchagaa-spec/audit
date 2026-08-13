// /view/calendar (PLAN.md 16.3) — same read-only-page pattern as the
// accounts summary, reusing listCalendarEvents (already existed for the
// chat "มีนัดอะไรวันนี้" command and the AI Q&A calendar data source).

import { CalendarApiDisabledError, InsufficientCalendarScopeError, listCalendarEvents, type CalendarEventSummary } from "./calendar.ts";
import type { Env } from "./index.ts";
import { addDaysToDateKey, bangkokDateKey, bangkokStartOfDayIso, formatThaiDateLabel } from "./thaiDate.ts";
import { escapeHtml, html, pageShell, renderErrorPage, resolveViewSession } from "./viewAuth.ts";

// A fixed window rather than infinite scroll/pagination — wide enough to
// cover "what did I have recently and what's coming up" in one page
// without an unbounded fetch, narrow enough to stay well under
// listCalendarEvents' own maxResults=50 cap.
const DAYS_BEFORE = 7;
const DAYS_AFTER = 60;

function groupByDate(events: CalendarEventSummary[]): Map<string, CalendarEventSummary[]> {
  const groups = new Map<string, CalendarEventSummary[]>();
  for (const e of events) {
    const list = groups.get(e.dateKey) ?? [];
    list.push(e);
    groups.set(e.dateKey, list);
  }
  return groups;
}

function renderCalendarPage(token: string, events: CalendarEventSummary[]): string {
  const nav = { token, active: "calendar" as const };

  if (events.length === 0) {
    return pageShell(
      "ปฏิทิน",
      `<h1>ปฏิทิน</h1><p class="subtitle">${DAYS_BEFORE} วันที่แล้ว ถึง ${DAYS_AFTER} วันข้างหน้า</p>
<div class="card"><p class="empty">ไม่มีนัดหมายในช่วงนี้</p></div>
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
      nav
    );
  }

  const groups = groupByDate(events);
  const dayGroupsHtml = Array.from(groups.entries())
    .map(([dateKey, dayEvents]) => {
      const rows = dayEvents
        .map(
          (e) =>
            `<div class="row"><span>${escapeHtml(e.title)}</span><span class="meta">${escapeHtml(e.time || "ไม่ระบุเวลา")}</span></div>`
        )
        .join("\n");
      return `<div class="day-group"><h2>${escapeHtml(formatThaiDateLabel(dateKey))}</h2><div class="card">${rows}</div></div>`;
    })
    .join("\n");

  return pageShell(
    "ปฏิทิน",
    `<h1>ปฏิทิน</h1><p class="subtitle">${DAYS_BEFORE} วันที่แล้ว ถึง ${DAYS_AFTER} วันข้างหน้า</p>
${dayGroupsHtml}
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
    nav
  );
}

const CALENDAR_UNAVAILABLE_MESSAGE =
  'ดูปฏิทินผ่านเว็บไม่ได้ตอนนี้ — บัญชีนี้อาจต้องเชื่อมใหม่เพื่อขอสิทธิ์ปฏิทินเพิ่ม หรือ Google Calendar API ยังไม่ได้เปิดใช้งาน พิมพ์ "มีนัดอะไรวันนี้" ในแชทเพื่อดูรายละเอียดเพิ่มเติม';

export async function handleViewCalendarRequest(request: Request, env: Env): Promise<Response> {
  const session = await resolveViewSession(request, env);
  if (session instanceof Response) return session;

  try {
    const today = bangkokDateKey();
    const rangeStart = addDaysToDateKey(today, -DAYS_BEFORE);
    const rangeEnd = addDaysToDateKey(today, DAYS_AFTER);
    const events = await listCalendarEvents(
      session.accessToken,
      bangkokStartOfDayIso(rangeStart),
      bangkokStartOfDayIso(rangeEnd)
    );
    return html(renderCalendarPage(session.token, events));
  } catch (err) {
    if (err instanceof CalendarApiDisabledError || err instanceof InsufficientCalendarScopeError) {
      return html(renderErrorPage("ปฏิทินใช้ไม่ได้", CALENDAR_UNAVAILABLE_MESSAGE), 400);
    }
    console.error("handleViewCalendarRequest: fetching calendar events failed", err);
    return html(renderErrorPage("ดึงข้อมูลไม่สำเร็จ", "ดึงข้อมูลปฏิทินไม่สำเร็จตอนนี้ ลองเปิดลิงก์ใหม่อีกครั้งสักครู่นะ"), 502);
  }
}
