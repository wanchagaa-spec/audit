// Deadlines for the outbound calls that had none (PLAN.md 17.52).
//
// Written after a message got read and answered with nothing at all. The
// handling code was cleared: every path it could have taken returns text,
// and a thrown error already replies with an apology. Silence only happens
// when the reply token has expired *and* the push fails too — so what
// mattered was how long the slow path could take before it tried to answer.
//
// Gemini was the only dependency with a timeout: the interpreter (3s), the
// Q&A call (15s) and persona styling (2.5s). Sheets, Calendar and the
// weather API had none whatsoever, which is exactly backwards — those are
// the ones nothing else was watching. A single hung Google request could
// hold a reply open indefinitely, long past the token that was supposed to
// answer it.
//
// These are guards against hanging, not latency targets. Each is well past
// how long its call takes when anything is working, so a slow-but-alive
// dependency still succeeds; what they stop is the unbounded case.

/** Mutable on purpose. The tests need a deadline they can actually reach
 * without sleeping for seconds, and threading a timeout parameter through
 * every fetch wrapper to achieve that would put test plumbing in the
 * signature of every Sheets call in the codebase. Nothing in src/ writes to
 * this. */
export const NETWORK_TIMEOUTS = {
  /** Reads and writes of the user's spreadsheet — the biggest payloads here,
   * and on the critical path of nearly every reply. */
  sheets: 10_000,
  calendar: 8_000,
  /** Lowest of the three: the weather line is decorative, and its callers
   * already drop it silently when it fails. */
  weather: 5_000,
};

export class NetworkTimeoutError extends Error {}

/** fetch with a deadline. Reports which dependency ran out of time, because
 * "the request was aborted" in a log tells you nothing about which of half a
 * dozen Google APIs it was. */
export async function fetchWithTimeout(
  label: string,
  timeoutMs: number,
  input: string,
  init: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    // An aborted fetch throws a bare DOMException whose message says nothing
    // useful. Anything else (DNS, TLS, a socket dying) is a real network
    // error and is passed through untouched.
    if (controller.signal.aborted) {
      throw new NetworkTimeoutError(`${label} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
