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
  /** TMDb (PLAN.md 17.57). Between weather and calendar: a movie list is
   * never the only thing a reply is carrying, but a description search
   * makes several of these back to back (genres, then a keyword lookup per
   * term, then discover), so the per-call budget has to leave room for the
   * whole chain inside one reply. */
  tmdb: 6_000,
  /** Thai lottery results (PLAN.md 17.73). Same budget as TMDb, and for the
   * opposite reason: only ever one call per reply, but the upstream is a
   * community service that scrapes a news site, so it is the slowest thing
   * here on a bad day and the one most worth cutting off. */
  lottery: 6_000,
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
