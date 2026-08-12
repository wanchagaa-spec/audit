import type { PendingClarification } from "../../app/src/lib/chatEngine.ts";

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

// A single "waiting for ใช่/no" slot shared by every feature that needs a
// confirm-before-you-do-it step (trip switching, calendar create/edit/delete,
// diary entries — PLAN.md 15.3/15.4). One slot per user is enough since only
// the most recent question is ever still relevant; see confirmations.ts for
// how a reply resolves whichever kind is pending.
export type PendingConfirmation =
  | { kind: "tripSwitch"; newName: string }
  | { kind: "calendarCreate"; title: string; dateKey: string; time: string }
  | { kind: "calendarDelete"; eventId: string; title: string; dateKey: string; time: string }
  | { kind: "calendarEdit"; eventId: string; title: string; dateKey: string; time: string }
  | { kind: "diaryCreate"; category: string; text: string };

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

/** Shared context passed to trip/calendar/diary command handlers. */
export interface ActionCtx {
  accessToken: string;
  kv: KVNamespace;
  lineUserId: string;
  spreadsheetId: string;
}
