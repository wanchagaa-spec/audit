// Google Tasks API helpers (PLAN.md 17.26) — the first Google integration
// added since Calendar. Deliberately scoped to a plain title-only to-do
// list for v1 (no due dates/reminders) — narrower than Calendar on purpose,
// matching the "start narrow, extend later if actually needed" precedent
// this codebase already follows (e.g. the shift-schedule feature, PLAN.md
// 17.18). Every account's default task list (`@default`, always present,
// no separate lookup needed) is used — this bot never manages multiple
// task lists.

import { toRfc3339 } from "./thaiDate.ts";

const TASKS_BASE = "https://tasks.googleapis.com/tasks/v1";
const DEFAULT_TASKLIST = "@default";

/** Thrown when the linked Google account's refresh token predates the
 * `tasks` scope — the caller should prompt the user to re-link. */
export class InsufficientTasksScopeError extends Error {}

/** Thrown when the Google Cloud project itself hasn't turned the Tasks API
 * on — re-linking the Google account can't fix this, only enabling the API
 * in Google Cloud Console can (see worker/README.md setup step 3.5). */
export class TasksApiDisabledError extends Error {}

async function tasksFetch(accessToken: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${TASKS_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  if (res.status === 401 || res.status === 403) {
    const bodyText = await res.text();
    // Same two-different-403-problems distinction as calendar.ts's
    // calendarFetch — see its own comment for why telling them apart
    // matters for which fix actually applies.
    if (/accessNotConfigured|has (not|n't) been used in project|it is disabled/i.test(bodyText)) {
      throw new TasksApiDisabledError(bodyText);
    }
    throw new InsufficientTasksScopeError(bodyText);
  }
  if (!res.ok) {
    throw new Error(`Google Tasks API error (${res.status}): ${await res.text()}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export interface TaskSummary {
  id: string;
  title: string;
  dueDateKey?: string;
  dueTime?: string;
}

// Google Tasks' `due` field has a long-standing, well-known quirk: the
// Tasks apps/UI historically only ever respected the *date* part of it,
// silently treating the time-of-day as 00:00 UTC no matter what was sent —
// this may or may not have changed with Google Tasks' newer time-based
// reminder UI, and there's no way to verify that from this sandbox (no
// live Google API access). So on the way back in, an exact 00:00 UTC is
// treated as "no real time was set" rather than surfaced as a literal
// midnight due time; anything else is shown as-is, best effort.
function parseDueField(due: string | undefined): { dateKey: string; time?: string } | undefined {
  if (!due) return undefined;
  const dateKey = due.slice(0, 10);
  const hhmm = due.slice(11, 16);
  return hhmm && hhmm !== "00:00" ? { dateKey, time: hhmm } : { dateKey };
}

/** Incomplete tasks only — a finished to-do list is meant to disappear from
 * view, not linger; Google Tasks keeps completed items around for a while
 * before actually deleting them, so this filters them out explicitly
 * rather than relying on that being invisible by default. */
export async function listIncompleteTasks(accessToken: string): Promise<TaskSummary[]> {
  const data = await tasksFetch(
    accessToken,
    `/lists/${DEFAULT_TASKLIST}/tasks?showCompleted=false&showHidden=false&maxResults=100`
  );
  return ((data.items ?? []) as any[]).map((t) => {
    const due = parseDueField(t.due);
    return { id: t.id, title: t.title || "(ไม่มีชื่อ)", dueDateKey: due?.dateKey, dueTime: due?.time };
  });
}

export async function createTask(
  accessToken: string,
  title: string,
  due?: { dateKey: string; time?: string }
): Promise<string> {
  const body: Record<string, unknown> = { title };
  if (due) {
    // Sent best-effort even with a time-of-day — see parseDueField's
    // comment on why we can't be sure Google keeps it.
    body.due = toRfc3339(due.dateKey, due.time ?? "00:00");
  }
  const created = await tasksFetch(accessToken, `/lists/${DEFAULT_TASKLIST}/tasks`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return created.id;
}

export async function completeTask(accessToken: string, taskId: string): Promise<void> {
  await tasksFetch(accessToken, `/lists/${DEFAULT_TASKLIST}/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "completed" }),
  });
}

export async function deleteTask(accessToken: string, taskId: string): Promise<void> {
  await tasksFetch(accessToken, `/lists/${DEFAULT_TASKLIST}/tasks/${taskId}`, { method: "DELETE" });
}
