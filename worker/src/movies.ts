// The Movie Database (TMDb) API (PLAN.md 17.57) — the bot's first
// entertainment data source, and the third integration (after Google Maps
// Platform and Travelpayouts) that needs no per-user OAuth at all: what is
// in cinemas is public data, not anybody's account, so this uses a flat
// project-level key (TMDB_API_KEY) the same way GOOGLE_MAPS_API_KEY works.
//
// Five different things get called "หนังใหม่" and TMDb puts each on its own
// endpoint, so `MovieListKind` names them rather than guessing:
//   now_playing — in Thai cinemas right now
//   upcoming    — dated for Thai cinemas but not open yet
//   trending    — what people are actually watching this week, cinema or not
//   streaming   — new on the subscription apps available in Thailand
// plus title search and description/genre search, which are their own
// functions below because they take an argument.
//
// **Attribution is a licence condition, not a courtesy**: TMDb's terms
// require any product using the API to say so and not to imply endorsement.
// TMDB_ATTRIBUTION below is that statement, and it is rendered on the web
// page. Do not remove it.
//
// Written against the documented shape of TMDb API v3. Worth knowing when
// reading the tests: the network egress proxy in the environment this was
// built in blocks api.themoviedb.org and developer.themoviedb.org, so no
// call here has ever been made against the real service — the tests drive a
// mock that encodes these same assumptions, and therefore cannot catch a
// wrong path or parameter name. Verify against a real key before trusting
// it in production. Everything that reads a response is deliberately
// defensive about missing fields for the same reason.

import { fetchWithTimeout, NETWORK_TIMEOUTS } from "./timeouts.ts";

const TMDB_BASE = "https://api.themoviedb.org/3";

/** Poster CDN. `w342` is the smallest size that still looks sharp in the
 * three-column grid on a phone, which is the only place posters are shown. */
export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w342";

export const TMDB_ATTRIBUTION =
  "ข้อมูลและรูปภาพหนังจาก TMDB — บริการนี้ใช้ TMDB API แต่ไม่ได้รับการรับรองจาก TMDB";

/** Thailand, for every region-scoped call. TMDb's release/streaming data is
 * per-country: without this, "now playing" is whatever is open in the US. */
const REGION = "TH";

/** Thai titles and overviews where TMDb has them; it falls back to the
 * original language per-field on its own, so a film with no Thai
 * translation still comes back readable rather than blank. */
const LANGUAGE = "th-TH";

export class TmdbError extends Error {}

export interface Movie {
  id: number;
  title: string;
  /** Shown alongside `title` only when they differ — a Thai title on its own
   * is often not enough to recognise a film by. */
  originalTitle: string;
  overview: string;
  /** Path fragment, not a URL: the caller joins it to TMDB_IMAGE_BASE. Null
   * when TMDb has no poster, which is common for unreleased films. */
  posterPath: string | null;
  /** "YYYY-MM-DD", or "" when TMDb has no date. Never assume it parses. */
  releaseDate: string;
  /** 0–10. Zero means "not rated yet", which is why the formatter below
   * hides it rather than printing "⭐0.0". */
  voteAverage: number;
}

export type MovieListKind = "now_playing" | "upcoming" | "trending" | "streaming";

/**
 * Subscription services whose Thai catalogues are worth searching.
 *
 * These are TMDb provider ids, which are global and stable — the numbers
 * mean the same thing in every region; `watch_region` is what decides
 * whether a given title is actually on that service *here*. Kept to the
 * services with a real Thai presence: a longer list would mostly add
 * catalogues nobody asking this question can watch.
 *
 * Deliberately short. Ids for the smaller Thai services (WeTV, iQIYI,
 * TrueID) exist but could not be confirmed from this environment (see the
 * egress note at the top of this file), and a wrong id here fails silently
 * — it just quietly filters out a catalogue — which is exactly the kind of
 * bug worth not guessing at. Add them once checked against
 * /watch/providers/movie?watch_region=TH with a real key.
 */
const TH_STREAMING_PROVIDER_IDS = [
  8, // Netflix
  119, // Amazon Prime Video
  337, // Disney+
  350, // Apple TV+
  158, // Viu
];

/** How far back "new on streaming" reaches. A year is long enough that the
 * list is never thin, short enough that it is still recognisably "new". */
const STREAMING_WINDOW_DAYS = 365;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function tmdbFetch(apiKey: string, path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("language", LANGUAGE);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const res = await fetchWithTimeout("TMDb", NETWORK_TIMEOUTS.tmdb, url.toString());
  if (!res.ok) {
    // One error class for everything, deliberately. Unlike Calendar/Tasks/
    // Gmail — where a 403 means "this user must re-consent" and the caller
    // has to say so — every failure mode here (bad key, quota, TMDb down)
    // can only be fixed by whoever runs the bot, so there is nothing for a
    // caller to branch on.
    throw new TmdbError(`TMDb API error (${res.status}): ${await res.text()}`);
  }
  return await res.json();
}

/** TMDb returns nulls for fields it has no data for, and the list endpoints
 * carry the odd entry with no title at all. Anything without a title is
 * dropped rather than rendered as an empty row. */
function parseMovies(raw: unknown): Movie[] {
  const results = (raw as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  const movies: Movie[] = [];
  for (const item of results) {
    const r = item as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const originalTitle = typeof r.original_title === "string" ? r.original_title.trim() : "";
    const name = title || originalTitle;
    if (!name || typeof r.id !== "number") continue;
    movies.push({
      id: r.id,
      title: name,
      originalTitle,
      overview: typeof r.overview === "string" ? r.overview.trim() : "",
      posterPath: typeof r.poster_path === "string" && r.poster_path !== "" ? r.poster_path : null,
      releaseDate: typeof r.release_date === "string" ? r.release_date : "",
      voteAverage: typeof r.vote_average === "number" ? r.vote_average : 0,
    });
  }
  return movies;
}

/** One of the four ready-made lists. */
export async function fetchMovieList(apiKey: string, kind: MovieListKind): Promise<Movie[]> {
  if (kind === "trending") {
    // The only endpoint here that takes no region: "trending" is global by
    // definition, and TMDb offers no per-country variant of it.
    return parseMovies(await tmdbFetch(apiKey, "/trending/movie/week", {}));
  }
  if (kind === "streaming") {
    return parseMovies(
      await tmdbFetch(apiKey, "/discover/movie", {
        watch_region: REGION,
        // "|" is TMDb's OR separator (a comma would mean AND — on *every*
        // one of these services at once, which is nearly nothing).
        with_watch_providers: TH_STREAMING_PROVIDER_IDS.join("|"),
        // Subscription only. Without this the results include rentals and
        // purchases, which is not what "อยู่ในแอปที่สมัครไว้" means.
        with_watch_monetization_types: "flatrate",
        "primary_release_date.gte": isoDaysAgo(STREAMING_WINDOW_DAYS),
        sort_by: "popularity.desc",
      })
    );
  }
  return parseMovies(await tmdbFetch(apiKey, `/movie/${kind}`, { region: REGION }));
}

export async function searchMoviesByTitle(apiKey: string, query: string): Promise<Movie[]> {
  return parseMovies(await tmdbFetch(apiKey, "/search/movie", { query, include_adult: "false" }));
}

/** TMDb's own genre vocabulary, in Thai. Fetched rather than hard-coded
 * because the ids are TMDb's to change and the Thai names are TMDb's
 * translations — a local copy would drift silently. */
export async function fetchGenres(apiKey: string): Promise<Array<{ id: number; name: string }>> {
  const raw = (await tmdbFetch(apiKey, "/genre/movie/list", {})) as { genres?: unknown[] };
  if (!Array.isArray(raw.genres)) return [];
  return raw.genres
    .map((g) => g as Record<string, unknown>)
    .filter((g): g is { id: number; name: string } => typeof g.id === "number" && typeof g.name === "string");
}

/** Resolves free-text keyword terms to TMDb keyword ids, taking the best
 * match for each and ignoring terms that match nothing. Terms are searched
 * one at a time because TMDb's keyword search takes a single query. */
export async function resolveKeywordIds(apiKey: string, terms: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const term of terms) {
    const raw = (await tmdbFetch(apiKey, "/search/keyword", { query: term })) as { results?: unknown[] };
    const first = Array.isArray(raw.results) ? (raw.results[0] as Record<string, unknown> | undefined) : undefined;
    if (first && typeof first.id === "number") ids.push(first.id);
  }
  return ids;
}

export interface DiscoverFilters {
  genreIds: number[];
  keywordIds: number[];
  /** Restricts to the subscription services in TH_STREAMING_PROVIDER_IDS —
   * for "หาหนังแนวนี้ที่ดูใน Netflix ได้เลย". */
  streamingOnly: boolean;
}

/** Structured search. Genres are ANDed and keywords are ORed on purpose: a
 * request like "หนังผีตลก" means both genres at once, whereas the keywords
 * a description produces are alternative ways of describing one idea, and
 * ANDing them returns nothing far too often. */
export async function discoverMovies(apiKey: string, filters: DiscoverFilters): Promise<Movie[]> {
  const params: Record<string, string> = { sort_by: "popularity.desc", include_adult: "false" };
  if (filters.genreIds.length > 0) params.with_genres = filters.genreIds.join(",");
  if (filters.keywordIds.length > 0) params.with_keywords = filters.keywordIds.join("|");
  if (filters.streamingOnly) {
    params.watch_region = REGION;
    params.with_watch_providers = TH_STREAMING_PROVIDER_IDS.join("|");
    params.with_watch_monetization_types = "flatrate";
  }
  return parseMovies(await tmdbFetch(apiKey, "/discover/movie", params));
}

/** Which subscription services carry a film in Thailand, by display name.
 * Empty when TMDb has no Thai availability data for it — which is a real
 * answer ("not streaming here"), not an error. */
export async function fetchThaiWatchProviders(apiKey: string, movieId: number): Promise<string[]> {
  // Note: this endpoint ignores `language` and is not translated, so the
  // names come back in English ("Netflix", "Disney Plus") by design.
  const raw = (await tmdbFetch(apiKey, `/movie/${movieId}/watch/providers`, {})) as {
    results?: Record<string, { flatrate?: unknown[] }>;
  };
  const flatrate = raw.results?.[REGION]?.flatrate;
  if (!Array.isArray(flatrate)) return [];
  return flatrate
    .map((p) => (p as Record<string, unknown>).provider_name)
    .filter((name): name is string => typeof name === "string");
}

/** TMDb's own "where to watch" page for a film, localised to Thailand. Used
 * instead of calling the providers endpoint once per row: it costs no
 * subrequest, and it stays right after this bot's cached copy would have
 * gone stale. */
export function tmdbWatchUrl(movieId: number): string {
  return `https://www.themoviedb.org/movie/${movieId}/watch?locale=${REGION}`;
}

export function releaseYear(movie: Movie): string {
  return movie.releaseDate.slice(0, 4);
}
