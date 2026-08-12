// Cloudflare Workers' Free plan caps external subrequests (~50) and CPU time per
// invocation, which a single webhook call can't safely spend on a large batch of
// photos/videos — each one needs 2 external requests (fetch from LINE, upload to
// Drive), plus the reply itself is a request. Real reports: 37 photos → 2 silently
// missing from Drive, 50 photos → 1-4 silently missing, always with zero reply and
// zero error for the missing ones — the telltale sign of the whole invocation
// getting cut off by a platform limit rather than a normal catchable failure. See
// PLAN.md 15.2's later "แก้ไขระหว่างพัฒนา" callouts for the two earlier, insufficient
// attempts at fixing this purely by trimming the request count per file.
//
// A big batch gets queued here instead of processed immediately (src/index.ts
// decides the cutoff). A scheduled Worker invocation — wired to the cron trigger
// in wrangler.toml, handled by `drainUploadQueue` in src/index.ts — drains a
// bounded number of queued items at a time; each drain is its own invocation with
// a completely fresh subrequest/CPU budget, so a batch of any size eventually gets
// through safely instead of losing files past whatever the real ceiling turns out
// to be.
//
// Each queued item gets its own KV key rather than living in one shared array, so
// concurrent enqueues (e.g. two people using the bot around the same time) can
// never race each other on a read-modify-write of a single value.

const QUEUE_PREFIX = "upload-queue:";

export interface QueuedUpload {
  lineUserId: string;
  kind: "image" | "video";
  messageId: string;
  timestampMs: number;
  // Snapshotted at enqueue time (not re-checked at drain time): a photo belongs
  // to whatever trip was open when it was sent, even if the trip gets closed
  // before the queue drains it.
  tripFolderId: string;
  tripName: string;
}

export async function enqueueUploads(kv: KVNamespace, jobs: QueuedUpload[]): Promise<void> {
  await Promise.all(
    jobs.map((job) =>
      kv.put(`${QUEUE_PREFIX}${crypto.randomUUID()}`, JSON.stringify(job), {
        metadata: { lineUserId: job.lineUserId },
      })
    )
  );
}

// KV list() returns key metadata inline without fetching each value, so this
// stays cheap even with a decently deep queue. Caps at KV's own 1000-keys-per-call
// list limit, which a personal bot's queue depth is never remotely close to.
export async function countQueuedForUser(kv: KVNamespace, lineUserId: string): Promise<number> {
  const { keys } = await kv.list<{ lineUserId: string }>({ prefix: QUEUE_PREFIX });
  return keys.filter((k) => k.metadata?.lineUserId === lineUserId).length;
}

export interface QueueEntry {
  key: string;
  job: QueuedUpload;
}

export async function listQueueBatch(kv: KVNamespace, limit: number): Promise<QueueEntry[]> {
  const { keys } = await kv.list({ prefix: QUEUE_PREFIX, limit });
  const entries: QueueEntry[] = [];
  for (const k of keys) {
    const raw = await kv.get(k.name);
    if (raw) entries.push({ key: k.name, job: JSON.parse(raw) as QueuedUpload });
  }
  return entries;
}

export async function deleteQueueEntry(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(key);
}
