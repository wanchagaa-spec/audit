// Google Drive helpers for the trip photo album feature (PLAN.md section 15.2).
// Uses the same `drive.file` scope already granted for creating the Sheets
// spreadsheet, so no extra Google consent is needed for this feature.

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const ALBUM_ROOT_FOLDER_NAME = "จดบัญชี - อัลบั้มทริป";

async function driveFetch(accessToken: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${DRIVE_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Google Drive API error (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findFolder(accessToken: string, name: string, parentId: string): Promise<string | null> {
  const q = `mimeType='${FOLDER_MIME}' and name='${escapeDriveQueryValue(name)}' and trashed=false and '${parentId}' in parents`;
  const found = await driveFetch(accessToken, `/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`);
  return found.files?.[0]?.id ?? null;
}

export async function findOrCreateFolder(accessToken: string, name: string, parentId: string): Promise<string> {
  const existing = await findFolder(accessToken, name, parentId);
  if (existing) return existing;
  const created = await driveFetch(accessToken, `/files?fields=id`, {
    method: "POST",
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  return created.id;
}

export async function getOrCreateAlbumRoot(accessToken: string): Promise<string> {
  const q = `mimeType='${FOLDER_MIME}' and name='${ALBUM_ROOT_FOLDER_NAME}' and trashed=false and 'root' in parents`;
  const found = await driveFetch(accessToken, `/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`);
  const existing = found.files?.[0]?.id;
  if (existing) return existing;
  const created = await driveFetch(accessToken, `/files?fields=id`, {
    method: "POST",
    body: JSON.stringify({ name: ALBUM_ROOT_FOLDER_NAME, mimeType: FOLDER_MIME }),
  });
  return created.id;
}

/**
 * Which of these messageIds already have a file in the trip folder
 * (PLAN.md 17.68).
 *
 * The upload queue cannot promise exactly-once on its own. KV is eventually
 * consistent, so an entry deleted after a successful upload can still be
 * read back for up to a minute and uploaded again; and because the cron
 * fires every minute while a drain of several videos can take longer than
 * that, two drains can overlap and work through the same entries. Both were
 * observed in production as duplicate photos in one trip folder.
 *
 * Drive is the one strongly consistent thing in the loop, and the filename
 * already carries the messageId (see uploadTripMedia), so it can answer
 * "did this one already land?" exactly. One request covers a whole drain
 * batch — the messageIds are OR-ed into a single query rather than asked one
 * at a time, because the subrequest budget is the reason the queue exists.
 *
 * A failure here is not fatal to the drain: the caller treats "don't know"
 * as "not uploaded" and proceeds, which is the same behaviour as before this
 * existed.
 */
export async function findUploadedMessageIds(
  accessToken: string,
  folderId: string,
  messageIds: string[]
): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const nameClauses = messageIds
    .map((id) => `name contains '${escapeDriveQueryValue(id)}'`)
    .join(" or ");
  const q = `trashed=false and '${escapeDriveQueryValue(folderId)}' in parents and (${nameClauses})`;
  const params = new URLSearchParams({
    q,
    fields: "files(name)",
    // One page is always enough: at most one file per requested id can match,
    // and a drain batch is far smaller than Drive's page size.
    pageSize: String(Math.max(messageIds.length, 10)),
    spaces: "drive",
  });
  const data = await driveFetch(accessToken, `/files?${params}`);
  const names: string[] = (data.files ?? []).map((f: any) => f.name ?? "");
  // Matched back by substring rather than by reconstructing the filename:
  // the extension depends on the content type Drive was handed, which is
  // only known after the media has been fetched from LINE — the whole thing
  // this check exists to avoid doing twice.
  return new Set(messageIds.filter((id) => names.some((name) => name.includes(id))));
}

// Everything below is for the web viewer (PLAN.md 16) reading trip photos
// back — nothing above this point ever needed to list or read a file back,
// only create folders and upload into them.

export interface DriveFolderSummary {
  id: string;
  name: string;
}

/** Trip folders directly under the album root, most recently created first. */
export async function listTripFolders(accessToken: string): Promise<DriveFolderSummary[]> {
  const rootId = await getOrCreateAlbumRoot(accessToken);
  const q = `mimeType='${FOLDER_MIME}' and trashed=false and '${rootId}' in parents`;
  const data = await driveFetch(
    accessToken,
    `/files?q=${encodeURIComponent(q)}&fields=files(id,name)&orderBy=createdTime desc&pageSize=100&spaces=drive`
  );
  return (data.files ?? []).map((f: any) => ({ id: f.id, name: f.name }));
}

export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  // ISO 8601, used by the web viewer to caption each thumbnail with the
  // upload date (PLAN.md 16.3) — Drive's own record of when the file was
  // created, not parsed back out of the filename (which happens to also
  // encode the date, but isn't the field meant to be authoritative for it).
  createdTime: string;
}

export interface DriveFileListPage {
  files: DriveFileSummary[];
  nextPageToken: string | null;
}

const PHOTOS_PAGE_SIZE = 60;

/** Photos/videos inside one trip folder, newest first, paginated (a trip
 * can easily hold more files than are worth loading in one page). */
export async function listFilesInFolder(
  accessToken: string,
  folderId: string,
  pageToken?: string
): Promise<DriveFileListPage> {
  // folderId comes straight from the URL path in the web viewer
  // (/view/trips/:folderId) — untrusted input, same as any folder *name*
  // elsewhere in this file, so it needs the same escaping or a crafted id
  // containing a quote could break out of the `'...' in parents` clause.
  const q = `mimeType!='${FOLDER_MIME}' and trashed=false and '${escapeDriveQueryValue(folderId)}' in parents`;
  const params = new URLSearchParams({
    q,
    fields: "nextPageToken,files(id,name,mimeType,createdTime)",
    orderBy: "createdTime desc",
    pageSize: String(PHOTOS_PAGE_SIZE),
    spaces: "drive",
  });
  if (pageToken) params.set("pageToken", pageToken);
  const data = await driveFetch(accessToken, `/files?${params}`);
  return {
    files: (data.files ?? []).map((f: any) => ({ id: f.id, name: f.name, mimeType: f.mimeType, createdTime: f.createdTime })),
    nextPageToken: data.nextPageToken ?? null,
  };
}

/**
 * Every file in a trip folder, following Drive's pagination (PLAN.md 17.69).
 *
 * The photo grid deliberately pages — a trip can hold more files than are
 * worth loading at once — but duplicate detection cannot: two copies of the
 * same photo can easily land on different pages, and a check that only looks
 * at one page reports "no duplicates" for a folder full of them.
 *
 * Bounded rather than looping until Drive says stop. A runaway pagination
 * loop inside a Worker is a request that never returns, and a trip folder
 * large enough to hit this ceiling is well past what one confirm page can
 * usefully show anyway.
 */
const MAX_DUPLICATE_SCAN_PAGES = 20;

export async function listAllFilesInFolder(
  accessToken: string,
  folderId: string
): Promise<{ files: DriveFileSummary[]; truncated: boolean }> {
  const files: DriveFileSummary[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_DUPLICATE_SCAN_PAGES; page++) {
    const result = await listFilesInFolder(accessToken, folderId, pageToken);
    files.push(...result.files);
    if (!result.nextPageToken) return { files, truncated: false };
    pageToken = result.nextPageToken;
  }
  return { files, truncated: true };
}

/**
 * Moves a file to Drive's trash rather than deleting it (PLAN.md 17.69).
 *
 * `files.delete` is permanent and immediate; this is somebody's photo, and
 * the whole feature is built on the bot's own judgement about which copy is
 * redundant. Trashing keeps Drive's own 30-day undo behind that judgement,
 * at no cost to the thing the user actually wanted — the duplicate stops
 * being in the trip folder either way.
 */
export async function trashFile(accessToken: string, fileId: string): Promise<void> {
  await driveFetch(accessToken, `/files/${encodeURIComponent(fileId)}?fields=id`, {
    method: "PATCH",
    body: JSON.stringify({ trashed: true }),
  });
}

/** A trip folder's display name, or null specifically when it doesn't
 * exist (or isn't reachable with this access token — same 404 either
 * way). Any other failure throws instead, same distinction
 * fetchDriveFileContent makes and for the same reason: driveFetch's
 * generic "throw on any non-ok response" would otherwise collapse a
 * transient 5xx into the same null as "no such trip," which the caller
 * renders as a flat "not found" — misleading for a failure a retry would
 * have fixed. */
export async function getFileName(accessToken: string, fileId: string): Promise<string | null> {
  const res = await fetch(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?fields=name`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Google Drive API error (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { name?: string };
  return data.name ?? null;
}

/** Streams one file's raw bytes straight from Drive, or null specifically
 * when the file genuinely doesn't exist (or isn't reachable with this
 * access token — same 404 either way) — used to proxy trip photos to the
 * browser, since files uploaded under the `drive.file` scope aren't
 * publicly reachable by any other means (no Authorization header, no
 * anonymous fetch). Any other failure (a transient 5xx, say) throws
 * instead of also returning null, so the caller can tell "this photo
 * doesn't exist" apart from "couldn't load it right now, try again" —
 * conflating the two would tell someone their photo is gone when Drive
 * just hiccuped. Returns the live Response rather than buffering the body
 * into memory first, the same streaming approach uploadFileToFolder
 * already uses in the other direction. */
export async function fetchDriveFileContent(
  accessToken: string,
  fileId: string
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string } | null> {
  const res = await fetch(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Google Drive API error (${res.status}): ${await res.text()}`);
  }
  if (!res.body) return null;
  return { body: res.body, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}

// Concatenates fixed byte chunks and/or passthrough streams into one
// ReadableStream, reading each source only once and only as fast as the
// consumer pulls. Used below to build a streamed multipart body without
// materializing the whole thing (or the whole media file) in memory first.
function concatStreams(...parts: Array<Uint8Array | ReadableStream<Uint8Array>>): ReadableStream<Uint8Array> {
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (index < parts.length) {
        const part = parts[index];
        if (part instanceof Uint8Array) {
          controller.enqueue(part);
          index++;
          return;
        }
        if (!reader) reader = part.getReader();
        const { value, done } = await reader.read();
        if (done) {
          reader = null;
          index++;
          continue;
        }
        controller.enqueue(value);
        return;
      }
      controller.close();
    },
  });
}

// Uploads in a single request — Drive's multipart upload, same as before the
// streaming work started — but with the body assembled as a stream instead
// of a fully-buffered Blob, so a large video clip never has to sit in Worker
// memory in one piece. This combines two things that turned out to matter
// for real reports and can't each be dropped:
//
// - Streaming (not buffering) matters for a single large file: a ~1 minute
//   clip that uploaded fine via LINE never got a bot reply, traced to
//   buffering the whole file into memory before upload (risking the
//   Worker's memory limit and doubling total latency).
// - A single request per file matters for a *large batch*: an earlier
//   version of this streaming fix used Drive's resumable upload, which needs
//   two requests per file (init + content). Sending 37 photos in one LINE
//   multi-select then needed ~75 Drive subrequests in one webhook call,
//   which silently exceeded Cloudflare's per-request subrequest budget for
//   a couple of the files — the exact "some files vanish with zero reply"
//   failure mode already hit and fixed once before (see PLAN.md 15.2's
//   second correction), reintroduced by doubling the request count per file.
//
// Multipart (unlike simple upload) also carries the name+parent metadata
// inline, so this stays atomic — Drive doesn't create anything until the one
// request completes, so a failure never leaves an orphaned file behind.
export async function uploadFileToFolder(
  accessToken: string,
  folderId: string,
  filename: string,
  body: ReadableStream<Uint8Array>,
  mimeType: string
): Promise<string> {
  const boundary = `beq_${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const metadata = JSON.stringify({ name: filename, parents: [folderId] });
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const suffix = encoder.encode(`\r\n--${boundary}--`);
  const streamedBody = concatStreams(prefix, body, suffix);

  const res = await fetch(`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: streamedBody,
    duplex: "half",
  } as RequestInit);
  if (!res.ok) {
    throw new Error(`Google Drive upload error (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}
