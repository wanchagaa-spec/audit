export interface LineMessageEvent {
  type: "message";
  message: { type: "text"; text: string };
  source: { type: "user"; userId: string };
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
  return (
    event.type === "message" &&
    "message" in event &&
    (event as LineMessageEvent).message?.type === "text" &&
    (event as LineMessageEvent).source?.type === "user"
  );
}

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

/** Push messages target a userId directly instead of a one-time replyToken,
 * so — unlike replyToLine — they can't fail from a token that's expired or
 * already been used. Used as a fallback when a reply attempt fails, so slow
 * processing (e.g. a big trip-photo batch) never results in total silence. */
export async function pushToLine(userId: string, text: string, channelAccessToken: string): Promise<void> {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${channelAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: "text", text: text.slice(0, 5000) }],
    }),
  });
  if (!res.ok) {
    throw new Error(`LINE push API error (${res.status}): ${await res.text()}`);
  }
}
