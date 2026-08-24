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
//
// That key is the LINE messageId, not a random UUID: LINE redelivers a webhook
// it didn't get a timely "ok" for, and with a random key each redelivery
// enqueued the same photo again, uploading a duplicate into the trip folder.
// A messageId is globally unique and identifies exactly one media file, so a
// redelivery now overwrites its own entry instead of adding a second one —
// idempotent by construction, with no extra bookkeeping and no risk of the
// opposite failure (a dedup marker outliving a failed upload and suppressing
// the retry that would have saved the file). Each item still owns its own key,
// so the no-read-modify-write property above is unchanged.

const QUEUE_PREFIX = "upload-queue:";

/**
 * "There is probably something in the queue" (PLAN.md 17.66).
 *
 * The cron runs every minute so the 07:00 briefing lands on the right one,
 * and until this the drain opened every single tick with a `kv.list()` —
 * 1,440 list operations a day against a **free-plan cap of 1,000**, which is
 * the same ceiling as writes and not the 100,000 that reads get. It went over
 * by 44% structurally, whether or not anyone used the bot, and once it blew
 * (roughly 23:40 Bangkok, since the quota resets at 00:00 UTC = 07:00 here)
 * the queue simply stopped draining until morning.
 *
 * So the per-minute question is asked with a `get` instead — 1,440 reads a
 * day is 1.4% of the read cap — and the list only happens when the answer is
 * yes, or on the periodic sweep below.
 *
 * **Deliberately not under QUEUE_PREFIX.** listQueueBatch JSON.parses every
 * key the prefix scan returns, so a flag living inside that namespace would
 * come back as a malformed job on every drain. The name is kept visibly
 * different rather than merely one character apart.
 */
const QUEUE_PENDING_KEY = "uploads-pending";

/**
 * How often the queue is scanned even with the flag unset.
 *
 * The flag is an optimisation, and an optimisation that can lose photos is
 * not worth having: if its write fails while the job writes succeed, or a
 * deploy lands between the two, nothing would ever look at those entries
 * again — the silent-data-loss failure this file's header already spends
 * three paragraphs guarding against. The sweep bounds that to half an hour
 * instead of forever, and costs 48 list operations a day.
 */
const SWEEP_EVERY_MINUTES = 30;

/** Marks the queue non-empty. Called *before* the jobs are written, not
 * after: a flag set with no jobs behind it costs exactly one wasted list on
 * the next tick, while jobs written with no flag set are invisible until the
 * sweep. The error can only be affordable in one of those two directions. */
export async function markQueuePending(kv: KVNamespace): Promise<void> {
  await kv.put(QUEUE_PENDING_KEY, "1");
}

/**
 * Should this tick spend a list operation?
 *
 * Returns the flag's own state alongside the answer, so the caller can tell a
 * flag-driven scan from a sweep and avoid a pointless delete on a queue that
 * was already known to be empty.
 */
export async function shouldScanQueue(
  kv: KVNamespace,
  now: Date = new Date()
): Promise<{ scan: boolean; flagged: boolean }> {
  const flagged = (await kv.get(QUEUE_PENDING_KEY)) !== null;
  // Minutes are timezone-independent for whole-hour offsets, so this is the
  // same instant everywhere and needs no Bangkok conversion.
  const sweep = now.getUTCMinutes() % SWEEP_EVERY_MINUTES === 0;
  return { scan: flagged || sweep, flagged };
}

/** Called once the queue is observed empty, so the next 29 ticks cost a read
 * each instead of a list each. */
export async function clearQueuePending(kv: KVNamespace): Promise<void> {
  await kv.delete(QUEUE_PENDING_KEY);
}

export interface QueuedUpload {
  lineUserId: string;
  // Where drainUploadQueue's final "✅ อัปโหลดแล้ว" confirmation gets pushed
  // — the same value as lineUserId in personal mode, but a real LINE
  // groupId (not the synthesized "group:<groupId>" subject id lineUserId
  // holds in that case) in group mode, since pushToLine needs an actual
  // LINE recipient id, not an opaque KV key. Snapshotted at enqueue time
  // since the triggering event (and its `source`) is long gone by drain
  // time — there's nothing left to re-derive it from.
  pushTarget: string;
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
  // Awaited on its own line rather than folded into the Promise.all below —
  // see markQueuePending for why it has to land first.
  await markQueuePending(kv);
  await Promise.all(
    jobs.map((job) =>
      kv.put(`${QUEUE_PREFIX}${job.messageId}`, JSON.stringify(job), {
        metadata: { lineUserId: job.lineUserId },
      })
    )
  );
}

/**
 * How many files are queued for one subject.
 *
 * **Not for the drain's own "N files left" message.** KV is eventually
 * consistent: a key deleted moments ago can still be returned by `list` for
 * up to 60 seconds, so calling this right after a drain deleted its entries
 * counts ghosts and reports files remaining when the queue is empty — which
 * is exactly what it used to do (PLAN.md 17.67). The drain uses
 * QueueBatch.truncated instead, which it already knows for free. This stays
 * for tests and diagnostics, where a count taken well after the fact is
 * meaningful.
 *
 * KV list() returns key metadata inline without fetching each value, so this
 * stays cheap even with a decently deep queue. Caps at KV's own
 * 1000-keys-per-call list limit, which a personal bot's queue depth is never
 * remotely close to.
 */
export async function countQueuedForUser(kv: KVNamespace, lineUserId: string): Promise<number> {
  const { keys } = await kv.list<{ lineUserId: string }>({ prefix: QUEUE_PREFIX });
  return keys.filter((k) => k.metadata?.lineUserId === lineUserId).length;
}

export interface QueueEntry {
  key: string;
  job: QueuedUpload;
}

export interface QueueBatch {
  /** At most `limit` jobs, whatever the peek below turned up. */
  entries: QueueEntry[];
  /**
   * There is real work behind this batch.
   *
   * How the drain knows whether to promise more files are coming, derived
   * from the listing it already did rather than from a fresh count
   * afterwards (PLAN.md 17.67). A count taken after the drain deleted its
   * entries is a guess — KV can keep returning a deleted key from `list` for
   * up to 60 seconds — and it guessed wrong in production, telling someone
   * "เหลืออีก 4 ไฟล์" with an empty queue.
   */
  truncated: boolean;
}

/**
 * One page of the queue, plus whether anything real follows it.
 *
 * Lists `limit + 1` and returns at most `limit`. Asking for exactly `limit`
 * and calling a full page "truncated" is wrong precisely when the queue is a
 * multiple of the batch size — the last full drain would promise more files
 * and then never send the "all done" it had just earned, because the drain
 * after it finds nothing and returns without a push.
 *
 * The peek is judged on *values*, not on the key listing: a key whose value
 * is gone is an entry deleted moments ago that this location has not caught
 * up on. Skipping those is also what stops a stale listing from re-uploading
 * a photo that already reached Drive.
 */
export async function listQueueBatch(kv: KVNamespace, limit: number): Promise<QueueBatch> {
  const { keys } = await kv.list({ prefix: QUEUE_PREFIX, limit: limit + 1 });
  const found: QueueEntry[] = [];
  for (const k of keys) {
    const raw = await kv.get(k.name);
    if (raw) found.push({ key: k.name, job: JSON.parse(raw) as QueuedUpload });
  }
  return { entries: found.slice(0, limit), truncated: found.length > limit };
}

export async function deleteQueueEntry(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(key);
}
