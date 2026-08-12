import { handleUserMessage, isGreeting } from "../../app/src/lib/chatEngine.ts";
import { DEFAULT_CATEGORIES } from "../../app/src/data/defaultCategories.ts";
import { CalendarApiDisabledError, InsufficientCalendarScopeError } from "./calendar.ts";
import { matchCalendarCommand } from "./calendarCommands.ts";
import { matchCommand } from "./commands.ts";
import { resolveConfirmation } from "./confirmations.ts";
import { matchDiaryCommand } from "./diaryCommands.ts";
import { uploadFileToFolder } from "./drive.ts";
import { buildGoogleAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken } from "./googleAuth.ts";
import {
  fetchLineMediaContent,
  isImageMessageEvent,
  isTextMessageEvent,
  isUnsupportedMessageEvent,
  isVideoMessageEvent,
  pushToLine,
  replyToLine,
  verifyLineSignature,
  type LineImageMessageEvent,
  type LineVideoMessageEvent,
  type LineWebhookBody,
} from "./line.ts";
import { appendTransaction, createBookSpreadsheet } from "./sheets.ts";
import { signState, verifyState } from "./signedState.ts";
import {
  getAccountLink,
  getActiveTrip,
  getPending,
  getPendingConfirmation,
  setAccountLink,
  setPending,
  type ActionCtx,
  type ActiveTrip,
} from "./state.ts";
import { bangkokDateFolderName, bangkokDateKey } from "./thaiDate.ts";
import { matchTransactionCommand } from "./transactionCommands.ts";
import { matchTripCommand } from "./tripCommands.ts";
import {
  countQueuedForUser,
  deleteQueueEntry,
  enqueueUploads,
  listQueueBatch,
  type QueuedUpload,
} from "./uploadQueue.ts";

export interface Env {
  ACCOUNTS: KVNamespace;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  STATE_SIGNING_SECRET: string;
}

const WELCOME_MESSAGE = [
  "สวัสดีค่ะ 👋 ฉันเป็นผู้ช่วยส่วนตัวในแชท ช่วยได้ 4 เรื่องหลักๆ:",
  "",
  "💰 จดรายรับ-รายจ่าย พิมพ์ประโยคธรรมชาติได้เลย เช่น \"ซื้อกาแฟ 60\"",
  "📸 เก็บรูป/คลิปทริปอัตโนมัติ ขึ้น Google Drive แยกโฟลเดอร์ตามทริป",
  "📅 จดนัดลง Google Calendar แล้วมันเตือนให้เองอัตโนมัติ",
  "📔 บันทึกไดอารี่ประจำวัน ค้นย้อนหลังได้",
  "",
  "พิมพ์ \"วิธีใช้\" เพื่อดูคำสั่งทั้งหมดแบบละเอียด หรือแตะเมนูใต้ช่องพิมพ์ได้เลย",
].join("\n");

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function renderLinkedPage(): string {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>เชื่อมบัญชีสำเร็จ</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 2rem 1.5rem; text-align: center; color: #1c1e21; }
</style>
</head>
<body>
  <h2>เชื่อมบัญชีสำเร็จ ✅</h2>
  <p>ปิดหน้าต่างนี้แล้วกลับไปแชทกับบอทใน LINE ได้เลย</p>
</body>
</html>`;
}

async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return html("ลิงก์ไม่ถูกต้อง", 400);

  const lineUserId = await verifyState(state, env.STATE_SIGNING_SECRET);
  if (!lineUserId) return html("ลิงก์หมดอายุหรือไม่ถูกต้อง กลับไปกดลิงก์ใหม่ใน LINE", 400);

  const redirectUri = `${url.origin}/oauth/callback`;
  const tokens = await exchangeCodeForTokens({
    code,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  });
  if (!tokens.refresh_token) {
    return html(
      "ไม่ได้รับสิทธิ์ระยะยาวจาก Google (refresh token) ลองเชื่อมใหม่อีกครั้ง และเลือกบัญชีที่ยังไม่เคยอนุญาตแอปนี้มาก่อน",
      400
    );
  }

  const existing = await getAccountLink(env.ACCOUNTS, lineUserId);
  const spreadsheetId =
    existing?.spreadsheetId ?? (await createBookSpreadsheet(tokens.access_token, "สมุดส่วนตัว"));

  await setAccountLink(env.ACCOUNTS, lineUserId, {
    spreadsheetId,
    refreshToken: tokens.refresh_token,
    displayName: "สมุดส่วนตัว",
  });

  return html(renderLinkedPage());
}

// Refresh tokens obtained per user per webhook call, keyed by refreshToken.
// A single LINE multi-select send can bundle many events (photos, videos,
// text) into one webhook request; each event was independently calling
// Google's token endpoint for the same account, burning through Cloudflare's
// per-request subrequest budget for no reason. handleWebhook now processes
// all events in one call concurrently (see handleWebhook), so the cache
// stores the in-flight Promise rather than the resolved string — otherwise
// two events could both miss the cache at the same instant and each fire
// their own refresh request. Call sites that don't pass one (e.g. tests
// calling handleTextMessage directly) just always refresh, same as before.
type TokenCache = Map<string, Promise<string>>;

async function withFreshAccessToken<T>(
  env: Env,
  refreshToken: string,
  fn: (accessToken: string) => Promise<T>,
  tokenCache?: TokenCache
): Promise<T> {
  let tokenPromise = tokenCache?.get(refreshToken);
  if (!tokenPromise) {
    tokenPromise = refreshAccessToken({
      refreshToken,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    });
    tokenCache?.set(refreshToken, tokenPromise);
  }
  return fn(await tokenPromise);
}

async function buildUnlinkedPrompt(env: Env, lineUserId: string, origin: string): Promise<string> {
  // The state param embeds this exact webhook-scoped lineUserId, signed, so
  // /oauth/callback links the account to the same id future messages use.
  const authorizeUrl = await buildAuthorizeUrl(env, lineUserId, origin);
  return `ยังไม่ได้เชื่อมบัญชี Google เลย กดลิงก์นี้เพื่อเชื่อมก่อนเริ่มใช้งานนะ\n${authorizeUrl}`;
}

async function buildAuthorizeUrl(env: Env, lineUserId: string, origin: string): Promise<string> {
  const state = await signState(lineUserId, env.STATE_SIGNING_SECRET);
  return buildGoogleAuthorizeUrl({
    clientId: env.GOOGLE_CLIENT_ID,
    redirectUri: `${origin}/oauth/callback`,
    state,
  });
}

// Accounts linked before the calendar feature shipped only granted the
// drive.file scope. A 401/403 from the Calendar API means that's the case —
// send the same re-link link, worded for "add a permission" rather than
// "connect for the first time" (setAccountLink overwrites the refresh token
// in place, so existing data/spreadsheetId are untouched).
async function buildCalendarRelinkPrompt(env: Env, lineUserId: string, origin: string): Promise<string> {
  const authorizeUrl = await buildAuthorizeUrl(env, lineUserId, origin);
  return `ต้องเชื่อมบัญชี Google ใหม่อีกครั้งเพื่อขอสิทธิ์ปฏิทินเพิ่ม (บัญชีเดิมยังไม่มีสิทธิ์นี้) กดลิงก์นี้แล้วเลือกบัญชีเดิมได้เลย ข้อมูลเก่าจะไม่หายนะ\n${authorizeUrl}`;
}

// A completely different problem from insufficient scope: the Calendar API
// itself is switched off at the Google Cloud project level. Re-linking the
// Google account does nothing here — every account, old or freshly
// reconnected, will keep getting a 403 until an admin flips it on in Google
// Cloud Console (see worker/README.md setup step 3.5).
const CALENDAR_API_DISABLED_MESSAGE =
  'ปฏิทินยังใช้ไม่ได้ เพราะ "Google Calendar API" ยังไม่ได้เปิดใช้งานในโปรเจกต์ Google Cloud (คนละเรื่องกับสิทธิ์ของบัญชีที่เชื่อมไว้ เชื่อมบัญชีใหม่ไม่ช่วย) ผู้ดูแลต้องไปที่ Google Cloud Console → APIs & Services → Library → ค้นหา "Google Calendar API" → กด Enable แล้วลองพิมพ์คำสั่งปฏิทินใหม่อีกครั้ง';

export async function handleTextMessage(
  env: Env,
  lineUserId: string,
  text: string,
  origin: string,
  tokenCache?: TokenCache
): Promise<string> {
  const link = await getAccountLink(env.ACCOUNTS, lineUserId);
  if (!link) return buildUnlinkedPrompt(env, lineUserId, origin);

  const actionCtx = (accessToken: string): ActionCtx => ({
    accessToken,
    kv: env.ACCOUNTS,
    lineUserId,
    spreadsheetId: link.spreadsheetId,
  });

  try {
    const pendingConfirmation = await getPendingConfirmation(env.ACCOUNTS, lineUserId);
    if (pendingConfirmation) {
      const reply = await withFreshAccessToken(
        env,
        link.refreshToken,
        (accessToken) => resolveConfirmation(actionCtx(accessToken), text, pendingConfirmation),
        tokenCache
      );
      if (reply) return reply;
      // Not an affirmative reply — the pending question is already cleared
      // (see confirmations.ts), fall through and handle `text` normally.
    }

    const tripHandler = await matchTripCommand(text);
    if (tripHandler) {
      return await withFreshAccessToken(
        env,
        link.refreshToken,
        (accessToken) => tripHandler(actionCtx(accessToken)),
        tokenCache
      );
    }

    const calendarHandler = await matchCalendarCommand(text);
    if (calendarHandler) {
      return await withFreshAccessToken(
        env,
        link.refreshToken,
        (accessToken) => calendarHandler(actionCtx(accessToken)),
        tokenCache
      );
    }

    const diaryHandler = await matchDiaryCommand(text);
    if (diaryHandler) {
      return await withFreshAccessToken(
        env,
        link.refreshToken,
        (accessToken) => diaryHandler(actionCtx(accessToken)),
        tokenCache
      );
    }

    // Checked before reportHandler below: "ลบรายการล่าสุด"/"ยกเลิกรายการล่าสุด"
    // contain "รายการล่าสุด" as a substring, which commands.ts's report
    // matcher would otherwise catch first (includesAny is substring-based),
    // showing the recent-transactions list instead of actually deleting
    // anything — this is the exact bug a user hit.
    const transactionHandler = await matchTransactionCommand(text);
    if (transactionHandler) {
      return await withFreshAccessToken(
        env,
        link.refreshToken,
        (accessToken) => transactionHandler(actionCtx(accessToken)),
        tokenCache
      );
    }
  } catch (err) {
    if (err instanceof CalendarApiDisabledError) {
      return CALENDAR_API_DISABLED_MESSAGE;
    }
    if (err instanceof InsufficientCalendarScopeError) {
      return buildCalendarRelinkPrompt(env, lineUserId, origin);
    }
    throw err;
  }

  const reportHandler = await matchCommand(text);
  if (reportHandler) {
    return withFreshAccessToken(
      env,
      link.refreshToken,
      (accessToken) => reportHandler(accessToken, link.spreadsheetId),
      tokenCache
    );
  }

  const pending = await getPending(env.ACCOUNTS, lineUserId);

  // Checked after every real command above so "วิธีใช้"/"help" (also in
  // chatEngine's GREETINGS) still get the detailed list from matchCommand
  // instead of being shadowed by this shorter welcome blurb — and only when
  // there's no dangling money clarification, so a stray greeting mid-flow
  // still cancels it properly via chatEngine's own greeting handling instead
  // of leaving `pending` stuck in KV.
  if (!pending && isGreeting(text)) {
    return WELCOME_MESSAGE;
  }

  const result = handleUserMessage(text, pending, DEFAULT_CATEGORIES);
  await setPending(env.ACCOUNTS, lineUserId, result.pending);

  if (result.transactionDraft) {
    const now = new Date().toISOString();
    await withFreshAccessToken(
      env,
      link.refreshToken,
      (accessToken) =>
        appendTransaction(accessToken, link.spreadsheetId, {
          id: crypto.randomUUID(),
          date: now.slice(0, 10),
          type: result.transactionDraft!.type,
          amount: result.transactionDraft!.amount,
          categoryId: result.transactionDraft!.categoryId,
          note: result.transactionDraft!.note,
          rawText: text,
          addedBy: lineUserId,
          addedByName: "LINE",
          createdAt: now,
        }),
      tokenCache
    );
  }

  return result.botMessage;
}

function extensionForContentType(contentType: string, kind: "image" | "video"): string {
  if (kind === "video") return contentType.includes("quicktime") ? "mov" : "mp4";
  return contentType.includes("png") ? "png" : "jpg";
}

// Cloudflare's own metrics showed a real, if small, background failure rate
// for the Drive upload request (a handful of 4xx responses out of dozens of
// otherwise-successful requests over a day of testing) — ordinary transient
// flakiness, not a design flaw, but worth not giving up on immediately. Each
// attempt re-fetches from LINE rather than reusing bytes from a failed
// attempt, since a ReadableStream can only be read once — a partially
// consumed stream from a failed upload can't be retried directly.
const MAX_UPLOAD_ATTEMPTS = 2;

// The actual upload work, assuming the caller has already resolved the
// account link and destination folder — factored out so the three places
// that need it (a single immediate upload, a same-webhook-call media batch,
// and the queue drain) don't each duplicate the fetch + upload logic, and so
// all three get the same retry behavior for free. Takes a bare folderId
// rather than a full ActiveTrip since that's all it needs — the queue drain
// only has a snapshotted folderId/tripName, not a live trip.
async function uploadTripMedia(
  env: Env,
  accessToken: string,
  tripFolderId: string,
  messageId: string,
  timestampMs: number,
  kind: "image" | "video"
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    try {
      const { body, contentType } = await fetchLineMediaContent(messageId, env.LINE_CHANNEL_ACCESS_TOKEN);
      const timestamp = new Date(timestampMs);
      const ext = extensionForContentType(contentType, kind);
      // Uploads straight into the trip folder (created once, up front, when
      // the trip started) with a zero-padded date baked into the filename
      // (so files still sort chronologically), instead of finding-or-
      // creating a per-day subfolder on every single upload. That per-day
      // lookup used to run for every photo/video, which (a) had an
      // unavoidable race — Drive's find-then-create isn't atomic, so
      // several files sent in the same LINE multi-select burst could each
      // miss the search and create duplicate day folders, splitting the
      // trip's files across them — and (b) burned 3-4 extra subrequests per
      // file, which could exceed Cloudflare's per-request subrequest budget
      // when someone sent many photos/clips at once, silently dropping
      // whichever ones ran out of budget. A flat folder needs neither.
      const filename = `${bangkokDateKey(timestamp)}_${messageId}.${ext}`;
      await uploadFileToFolder(accessToken, tripFolderId, filename, body, contentType);
      return;
    } catch (err) {
      lastErr = err;
      console.error(`uploadTripMedia attempt ${attempt}/${MAX_UPLOAD_ATTEMPTS} failed for ${messageId}`, err);
    }
  }
  throw lastErr;
}

async function handleTripMediaMessage(
  env: Env,
  lineUserId: string,
  messageId: string,
  timestampMs: number,
  origin: string,
  kind: "image" | "video",
  tokenCache?: TokenCache
): Promise<string> {
  const link = await getAccountLink(env.ACCOUNTS, lineUserId);
  if (!link) return buildUnlinkedPrompt(env, lineUserId, origin);

  const trip = await getActiveTrip(env.ACCOUNTS, lineUserId);
  if (!trip) {
    const noun = kind === "video" ? "คลิป" : "รูป";
    return `ยังไม่ได้เริ่มทริปอยู่เลย พิมพ์ "เริ่มทริป <ชื่อ>" ก่อนนะ แล้วค่อยส่ง${noun}ตามมาได้เลย`;
  }

  return withFreshAccessToken(
    env,
    link.refreshToken,
    async (accessToken) => {
      await uploadTripMedia(env, accessToken, trip.folderId, messageId, timestampMs, kind);
      const emoji = kind === "video" ? "🎬" : "📸";
      const noun = kind === "video" ? "คลิป" : "รูป";
      const dateFolder = bangkokDateFolderName(timestampMs);
      return `${emoji} เก็บ${noun}ในทริป "${trip.name}" วันที่ ${dateFolder} แล้ว`;
    },
    tokenCache
  );
}

export async function handleImageMessage(
  env: Env,
  lineUserId: string,
  messageId: string,
  timestampMs: number,
  origin: string,
  tokenCache?: TokenCache
): Promise<string> {
  return handleTripMediaMessage(env, lineUserId, messageId, timestampMs, origin, "image", tokenCache);
}

export async function handleVideoMessage(
  env: Env,
  lineUserId: string,
  messageId: string,
  timestampMs: number,
  origin: string,
  tokenCache?: TokenCache
): Promise<string> {
  return handleTripMediaMessage(env, lineUserId, messageId, timestampMs, origin, "video", tokenCache);
}

// LINE reply tokens are single-use and short-lived. Sending several photos
// or clips together bundles many events into one webhook call, and each
// Drive upload takes real network time — replying to event N only after
// events 1..N-1 finished serially could push N's reply past its token's
// window, and a failed reply threw straight into the catch block below,
// which retried the *same* (still-expired) token and swallowed that
// failure too, producing total silence. Push messages target the userId
// directly, so they're immune to token expiry — falling back to one here
// means the user always hears back even if the reply attempt lost the race.
async function replyOrPush(
  event: { replyToken: string; source: { userId: string } },
  text: string,
  channelAccessToken: string
): Promise<void> {
  try {
    await replyToLine(event.replyToken, text, channelAccessToken);
  } catch (err) {
    console.error("line reply failed, falling back to push", err);
    await pushToLine(event.source.userId, text, channelAccessToken);
  }
}

// Runs `handler` over `items`, at most `limit` at a time, rather than all at
// once. A batch of many photos/clips needs 2 outbound subrequests per file
// (fetch from LINE, upload to Drive) plus its own reply — running an entire
// large batch fully concurrently maximizes how many of those are in flight
// at the same instant, which turned out to matter: a real report of 50
// photos in one send came back with 1 silently missing from Drive and no
// error reply for it either, even after cutting Drive's own request count
// back down to one per file. The likely cause is some platform-level ceiling
// on simultaneous/total subrequests for one webhook call — and since the
// fallback error reply is itself a subrequest, an event unlucky enough to
// land right at that ceiling can lose both its upload *and* its error
// message at once, which is exactly what "total silence" looks like from
// the user's side. Bounding concurrency caps how many subrequests are ever
// in flight together, while still processing far faster than one-at-a-time
// (the sequential version was what caused the earlier reply-token-expiry
// bug — see replyOrPush above), so this keeps both fixes.
const WEBHOOK_EVENT_CONCURRENCY = 5;

async function processWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  handler: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.allSettled(items.slice(i, i + limit).map(handler));
  }
}

// Even a batch that uploads immediately (rather than being queued) has a
// subrequest cost per file: fetch from LINE (1) + upload to Drive (1) + a
// reply (1) = 3 — the reply is easy to forget when doing this math, but it's
// a real outbound request like the other two. At or above this many media
// files in one webhook call, the whole batch is queued instead (see
// uploadQueue.ts) and a scheduled invocation drains it a safe amount at a
// time, each drain getting its own completely fresh budget — a batch of any
// size gets through eventually instead of losing files. Below this, media
// still uploads immediately, just as one combined reply per webhook call
// (handleImmediateMediaBatch below) instead of one per file — collapsing N
// replies into 1 is what makes the per-file cost 2 instead of 3.
//
// Set below the ~50-external-subrequest ceiling with real headroom, not
// right up against it: MAX_UPLOAD_ATTEMPTS means a file that fails once
// costs double (a fresh LINE fetch + Drive upload on retry), and Cloudflare's
// own metrics showed a small but real background failure rate in practice.
// Happy path (no retries) is 2 × 15 + a couple of housekeeping requests ≈
// low 30s; even if a handful of files in the batch need a retry, this stays
// well clear of the ceiling instead of being one bad file away from it.
const IMMEDIATE_MEDIA_BATCH_LIMIT = 15;

// Same headroom reasoning as IMMEDIATE_MEDIA_BATCH_LIMIT above: kept below
// the ~50 external-subrequest budget with room for MAX_UPLOAD_ATTEMPTS
// retries on whichever files hit a transient failure, not just the happy-path
// count.
const DRAIN_BATCH_SIZE = 15;

// Shared by both media-batch paths below: resolves the account link and
// active trip once per sender instead of once per file, replying with the
// appropriate prompt and returning null if either is missing so the caller
// knows to stop.
async function resolveMediaBatchContext(
  env: Env,
  lineUserId: string,
  events: Array<LineImageMessageEvent | LineVideoMessageEvent>,
  origin: string
): Promise<{ refreshToken: string; trip: ActiveTrip } | null> {
  const link = await getAccountLink(env.ACCOUNTS, lineUserId);
  if (!link) {
    await replyOrPush(events[0], await buildUnlinkedPrompt(env, lineUserId, origin), env.LINE_CHANNEL_ACCESS_TOKEN);
    return null;
  }
  const trip = await getActiveTrip(env.ACCOUNTS, lineUserId);
  if (!trip) {
    await replyOrPush(
      events[0],
      'ยังไม่ได้เริ่มทริปอยู่เลย พิมพ์ "เริ่มทริป <ชื่อ>" ก่อนนะ แล้วค่อยส่งรูป/คลิปตามมาได้เลย',
      env.LINE_CHANNEL_ACCESS_TOKEN
    );
    return null;
  }
  return { refreshToken: link.refreshToken, trip };
}

// Below IMMEDIATE_MEDIA_BATCH_LIMIT: uploads every file right away (bounded
// concurrency, same as before), but with one combined reply for the whole
// batch instead of one per file — both a nicer chat experience (a real user
// asked for this instead of a stream of separate confirmations) and, per the
// IMMEDIATE_MEDIA_BATCH_LIMIT comment above, what keeps the per-file
// subrequest cost low enough for the threshold's own math to hold.
async function handleImmediateMediaBatch(
  env: Env,
  lineUserId: string,
  events: Array<LineImageMessageEvent | LineVideoMessageEvent>,
  origin: string,
  tokenCache: TokenCache
): Promise<void> {
  const ctx = await resolveMediaBatchContext(env, lineUserId, events, origin);
  if (!ctx) return;
  const { refreshToken, trip } = ctx;

  let succeeded = 0;
  let failed = 0;
  await processWithConcurrencyLimit(events, WEBHOOK_EVENT_CONCURRENCY, async (event) => {
    try {
      await withFreshAccessToken(
        env,
        refreshToken,
        (accessToken) =>
          uploadTripMedia(
            env,
            accessToken,
            trip.folderId,
            event.message.id,
            event.timestamp,
            isImageMessageEvent(event) ? "image" : "video"
          ),
        tokenCache
      );
      succeeded++;
    } catch (err) {
      console.error("immediate media batch upload failed", event.message.id, err);
      failed++;
    }
  });

  const parts = [`📸 เก็บ ${succeeded} ไฟล์เข้าทริป "${trip.name}" แล้ว`];
  if (failed > 0) parts.push(`(อีก ${failed} ไฟล์อัปโหลดไม่สำเร็จ ลองส่งใหม่อีกครั้งได้นะ)`);
  await replyOrPush(events[0], parts.join(" "), env.LINE_CHANNEL_ACCESS_TOKEN);
}

async function handleQueuedMediaBatch(
  env: Env,
  lineUserId: string,
  events: Array<LineImageMessageEvent | LineVideoMessageEvent>,
  origin: string
): Promise<void> {
  const ctx = await resolveMediaBatchContext(env, lineUserId, events, origin);
  if (!ctx) return;
  const { trip } = ctx;

  const jobs: QueuedUpload[] = events.map((event) => ({
    lineUserId,
    kind: isImageMessageEvent(event) ? "image" : "video",
    messageId: event.message.id,
    timestampMs: event.timestamp,
    tripFolderId: trip.folderId,
    tripName: trip.name,
  }));
  await enqueueUploads(env.ACCOUNTS, jobs);

  // Only one reply for the whole batch — the other events' reply tokens are
  // simply left unused (LINE tokens that never get used just expire quietly
  // on their own; there's no cost to skipping them).
  await replyOrPush(
    events[0],
    `📥 รับไว้ ${events.length} ไฟล์แล้ว กำลังทยอยอัปโหลดเข้าทริป "${trip.name}" อยู่นะ จะแจ้งเมื่อเสร็จ`,
    env.LINE_CHANNEL_ACCESS_TOKEN
  );
}

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");
  const valid = await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET);
  if (!valid) return new Response("invalid signature", { status: 401 });

  const body = JSON.parse(rawBody) as LineWebhookBody;
  const origin = new URL(request.url).origin;
  // Shared across every event in this one webhook call — see the
  // TokenCache comment on withFreshAccessToken for why.
  const tokenCache: TokenCache = new Map();

  // Media events (image/video) are always handled as a batch — grouped by
  // sender, one combined reply per sender — never individually inline below.
  // Below IMMEDIATE_MEDIA_BATCH_LIMIT they still upload right away
  // (handleImmediateMediaBatch); at/above it, the whole batch is queued for
  // the scheduled drain instead (handleQueuedMediaBatch). See
  // IMMEDIATE_MEDIA_BATCH_LIMIT's comment for why collapsing replies into
  // one per batch matters, not just for tidiness.
  const mediaEvents = body.events.filter(
    (event): event is LineImageMessageEvent | LineVideoMessageEvent =>
      isImageMessageEvent(event) || isVideoMessageEvent(event)
  );
  if (mediaEvents.length > 0) {
    // Grouped by sender — a webhook call is almost always one person's send,
    // but handling it generally costs nothing extra.
    const eventsByUser = new Map<string, Array<LineImageMessageEvent | LineVideoMessageEvent>>();
    for (const event of mediaEvents) {
      const forUser = eventsByUser.get(event.source.userId) ?? [];
      forUser.push(event);
      eventsByUser.set(event.source.userId, forUser);
    }
    const handleBatch = mediaEvents.length >= IMMEDIATE_MEDIA_BATCH_LIMIT ? handleQueuedMediaBatch : null;
    await Promise.all(
      [...eventsByUser.entries()].map(([lineUserId, events]) =>
        handleBatch
          ? handleBatch(env, lineUserId, events, origin)
          : handleImmediateMediaBatch(env, lineUserId, events, origin, tokenCache)
      )
    );
  }

  // Everything else (text, unsupported message types) is processed
  // individually with bounded concurrency, same as always.
  const mediaEventSet = new Set<LineWebhookBody["events"][number]>(mediaEvents);
  const otherEvents = body.events.filter((event) => !mediaEventSet.has(event));

  // Processed with bounded concurrency rather than one-at-a-time or all at
  // once — see WEBHOOK_EVENT_CONCURRENCY above for why neither extreme
  // works: events used to be handled fully sequentially, so each one's
  // reply had to wait for every earlier one's full round-trip first, making
  // later replies far more likely to miss their token's short window (see
  // replyOrPush); running a whole batch fully concurrently instead fixed
  // that but could spike too many subrequests in flight at once for a large
  // batch.
  await processWithConcurrencyLimit(otherEvents, WEBHOOK_EVENT_CONCURRENCY, async (event) => {
    try {
      if (isTextMessageEvent(event)) {
        const reply = await handleTextMessage(env, event.source.userId, event.message.text, origin, tokenCache);
        await replyOrPush(event, reply, env.LINE_CHANNEL_ACCESS_TOKEN);
      } else if (isUnsupportedMessageEvent(event)) {
        await replyOrPush(
          event,
          "ขอโทษด้วย ไฟล์ประเภทนี้ยังไม่รองรับนะ ตอนนี้รองรับแค่รูปภาพและวิดีโอ",
          env.LINE_CHANNEL_ACCESS_TOKEN
        );
      }
    } catch (err) {
      if (isTextMessageEvent(event) || isUnsupportedMessageEvent(event)) {
        await replyOrPush(
          event,
          "ขอโทษด้วย เกิดข้อผิดพลาดตอนบันทึก ลองใหม่อีกครั้งนะ",
          env.LINE_CHANNEL_ACCESS_TOKEN
        ).catch(() => undefined);
      }
      console.error("webhook handling failed", err);
    }
  });

  return new Response("ok");
}

interface DrainUserSummary {
  tripName: string;
  succeeded: number;
  failed: number;
}

// Called on the cron trigger configured in wrangler.toml (see
// IMMEDIATE_MEDIA_BATCH_LIMIT/DRAIN_BATCH_SIZE above for the full story of
// why this exists). Each firing is its own Worker invocation with its own
// fresh subrequest/CPU budget, so working through a big backlog a bounded
// amount at a time — rather than trying to force it all through one webhook
// call's budget — is what actually gets every file uploaded reliably.
export async function drainUploadQueue(env: Env): Promise<void> {
  const entries = await listQueueBatch(env.ACCOUNTS, DRAIN_BATCH_SIZE);
  if (entries.length === 0) return;

  const tokenCache: TokenCache = new Map();
  const summaries = new Map<string, DrainUserSummary>();

  for (const { key, job } of entries) {
    const summary = summaries.get(job.lineUserId) ?? { tripName: job.tripName, succeeded: 0, failed: 0 };
    try {
      const link = await getAccountLink(env.ACCOUNTS, job.lineUserId);
      if (link) {
        await withFreshAccessToken(
          env,
          link.refreshToken,
          (accessToken) =>
            uploadTripMedia(env, accessToken, job.tripFolderId, job.messageId, job.timestampMs, job.kind),
          tokenCache
        );
      }
      summary.succeeded++;
    } catch (err) {
      console.error("upload queue drain failed", key, err);
      summary.failed++;
    } finally {
      await deleteQueueEntry(env.ACCOUNTS, key);
    }
    summary.tripName = job.tripName; // keep whichever job was processed most recently
    summaries.set(job.lineUserId, summary);
  }

  for (const [lineUserId, summary] of summaries) {
    const remaining = await countQueuedForUser(env.ACCOUNTS, lineUserId);
    const parts = [`✅ อัปโหลดเพิ่ม ${summary.succeeded} ไฟล์เข้าทริป "${summary.tripName}" แล้ว`];
    if (summary.failed > 0) {
      parts.push(`(อีก ${summary.failed} ไฟล์อัปโหลดไม่สำเร็จ ลองส่งใหม่อีกครั้งได้นะ)`);
    }
    parts.push(remaining > 0 ? `เหลืออีก ${remaining} ไฟล์ กำลังทยอยอัปโหลดต่อ` : `อัปโหลดครบทุกไฟล์แล้ว`);
    await pushToLine(lineUserId, parts.join(" "), env.LINE_CHANNEL_ACCESS_TOKEN).catch((err) =>
      console.error("drain summary push failed", err)
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/oauth/callback") return handleOAuthCallback(request, env);
    if (url.pathname === "/webhook" && request.method === "POST") return handleWebhook(request, env);
    if (url.pathname === "/health") return new Response("ok");

    return new Response("not found", { status: 404 });
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(drainUploadQueue(env));
  },
};
