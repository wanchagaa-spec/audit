// Google Tasks API helpers (PLAN.md 17.26) — the first Google integration
// added since Calendar. Deliberately scoped to a plain title-only to-do
// list for v1 (no due dates/reminders) — narrower than Calendar on purpose,
// matching the "start narrow, extend later if actually needed" precedent
// this codebase already follows (e.g. the shift-schedule feature, PLAN.md
// 17.18). Every account's default task list (`@default`, always present,
// no separate lookup needed) is used — this bot never manages multiple
// task lists.

import { bangkokDateKey, bangkokHourMinute, toRfc3339 } from "./thaiDate.ts";

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

// Real bug found in production: this used to slice the returned `due`
// string directly (`due.slice(0, 10)` / `due.slice(11, 16)`) as if it were
// already Bangkok-local text — but Google's API returns it as a real
// UTC timestamp (a trailing "Z"), the same as everything else in this
// codebase's Google integrations. Slicing it raw showed the *UTC* date/time
// instead of the Bangkok one: created via `toRfc3339` (which always encodes
// with the +07:00 offset, e.g. "2026-01-20T14:00:00+07:00"), Google's
// response came back UTC-normalized ("2026-01-20T07:00:00.000Z" — 7 hours
// off), and for anything before 07:00 Bangkok time the UTC date itself
// rolls back to the previous day on top of that. Fixed by parsing it as a
// real `Date` and converting through the same `bangkokDateKey`/
// `bangkokHourMinute` helpers every other feature in this bot already uses
// for the reverse direction, instead of ever assuming a fixed textual
// layout in a specific timezone.
//
// Separately (still unverified, still worth knowing): Google Tasks' `due`
// field has a long-standing, well-known quirk where the Tasks apps/UI
// historically only ever respected the *date* part of it, silently
// resetting the time-of-day to 00:00 no matter what was sent — this may or
// may not still hold, and there's no way to check from this sandbox (no
// live Google API access). An exact Bangkok-local 00:00 after conversion is
// still treated as "no real time was set" rather than shown as a literal
// midnight due time, since that's what this bot itself sends by default
// when no time is given.
function parseDueField(due: string | undefined): { dateKey: string; time?: string } | undefined {
  if (!due) return undefined;
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return undefined;
  const dateKey = bangkokDateKey(d);
  const { hour, minute } = bangkokHourMinute(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hhmm = `${pad(hour)}:${pad(minute)}`;
  return hhmm !== "00:00" ? { dateKey, time: hhmm } : { dateKey };
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
