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
