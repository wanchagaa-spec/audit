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
