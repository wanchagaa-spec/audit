import type { PendingClarification, TransactionDraft } from "../../app/src/lib/chatEngine.ts";

export interface AccountLink {
  spreadsheetId: string;
  refreshToken: string;
  displayName: string;
}

const PENDING_TTL_SECONDS = 10 * 60; // clarification questions expire after 10 minutes

export async function getAccountLink(kv: KVNamespace, lineUserId: string): Promise<AccountLink | null> {
  const raw = await kv.get(`link:${lineUserId}`);
  return raw ? (JSON.parse(raw) as AccountLink) : null;
}

export async function setAccountLink(kv: KVNamespace, lineUserId: string, link: AccountLink): Promise<void> {
  await kv.put(`link:${lineUserId}`, JSON.stringify(link));
}

export async function getPending(kv: KVNamespace, lineUserId: string): Promise<PendingClarification | null> {
  const raw = await kv.get(`pending:${lineUserId}`);
  return raw ? (JSON.parse(raw) as PendingClarification) : null;
}

export async function setPending(
  kv: KVNamespace,
  lineUserId: string,
  pending: PendingClarification | null
): Promise<void> {
  const key = `pending:${lineUserId}`;
  if (pending === null) {
    await kv.delete(key);
    return;
  }
  await kv.put(key, JSON.stringify(pending), { expirationTtl: PENDING_TTL_SECONDS });
}

export interface ActiveTrip {
  name: string;
  folderId: string;
  startedAt: string;
}

export async function getActiveTrip(kv: KVNamespace, lineUserId: string): Promise<ActiveTrip | null> {
  const raw = await kv.get(`trip:${lineUserId}`);
  return raw ? (JSON.parse(raw) as ActiveTrip) : null;
}

export async function setActiveTrip(
  kv: KVNamespace,
  lineUserId: string,
  trip: ActiveTrip | null
): Promise<void> {
  const key = `trip:${lineUserId}`;
  if (trip === null) {
    await kv.delete(key);
    return;
  }
  // No TTL: a trip stays open until "จบทริป" is typed, by design (PLAN.md 15.2)
  // — a forgotten trip is meant to be caught with "ทริปตอนนี้", not silently expired.
  await kv.put(key, JSON.stringify(trip));
}

// Who a transaction gets credited to — always {addedBy: lineUserId,
// addedByName: "LINE"} in personal mode (meaningless in a 1:1 chat, it's
// always just "you"), and whoever actually sent the message in group mode
// (PLAN.md 17), via getGroupMemberProfile. Lives here (not index.ts) so
// state.ts's PendingConfirmation type can reference it below.
export interface TransactionAttribution {
  addedBy: string;
  addedByName: string;
}

// A single "waiting for ใช่/no" slot shared by every feature that needs a
// confirm-before-you-do-it step (trip switching, calendar create/edit/delete,
// diary entries, transaction logging — PLAN.md 15.3/15.4/17.9). One slot per
// user is enough since only the most recent question is ever still relevant;
// see confirmations.ts for how a reply resolves whichever kind is pending.
export type PendingConfirmation =
  | { kind: "tripSwitch"; newName: string }
  | { kind: "calendarCreate"; title: string; dateKey: string; time: string }
  | { kind: "calendarDelete"; eventId: string; title: string; dateKey: string; time: string }
  | { kind: "calendarEdit"; eventId: string; title: string; dateKey: string; time: string }
  | { kind: "diaryCreate"; category: string; text: string }
  | { kind: "taskCreate"; title: string; dateKey?: string; time?: string }
  | { kind: "taskComplete"; taskId: string; title: string }
  | { kind: "taskDelete"; taskId: string; title: string }
  | { kind: "emailSend"; to: string; subject: string; body: string }
  | { kind: "transactionDeleteLast" }
  // PLAN.md 17.9: money logging no longer saves immediately, even for an
  // unambiguous message — always confirms first, same as every other
  // create/delete action already did. `attribution` is resolved once, at
  // the moment this prompt is built (whoever actually typed the entry, via
  // the sender of the message that completed the draft), and stays fixed
  // even if a different group member ends up confirming it.
  | { kind: "transactionCreate"; drafts: TransactionDraft[]; rawText: string; attribution: TransactionAttribution };

export async function getPendingConfirmation(
  kv: KVNamespace,
  lineUserId: string
): Promise<PendingConfirmation | null> {
  const raw = await kv.get(`confirm:${lineUserId}`);
  return raw ? (JSON.parse(raw) as PendingConfirmation) : null;
}

export async function setPendingConfirmation(
  kv: KVNamespace,
  lineUserId: string,
  pending: PendingConfirmation | null
): Promise<void> {
  const key = `confirm:${lineUserId}`;
  if (pending === null) {
    await kv.delete(key);
    return;
  }
  await kv.put(key, JSON.stringify(pending), { expirationTtl: PENDING_TTL_SECONDS });
}

/** Shared context passed to trip/calendar/diary/AI command handlers. */
export interface ActionCtx {
  accessToken: string;
  kv: KVNamespace;
  lineUserId: string;
  spreadsheetId: string;
  geminiApiKey: string;
}

// The morning briefing (PLAN.md 15.11) needs to know which calendar day a
// user was last greeted on, to tell a first-greeting-of-the-day (full
// briefing) apart from any later one (short "ว่าไง" prompt) — this is the
// only piece of state it needs, since the briefing itself is composed fresh
// from live weather/news each time rather than being cached.
export async function getLastGreetingDate(kv: KVNamespace, lineUserId: string): Promise<string | null> {
  return kv.get(`last-greeting:${lineUserId}`);
}

export async function setLastGreetingDate(kv: KVNamespace, lineUserId: string, dateKey: string): Promise<void> {
  await kv.put(`last-greeting:${lineUserId}`, dateKey);
}

// Daily 7:00 broadcast (PLAN.md 17.21): a single global key (not per-user,
// unlike last-greeting above) guards against sending the broadcast twice on
// the same Bangkok day — the once-a-minute cron only *usually* fires exactly
// once during the 07:00 minute, so this is a cheap idempotency check rather
// than the primary way the schedule is enforced.
export async function getLastBroadcastDate(kv: KVNamespace): Promise<string | null> {
  return kv.get("last-broadcast-date");
}

export async function setLastBroadcastDate(kv: KVNamespace, dateKey: string): Promise<void> {
  await kv.put("last-broadcast-date", dateKey);
}

export interface UserProvince {
  name: string; // display name from the geocoder, not necessarily what the user typed
  lat: number;
  lon: number;
}

export async function getUserProvince(kv: KVNamespace, lineUserId: string): Promise<UserProvince | null> {
  const raw = await kv.get(`province:${lineUserId}`);
  return raw ? (JSON.parse(raw) as UserProvince) : null;
}

export async function setUserProvince(kv: KVNamespace, lineUserId: string, province: UserProvince): Promise<void> {
  await kv.put(`province:${lineUserId}`, JSON.stringify(province));
}

// Nearby-place search (PLAN.md 17.30): "หา<คำ>ใกล้ฉัน" only records what the
// user wants to search for — LINE's location-sharing message that resolves
// it always arrives as a *separate* message with no way to attach text, so
// this bridges the two the same way the money-clarification pending slot
// (getPending/setPending above) bridges an ambiguous message and its
// follow-up answer. Same short TTL: a share that never comes shouldn't
// leave a stale search waiting indefinitely.
const PLACE_SEARCH_TTL_SECONDS = 10 * 60;

export interface PendingPlaceSearch {
  keyword: string;
}

export async function getPendingPlaceSearch(kv: KVNamespace, subjectId: string): Promise<PendingPlaceSearch | null> {
  const raw = await kv.get(`place-search:${subjectId}`);
  return raw ? (JSON.parse(raw) as PendingPlaceSearch) : null;
}

export async function setPendingPlaceSearch(
  kv: KVNamespace,
  subjectId: string,
  pending: PendingPlaceSearch | null
): Promise<void> {
  const key = `place-search:${subjectId}`;
  if (pending === null) {
    await kv.delete(key);
    return;
  }
  await kv.put(key, JSON.stringify(pending), { expirationTtl: PLACE_SEARCH_TTL_SECONDS });
}

// Task due-time reminders (PLAN.md 17.35): the reminder check runs on the
// same once-a-minute cron as everything else, but the actual send window
// around "about an hour before due" is several minutes wide (see
// reminders.ts) — so this marker is what stops the same task's reminder
// from going out more than once, not the timing itself. TTL only needs to
// outlive same-day creation-to-due-time plus the send window; 2 days is
// comfortable headroom without leaving markers in KV forever for tasks that
// get completed or deleted afterward.
const TASK_REMINDER_TTL_SECONDS = 2 * 24 * 60 * 60;

export async function getTaskReminderSent(kv: KVNamespace, lineUserId: string, taskId: string): Promise<boolean> {
  return (await kv.get(`task-reminded:${lineUserId}:${taskId}`)) !== null;
}

export async function markTaskReminderSent(kv: KVNamespace, lineUserId: string, taskId: string): Promise<void> {
  await kv.put(`task-reminded:${lineUserId}:${taskId}`, "1", { expirationTtl: TASK_REMINDER_TTL_SECONDS });
}
