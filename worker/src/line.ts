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

export interface LineWebhookBody {
  events: Array<LineMessageEvent | LineImageMessageEvent | { type: string; [key: string]: unknown }>;
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

export async function fetchLineImageContent(
  messageId: string,
  channelAccessToken: string
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${channelAccessToken}` },
  });
  if (!res.ok) {
    throw new Error(`LINE content API error (${res.status}): ${await res.text()}`);
  }
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  const bytes = await res.arrayBuffer();
  return { bytes, contentType };
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
