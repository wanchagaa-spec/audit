// /view/movies (PLAN.md 17.57, series added in 17.58) — the poster half of
// a movie or series answer.
//
// This page exists for the same reason /view/search does: the chat can only
// send text, and for a list of films or series the poster is most of the
// information. It reads the stored result the chat message was built from,
// so what is on the page is exactly what was listed in chat, and adds the
// things that did not fit there — the poster, the synopsis, and a per-title
// link to TMDb's own "where to watch in Thailand" page.
//
// Like /view/search and unlike the rest of the /view family, this skips
// resolveViewSession: the token is verified, but there is no Google data
// here to trade it for, and refreshing an access token nothing reads would
// spend a subrequest for nothing.

import type { Env } from "./index.ts";
import {
  languageNameTh,
  releaseYear,
  TMDB_ATTRIBUTION,
  TMDB_IMAGE_BASE,
  tmdbWatchUrl,
  type Title,
} from "./movies.ts";
import { getMovieResult, type StoredMovieResult } from "./movieResults.ts";
import { verifyViewToken } from "./signedState.ts";
import { escapeHtml, html, pageShell, renderErrorPage, TOKEN_INVALID_MESSAGE } from "./viewAuth.ts";

const RESULT_GONE_MESSAGE =
  "รายการนี้หมดอายุแล้ว (เก็บไว้ 1 ชั่วโมง) ลองถามใหม่ในแชทเพื่อดึงรายการล่าสุดนะ";

/** Said once at the foot of the page rather than on every row: TMDb carries
 * no dub or subtitle data at all (see fetchThaiWatchProviders), and the
 * per-title link is where that question can actually be answered. */
const DUB_DISCLAIMER =
  "TMDb ไม่มีข้อมูลพากย์ไทย/ซับไทย — กด \"ดูได้ที่ไหนบ้าง\" เพื่อไปเช็คในแอปได้เลย";

/** Titles with no poster still get a row — a placeholder tile rather than a
 * broken image, which is common for things that have not premiered yet. */
function renderPoster(title: Title): string {
  if (!title.posterPath) return `<div class="poster poster-empty">ไม่มีโปสเตอร์</div>`;
  return `<img class="poster" src="${escapeHtml(`${TMDB_IMAGE_BASE}${title.posterPath}`)}" alt="${escapeHtml(
    title.name
  )}" loading="lazy" />`;
}

/** Only rendered when the chat answer actually looked availability up.
 * `undefined` means nothing asked, which is not the same as "not available"
 * and must not be shown as if it were. */
function renderProviders(title: Title): string {
  if (title.providers === undefined) return "";
  if (title.providers.length === 0) {
    return `<div class="movie-providers movie-providers-none">ยังไม่มีในแอปสตรีมมิ่งไทย</div>`;
  }
  const chips = title.providers.map((p) => `<span class="provider">${escapeHtml(p)}</span>`).join("");
  return `<div class="movie-providers">ดูได้ที่ ${chips}</div>`;
}

function renderTitle(title: Title): string {
  const year = releaseYear(title);
  const meta: string[] = [];
  meta.push(title.mediaType === "tv" ? "ซีรีส์" : "หนัง");
  if (year) meta.push(escapeHtml(year));
  // Hidden rather than shown as 0.0 when TMDb has no votes yet — the same
  // rule the chat lines follow, for the same reason.
  if (title.voteAverage > 0) meta.push(`⭐ ${title.voteAverage.toFixed(1)}`);
  const language = languageNameTh(title.originalLanguage);
  if (language) meta.push(`เสียง${escapeHtml(language)}`);

  const original =
    title.originalName && title.originalName !== title.name
      ? `<div class="movie-original">${escapeHtml(title.originalName)}</div>`
      : "";
  const overview = title.overview
    ? `<p class="movie-overview">${escapeHtml(title.overview)}</p>`
    : `<p class="movie-overview movie-overview-empty">ยังไม่มีเรื่องย่อภาษาไทย</p>`;

  return `<div class="card movie">
${renderPoster(title)}
<div class="movie-body">
<h2 class="movie-title">${escapeHtml(title.name)}</h2>
${original}
<div class="movie-meta">${meta.join(" · ")}</div>
${renderProviders(title)}
${overview}
<a class="movie-watch" href="${escapeHtml(tmdbWatchUrl(title.mediaType, title.id))}" target="_blank" rel="noopener noreferrer">ดูได้ที่ไหนบ้าง →</a>
</div>
</div>`;
}

function renderMoviesPage(result: StoredMovieResult): string {
  const body =
    result.movies.length === 0
      ? `<p class="empty">ไม่มีรายการ</p>`
      : result.movies.map(renderTitle).join("");
  return pageShell(
    result.heading,
    `<h1>${escapeHtml(result.heading)}</h1>
<p class="subtitle">${result.movies.length} เรื่อง</p>
${body}
<p class="footnote">${escapeHtml(DUB_DISCLAIMER)}</p>
<p class="footnote">${escapeHtml(TMDB_ATTRIBUTION)}</p>`
  );
}

export async function handleViewMoviesRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  const token = url.searchParams.get("token");
  if (!token) return html(renderErrorPage("เปิดหน้านี้ไม่ได้", TOKEN_INVALID_MESSAGE), 400);
  const subjectId = await verifyViewToken(token, env.STATE_SIGNING_SECRET);
  if (!subjectId) return html(renderErrorPage("เปิดหน้านี้ไม่ได้", TOKEN_INVALID_MESSAGE), 400);

  const id = url.searchParams.get("id");
  if (!id) return html(renderErrorPage("ไม่พบรายการ", RESULT_GONE_MESSAGE), 404);

  try {
    // Read through the token's own subject — one account's result id is
    // meaningless against another's token (see movieResults.ts).
    const result = await getMovieResult(env.ACCOUNTS, subjectId, id);
    if (!result) return html(renderErrorPage("ไม่พบรายการ", RESULT_GONE_MESSAGE), 404);
    return html(renderMoviesPage(result));
  } catch (err) {
    console.error("handleViewMoviesRequest: loading the stored result failed", err);
    return html(renderErrorPage("เปิดรายการไม่ได้", RESULT_GONE_MESSAGE), 502);
  }
}
