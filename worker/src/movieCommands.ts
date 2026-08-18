// Movie and series search and listings (PLAN.md 17.57, TV added in 17.58).
// Reads TMDb, writes nothing, confirms nothing — the same read-only shape
// as nearby-place search.
//
// Films and series run through exactly the same code, parameterised by
// `MediaType`: TMDb mirrors its API across /movie and /tv, so the only real
// differences are which endpoint a list comes from (movies.ts handles that)
// and what the answer is called in Thai (LIST_HEADINGS below).
//
// Every answer is two parts: a short list in chat, and a link to
// /view/movies for the same result with posters. That split is forced by
// the medium, not chosen — replyToLine sends plain text, so a poster can
// only ever be shown on a page. The chat half is deliberately still useful
// on its own (title, year, rating, and where to watch), because a list of
// five is a perfectly good chat answer and making someone tap a link to
// read one would be worse.

import { askGemini, GeminiError, type AskGeminiOptions } from "./gemini.ts";
import {
  attachThaiProviders,
  discoverTitles,
  fetchGenres,
  fetchTitleList,
  languageNameTh,
  releaseYear,
  resolveKeywordIds,
  searchTitlesByName,
  TmdbError,
  type MediaType,
  type MovieListKind,
  type Title,
} from "./movies.ts";
import { saveMovieResult, type StoredMovieResult } from "./movieResults.ts";
import { signViewToken } from "./signedState.ts";

/** Everything a movie/series answer needs. Narrower than the shared action
 * context the Google-backed commands take: nothing here touches Sheets,
 * Drive or a per-user access token, so asking for one would mean refreshing
 * a Google token to answer a question about cinema listings. */
export interface MovieCtx {
  kv: KVNamespace;
  subjectId: string;
  origin: string;
  tmdbReadToken: string;
  geminiApiKey: string;
  signingSecret: string;
}

type Handler = (ctx: MovieCtx) => Promise<string>;

/** Shown in chat. Five is what fits without the message becoming a wall —
 * the page carries the rest. Also the cap on provider lookups, since those
 * cost one subrequest each and these are the rows that display them. */
const CHAT_RESULTS = 5;

/** Kept on the page. Past twenty the list stops being browsable and the
 * stored blob stops being small. */
const PAGE_RESULTS = 20;

const NOT_CONFIGURED =
  "ฟีเจอร์หนัง/ซีรีส์ยังไม่พร้อมใช้งาน (ยังไม่ได้ตั้งค่า TMDb read access token) แจ้งผู้ดูแลบอทดูนะ";
const LOOKUP_FAILED = "ดึงข้อมูลหนัง/ซีรีส์ไม่สำเร็จ ลองใหม่อีกครั้งนะ";

/**
 * Shown under any answer that lists where to watch.
 *
 * The honest half of a question that was asked in full. "ดูได้ที่ไหน" TMDb
 * can answer; "มีพากย์ไทยไหม" it cannot — there is no dub or subtitle field
 * anywhere in its API (see fetchThaiWatchProviders' comment). Rather than
 * quietly answering only half and letting the other half look forgotten,
 * this says which half is missing and where to go for it.
 */
const DUB_DISCLAIMER = "ℹ️ TMDb ไม่มีข้อมูลพากย์ไทย/ซับไทย กดลิงก์ไปดูในแอปเพื่อเช็คได้เลย";

const LIST_HEADINGS: Record<MediaType, Record<MovieListKind, string>> = {
  movie: {
    now_playing: "หนังที่กำลังฉายในโรงตอนนี้",
    upcoming: "หนังที่กำลังจะเข้าโรงเร็วๆ นี้",
    trending: "หนังที่มาแรงในสัปดาห์นี้",
    streaming: "หนังใหม่ในแอปสตรีมมิ่ง",
  },
  tv: {
    now_playing: "ซีรีส์ที่กำลังฉายอยู่ตอนนี้",
    upcoming: "ซีรีส์ที่กำลังจะเริ่มฉาย",
    trending: "ซีรีส์ที่มาแรงในสัปดาห์นี้",
    streaming: "ซีรีส์ใหม่ในแอปสตรีมมิ่ง",
  },
};

const NOUN: Record<MediaType, string> = { movie: "หนัง", tv: "ซีรีส์" };

/** One chat line per title, plus a second indented line for availability
 * when it was looked up. The rating is dropped when TMDb has none rather
 * than printed as ⭐0.0, and the original name only appears when it differs
 * from the Thai one — otherwise every line says the same thing twice. */
function chatLine(title: Title, index: number): string {
  const year = releaseYear(title);
  const head = [`${index + 1}. ${title.name}`];
  if (title.originalName && title.originalName !== title.name) head.push(`(${title.originalName})`);
  if (year) head.push(`· ${year}`);
  if (title.voteAverage > 0) head.push(`· ⭐${title.voteAverage.toFixed(1)}`);

  // `providers` is undefined when nothing looked it up, and an empty array
  // when TMDb was asked and had nothing. Only the second is worth saying
  // out loud — the first would be reporting our own decision as a fact.
  if (title.providers === undefined) return head.join(" ");

  const detail: string[] = [];
  detail.push(title.providers.length > 0 ? `ดูได้ที่: ${title.providers.join(", ")}` : "ยังไม่มีในแอปสตรีมมิ่งไทย");
  const language = languageNameTh(title.originalLanguage);
  if (language) detail.push(`เสียงต้นฉบับ: ${language}`);
  return `${head.join(" ")}\n   ${detail.join(" · ")}`;
}

async function buildReply(
  ctx: MovieCtx,
  heading: string,
  titles: Title[],
  emptyMessage: string,
  showProviders: boolean
): Promise<string> {
  if (titles.length === 0) return emptyMessage;

  const shown = titles.slice(0, CHAT_RESULTS);
  if (showProviders) await attachThaiProviders(ctx.tmdbReadToken, shown, CHAT_RESULTS);
  const lines = shown.map(chatLine);

  const result: StoredMovieResult = {
    heading,
    movies: titles.slice(0, PAGE_RESULTS),
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
    console.error("buildReply: storing the result failed, sending the list without a link", err);
  }

  const tail = link === null ? [] : ["", "ดูโปสเตอร์ เรื่องย่อ และดูได้ที่ไหนบ้าง (ลิงก์ใช้ได้ 1 ชั่วโมง):", link];
  const note = showProviders ? ["", DUB_DISCLAIMER] : [];
  const more = titles.length > shown.length ? ` (มีอีก ${titles.length - shown.length} เรื่องในลิงก์)` : "";
  return [`${heading}${more}`, ...lines, ...note, ...tail].join("\n");
}

/** Every entry point funnels through here, so "no token configured" and
 * "TMDb threw" are answered identically no matter which command asked. */
async function answerWith(
  ctx: MovieCtx,
  heading: string,
  emptyMessage: string,
  showProviders: boolean,
  load: () => Promise<Title[]>
): Promise<string> {
  if (!ctx.tmdbReadToken) return NOT_CONFIGURED;
  let titles: Title[];
  try {
    titles = await load();
  } catch (err) {
    console.error("movieCommands: TMDb lookup failed", err);
    if (err instanceof TmdbError) return LOOKUP_FAILED;
    throw err;
  }
  return buildReply(ctx, heading, titles, emptyMessage, showProviders);
}

/**
 * Where to watch is shown for the answers whose question it *is*.
 *
 * Not for every answer: it costs one subrequest per row. A cinema listing
 * does not need it (the answer is "a cinema"), but anything about a
 * streaming catalogue does, and series are watched on streaming services
 * often enough that it is always worth showing for them.
 */
function wantsProviders(mediaType: MediaType, kind: MovieListKind): boolean {
  return mediaType === "tv" || kind === "streaming";
}

export async function answerMovieList(
  ctx: MovieCtx,
  mediaType: MediaType,
  kind: MovieListKind
): Promise<string> {
  const heading = LIST_HEADINGS[mediaType][kind];
  return answerWith(ctx, heading, `ตอนนี้ยังไม่มีข้อมูล${heading}เลยนะ`, wantsProviders(mediaType, kind), () =>
    fetchTitleList(ctx.tmdbReadToken, mediaType, kind)
  );
}

export async function answerMovieSearch(
  ctx: MovieCtx,
  mediaType: MediaType,
  query: string
): Promise<string> {
  const noun = NOUN[mediaType];
  return answerWith(
    ctx,
    `ผลค้นหา${noun} "${query}"`,
    `ไม่เจอ${noun}ชื่อ "${query}" เลยนะ ลองพิมพ์ชื่ออังกฤษดูไหม`,
    // A named title is exactly when "so where do I watch it" is the next
    // question, and there is only ever a handful of results.
    true,
    () => searchTitlesByName(ctx.tmdbReadToken, mediaType, query)
  );
}

// ---- Searching by what something is about ---------------------------------
//
// TMDb has no plot search: /search/movie and /search/tv match names only.
// What it does have is genres and a large human-curated keyword vocabulary,
// both searchable — so the job is turning "หนังเกี่ยวกับหุ่นยนต์ที่อยากเป็น
// มนุษย์" into those. That is a language problem, which is what Gemini is
// for, and it is a safe use of it by this codebase's own rule (see
// news.ts): the model picks search terms, it never states a fact. Every id
// it produces is resolved against TMDb's real vocabulary before use, and
// the titles that come back are TMDb's answer, not the model's.

const PLAN_SYSTEM_INSTRUCTION = [
  "คุณช่วยแปลงคำอธิบายหนัง/ซีรีส์ที่ผู้ใช้อยากดู ให้กลายเป็นคำค้นสำหรับฐานข้อมูล TMDb",
  "ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่นนอก JSON ห้ามใส่ ```",
  'รูปแบบ: {"genres": ["ชื่อแนวภาษาไทย"], "keywords": ["english keyword"], "streamingOnly": false}',
  "genres: ชื่อแนวภาษาไทยตามที่ TMDb ใช้ เช่น แอ็คชั่น ผจญภัย ตลก อาชญากรรม สารคดี ดราม่า ครอบครัว แฟนตาซี สยองขวัญ เพลง ลึกลับ โรแมนติก นิยายวิทยาศาสตร์ ระทึกขวัญ สงคราม ตะวันตก แอนิเมชัน ประวัติศาสตร์ ถ้าไม่แน่ใจให้ใส่ [] แทนการเดา",
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

export async function answerMovieDiscover(
  ctx: MovieCtx,
  mediaType: MediaType,
  description: string
): Promise<string> {
  if (!ctx.tmdbReadToken) return NOT_CONFIGURED;
  const noun = NOUN[mediaType];

  const plan = await planSearch(ctx.geminiApiKey, description, { kv: ctx.kv });

  // No plan means Gemini is unavailable or answered unusably. Falling back
  // to a title search is not the same question, but it is a real answer to a
  // near-enough one — and it is the only search TMDb can do without the
  // model. Saying "the AI is down" and stopping would be honest and useless.
  if (plan === null) {
    return answerWith(
      ctx,
      `ผลค้นหา${noun} "${description}"`,
      `ตอนนี้ค้นหาแบบบอกเนื้อเรื่องไม่ได้ (ระบบ AI ไม่ว่าง) และค้นจากชื่อ "${description}" ก็ไม่เจอนะ ลองบอกชื่อเรื่องตรงๆ ดูไหม`,
      true,
      () => searchTitlesByName(ctx.tmdbReadToken, mediaType, description)
    );
  }

  return answerWith(
    ctx,
    `${noun}ที่น่าจะตรงกับ "${description}"`,
    `ไม่เจอ${noun}ที่ตรงกับ "${description}" เลยนะ ลองบอกแนวหรือเนื้อเรื่องให้ละเอียดกว่านี้ดูไหม`,
    // Series are always worth showing availability for; films only when the
    // user asked for something they can stream.
    mediaType === "tv" || plan.streamingOnly,
    async () => {
      const [catalogue, keywordIds] = await Promise.all([
        plan.genres.length > 0 ? fetchGenres(ctx.tmdbReadToken, mediaType) : Promise.resolve([]),
        plan.keywords.length > 0 ? resolveKeywordIds(ctx.tmdbReadToken, plan.keywords) : Promise.resolve([]),
      ]);
      const genreIds = matchGenreIds(plan.genres, catalogue);

      // Nothing resolved — /discover with no filter at all would answer "the
      // most popular titles on TMDb", which looks like a result and answers
      // nothing. A name search at least tried to use what the user typed.
      if (genreIds.length === 0 && keywordIds.length === 0) {
        return await searchTitlesByName(ctx.tmdbReadToken, mediaType, description);
      }
      return await discoverTitles(ctx.tmdbReadToken, mediaType, {
        genreIds,
        keywordIds,
        streamingOnly: plan.streamingOnly,
      });
    }
  );
}

// ---- Matching -------------------------------------------------------------
//
// Whole phrases for the ready-made lists, prefixes for the two that take an
// argument. Both deliberately narrow: "หนัง" is an ordinary Thai word that
// already appears in a spending note ("ค่าตั๋วหนัง 300") and in the
// entertainment category's own keywords, so anything looser here would start
// swallowing expenses. Natural phrasing is aiInterpreter.ts's job — the same
// division of labour as place search (see placesCommands.ts).

/** "ซีรีส์" and "ซีรีย์" are both in everyday use and neither is a typo of
 * the other. Normalising once here means every phrase below is written a
 * single way instead of doubled. */
function normalizeMediaWords(text: string): string {
  return text.replace(/ซีรี[ยส]์|ซีรีส|ซีรีย/g, "ซีรีส์");
}

const LIST_PHRASES: Array<[MediaType, MovieListKind, string[]]> = [
  ["movie", "now_playing", ["หนังใหม่", "หนังเข้าใหม่", "หนังโรง", "หนังกำลังฉาย", "หนังเข้าโรง", "มีหนังอะไรน่าดูบ้าง"]],
  ["movie", "upcoming", ["หนังกำลังจะเข้า", "หนังที่กำลังจะเข้า", "หนังเข้าเร็วๆ นี้", "หนังเร็วๆ นี้", "หนังที่จะเข้าโรง"]],
  ["movie", "trending", ["หนังมาแรง", "หนังฮิต", "หนังยอดนิยม", "หนังดัง"]],
  ["movie", "streaming", ["หนังสตรีมมิ่ง", "หนังใหม่ในสตรีมมิ่ง", "หนังใน netflix", "หนังเน็ตฟลิกซ์", "หนังออนไลน์"]],
  ["tv", "now_playing", ["ซีรีส์ใหม่", "ซีรีส์กำลังฉาย", "ซีรีส์ที่กำลังฉาย", "มีซีรีส์อะไรน่าดูบ้าง"]],
  ["tv", "upcoming", ["ซีรีส์กำลังจะมา", "ซีรีส์ที่กำลังจะมา", "ซีรีส์เร็วๆ นี้", "ซีรีส์ที่จะฉาย"]],
  ["tv", "trending", ["ซีรีส์มาแรง", "ซีรีส์ฮิต", "ซีรีส์ยอดนิยม", "ซีรีส์ดัง"]],
  ["tv", "streaming", ["ซีรีส์สตรีมมิ่ง", "ซีรีส์ใหม่ในสตรีมมิ่ง", "ซีรีส์ใน netflix", "ซีรีส์เน็ตฟลิกซ์", "ซีรีส์ออนไลน์"]],
];

const SEARCH_PREFIXES: Array<[MediaType, RegExp]> = [
  ["movie", /^(?:หนังเรื่อง|ค้นหาหนัง|หาหนังเรื่อง)\s*(.+)$/],
  ["tv", /^(?:ซีรีส์เรื่อง|ค้นหาซีรีส์|หาซีรีส์เรื่อง)\s*(.+)$/],
];

const DISCOVER_PREFIXES: Array<[MediaType, RegExp]> = [
  ["movie", /^(?:หนังแนว|หนังเกี่ยวกับ|อยากดูหนัง|แนะนำหนัง)\s*(.*)$/],
  ["tv", /^(?:ซีรีส์แนว|ซีรีส์เกี่ยวกับ|อยากดูซีรีส์|แนะนำซีรีส์)\s*(.*)$/],
];

/** Trailing politeness and emphasis. Stripped before the remainder is
 * judged, so "แนะนำหนังหน่อย" and "แนะนำหนังมันๆ" both reduce to something
 * that can be recognised rather than searched for. */
const TRAILING_NOISE_RE = /(?:ให้|หน่อย|ที|ดิ|สิ|ด้วย|บ้าง|มั้ย|ไหม|นะ|ครับ|ค่ะ|คะ|จ้า|อ่ะ|ๆ|\s)+$/;

/**
 * Words that qualify a request without describing anything.
 *
 * "แนะนำหนังใหม่" leaves "ใหม่" after the prefix, and "แนะนำหนังมันๆ" leaves
 * "มัน" — neither describes a plot or a genre, so searching TMDb for them
 * returns nonsense that *looks like* an answer. They do carry a clear
 * intent, though, and it maps onto a list this bot already has. Anything not
 * in here is treated as a genuine description and goes to the AI-planned
 * search.
 */
const DESCRIPTOR_LISTS: Record<string, MovieListKind> = {
  "": "trending", // "แนะนำหนังหน่อย" — nothing left at all
  ใหม่: "now_playing",
  เข้าใหม่: "now_playing",
  โรง: "now_playing",
  ในโรง: "now_playing",
  ล่าสุด: "now_playing",
  มัน: "trending",
  สนุก: "trending",
  ดี: "trending",
  เด็ด: "trending",
  ดัง: "trending",
  ฮิต: "trending",
  มาแรง: "trending",
  น่าดู: "trending",
  เจ๋ง: "trending",
};

export function matchMovieCommand(text: string): Handler | null {
  const trimmed = normalizeMediaWords(text.trim());
  const normalized = trimmed.replace(/[?？!]/g, "").trim().toLowerCase();

  for (const [mediaType, kind, phrases] of LIST_PHRASES) {
    if (phrases.includes(normalized)) return (ctx) => answerMovieList(ctx, mediaType, kind);
  }

  // Name search before description search: the two prefix sets cannot both
  // match today, but a future prefix could, and naming a title is the more
  // specific request of the two.
  for (const [mediaType, re] of SEARCH_PREFIXES) {
    const m = trimmed.match(re);
    if (!m) continue;
    const query = m[1].trim();
    if (query) return (ctx) => answerMovieSearch(ctx, mediaType, query);
  }

  for (const [mediaType, re] of DISCOVER_PREFIXES) {
    const m = trimmed.match(re);
    if (!m) continue;
    const rest = m[1].trim();
    const descriptor = rest.replace(TRAILING_NOISE_RE, "").trim();
    const asList = DESCRIPTOR_LISTS[descriptor];
    if (asList !== undefined) return (ctx) => answerMovieList(ctx, mediaType, asList);
    if (rest) return (ctx) => answerMovieDiscover(ctx, mediaType, rest);
  }

  return null;
}
