// /view/trips + /view/photo (PLAN.md 16.3) — the one view page that needed
// genuinely new data-access code: nothing before this ever read trip
// folders/files back out of Drive, only created folders and uploaded into
// them. Two routes share this file:
//   /view/trips            -> list of trip folders
//   /view/trips/:folderId  -> photo grid for one trip (paginated)
// plus /view/photo/:fileId, which proxies a single file's raw bytes — trip
// photos were uploaded under the `drive.file` scope, so they aren't
// publicly reachable any other way; the browser can never talk to the
// Drive API directly here, only to this Worker.
//
// Every grid thumbnail is the same full-resolution proxied image, just
// CSS-scaled down to a tile — no separate lightweight-thumbnail fetch.
// Simpler and always correctly authorized, at the cost of downloading full
// photos for what's visually a thumbnail; a real optimization (Drive's
// `thumbnailLink`, if it turns out to be fetchable without auth — untested
// here) is a good next improvement, not done in this pass.

import {
  fetchDriveFileContent,
  getFileName,
  listFilesInFolder,
  listTripFolders,
  type DriveFileListPage,
  type DriveFolderSummary,
} from "./drive.ts";
import type { Env } from "./index.ts";
import { DATA_FETCH_FAILED_MESSAGE, escapeHtml, html, pageShell, renderErrorPage, resolveViewSession } from "./viewAuth.ts";

function renderTripFolderList(token: string, folders: DriveFolderSummary[]): string {
  const nav = { token, active: "trips" as const };
  if (folders.length === 0) {
    return pageShell(
      "รูปทริป",
      `<h1>รูปทริป</h1><div class="card"><p class="empty">ยังไม่มีทริปที่บันทึกไว้</p></div>
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
      nav
    );
  }
  const listHtml = `<div class="folder-list">${folders
    .map(
      (f) => `<a href="/view/trips/${encodeURIComponent(f.id)}?token=${encodeURIComponent(token)}">📸 ${escapeHtml(f.name)}</a>`
    )
    .join("\n")}</div>`;
  return pageShell("รูปทริป", `<h1>รูปทริป</h1>${listHtml}<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`, nav);
}

function renderTripPhotoGrid(token: string, folderName: string, folderId: string, page: DriveFileListPage): string {
  const nav = { token, active: "trips" as const };
  const backLink = `<div class="nav-links"><a href="/view/trips?token=${encodeURIComponent(token)}">‹ ทริปทั้งหมด</a></div>`;

  if (page.files.length === 0) {
    return pageShell(
      folderName,
      `<h1>${escapeHtml(folderName)}</h1>${backLink}
<div class="card"><p class="empty">ยังไม่มีรูปในทริปนี้</p></div>
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
      nav
    );
  }

  const gridHtml = `<div class="grid">${page.files
    .map((f) => {
      const src = `/view/photo/${encodeURIComponent(f.id)}?token=${encodeURIComponent(token)}`;
      return `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" loading="lazy" alt="${escapeHtml(f.name)}" /></a>`;
    })
    .join("\n")}</div>`;

  const loadMoreHtml = page.nextPageToken
    ? `<div class="nav-links"><a href="/view/trips/${encodeURIComponent(folderId)}?token=${encodeURIComponent(token)}&page=${encodeURIComponent(page.nextPageToken)}">ดูรูปเพิ่มเติม ›</a></div>`
    : "";

  return pageShell(
    folderName,
    `<h1>${escapeHtml(folderName)}</h1>${backLink}${gridHtml}${loadMoreHtml}
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว · แตะรูปเพื่อดูขนาดเต็ม</p>`,
    nav
  );
}

const TRIPS_PATH_PREFIX = "/view/trips/";

export async function handleViewTripsRequest(request: Request, env: Env): Promise<Response> {
  const session = await resolveViewSession(request, env);
  if (session instanceof Response) return session;

  const url = new URL(request.url);

  if (url.pathname === "/view/trips") {
    try {
      const folders = await listTripFolders(session.accessToken);
      return html(renderTripFolderList(session.token, folders));
    } catch (err) {
      console.error("handleViewTripsRequest: listing trip folders failed", err);
      return html(renderErrorPage("ดึงข้อมูลไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
    }
  }

  if (url.pathname.startsWith(TRIPS_PATH_PREFIX)) {
    const folderId = decodeURIComponent(url.pathname.slice(TRIPS_PATH_PREFIX.length));
    if (!folderId) return html(renderErrorPage("ไม่พบทริป", "ไม่พบทริปที่ขอ"), 404);

    const pageToken = url.searchParams.get("page") ?? undefined;
    try {
      const folderName = await getFileName(session.accessToken, folderId);
      if (!folderName) return html(renderErrorPage("ไม่พบทริป", "ไม่พบทริปนี้ หรือไม่มีสิทธิ์เข้าถึง"), 404);

      const page = await listFilesInFolder(session.accessToken, folderId, pageToken);
      return html(renderTripPhotoGrid(session.token, folderName, folderId, page));
    } catch (err) {
      console.error("handleViewTripsRequest: listing trip photos failed", err);
      return html(renderErrorPage("ดึงข้อมูลไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
    }
  }

  return html(renderErrorPage("ไม่พบหน้านี้", "ไม่พบหน้าที่ขอ"), 404);
}

const PHOTO_PATH_PREFIX = "/view/photo/";

export async function handleViewPhotoRequest(request: Request, env: Env): Promise<Response> {
  const session = await resolveViewSession(request, env);
  if (session instanceof Response) return session;

  const url = new URL(request.url);
  const fileId = decodeURIComponent(url.pathname.slice(PHOTO_PATH_PREFIX.length));
  if (!fileId) return html(renderErrorPage("ไม่พบรูป", "ไม่พบรูปที่ขอ"), 404);

  try {
    const file = await fetchDriveFileContent(session.accessToken, fileId);
    if (!file) return html(renderErrorPage("ไม่พบรูป", "ไม่พบรูปนี้ หรือไม่มีสิทธิ์เข้าถึง"), 404);
    return new Response(file.body, {
      status: 200,
      headers: {
        "content-type": file.contentType,
        // fileId never changes once uploaded, so caching aggressively is
        // safe — this only helps the same browser/session, not other
        // viewers ("private": not a shared cache like a CDN).
        "cache-control": "private, max-age=3600",
      },
    });
  } catch (err) {
    console.error("handleViewPhotoRequest: fetching photo failed", err);
    return html(renderErrorPage("ดึงรูปไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
  }
}
