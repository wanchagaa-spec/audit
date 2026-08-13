// A message from a 1:1 chat always has a userId; a message from a group
// chat (PLAN.md 17 — group mode) carries the groupId instead, plus the
// sender's userId when LINE includes it (it's omitted for senders on old
// LINE client versions, and possibly in other edge cases — never assume
// it's present for a group-sourced event).
export type LineEventSource = { type: "user"; userId: string } | { type: "group"; groupId: string; userId?: string };

/** One `@name` tag inside a text message. `userId`/`isSelf` are only set
 * when `type === "user"` — `isSelf: true` means this mentionee is the bot
 * itself (the one that received the webhook), which is how group mode
 * detects "was the bot actually addressed" (see findSelfMention). */
export interface MentionSpan {
  index: number;
  length: number;
  type: "user" | "all";
  userId?: string;
  isSelf?: boolean;
}

export interface LineMessageEvent {
  type: "message";
  message: { type: "text"; text: string; mention?: { mentionees: MentionSpan[] } };
  source: LineEventSource;
  replyToken: string;
  timestamp: number;
}

export interface LineImageMessageEvent {
  type: "message";
  message: { type: "image"; id: string };
  source: { type: "user"; userId: string };
  replyToken: string;
  timestamp: number;
}

export interface LineVideoMessageEvent {
  type: "message";
  message: { type: "video"; id: string };
  source: { type: "user"; userId: string };
  replyToken: string;
  timestamp: number;
}

export interface LineUnsupportedMessageEvent {
  type: "message";
  message: { type: string; [key: string]: unknown };
  source: { type: "user"; userId: string };
  replyToken: string;
  timestamp: number;
}

export interface LineWebhookBody {
  events: Array<
    | LineMessageEvent
    | LineImageMessageEvent
    | LineVideoMessageEvent
    | LineUnsupportedMessageEvent
    | { type: string; [key: string]: unknown }
  >;
}

function toBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let binary = "";
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyLineSignature(
  rawBody: string,
  signatureHeader: string | null,
  channelSecret: string
): Promise<boolean> {
  if (!signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return timingSafeEqual(toBase64(signature), signatureHeader);
}

export function isTextMessageEvent(
  event: LineWebhookBody["events"][number]
): event is LineMessageEvent {
  const sourceType = (event as LineMessageEvent).source?.type;
  return (
    event.type === "message" &&
    "message" in event &&
    (event as LineMessageEvent).message?.type === "text" &&
    (sourceType === "user" || sourceType === "group")
  );
}

/** The bot's own @mention span in a text message, or null if it wasn't
 * tagged — group mode (PLAN.md 17) only responds when this is non-null,
 * since every message in a group the bot belongs to reaches this webhook
 * whether the bot was addressed or not (LINE does no filtering on its
 * side). */
export function findSelfMention(message: LineMessageEvent["message"]): MentionSpan | null {
  return (message.mention?.mentionees ?? []).find((m) => m.type === "user" && m.isSelf === true) ?? null;
}

/** Removes the bot's own @mention span from the message text, trimming the
 * whitespace it leaves behind — "@BotName ซื้อกาแฟ 60" -> "ซื้อกาแฟ 60". */
export function stripSelfMention(text: string, mention: MentionSpan): string {
  return (text.slice(0, mention.index) + text.slice(mention.index + mention.length)).trim();
}

// isImageMessageEvent/isVideoMessageEvent/isUnsupportedMessageEvent below
// still require source.type === "user" — deliberate, not an oversight:
// LINE's @mention feature only exists on text messages, so there's no way
// for a group member to "address" a photo/sticker/other non-text message
// to the bot the way findSelfMention lets them address a text one.
// Responding to every non-text message any group member sends (the only
// alternative to requiring "user" source here) would defeat the entire
// point of gating group mode on being addressed — so these stay silently
// excluded from group chats for now, same as trip/calendar/diary/AI (see
// PLAN.md 17.4), rather than picked up as a partial, inconsistent case.
export function isImageMessageEvent(
  event: LineWebhookBody["events"][number]
): event is LineImageMessageEvent {
  return (
    event.type === "message" &&
    "message" in event &&
    (event as LineImageMessageEvent).message?.type === "image" &&
    (event as LineImageMessageEvent).source?.type === "user"
  );
}

export function isVideoMessageEvent(
  event: LineWebhookBody["events"][number]
): event is LineVideoMessageEvent {
  return (
    event.type === "message" &&
    "message" in event &&
    (event as LineVideoMessageEvent).message?.type === "video" &&
    (event as LineVideoMessageEvent).source?.type === "user"
  );
}

/** Any other real message type LINE can send (file, audio, sticker,
 * location, ...) that this bot doesn't handle yet. Used so handleWebhook can
 * still send *something* back instead of silently dropping the event — a
 * user sending a batch of clips can have some of them arrive as a type LINE
 * doesn't call "video" (e.g. "file" for some clip formats), and getting no
 * reply at all looks identical to a crash from the user's side. */
export function isUnsupportedMessageEvent(
  event: LineWebhookBody["events"][number]
): event is LineUnsupportedMessageEvent {
  return (
    event.type === "message" &&
    "message" in event &&
    typeof (event as LineUnsupportedMessageEvent).message?.type === "string" &&
    !["text", "image", "video"].includes((event as LineUnsupportedMessageEvent).message.type) &&
    (event as LineUnsupportedMessageEvent).source?.type === "user"
  );
}

/** Fetches the content stream for any LINE message content — image, video,
 * or audio all use this same content API, keyed only by messageId. Returns
 * the response body as a stream rather than buffering it into an ArrayBuffer
 * here: a longer video clip can be tens of MB, and reading the whole thing
 * into memory before even starting the Drive upload both risks the Worker's
 * memory limit and roughly doubles the time before a reply can be sent
 * (download fully, then upload fully, instead of both at once) — see the
 * streaming-upload comment in drive.ts for the other half of this. */
export async function fetchLineMediaContent(
  messageId: string,
  channelAccessToken: string
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string }> {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${channelAccessToken}` },
  });
  if (!res.ok) {
    throw new Error(`LINE content API error (${res.status}): ${await res.text()}`);
  }
  if (!res.body) {
    throw new Error("LINE content API returned an empty body");
  }
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  return { body: res.body, contentType };
}

export async function replyToLine(
  replyToken: string,
  text: string,
  channelAccessToken: string
): Promise<void> {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${channelAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: text.slice(0, 5000) }],
    }),
  });
  if (!res.ok) {
    throw new Error(`LINE reply API error (${res.status}): ${await res.text()}`);
  }
}

/** Push messages target an id directly (a userId, or a groupId for group
 * mode) instead of a one-time replyToken, so — unlike replyToLine — they
 * can't fail from a token that's expired or already been used. Used as a
 * fallback when a reply attempt fails, so slow processing (e.g. a big
 * trip-photo batch) never results in total silence. */
export async function pushToLine(to: string, text: string, channelAccessToken: string): Promise<void> {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${channelAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text: text.slice(0, 5000) }],
    }),
  });
  if (!res.ok) {
    throw new Error(`LINE push API error (${res.status}): ${await res.text()}`);
  }
}

/** A group member's display name, even if they've never added the OA as a
 * friend — unlike the general profile API (`/v2/bot/profile/:userId`,
 * which requires a friend relationship), this group-scoped endpoint works
 * for any member of a group the bot is still in. Used for attribution
 * ("who logged this") in group mode — purely cosmetic, so any failure
 * (member left, bot removed from group, network error) just degrades to
 * null rather than throwing. */
export async function getGroupMemberProfile(
  groupId: string,
  userId: string,
  channelAccessToken: string
): Promise<{ displayName: string } | null> {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/group/${groupId}/member/${userId}`, {
      headers: { Authorization: `Bearer ${channelAccessToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { displayName?: string };
    return data.displayName ? { displayName: data.displayName } : null;
  } catch (err) {
    console.error("getGroupMemberProfile failed", err);
    return null;
  }
}

/** A group's own name, used to label its spreadsheet more usefully than a
 * generic "สมุดกลุ่ม" when a group first links its account — same
 * best-effort treatment as getGroupMemberProfile, never blocks linking. */
export async function getGroupSummary(groupId: string, channelAccessToken: string): Promise<{ groupName: string } | null> {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/group/${groupId}/summary`, {
      headers: { Authorization: `Bearer ${channelAccessToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { groupName?: string };
    return data.groupName ? { groupName: data.groupName } : null;
  } catch (err) {
    console.error("getGroupSummary failed", err);
    return null;
  }
}
