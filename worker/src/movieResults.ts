// Short-lived storage for one movie result so /view/movies can render it
// (PLAN.md 17.57). Same shape and the same reasoning as webSearch.ts's
// stored search results — see that file for why the id is scoped by subject
// and why the TTL is what it is.
//
// The alternative was re-running the TMDb query when the page opens, with
// the query encoded in the URL. This stores the answer instead, for two
// reasons: the page then shows exactly the films the chat message listed
// (a "trending this week" list re-fetched an hour later need not match),
// and opening the link costs no TMDb request at all.

import type { Movie } from "./movies.ts";

/** Matched to the view token's own one-hour lifetime, exactly as
 * webSearch.ts's is: the link carries a view token, so a longer TTL would
 * only keep rows nothing can reach. */
const MOVIE_RESULT_TTL_SECONDS = 60 * 60;

export interface StoredMovieResult {
  heading: string;
  movies: Movie[];
  createdAtIso: string;
}

// Scoped by subject, so an id only resolves for the account that produced
// it: guessing one is worthless without also holding a valid view token for
// that same account.
function movieResultKey(subjectId: string, id: string): string {
  return `movie-result:${subjectId}:${id}`;
}

export async function saveMovieResult(
  kv: KVNamespace,
  subjectId: string,
  result: StoredMovieResult
): Promise<string> {
  const id = crypto.randomUUID();
  await kv.put(movieResultKey(subjectId, id), JSON.stringify(result), {
    expirationTtl: MOVIE_RESULT_TTL_SECONDS,
  });
  return id;
}

export async function getMovieResult(
  kv: KVNamespace,
  subjectId: string,
  id: string
): Promise<StoredMovieResult | null> {
  const raw = await kv.get(movieResultKey(subjectId, id));
  return raw ? (JSON.parse(raw) as StoredMovieResult) : null;
}
