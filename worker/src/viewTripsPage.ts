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
  listAllFilesInFolder,
  listFilesInFolder,
  listTripFolders,
  trashFile,
  type DriveFileListPage,
  type DriveFolderSummary,
} from "./drive.ts";
import { duplicateFileCount, findDuplicateGroups, type DuplicateGroup } from "./tripDuplicates.ts";
import type { Env } from "./index.ts";
import { bangkokDateKey, formatThaiDateLabel } from "./thaiDate.ts";
import {
  DATA_FETCH_FAILED_MESSAGE,
  decodeUrlSegment,
  escapeHtml,
  html,
  pageShell,
  renderErrorPage,
  resolveViewSession,
} from "./viewAuth.ts";

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
      // f.createdTime is Drive's own record of the upload moment, always
      // present for a real file — no fallback needed for a null/missing
      // case the API doesn't produce.
      const uploadedLabel = formatThaiDateLabel(bangkokDateKey(new Date(f.createdTime)));
      return `<div><a href="${src}" target="_blank" rel="noopener"><img src="${src}" loading="lazy" alt="${escapeHtml(f.name)}" /></a><div class="grid-caption">${escapeHtml(uploadedLabel)}</div></div>`;
    })
    .join("\n")}</div>`;

  const loadMoreHtml = page.nextPageToken
    ? `<div class="nav-links"><a href="/view/trips/${encodeURIComponent(folderId)}?token=${encodeURIComponent(token)}&page=${encodeURIComponent(page.nextPageToken)}">ดูรูปเพิ่มเติม ›</a></div>`
    : "";

  const duplicatesLink = `<div class="nav-links"><a href="${duplicatesUrl(token, folderId)}">ตรวจหาไฟล์ซ้ำในทริปนี้ ›</a></div>`;

  return pageShell(
    folderName,
    `<h1>${escapeHtml(folderName)}</h1>${backLink}${gridHtml}${loadMoreHtml}${duplicatesLink}
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว · แตะรูปเพื่อดูขนาดเต็ม</p>`,
    nav
  );
}

function tripUrl(token: string, folderId: string): string {
  return `/view/trips/${encodeURIComponent(folderId)}?token=${encodeURIComponent(token)}`;
}

function duplicatesUrl(token: string, folderId: string): string {
  return `${tripUrl(token, folderId)}&duplicates=1`;
}

/**
 * What would be removed, shown in full before anything is.
 *
 * The same two-speed rule the diary and accounts pages settled on, and with
 * more reason than either: this is the only place the bot proposes deleting
 * something the user never asked it about file by file. Every copy is named,
 * dated, and shown, and the one that survives is labelled — so the decision
 * being confirmed is visible rather than described.
 */
function renderDuplicatesPage(
  token: string,
  folderName: string,
  folderId: string,
  groups: DuplicateGroup[],
  truncated: boolean,
  notice?: string
): string {
  const nav = { token, active: "trips" as const };
  const backLink = `<div class="nav-links"><a href="${tripUrl(token, folderId)}">‹ กลับไปดูรูปทริป</a></div>`;
  const noticeHtml = notice ? `<p class="save-notice">${escapeHtml(notice)}</p>` : "";
  // Said whenever the scan stopped early, not only when duplicates were
  // found: "no duplicates" from a partial scan is a different statement from
  // "no duplicates", and the user cannot tell them apart otherwise.
  const truncatedHtml = truncated
    ? `<p class="footnote">ทริปนี้มีไฟล์เยอะมาก ตรวจได้แค่บางส่วน — ลบรอบนี้แล้วกดตรวจซ้ำอีกครั้งเพื่อดูส่วนที่เหลือ</p>`
    : "";

  if (groups.length === 0) {
    return pageShell(
      `ไฟล์ซ้ำ · ${folderName}`,
      `<h1>ไฟล์ซ้ำ</h1><p class="subtitle">${escapeHtml(folderName)}</p>
${backLink}
${noticeHtml}
<div class="card"><p class="empty">ไม่พบไฟล์ซ้ำในทริปนี้</p></div>
${truncatedHtml}
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
      nav
    );
  }

  const total = duplicateFileCount(groups);
  const rows = groups
    .map((g) => {
      const kept = `<div class="dup-keep">เก็บไว้ · ${escapeHtml(formatThaiDateLabel(bangkokDateKey(new Date(g.keep.createdTime))))}</div>`;
      const thumb = `<a href="/view/photo/${encodeURIComponent(g.keep.id)}?token=${encodeURIComponent(token)}" target="_blank" rel="noopener"><img class="dup-thumb" src="/view/photo/${encodeURIComponent(g.keep.id)}?token=${encodeURIComponent(token)}" loading="lazy" alt="${escapeHtml(g.name)}" /></a>`;
      return `<tr>
    <td>${thumb}</td>
    <td class="note"><div class="dup-name">${escapeHtml(g.name)}</div>${kept}</td>
    <td class="num">${g.remove.length + 1} ใบ<div class="dup-remove">ลบ ${g.remove.length}</div></td>
  </tr>`;
    })
    .join("\n");

  return pageShell(
    `ไฟล์ซ้ำ · ${folderName}`,
    `<h1>ไฟล์ซ้ำ</h1><p class="subtitle">${escapeHtml(folderName)}</p>
${backLink}
${noticeHtml}
<div class="card">
  <h2>พบ ${groups.length} รูปที่มีสำเนาซ้ำ</h2>
  <p class="subtitle">ชื่อไฟล์ซ้ำกันแปลว่าเป็นรูปเดียวกันแน่นอน (ชื่อมีรหัสข้อความของ LINE อยู่) · เก็บใบที่อัปขึ้นก่อนไว้เสมอ</p>
  <div class="table-scroll"><table class="data-table">
    <thead><tr><th></th><th>ไฟล์</th><th class="num">มีอยู่</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table></div>
</div>
<form method="post" action="${duplicatesUrl(token, folderId)}" class="confirm-actions">
  <button type="submit">ลบไฟล์ซ้ำ ${total} ไฟล์</button>
  <a href="${tripUrl(token, folderId)}">ยกเลิก</a>
</form>
<p class="footnote">ไฟล์ที่ลบจะไปอยู่ในถังขยะของ Google Drive กู้คืนได้ภายใน 30 วัน</p>
${truncatedHtml}`,
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
    const folderId = decodeUrlSegment(url.pathname.slice(TRIPS_PATH_PREFIX.length));
    if (!folderId) return html(renderErrorPage("ไม่พบทริป", "ไม่พบทริปที่ขอ"), 404);

    const pageToken = url.searchParams.get("page") ?? undefined;
    try {
      const folderName = await getFileName(session.accessToken, folderId);
      if (!folderName) return html(renderErrorPage("ไม่พบทริป", "ไม่พบทริปนี้ หรือไม่มีสิทธิ์เข้าถึง"), 404);

      if (url.searchParams.get("duplicates")) {
        return handleTripDuplicates(request, session, folderName, folderId);
      }

      const page = await listFilesInFolder(session.accessToken, folderId, pageToken);
      return html(renderTripPhotoGrid(session.token, folderName, folderId, page));
    } catch (err) {
      console.error("handleViewTripsRequest: listing trip photos failed", err);
      return html(renderErrorPage("ดึงข้อมูลไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
    }
  }

  return html(renderErrorPage("ไม่พบหน้านี้", "ไม่พบหน้าที่ขอ"), 404);
}


/**
 * The duplicate scan, and the delete behind it.
 *
 * The scan is re-run on the POST rather than trusting a list of file ids
 * posted back from the page. A form is not a promise: ids from a stale tab —
 * or edited by hand — would be a request to trash arbitrary files in the
 * user's Drive, and the page would look exactly the same either way. Doing
 * the work again costs a few Drive requests and means the only files that
 * can ever be trashed are ones the current state of the folder says are
 * redundant.
 */
async function handleTripDuplicates(
  request: Request,
  session: { token: string; accessToken: string },
  folderName: string,
  folderId: string
): Promise<Response> {
  const { files, truncated } = await listAllFilesInFolder(session.accessToken, folderId);
  const groups = findDuplicateGroups(files);

  if (request.method !== "POST") {
    return html(renderDuplicatesPage(session.token, folderName, folderId, groups, truncated));
  }

  let trashed = 0;
  let failed = 0;
  for (const group of groups) {
    for (const file of group.remove) {
      try {
        await trashFile(session.accessToken, file.id);
        trashed++;
      } catch (err) {
        // One file failing must not abandon the rest — the next scan will
        // simply offer whatever is still there.
        console.error("handleTripDuplicates: trashing a duplicate failed", file.id, err);
        failed++;
      }
    }
  }

  const notice =
    trashed === 0 && failed === 0
      ? "ไม่พบไฟล์ซ้ำที่ต้องลบแล้ว"
      : failed > 0
        ? `ลบไฟล์ซ้ำแล้ว ${trashed} ไฟล์ (อีก ${failed} ไฟล์ลบไม่สำเร็จ ลองกดใหม่อีกครั้งได้)`
        : `ลบไฟล์ซ้ำแล้ว ${trashed} ไฟล์`;

  // Re-scanned from Drive rather than reusing the groups above, so the page
  // shows what is actually left after the deletes instead of what was there
  // before them.
  const after = await listAllFilesInFolder(session.accessToken, folderId);
  return html(
    renderDuplicatesPage(
      session.token,
      folderName,
      folderId,
      findDuplicateGroups(after.files),
      after.truncated,
      notice
    )
  );
}

const PHOTO_PATH_PREFIX = "/view/photo/";

export async function handleViewPhotoRequest(request: Request, env: Env): Promise<Response> {
  const session = await resolveViewSession(request, env);
  if (session instanceof Response) return session;

  const url = new URL(request.url);
  const fileId = decodeUrlSegment(url.pathname.slice(PHOTO_PATH_PREFIX.length));
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
