// Signs the LINE userId into the OAuth `state` param so the callback can
// trust it after the round trip through Google's consent screen, without
// a database lookup. Prevents someone from linking a Google account to a
// LINE userId that isn't theirs.

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

export async function signState(lineUserId: string, secret: string): Promise<string> {
  const payload = JSON.stringify({ u: lineUserId, t: Date.now() });
  const payloadB64 = toBase64Url(new TextEncoder().encode(payload));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${toBase64Url(signature)}`;
}

const MAX_STATE_AGE_MS = 10 * 60 * 1000; // linking must complete within 10 minutes

export async function verifyState(state: string, secret: string): Promise<string | null> {
  const [payloadB64, signatureB64] = state.split(".");
  if (!payloadB64 || !signatureB64) return null;

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(signatureB64),
    new TextEncoder().encode(payloadB64)
  );
  if (!valid) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64))) as {
      u: string;
      t: number;
    };
    if (Date.now() - payload.t > MAX_STATE_AGE_MS) return null;
    return payload.u;
  } catch {
    return null;
  }
}
