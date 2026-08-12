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

export async function uploadFileToFolder(
  accessToken: string,
  folderId: string,
  filename: string,
  bytes: ArrayBuffer,
  mimeType: string
): Promise<string> {
  const boundary = `beq_${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name: filename, parents: [folderId] });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--`,
  ]);
  const res = await fetch(`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Google Drive upload error (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}
