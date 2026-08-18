// Google Calendar API helpers for the calendar feature (PLAN.md 15.3). Reminders
// are left entirely to Google Calendar's own notification system — this module
// only creates/reads/updates/deletes events, it never messages LINE proactively.

import { toRfc3339, toRfc3339PlusOneHour } from "./thaiDate.ts";

import { fetchWithTimeout, NETWORK_TIMEOUTS } from "./timeouts.ts";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const TIMEZONE = "Asia/Bangkok";

/** Thrown when the linked Google account's refresh token predates the
 * `calendar.events` scope — the caller should prompt the user to re-link. */
export class InsufficientCalendarScopeError extends Error {}

/** Thrown when the Google Cloud project itself hasn't turned the Calendar
 * API on — re-linking the Google account can't fix this, only enabling the
 * API in Google Cloud Console can (see worker/README.md setup step 3.5). */
export class CalendarApiDisabledError extends Error {}

async function calendarFetch(accessToken: string, path: string, init: RequestInit = {}): Promise<any> {
  // Bounded since PLAN.md 17.52, same reasoning as sheetsFetch.
  const res = await fetchWithTimeout("Google Calendar", NETWORK_TIMEOUTS.calendar, `${CALENDAR_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  if (res.status === 401 || res.status === 403) {
    const bodyText = await res.text();
    // Google returns 403 for two very different problems that look
    // identical from just the status code — telling them apart so the user
    // gets a fix that actually applies:
    //   - the Calendar API isn't enabled for the project at all (reason
    //     "accessNotConfigured" / "has not been used in project ... or it
    //     is disabled") — re-linking the Google account changes nothing.
    //   - the access token genuinely lacks the calendar.events scope
    //     (reason "ACCESS_TOKEN_SCOPE_INSUFFICIENT" / "insufficient
    //     authentication scopes") — re-linking is the actual fix.
    if (/accessNotConfigured|has (not|n't) been used in project|it is disabled/i.test(bodyText)) {
      throw new CalendarApiDisabledError(bodyText);
    }
    throw new InsufficientCalendarScopeError(bodyText);
  }
  if (!res.ok) {
    throw new Error(`Google Calendar API error (${res.status}): ${await res.text()}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export interface CalendarEventDraft {
  title: string;
  dateKey: string; // YYYY-MM-DD, Bangkok-local
  time: string; // HH:MM, 24-hour, Bangkok-local
}

export interface CalendarEventSummary {
  id: string;
  title: string;
  dateKey: string;
  time: string;
}

function eventBody(draft: CalendarEventDraft) {
  return {
    summary: draft.title,
    start: { dateTime: toRfc3339(draft.dateKey, draft.time), timeZone: TIMEZONE },
    end: { dateTime: toRfc3339PlusOneHour(draft.dateKey, draft.time), timeZone: TIMEZONE },
  };
}

export async function createCalendarEvent(accessToken: string, draft: CalendarEventDraft): Promise<string> {
  const created = await calendarFetch(accessToken, "/calendars/primary/events", {
    method: "POST",
    body: JSON.stringify(eventBody(draft)),
  });
  return created.id;
}

export async function patchCalendarEvent(
  accessToken: string,
  eventId: string,
  draft: CalendarEventDraft
): Promise<void> {
  await calendarFetch(accessToken, `/calendars/primary/events/${eventId}`, {
    method: "PATCH",
    body: JSON.stringify(eventBody(draft)),
  });
}

export async function deleteCalendarEvent(accessToken: string, eventId: string): Promise<void> {
  await calendarFetch(accessToken, `/calendars/primary/events/${eventId}`, { method: "DELETE" });
}

function fromApiEvent(item: any): CalendarEventSummary {
  const startDateTime: string | undefined = item.start?.dateTime;
  const dateKey = (startDateTime ?? item.start?.date ?? "").slice(0, 10);
  const time = startDateTime ? startDateTime.slice(11, 16) : "";
  return { id: item.id, title: item.summary ?? "(ไม่มีชื่อ)", dateKey, time };
}

export async function listCalendarEvents(
  accessToken: string,
  timeMinIso: string,
  timeMaxIso: string
): Promise<CalendarEventSummary[]> {
  const q = new URLSearchParams({
    timeMin: timeMinIso,
    timeMax: timeMaxIso,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });
  const data = await calendarFetch(accessToken, `/calendars/primary/events?${q}`);
  return ((data.items ?? []) as any[]).map(fromApiEvent);
}

/** Searches upcoming events (next `daysAhead` days) by keyword in the title/description. */
export async function searchUpcomingEvents(
  accessToken: string,
  keyword: string,
  daysAhead = 90
): Promise<CalendarEventSummary[]> {
  const now = new Date();
  const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const q = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    q: keyword,
    maxResults: "10",
  });
  const data = await calendarFetch(accessToken, `/calendars/primary/events?${q}`);
  return ((data.items ?? []) as any[]).map(fromApiEvent);
}
