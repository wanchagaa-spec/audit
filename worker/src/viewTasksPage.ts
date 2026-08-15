// /view/tasks (PLAN.md 17.36) — read-only list of incomplete Google Tasks,
// same pattern as viewCalendarPage.ts. Reuses listIncompleteTasks (already
// existed for the chat "สิ่งที่ต้องทำ" command). Read-only by design
// (confirmed with the user, not assumed): unlike diary, editing/completing/
// deleting tasks from here wasn't asked for, and chat already covers all
// three ("ทำเสร็จแล้ว <คำ>" / "ลบสิ่งที่ต้องทำ <คำ>") — this page is just
// meant to give an at-a-glance overview, the same "list" the user asked
// for, not a second way to manage them.

import type { Env } from "./index.ts";
import { InsufficientTasksScopeError, listIncompleteTasks, TasksApiDisabledError, type TaskSummary } from "./tasks.ts";
import { formatThaiDateLabel } from "./thaiDate.ts";
import { escapeHtml, html, pageShell, renderErrorPage, resolveViewSession } from "./viewAuth.ts";

function groupByDueDate(tasks: TaskSummary[]): { dated: Map<string, TaskSummary[]>; undated: TaskSummary[] } {
  const dated = new Map<string, TaskSummary[]>();
  const undated: TaskSummary[] = [];
  for (const t of tasks) {
    if (!t.dueDateKey) {
      undated.push(t);
      continue;
    }
    const list = dated.get(t.dueDateKey) ?? [];
    list.push(t);
    dated.set(t.dueDateKey, list);
  }
  return { dated, undated };
}

function renderTasksPage(token: string, tasks: TaskSummary[]): string {
  const nav = { token, active: "tasks" as const };

  if (tasks.length === 0) {
    return pageShell(
      "สิ่งที่ต้องทำ",
      `<h1>สิ่งที่ต้องทำ</h1>
<div class="card"><p class="empty">ไม่มีสิ่งที่ต้องทำค้างอยู่เลย</p></div>
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
      nav
    );
  }

  const { dated, undated } = groupByDueDate(tasks);
  // Earliest due date first — the opposite order from the diary/calendar
  // pages' "newest/most-recent first," since what's coming up soonest is
  // what a to-do list overview should lead with.
  const sortedDateKeys = Array.from(dated.keys()).sort();

  const datedHtml = sortedDateKeys
    .map((dateKey) => {
      const rows = dated
        .get(dateKey)!
        .map(
          (t) =>
            `<div class="row"><span>${escapeHtml(t.title)}</span><span class="meta">${escapeHtml(t.dueTime || "ไม่ระบุเวลา")}</span></div>`
        )
        .join("\n");
      return `<div class="day-group"><h2>${escapeHtml(formatThaiDateLabel(dateKey))}</h2><div class="card">${rows}</div></div>`;
    })
    .join("\n");

  const undatedHtml =
    undated.length === 0
      ? ""
      : `<div class="day-group"><h2>ไม่มีกำหนด</h2><div class="card">${undated
          .map((t) => `<div class="row"><span>${escapeHtml(t.title)}</span></div>`)
          .join("\n")}</div></div>`;

  return pageShell(
    "สิ่งที่ต้องทำ",
    `<h1>สิ่งที่ต้องทำ</h1><p class="subtitle">ที่ยังไม่เสร็จทั้งหมด</p>
${datedHtml}
${undatedHtml}
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
    nav
  );
}

const TASKS_UNAVAILABLE_MESSAGE =
  'ดูสิ่งที่ต้องทำผ่านเว็บไม่ได้ตอนนี้ — บัญชีนี้อาจต้องเชื่อมใหม่เพื่อขอสิทธิ์เพิ่ม หรือ Google Tasks API ยังไม่ได้เปิดใช้งาน พิมพ์ "สิ่งที่ต้องทำ" ในแชทเพื่อดูรายละเอียดเพิ่มเติม';

export async function handleViewTasksRequest(request: Request, env: Env): Promise<Response> {
  const session = await resolveViewSession(request, env);
  if (session instanceof Response) return session;

  try {
    const tasks = await listIncompleteTasks(session.accessToken);
    return html(renderTasksPage(session.token, tasks));
  } catch (err) {
    if (err instanceof TasksApiDisabledError || err instanceof InsufficientTasksScopeError) {
      return html(renderErrorPage("สิ่งที่ต้องทำใช้ไม่ได้", TASKS_UNAVAILABLE_MESSAGE), 400);
    }
    console.error("handleViewTasksRequest: fetching tasks failed", err);
    return html(renderErrorPage("ดึงข้อมูลไม่สำเร็จ", "ดึงข้อมูลสิ่งที่ต้องทำไม่สำเร็จตอนนี้ ลองเปิดลิงก์ใหม่อีกครั้งสักครู่นะ"), 502);
  }
}
