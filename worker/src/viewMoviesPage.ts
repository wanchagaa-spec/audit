// /view/movies (PLAN.md 17.57) — the poster half of a movie answer.
//
// This page exists for the same reason /view/search does: the chat can only
// send text, and for a list of films the poster is most of the information.
// It reads the stored result the chat message was built from, so what is on
// the page is exactly what was listed in chat, and adds the two things that
// did not fit there — the poster and the synopsis — plus a per-film link to
// TMDb's own "where to watch in Thailand" page.
//
// Like /view/search and unlike the rest of the /view family, this skips
// resolveViewSession: the token is verified, but there is no Google data
// here to trade it for, and refreshing an access token nothing reads would
// spend a subrequest for nothing.

import type { Env } from "./index.ts";
import { TMDB_ATTRIBUTION, TMDB_IMAGE_BASE, releaseYear, tmdbWatchUrl, type Movie } from "./movies.ts";
import { getMovieResult, type StoredMovieResult } from "./movieResults.ts";
import { verifyViewToken } from "./signedState.ts";
import { escapeHtml, html, pageShell, renderErrorPage, TOKEN_INVALID_MESSAGE } from "./viewAuth.ts";

const RESULT_GONE_MESSAGE =
  "รายการหนังนี้หมดอายุแล้ว (เก็บไว้ 1 ชั่วโมง) ลองถามใหม่ในแชทเพื่อดึงรายการล่าสุดนะ";

/** Films with no poster still get a row — a placeholder tile rather than a
 * broken image, which is common for films that have not opened yet. */
function renderPoster(movie: Movie): string {
  if (!movie.posterPath) return `<div class="poster poster-empty">ไม่มีโปสเตอร์</div>`;
  return `<img class="poster" src="${escapeHtml(`${TMDB_IMAGE_BASE}${movie.posterPath}`)}" alt="${escapeHtml(
    movie.title
  )}" loading="lazy" />`;
}

function renderMovie(movie: Movie): string {
  const year = releaseYear(movie);
  const meta: string[] = [];
  if (year) meta.push(escapeHtml(year));
  // Hidden rather than shown as 0.0 when TMDb has no votes yet — the same
  // rule the chat lines follow, for the same reason.
  if (movie.voteAverage > 0) meta.push(`⭐ ${movie.voteAverage.toFixed(1)}`);

  const original =
    movie.originalTitle && movie.originalTitle !== movie.title
      ? `<div class="movie-original">${escapeHtml(movie.originalTitle)}</div>`
      : "";
  const overview = movie.overview
    ? `<p class="movie-overview">${escapeHtml(movie.overview)}</p>`
    : `<p class="movie-overview movie-overview-empty">ยังไม่มีเรื่องย่อภาษาไทย</p>`;

  return `<div class="card movie">
${renderPoster(movie)}
<div class="movie-body">
<h2 class="movie-title">${escapeHtml(movie.title)}</h2>
${original}
<div class="movie-meta">${meta.join(" · ")}</div>
${overview}
<a class="movie-watch" href="${escapeHtml(tmdbWatchUrl(movie.id))}" target="_blank" rel="noopener noreferrer">ดูได้ที่ไหนบ้าง →</a>
</div>
</div>`;
}

function renderMoviesPage(result: StoredMovieResult): string {
  const body =
    result.movies.length === 0
      ? `<p class="empty">ไม่มีหนังในรายการนี้</p>`
      : result.movies.map(renderMovie).join("");
  return pageShell(
    result.heading,
    `<h1>${escapeHtml(result.heading)}</h1>
<p class="subtitle">${result.movies.length} เรื่อง</p>
${body}
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
  if (!id) return html(renderErrorPage("ไม่พบรายการหนัง", RESULT_GONE_MESSAGE), 404);

  try {
    // Read through the token's own subject — one account's result id is
    // meaningless against another's token (see movieResults.ts).
    const result = await getMovieResult(env.ACCOUNTS, subjectId, id);
    if (!result) return html(renderErrorPage("ไม่พบรายการหนัง", RESULT_GONE_MESSAGE), 404);
    return html(renderMoviesPage(result));
  } catch (err) {
    console.error("handleViewMoviesRequest: loading the stored movie result failed", err);
    return html(renderErrorPage("เปิดรายการหนังไม่ได้", RESULT_GONE_MESSAGE), 502);
  }
}
