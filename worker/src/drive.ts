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

// Streams the file straight from its source into Drive instead of buffering
// it into an ArrayBuffer/Blob first (the previous multipart approach, which
// needed the whole file in memory to interleave it with the JSON metadata
// part). A longer video clip is tens of MB, and holding the whole thing in
// memory just to re-serialize it risked the Worker's memory limit and added
// real latency — a real user report was a ~1 minute clip that uploaded fine
// via LINE but never got a bot reply, while short clips worked. Simple
// upload (uploadType=media) takes only raw bytes with no metadata, so name
// and folder are set with a small follow-up PATCH instead of inline.
export async function uploadFileToFolder(
  accessToken: string,
  folderId: string,
  filename: string,
  body: ReadableStream<Uint8Array>,
  mimeType: string
): Promise<string> {
  const uploadRes = await fetch(`${DRIVE_UPLOAD_BASE}/files?uploadType=media&fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": mimeType,
    },
    body,
    // Required by fetch implementations (e.g. Node/undici) whenever the
    // request body is a stream rather than a buffer; Cloudflare Workers'
    // fetch accepts it too.
    duplex: "half",
  } as RequestInit);
  if (!uploadRes.ok) {
    throw new Error(`Google Drive upload error (${uploadRes.status}): ${await uploadRes.text()}`);
  }
  const { id } = (await uploadRes.json()) as { id: string };

  // A file created via simple/media upload has no name and lands in the
  // account's root ("My Drive") by default, since no metadata was sent with
  // it — this renames it and moves it into the trip folder in one call.
  await driveFetch(accessToken, `/files/${id}?addParents=${folderId}&removeParents=root`, {
    method: "PATCH",
    body: JSON.stringify({ name: filename }),
  });

  return id;
}
