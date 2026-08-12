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

export interface PendingTripSwitch {
  newName: string;
}

export async function getPendingTripSwitch(
  kv: KVNamespace,
  lineUserId: string
): Promise<PendingTripSwitch | null> {
  const raw = await kv.get(`trip-switch:${lineUserId}`);
  return raw ? (JSON.parse(raw) as PendingTripSwitch) : null;
}

export async function setPendingTripSwitch(
  kv: KVNamespace,
  lineUserId: string,
  pending: PendingTripSwitch | null
): Promise<void> {
  const key = `trip-switch:${lineUserId}`;
  if (pending === null) {
    await kv.delete(key);
    return;
  }
  await kv.put(key, JSON.stringify(pending), { expirationTtl: PENDING_TTL_SECONDS });
}
