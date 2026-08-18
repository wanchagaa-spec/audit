// Movie search and listings (PLAN.md 17.57). Reads TMDb, writes nothing,
// confirms nothing — the same read-only shape as nearby-place search.
//
// Every answer is two parts: a short list in chat, and a link to
// /view/movies for the same result with posters. That split is forced by
// the medium, not chosen — replyToLine sends plain text, so a poster can
// only ever be shown on a page. The chat half is deliberately still useful
// on its own (title, year, rating), because a list of five films is a
// perfectly good chat answer and making someone tap a link to read one
// would be worse.

import { askGemini, GeminiError, type AskGeminiOptions } from "./gemini.ts";
import {
  discoverMovies,
  fetchGenres,
  fetchMovieList,
  releaseYear,
  resolveKeywordIds,
  searchMoviesByTitle,
  TmdbError,
  type Movie,
  type MovieListKind,
} from "./movies.ts";
import { saveMovieResult, type StoredMovieResult } from "./movieResults.ts";
import { signViewToken } from "./signedState.ts";

/** Everything a movie answer needs. Narrower than the shared action context
 * the Google-backed commands take: nothing here touches Sheets, Drive or a
 * per-user access token, so asking for one would mean refreshing a Google
 * token to answer a question about cinema listings. */
export interface MovieCtx {
  kv: KVNamespace;
  subjectId: string;
  origin: string;
  tmdbApiKey: string;
  geminiApiKey: string;
  signingSecret: string;
}

type Handler = (ctx: MovieCtx) => Promise<string>;

/** Shown in chat. Five is what fits without the message becoming a wall —
 * the page carries the rest. */
const CHAT_RESULTS = 5;

/** Kept on the page. Past twenty the grid stops being browsable and the
 * stored blob stops being small. */
const PAGE_RESULTS = 20;

const NOT_CONFIGURED =
  "ฟีเจอร์หนังยังไม่พร้อมใช้งาน (ยังไม่ได้ตั้งค่า TMDb API key) แจ้งผู้ดูแลบอทดูนะ";
const LOOKUP_FAILED = "ดึงข้อมูลหนังไม่สำเร็จ ลองใหม่อีกครั้งนะ";

const LIST_HEADINGS: Record<MovieListKind, string> = {
  now_playing: "หนังที่กำลังฉายในโรงตอนนี้",
  upcoming: "หนังที่กำลังจะเข้าโรงเร็วๆ นี้",
  trending: "หนังที่มาแรงในสัปดาห์นี้",
  streaming: "หนังใหม่ในแอปสตรีมมิ่ง",
};

/** One chat line per film. The rating is dropped when TMDb has none rather
 * than printed as ⭐0.0, and the original title only appears when it differs
 * from the Thai one — otherwise every line says the same thing twice. */
function chatLine(movie: Movie, index: number): string {
  const year = releaseYear(movie);
  const parts = [`${index + 1}. ${movie.title}`];
  if (movie.originalTitle && movie.originalTitle !== movie.title) parts.push(`(${movie.originalTitle})`);
  if (year) parts.push(`· ${year}`);
  if (movie.voteAverage > 0) parts.push(`· ⭐${movie.voteAverage.toFixed(1)}`);
  return parts.join(" ");
}

async function buildReply(ctx: MovieCtx, heading: string, movies: Movie[], emptyMessage: string): Promise<string> {
  if (movies.length === 0) return emptyMessage;

  const shown = movies.slice(0, CHAT_RESULTS);
  const lines = shown.map(chatLine);

  const result: StoredMovieResult = {
    heading,
    movies: movies.slice(0, PAGE_RESULTS),
    createdAtIso: new Date().toISOString(),
  };

  // A failed save costs the link, not the answer: the chat list is already
  // complete and useful, so this degrades to sending it without one rather
  // than turning a working reply into an error.
  let link: string | null = null;
  try {
    const id = await saveMovieResult(ctx.kv, ctx.subjectId, result);
    const token = await signViewToken(ctx.subjectId, ctx.signingSecret);
    link = `${ctx.origin}/view/movies?token=${token}&id=${id}`;
  } catch (err) {
    console.error("buildReply: storing the movie result failed, sending the list without a link", err);
  }

  const tail =
    link === null
      ? []
      : ["", `ดูโปสเตอร์ เรื่องย่อ และดูได้ที่ไหนบ้าง (ลิงก์ใช้ได้ 1 ชั่วโมง):`, link];
  const more = movies.length > shown.length ? ` (มีอีก ${movies.length - shown.length} เรื่องในลิงก์)` : "";
  return [`${heading}${more}`, ...lines, ...tail].join("\n");
}

/** Every entry point funnels through here, so "no key configured" and "TMDb
 * threw" are answered identically no matter which command asked. */
async function answerWith(
  ctx: MovieCtx,
  heading: string,
  emptyMessage: string,
  load: () => Promise<Movie[]>
): Promise<string> {
  if (!ctx.tmdbApiKey) return NOT_CONFIGURED;
  let movies: Movie[];
  try {
    movies = await load();
  } catch (err) {
    console.error("movieCommands: TMDb lookup failed", err);
    if (err instanceof TmdbError) return LOOKUP_FAILED;
    throw err;
  }
  return buildReply(ctx, heading, movies, emptyMessage);
}

export async function answerMovieList(ctx: MovieCtx, kind: MovieListKind): Promise<string> {
  return answerWith(ctx, LIST_HEADINGS[kind], `ตอนนี้ยังไม่มีข้อมูล${LIST_HEADINGS[kind]}เลยนะ`, () =>
    fetchMovieList(ctx.tmdbApiKey, kind)
  );
}

export async function answerMovieSearch(ctx: MovieCtx, query: string): Promise<string> {
  return answerWith(ctx, `ผลค้นหาหนัง "${query}"`, `ไม่เจอหนังชื่อ "${query}" เลยนะ ลองพิมพ์ชื่ออังกฤษดูไหม`, () =>
    searchMoviesByTitle(ctx.tmdbApiKey, query)
  );
}

// ---- Searching by what a film is about ------------------------------------
//
// TMDb has no plot search: /search/movie matches titles only. What it does
// have is genres and a large human-curated keyword vocabulary, both
// searchable — so the job is turning "หนังเกี่ยวกับหุ่นยนต์ที่อยากเป็นมนุษย์"
// into those. That is a language problem, which is what Gemini is for, and
// it is a safe use of it by this codebase's own rule (see news.ts): the
// model picks search terms, it never states a fact. Every id it produces is
// resolved against TMDb's real vocabulary before use, and the films that
// come back are TMDb's answer, not the model's.

const PLAN_SYSTEM_INSTRUCTION = [
  "คุณช่วยแปลงคำอธิบายหนังที่ผู้ใช้อยากดู ให้กลายเป็นคำค้นสำหรับฐานข้อมูลหนัง TMDb",
  "ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่นนอก JSON ห้ามใส่ ```",
  'รูปแบบ: {"genres": ["ชื่อแนวภาษาไทย"], "keywords": ["english keyword"], "streamingOnly": false}',
  "genres: ชื่อแนวหนังภาษาไทยตามที่ TMDb ใช้ เช่น แอ็คชั่น ผจญภัย ตลก อาชญากรรม สารคดี ดราม่า ครอบครัว แฟนตาซี สยองขวัญ เพลง ลึกลับ โรแมนติก นิยายวิทยาศาสตร์ ระทึกขวัญ สงคราม ตะวันตก แอนิเมชัน ประวัติศาสตร์ ถ้าไม่แน่ใจให้ใส่ [] แทนการเดา",
  "keywords: คำสำคัญที่บรรยายเนื้อเรื่อง เป็นภาษาอังกฤษเท่านั้น (TMDb เก็บ keyword เป็นภาษาอังกฤษ) เช่น time travel, robot, heist, zombie ใส่ได้ไม่เกิน 3 คำ ถ้าคำอธิบายบอกแค่แนว ไม่ได้บอกเนื้อเรื่อง ให้ใส่ []",
  'streamingOnly: true เฉพาะเมื่อผู้ใช้บอกชัดว่าอยากดูในแอปสตรีมมิ่ง เช่น "ใน Netflix" "ที่ดูออนไลน์ได้เลย" นอกนั้นเป็น false',
].join("\n");

interface SearchPlan {
  genres: string[];
  keywords: string[];
  streamingOnly: boolean;
}

/** Reads the model's JSON without trusting any of it: wrong types become
 * empty, and the caller can still search on whatever half survived. Returns
 * null only when nothing usable came back at all. */
function parseSearchPlan(raw: string): SearchPlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").slice(0, 3) : [];
  return {
    genres: strings(r.genres),
    keywords: strings(r.keywords),
    streamingOnly: r.streamingOnly === true,
  };
}

async function planSearch(
  geminiApiKey: string,
  description: string,
  options: AskGeminiOptions
): Promise<SearchPlan | null> {
  if (!geminiApiKey) return null;
  try {
    // jsonMode for the same reason aiInterpreter.ts uses it: the answer is
    // parsed, not read, so a stray sentence around the JSON is a failure
    // rather than a style. parseSearchPlan still validates every field —
    // valid JSON syntax is not a valid plan.
    return parseSearchPlan(
      await askGemini(geminiApiKey, PLAN_SYSTEM_INSTRUCTION, description, { ...options, jsonMode: true })
    );
  } catch (err) {
    if (err instanceof GeminiError) {
      console.error("planSearch: Gemini could not turn the description into search terms", err);
      return null;
    }
    throw err;
  }
}

/**
 * Everyday Thai names for genres TMDb spells differently.
 *
 * These are transliterations and colloquialisms, not abbreviations, so no
 * amount of substring matching finds them: nothing in "นิยายวิทยาศาสตร์"
 * contains "ไซไฟ". A genre that fails to resolve does not fail loudly — it
 * simply drops out of the filter and quietly widens the search — so the
 * handful of terms people actually type are worth naming outright.
 */
const GENRE_ALIASES: Record<string, string> = {
  ไซไฟ: "นิยายวิทยาศาสตร์",
  วิทยาศาสตร์: "นิยายวิทยาศาสตร์",
  หนังผี: "สยองขวัญ",
  ผี: "สยองขวัญ",
  สยอง: "สยองขวัญ",
  การ์ตูน: "แอนิเมชัน",
  อนิเมะ: "แอนิเมชัน",
  แอคชั่น: "แอ็คชั่น",
  บู๊: "แอ็คชั่น",
  รัก: "โรแมนติก",
  โรแมนซ์: "โรแมนติก",
  ทริลเลอร์: "ระทึกขวัญ",
  สืบสวน: "ลึกลับ",
  ตะวันตกคาวบอย: "ตะวันตก",
  เพลงและดนตรี: "เพลง",
};

/** Matches the model's Thai genre names against TMDb's own list: alias
 * first, then exact, then substring either way — TMDb writes
 * "นิยายวิทยาศาสตร์" where a model may answer just "วิทยาศาสตร์". An
 * exact-match-only filter would silently drop the genre and widen the search
 * instead, which looks like a result and answers nothing. */
function matchGenreIds(genreNames: string[], catalogue: Array<{ id: number; name: string }>): number[] {
  const ids: number[] = [];
  for (const wanted of genreNames) {
    const raw = wanted.trim();
    if (!raw) continue;
    const needle = GENRE_ALIASES[raw] ?? raw;
    const hit = catalogue.find((g) => g.name === needle) ??
      catalogue.find((g) => g.name.includes(needle) || needle.includes(g.name));
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
  }
  return ids;
}

export async function answerMovieDiscover(ctx: MovieCtx, description: string): Promise<string> {
  if (!ctx.tmdbApiKey) return NOT_CONFIGURED;

  const plan = await planSearch(ctx.geminiApiKey, description, { kv: ctx.kv });

  // No plan means Gemini is unavailable or answered unusably. Falling back
  // to a title search is not the same question, but it is a real answer to a
  // near-enough one — and it is the only search TMDb can do without the
  // model. Saying "the AI is down" and stopping would be honest and useless.
  if (plan === null) {
    return answerWith(
      ctx,
      `ผลค้นหาหนัง "${description}"`,
      `ตอนนี้ค้นหาแบบบอกเนื้อเรื่องไม่ได้ (ระบบ AI ไม่ว่าง) และค้นจากชื่อ "${description}" ก็ไม่เจอนะ ลองบอกชื่อหนังตรงๆ ดูไหม`,
      () => searchMoviesByTitle(ctx.tmdbApiKey, description)
    );
  }

  return answerWith(ctx, `หนังที่น่าจะตรงกับ "${description}"`, `ไม่เจอหนังที่ตรงกับ "${description}" เลยนะ ลองบอกแนวหรือเนื้อเรื่องให้ละเอียดกว่านี้ดูไหม`, async () => {
    const [catalogue, keywordIds] = await Promise.all([
      plan.genres.length > 0 ? fetchGenres(ctx.tmdbApiKey) : Promise.resolve([]),
      plan.keywords.length > 0 ? resolveKeywordIds(ctx.tmdbApiKey, plan.keywords) : Promise.resolve([]),
    ]);
    const genreIds = matchGenreIds(plan.genres, catalogue);

    // Nothing resolved — /discover with no filter at all would answer "the
    // most popular films on TMDb", which looks like a result and answers
    // nothing. A title search at least tried to use what the user typed.
    if (genreIds.length === 0 && keywordIds.length === 0) {
      return await searchMoviesByTitle(ctx.tmdbApiKey, description);
    }
    return await discoverMovies(ctx.tmdbApiKey, { genreIds, keywordIds, streamingOnly: plan.streamingOnly });
  });
}

// ---- Matching -------------------------------------------------------------
//
// Whole phrases for the four ready-made lists, prefixes for the two that
// take an argument. Both deliberately narrow: "หนัง" is an ordinary Thai
// word that already appears in a spending note ("ค่าตั๋วหนัง 300") and in
// the entertainment category's own keywords, so anything looser here would
// start swallowing expenses. Natural phrasing is aiInterpreter.ts's job —
// the same division of labour as place search (see placesCommands.ts).

const LIST_PHRASES: Array<[MovieListKind, string[]]> = [
  ["now_playing", ["หนังใหม่", "หนังเข้าใหม่", "หนังโรง", "หนังกำลังฉาย", "หนังเข้าโรง", "มีหนังอะไรน่าดูบ้าง"]],
  ["upcoming", ["หนังกำลังจะเข้า", "หนังที่กำลังจะเข้า", "หนังเข้าเร็วๆ นี้", "หนังเร็วๆ นี้", "หนังที่จะเข้าโรง"]],
  ["trending", ["หนังมาแรง", "หนังฮิต", "หนังยอดนิยม", "หนังดัง"]],
  ["streaming", ["หนังสตรีมมิ่ง", "หนังใหม่ในสตรีมมิ่ง", "หนังใน netflix", "หนังเน็ตฟลิกซ์", "หนังออนไลน์"]],
];

const TITLE_SEARCH_RE = /^(?:หนังเรื่อง|ค้นหาหนัง|หาหนังเรื่อง)\s*(.+)$/;
const DISCOVER_RE = /^(?:หนังแนว|หนังเกี่ยวกับ|อยากดูหนัง|แนะนำหนัง)\s*(.+)$/;

/** Politeness that is not a description. "แนะนำหนังหน่อย" is a real request
 * with a real answer, but the words left after the prefix ("หน่อย") describe
 * no film at all — searching TMDb for them returns nonsense that looks like
 * a result. Stripped so that case can be recognised as "recommend me
 * something" and answered with the trending list instead. */
const POLITENESS_RE = /^(?:ให้)?(?:หน่อย|ที|ดิ|สิ|ด้วย|บ้าง|มั้ย|ไหม|นะ|ครับ|ค่ะ|คะ|\s)+$/;

export function matchMovieCommand(text: string): Handler | null {
  const trimmed = text.trim();
  const normalized = trimmed.replace(/[?？!]/g, "").trim().toLowerCase();

  for (const [kind, phrases] of LIST_PHRASES) {
    if (phrases.includes(normalized)) return (ctx) => answerMovieList(ctx, kind);
  }

  // Title search before description search: "หาหนังเรื่อง..." and
  // "แนะนำหนัง..." can't both match, but a future prefix could, and naming
  // a film is the more specific request of the two.
  const titleMatch = trimmed.match(TITLE_SEARCH_RE);
  if (titleMatch) {
    const query = titleMatch[1].trim();
    if (query) return (ctx) => answerMovieSearch(ctx, query);
  }

  const discoverMatch = trimmed.match(DISCOVER_RE);
  if (discoverMatch) {
    const description = discoverMatch[1].trim();
    if (POLITENESS_RE.test(description)) return (ctx) => answerMovieList(ctx, "trending");
    if (description) return (ctx) => answerMovieDiscover(ctx, description);
  }

  return null;
}

