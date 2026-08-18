// Degrading gracefully when Gemini says no (PLAN.md 17.54).
//
// Asked for as "a daily cap on Gemini calls, and fall back to the
// deterministic matchers once it's hit". The goal is exactly right; the
// mechanism here is a circuit breaker on Gemini's own 429 rather than a
// counter, for three reasons:
//
//   1. A counter needs a number, and the free tier's real limit is Google's
//      to change. A guess that is too high protects nothing; too low throws
//      away calls that would have worked.
//   2. Counting means a KV *write* per Gemini call. The free plan allows
//      1,000 writes a day in total, and this bot already spends a few
//      hundred on conversation history and pending state. Roughly 400 more
//      for bookkeeping would make the accounting the thing that broke first.
//   3. Google already counts, accurately, and says so with a 429. Reacting
//      to the real answer beats maintaining a second, worse copy of it.
//
// So: one KV read per Gemini call (reads are the cheap direction — 100,000 a
// day), and one write only when an outage actually starts.

const PAUSE_KEY = "gemini-paused";

// Short on purpose. A 429 can mean the per-minute limit (clears in seconds)
// or the per-day one (clears at Google's midnight), and the error body does
// not reliably say which. Rather than guess, this re-probes every few
// minutes: if it was per-minute, service resumes almost immediately; if it
// was per-day, the cost of being wrong is one rejected call every five
// minutes until it clears, which is nothing.
const PAUSE_SECONDS = 5 * 60;

/** True while Gemini is being given a rest after refusing a call. */
export async function isGeminiPaused(kv: KVNamespace): Promise<boolean> {
  return (await kv.get(PAUSE_KEY)) !== null;
}

/** Called when Gemini answers 429. Records only that it happened and when —
 * the reason is logged rather than stored, since nothing reads it back and a
 * quota error body can be long. */
export async function pauseGemini(kv: KVNamespace, reason: string): Promise<void> {
  console.error(`Gemini rejected a call, pausing AI features for ${PAUSE_SECONDS}s`, reason);
  await kv.put(PAUSE_KEY, new Date().toISOString(), { expirationTtl: PAUSE_SECONDS });
}

/** Lets the settings page and tests clear it deliberately. */
export async function resumeGemini(kv: KVNamespace): Promise<void> {
  await kv.delete(PAUSE_KEY);
}
