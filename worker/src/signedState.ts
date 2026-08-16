// Signs a LINE userId into a short opaque token, HMAC'd with a shared
// secret so it can be trusted later without a database lookup. Two
// unrelated things use this: the OAuth `state` param (so /oauth/callback
// can trust which LINE userId a completed Google consent belongs to), and
// the web-viewer session token (PLAN.md 16 — "เปิดเว็บดูข้อมูล" mints one of
// these so /view can tell which linked account's data to show).
//
// Both payloads have the same shape ({u, t}), so each carries a `k`
// (purpose) tag and each verify function rejects a token whose `k` doesn't
// match what it expects — without this, a leaked view-link token (valid an
// hour, sitting in LINE chat history) could otherwise be replayed as an
// OAuth `state` and used to rebind that victim's LINE account to an
// attacker's Google account, since both are just "a signature over an
// {u, t} payload" the same secret would accept either way.

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signPayload(payload: { u: string; t: number; k: string }, secret: string): Promise<string> {
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${toBase64Url(signature)}`;
}

// Everything here runs on a token that came straight off a URL, so every
// step has to treat it as arbitrary text rather than something this code
// produced. `atob` (inside fromBase64Url) *throws* on a character outside
// the base64 alphabet, and on a length that can't be padded to a multiple
// of 4 — an easy thing to hit by hand-editing or truncating a link. That
// exception used to escape all the way out of the fetch handler, so a
// mangled link produced a bare 500 instead of the friendly "ลิงก์หมดอายุหรือ
// ไม่ถูกต้อง" page every caller here already knows how to render for a null
// return. A malformed token is simply an invalid token: return null.
async function verifyPayload(
  token: string,
  secret: string
): Promise<{ u: string; t: number; k: string } | null> {
  const [payloadB64, signatureB64] = token.split(".");
  if (!payloadB64 || !signatureB64) return null;

  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(signatureB64),
      new TextEncoder().encode(payloadB64)
    );
    if (!valid) return null;

    return JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64))) as { u: string; t: number; k: string };
  } catch {
    return null;
  }
}

const MAX_STATE_AGE_MS = 10 * 60 * 1000; // linking must complete within 10 minutes

export async function signState(lineUserId: string, secret: string): Promise<string> {
  return signPayload({ u: lineUserId, t: Date.now(), k: "oauth" }, secret);
}

export async function verifyState(state: string, secret: string): Promise<string | null> {
  const payload = await verifyPayload(state, secret);
  if (!payload || payload.k !== "oauth") return null;
  if (Date.now() - payload.t > MAX_STATE_AGE_MS) return null;
  return payload.u;
}

// Long enough to comfortably browse the viewer for a while; short enough
// that a link left sitting in LINE chat history (LINE never expires/deletes
// old messages) stops working on its own before too long. Re-requesting a
// fresh one is just "พิมพ์ 'เปิดเว็บดูข้อมูล' อีกครั้ง" — cheap, so there's no
// pressure to make this long-lived instead.
const MAX_VIEW_TOKEN_AGE_MS = 60 * 60 * 1000;

export async function signViewToken(lineUserId: string, secret: string): Promise<string> {
  return signPayload({ u: lineUserId, t: Date.now(), k: "view" }, secret);
}

export async function verifyViewToken(token: string, secret: string): Promise<string | null> {
  const payload = await verifyPayload(token, secret);
  if (!payload || payload.k !== "view") return null;
  if (Date.now() - payload.t > MAX_VIEW_TOKEN_AGE_MS) return null;
  return payload.u;
}
