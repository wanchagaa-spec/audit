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

// Streams the file straight from its source into Drive via the resumable
// upload protocol, instead of buffering it into an ArrayBuffer/Blob first
// (the previous multipart approach, which needed the whole file in memory to
// interleave it with the JSON metadata part). A longer video clip is tens of
// MB, and holding the whole thing in memory just to re-serialize it risked
// the Worker's memory limit and added real latency — a real user report was
// a ~1 minute clip that uploaded fine via LINE but never got a bot reply,
// while short clips worked.
//
// Deliberately not `uploadType=media` (Google's "simple upload"): that's
// documented for small files only (roughly under 5MB) — the opposite of the
// case this exists for. Resumable upload is Google's documented mechanism
// for larger/streamed files, and its init request carries the metadata
// (name + parent folder) up front, so — unlike simple upload — there's no
// separate rename/move call after the fact, and no risk of an orphaned,
// unnamed file sitting in Drive's root if a later step fails: nothing is
// created in Drive at all until the content upload itself succeeds.
export async function uploadFileToFolder(
  accessToken: string,
  folderId: string,
  filename: string,
  body: ReadableStream<Uint8Array>,
  mimeType: string,
  contentLength: number | null
): Promise<string> {
  const sessionRes = await fetch(`${DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
    },
    body: JSON.stringify({ name: filename, parents: [folderId] }),
  });
  if (!sessionRes.ok) {
    throw new Error(`Google Drive upload session error (${sessionRes.status}): ${await sessionRes.text()}`);
  }
  const uploadUrl = sessionRes.headers.get("location");
  if (!uploadUrl) {
    throw new Error("Google Drive did not return a resumable upload session URL");
  }

  // A single-request resumable upload needs the total size up front. LINE's
  // content API sends a Content-Length in practice, so the common case still
  // streams straight through with nothing buffered here; on the rare chance
  // it's missing, fall back to reading the stream fully first so this never
  // behaves worse than the old buffer-everything approach it replaced.
  let uploadBody: ReadableStream<Uint8Array> | ArrayBuffer = body;
  let length = contentLength;
  if (length == null) {
    uploadBody = await new Response(body).arrayBuffer();
    length = uploadBody.byteLength;
  }

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType, "Content-Length": String(length) },
    body: uploadBody,
    ...(uploadBody instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
  if (!putRes.ok) {
    throw new Error(`Google Drive upload error (${putRes.status}): ${await putRes.text()}`);
  }
  const { id } = (await putRes.json()) as { id: string };
  return id;
}
