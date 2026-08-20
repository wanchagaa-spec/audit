// The Movie Database (TMDb) API (PLAN.md 17.57, extended to TV in 17.58) —
// the bot's entertainment data source, and the third integration (after
// Google Maps Platform and Travelpayouts) that needs no per-user OAuth at
// all: what is in cinemas is public data, not anybody's account, so this
// uses a flat project-level credential (TMDB_READ_TOKEN) the same way
// GOOGLE_MAPS_API_KEY works.
//
// **The file is still called movies.ts but it covers series too.** Every
// function takes a `MediaType`, because TMDb mirrors its whole API across
// `/movie/...` and `/tv/...`: same shapes, same filters, different paths and
// — the part that catches people — different field names for the same
// things (`title`/`name`, `release_date`/`first_air_date`). `parseTitles`
// below is where that difference stops.
//
// Four different things get called "หนังใหม่", and TMDb puts each on its own
// endpoint, so `MovieListKind` names them rather than guessing:
//   now_playing — in Thai cinemas right now / series currently airing
//   upcoming    — dated but not open yet / series not yet premiered
//   trending    — what people are actually watching this week
//   streaming   — new on the subscription apps available in Thailand
// plus title search and description/genre search, which are their own
// functions below because they take an argument.
//
// **Attribution is a licence condition, not a courtesy**: TMDb's terms
// require any product using the API to say so and not to imply endorsement.
// TMDB_ATTRIBUTION below is that statement, and it is rendered on the web
// page. Do not remove it.
//
// Written against the documented shape of TMDb API v3, and **confirmed
// working against the live service** with a real read token (PLAN.md 17.62).
// Until that confirmation this was the largest unknown in the codebase: the
// network egress proxy in the environment it was built in blocks
// api.themoviedb.org, so the tests drive a mock encoding the same
// assumptions as the code and could never have caught a wrong path or
// parameter name. The bearer auth, the base URL, the response shapes and the
// listing endpoints are now known good rather than assumed.
//
// Everything that reads a response is still deliberately defensive about
// missing fields — TMDb genuinely omits them, and that has not changed.

import { fetchWithTimeout, NETWORK_TIMEOUTS } from "./timeouts.ts";

const TMDB_BASE = "https://api.themoviedb.org/3";

/** Poster CDN. `w342` is the smallest size that still looks sharp in the
 * layout on a phone, which is the only place posters are shown. */
export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w342";

export const TMDB_ATTRIBUTION =
  "ข้อมูลและรูปภาพจาก TMDB — บริการนี้ใช้ TMDB API แต่ไม่ได้รับการรับรองจาก TMDB";

/** Thailand, for every region-scoped call. TMDb's release and streaming data
 * is per-country: without this, "now playing" is whatever is open in the US
 * and "where to watch" is whatever is licensed there. */
const REGION = "TH";

/** Thai titles and overviews where TMDb has them; it falls back to the
 * original language per-field on its own, so a title with no Thai
 * translation still comes back readable rather than blank. */
const LANGUAGE = "th-TH";

export class TmdbError extends Error {}

/** Which half of TMDb's mirrored API a call is about. Threaded through
 * everything rather than inferred, because the two halves disagree on field
 * names and there is no reliable way to tell them apart after the fact. */
export type MediaType = "movie" | "tv";

export interface Title {
  id: number;
  mediaType: MediaType;
  name: string;
  /** Shown alongside `name` only when they differ — a Thai title on its own
   * is often not enough to recognise something by. */
  originalName: string;
  overview: string;
  /** Path fragment, not a URL: the caller joins it to TMDB_IMAGE_BASE. Null
   * when TMDb has no poster, which is common for unreleased titles. */
  posterPath: string | null;
  /** "YYYY-MM-DD", or "" when TMDb has no date. Never assume it parses.
   * Release date for a film, first-air date for a series. */
  releaseDate: string;
  /** 0–10. Zero means "not rated yet", which is why the formatters hide it
   * rather than printing "⭐0.0". */
  voteAverage: number;
  /** ISO 639-1 of the language the thing was *made* in. Not a dub list —
   * see the note on fetchThaiWatchProviders. "" when TMDb has none. */
  originalLanguage: string;
  /** Subscription services carrying it in Thailand, by display name. Filled
   * in only for the answers that show it (see attachThaiProviders): an empty
   * array means "not looked up" as much as "not available", which is why
   * nothing renders it as a definite "not streaming". */
  providers?: string[];
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
 * Deliberately short, and still the one part of this file taken on trust:
 * ids for the smaller Thai services (WeTV, iQIYI, TrueID) could not be
 * confirmed from this environment, and a wrong id here fails silently — it
 * just quietly filters out a catalogue rather than erroring — which is
 * exactly the kind of bug worth not guessing at. Add them once checked
 * against /watch/providers/movie?watch_region=TH with a real token.
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

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Authenticated with the API Read Access Token as a bearer header, not the
 * v3 `?api_key=` query parameter.
 *
 * Both work against every endpoint used here, and TMDb issues both from the
 * same page. The header is the one to use: a credential in a query string
 * travels inside the URL, which is the part of a request that ends up in
 * proxy and CDN logs, in error messages, and in anything that records "what
 * was requested". A header does not. Same key, same free tier, one fewer
 * place for it to leak.
 */
async function tmdbFetch(readToken: string, path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("language", LANGUAGE);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const res = await fetchWithTimeout("TMDb", NETWORK_TIMEOUTS.tmdb, url.toString(), {
    headers: { Authorization: `Bearer ${readToken}`, accept: "application/json" },
  });
  if (!res.ok) {
    // One error class for everything, deliberately. Unlike Calendar/Tasks/
    // Gmail — where a 403 means "this user must re-consent" and the caller
    // has to say so — every failure mode here (bad token, quota, TMDb down)
    // can only be fixed by whoever runs the bot, so there is nothing for a
    // caller to branch on.
    throw new TmdbError(`TMDb API error (${res.status}): ${await res.text()}`);
  }
  return await res.json();
}

/**
 * The one place the movie/TV field-name split is handled.
 *
 * TMDb calls the same thing `title`/`release_date` on a film and
 * `name`/`first_air_date` on a series, and returns nulls for anything it
 * has no data for. Entries with no usable name at all are dropped rather
 * than rendered as an empty row.
 */
function parseTitles(raw: unknown, mediaType: MediaType): Title[] {
  const results = (raw as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  const titles: Title[] = [];
  for (const item of results) {
    const r = item as Record<string, unknown>;
    const primary = mediaType === "movie" ? r.title : r.name;
    const original = mediaType === "movie" ? r.original_title : r.original_name;
    const dated = mediaType === "movie" ? r.release_date : r.first_air_date;

    const name = typeof primary === "string" ? primary.trim() : "";
    const originalName = typeof original === "string" ? original.trim() : "";
    const display = name || originalName;
    if (!display || typeof r.id !== "number") continue;

    titles.push({
      id: r.id,
      mediaType,
      name: display,
      originalName,
      overview: typeof r.overview === "string" ? r.overview.trim() : "",
      posterPath: typeof r.poster_path === "string" && r.poster_path !== "" ? r.poster_path : null,
      releaseDate: typeof dated === "string" ? dated : "",
      voteAverage: typeof r.vote_average === "number" ? r.vote_average : 0,
      originalLanguage: typeof r.original_language === "string" ? r.original_language : "",
    });
  }
  return titles;
}

/** One of the four ready-made lists, for either media type. */
export async function fetchTitleList(
  readToken: string,
  mediaType: MediaType,
  kind: MovieListKind
): Promise<Title[]> {
  if (kind === "trending") {
    // The only endpoint here that takes no region: "trending" is global by
    // definition, and TMDb offers no per-country variant of it.
    return parseTitles(await tmdbFetch(readToken, `/trending/${mediaType}/week`, {}), mediaType);
  }

  if (kind === "streaming") {
    const dateField = mediaType === "movie" ? "primary_release_date.gte" : "first_air_date.gte";
    return parseTitles(
      await tmdbFetch(readToken, `/discover/${mediaType}`, {
        watch_region: REGION,
        // "|" is TMDb's OR separator (a comma would mean AND — on *every*
        // one of these services at once, which is nearly nothing).
        with_watch_providers: TH_STREAMING_PROVIDER_IDS.join("|"),
        // Subscription only. Without this the results include rentals and
        // purchases, which is not what "อยู่ในแอปที่สมัครไว้" means.
        with_watch_monetization_types: "flatrate",
        [dateField]: isoDaysAgo(STREAMING_WINDOW_DAYS),
        sort_by: "popularity.desc",
      }),
      mediaType
    );
  }

  if (mediaType === "tv") {
    // TV has no /tv/upcoming. "Currently airing" is a real endpoint;
    // "not started yet" has to be discovered by first-air date, which is
    // why these two are not symmetrical with the movie branch below.
    if (kind === "now_playing") {
      return parseTitles(await tmdbFetch(readToken, "/tv/on_the_air", {}), "tv");
    }
    return parseTitles(
      await tmdbFetch(readToken, "/discover/tv", {
        "first_air_date.gte": isoToday(),
        sort_by: "popularity.desc",
      }),
      "tv"
    );
  }

  return parseTitles(await tmdbFetch(readToken, `/movie/${kind}`, { region: REGION }), "movie");
}

export async function searchTitlesByName(
  readToken: string,
  mediaType: MediaType,
  query: string
): Promise<Title[]> {
  return parseTitles(
    await tmdbFetch(readToken, `/search/${mediaType}`, { query, include_adult: "false" }),
    mediaType
  );
}

/** TMDb's own genre vocabulary, in Thai. Fetched rather than hard-coded
 * because the ids are TMDb's to change and the Thai names are TMDb's
 * translations — a local copy would drift silently. Movies and series have
 * separate lists that mostly, but not entirely, agree. */
export async function fetchGenres(
  readToken: string,
  mediaType: MediaType
): Promise<Array<{ id: number; name: string }>> {
  const raw = (await tmdbFetch(readToken, `/genre/${mediaType}/list`, {})) as { genres?: unknown[] };
  if (!Array.isArray(raw.genres)) return [];
  return raw.genres
    .map((g) => g as Record<string, unknown>)
    .filter((g): g is { id: number; name: string } => typeof g.id === "number" && typeof g.name === "string");
}

/** Resolves free-text keyword terms to TMDb keyword ids, taking the best
 * match for each and ignoring terms that match nothing. Terms are searched
 * one at a time because TMDb's keyword search takes a single query. The
 * keyword vocabulary is shared between films and series. */
export async function resolveKeywordIds(readToken: string, terms: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const term of terms) {
    const raw = (await tmdbFetch(readToken, "/search/keyword", { query: term })) as { results?: unknown[] };
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
export async function discoverTitles(
  readToken: string,
  mediaType: MediaType,
  filters: DiscoverFilters
): Promise<Title[]> {
  const params: Record<string, string> = { sort_by: "popularity.desc" };
  // /discover/tv has no include_adult parameter; sending one is a 400.
  if (mediaType === "movie") params.include_adult = "false";
  if (filters.genreIds.length > 0) params.with_genres = filters.genreIds.join(",");
  if (filters.keywordIds.length > 0) params.with_keywords = filters.keywordIds.join("|");
  if (filters.streamingOnly) {
    params.watch_region = REGION;
    params.with_watch_providers = TH_STREAMING_PROVIDER_IDS.join("|");
    params.with_watch_monetization_types = "flatrate";
  }
  return parseTitles(await tmdbFetch(readToken, `/discover/${mediaType}`, params), mediaType);
}

/**
 * Which subscription services carry a title in Thailand, by display name.
 *
 * **This is availability, not audio.** TMDb has no field anywhere for
 * whether a Thai dub or Thai subtitles exist — not on this endpoint, not on
 * the detail endpoint, not in /translations (which covers translated
 * *metadata*: title and synopsis text, nothing about the soundtrack).
 * `originalLanguage` on a Title says what language it was made in, which is
 * a different question again. So nothing in this codebase claims a dub
 * exists; the answers say where to watch and point at the service, where
 * that question can actually be answered.
 *
 * An empty result is a real answer ("no subscription service here carries
 * it"), not an error.
 */
export async function fetchThaiWatchProviders(
  readToken: string,
  mediaType: MediaType,
  id: number
): Promise<string[]> {
  // Note: this endpoint ignores `language` and is not translated, so the
  // names come back in English ("Netflix", "Disney Plus") by design.
  const raw = (await tmdbFetch(readToken, `/${mediaType}/${id}/watch/providers`, {})) as {
    results?: Record<string, { flatrate?: unknown[] }>;
  };
  const flatrate = raw.results?.[REGION]?.flatrate;
  if (!Array.isArray(flatrate)) return [];
  return flatrate
    .map((p) => (p as Record<string, unknown>).provider_name)
    .filter((name): name is string => typeof name === "string");
}

/**
 * Fills in `providers` for the first `limit` titles, in parallel.
 *
 * Costs one subrequest per title, which is why it is opt-in and capped
 * rather than done for every answer: a list of twenty would spend twenty
 * requests on information most questions never ask for. Callers use it for
 * the answers where "where can I watch this" is the actual question — the
 * streaming lists and everything about series.
 *
 * A failed lookup leaves that one title without providers instead of
 * failing the answer: the list is the thing that was asked for, and a row
 * that just doesn't say where to watch is far better than no reply.
 */
export async function attachThaiProviders(readToken: string, titles: Title[], limit: number): Promise<void> {
  await Promise.all(
    titles.slice(0, limit).map(async (title) => {
      try {
        title.providers = await fetchThaiWatchProviders(readToken, title.mediaType, title.id);
      } catch (err) {
        console.error("attachThaiProviders: provider lookup failed for", title.mediaType, title.id, err);
      }
    })
  );
}

/** TMDb's own "where to watch" page, localised to Thailand. Every row links
 * to it whether or not providers were looked up: it is always current, it
 * costs no subrequest, and it is where a question this bot cannot answer —
 * dubbing, subtitles, price — can actually be followed up. */
export function tmdbWatchUrl(mediaType: MediaType, id: number): string {
  return `https://www.themoviedb.org/${mediaType}/${id}/watch?locale=${REGION}`;
}

export function releaseYear(title: Title): string {
  return title.releaseDate.slice(0, 4);
}

/**
 * Thai names for the languages that actually turn up, so a row can say
 * "เสียงต้นฉบับ: เกาหลี" instead of "ko".
 *
 * Falls back to the raw ISO code rather than hiding the field: an
 * unrecognised code is still more informative than nothing, and silently
 * dropping it would make a short list look inconsistent for no visible
 * reason.
 */
const LANGUAGE_NAMES_TH: Record<string, string> = {
  th: "ไทย",
  en: "อังกฤษ",
  ja: "ญี่ปุ่น",
  ko: "เกาหลี",
  zh: "จีน",
  cn: "จีน",
  hi: "ฮินดี",
  fr: "ฝรั่งเศส",
  es: "สเปน",
  de: "เยอรมัน",
  it: "อิตาลี",
  ru: "รัสเซีย",
  pt: "โปรตุเกส",
  id: "อินโดนีเซีย",
  tl: "ตากาล็อก",
  vi: "เวียดนาม",
  ta: "ทมิฬ",
  tr: "ตุรกี",
};

export function languageNameTh(code: string): string {
  if (!code) return "";
  return LANGUAGE_NAMES_TH[code] ?? code;
}
