import { handleUserMessage, isGreeting, type PendingClarification } from "../../app/src/lib/chatEngine.ts";
import { extractAmount } from "../../app/src/lib/parser.ts";
import { DEFAULT_CATEGORIES } from "../../app/src/data/defaultCategories.ts";
import { answerQuestion, matchAiCommand } from "./aiCommands.ts";
import { interpretMessage, type InterpretedIntent } from "./aiInterpreter.ts";
import { CalendarApiDisabledError, InsufficientCalendarScopeError } from "./calendar.ts";
import { ContactsApiDisabledError, InsufficientContactsScopeError } from "./contacts.ts";
import { GmailApiDisabledError, InsufficientGmailScopeError } from "./gmail.ts";
import { InsufficientTasksScopeError, TasksApiDisabledError } from "./tasks.ts";
import {
  answerCalendarQuery,
  matchCalendarCommand,
  promptCalendarCreateFromDraft,
  promptCalendarDeleteByKeyword,
  promptCalendarEditByKeyword,
} from "./calendarCommands.ts";
import { buildHelpText, matchCommand } from "./commands.ts";
import { appendConversationTurn, getConversationHistory } from "./conversationHistory.ts";
import { resolveConfirmation } from "./confirmations.ts";
import {
  answerDiaryByDate,
  answerDiaryMonthSummary,
  answerDiarySearch,
  matchDiaryCommand,
  promptDiaryCreateFromDraft,
} from "./diaryCommands.ts";
import { uploadFileToFolder } from "./drive.ts";
import { buildGoogleAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken } from "./googleAuth.ts";
import {
  answerTaskList,
  matchTaskCommand,
  promptTaskComplete,
  promptTaskCreate,
  promptTaskDelete,
} from "./taskCommands.ts";
import { answerEmailCheck, matchGmailCommand, promptEmailSendResolved } from "./gmailCommands.ts";
import { answerContactEmail, matchContactsCommand } from "./contactsCommands.ts";
import { groupIdFromSubject, groupSubjectId } from "./groupSubject.ts";
import {
  broadcastMorningBriefings,
  buildMorningBriefing,
  buildReturnGreeting,
  classifyGreeting,
  matchProvinceCommand,
  setProvinceByName,
} from "./greetingCommands.ts";
import {
  fetchLineMediaContent,
  findSelfMention,
  getGroupMemberProfile,
  getGroupSummary,
  isImageMessageEvent,
  isLocationMessageEvent,
  isTextMessageEvent,
  isUnsupportedMessageEvent,
  isVideoMessageEvent,
  pushToLine,
  replyToLine,
  stripSelfMention,
  verifyLineSignature,
  type LineEventSource,
  type LineImageMessageEvent,
  type LineVideoMessageEvent,
  type LineWebhookBody,
} from "./line.ts";
import { answerNearbySearch, matchPlacesCommand, promptPlaceSearch } from "./placesCommands.ts";
import { canAccessSpreadsheet, createBookSpreadsheet } from "./sheets.ts";
import { signState, verifyState } from "./signedState.ts";
import {
  getAccountLink,
  getActiveTrip,
  getPending,
  getPendingConfirmation,
  setAccountLink,
  setPending,
  type AccountLink,
  type ActionCtx,
  type ActiveTrip,
  type TransactionAttribution,
} from "./state.ts";
import { applyPersona, BOT_NAME } from "./persona.ts";
import { bangkokDateFolderName, bangkokDateKey } from "./thaiDate.ts";
import { matchTransactionCommand, promptTransactionCreate } from "./transactionCommands.ts";
import { endTrip, matchTripCommand, promptOrStartTrip, tripStatus } from "./tripCommands.ts";
import { handleViewCalendarRequest } from "./viewCalendarPage.ts";
import { buildViewLinkReply, matchViewLinkCommand } from "./viewCommands.ts";
import { handleViewDiaryRequest } from "./viewDiaryPage.ts";
import { handleViewShiftsRequest } from "./viewShiftsPage.ts";
import { handleViewAccountsRequest } from "./viewPages.ts";
import { handleViewPhotoRequest, handleViewTripsRequest } from "./viewTripsPage.ts";
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
  GEMINI_API_KEY: string;
  // Optional, same degrade-gracefully treatment as GEMINI_API_KEY — a flat
  // Google Maps Platform API key (PLAN.md 17.30), not an OAuth secret, so
  // it's not tied to any linked account. "หา...ใกล้ฉัน" just tells the user
  // the feature isn't set up yet if this is missing, same as ถาม/วิเคราะห์
  // do when GEMINI_API_KEY is missing.
  GOOGLE_MAPS_API_KEY: string;
}

const WELCOME_MESSAGE = [
  `สวัสดีค่ะ 👋 ฉันชื่อ${BOT_NAME}นะ เป็นผู้ช่วยส่วนตัวในแชท ช่วยได้ 11 เรื่องหลักๆ:`,
  "",
  "💰 จดรายรับ-รายจ่ายประจำวัน พร้อมสรุปรายงาน",
  "📸 เก็บรูป/คลิปทริปอัตโนมัติขึ้น Google Drive",
  "📅 จดนัดหมายลง Google Calendar",
  "📔 บันทึกไดอารี่ประจำวัน",
  "🗓️ ตารางเวร",
  "✅ จัดการสิ่งที่ต้องทำ (Google Tasks)",
  "📧 เช็ค/ส่งอีเมล พร้อมค้นหาอีเมลผู้ติดต่อให้",
  "📍 หาร้าน/สถานที่ใกล้ตัวจากตำแหน่งจริง",
  "🤖 ถามคำถาม/วิเคราะห์การใช้จ่ายด้วย AI",
  "☀️ สรุปวันที่/อากาศ/ข่าวให้ทุกเช้าอัตโนมัติ",
  "🌐 ดูบัญชี/ปฏิทิน/ไดอารี่/รูปทริป/ตารางเวรผ่านเว็บ",
  "",
  "พิมพ์ \"วิธีใช้\" เพื่อดูคำสั่งทั้งหมดแบบละเอียด หรือแตะเมนูใต้ช่องพิมพ์ได้เลย",
].join("\n");

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

// groupSubjectId/groupIdFromSubject moved to groupSubject.ts (imported
// above) so viewCommands.ts can use them too without an import cycle
// (index.ts already imports from viewCommands.ts).

function renderLinkedPage(isGroup: boolean): string {
  const heading = isGroup ? "เชื่อมบัญชีกลุ่มสำเร็จ ✅" : "เชื่อมบัญชีสำเร็จ ✅";
  const body = isGroup
    ? "ปิดหน้าต่างนี้แล้วกลับไปที่กลุ่มใน LINE ได้เลย ทุกคนในกลุ่มใช้บัญชีนี้ร่วมกันได้ทันที"
    : "ปิดหน้าต่างนี้แล้วกลับไปแชทกับบอทใน LINE ได้เลย";
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${heading}</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 2rem 1.5rem; text-align: center; color: #1c1e21; }
</style>
</head>
<body>
  <h2>${heading}</h2>
  <p>${body}</p>
</body>
</html>`;
}

async function buildGroupSpreadsheetName(env: Env, groupId: string): Promise<string> {
  const summary = await getGroupSummary(groupId, env.LINE_CHANNEL_ACCESS_TOKEN);
  return summary ? `สมุดกลุ่ม - ${summary.groupName}` : "สมุดกลุ่ม";
}

async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return html("ลิงก์ไม่ถูกต้อง", 400);

  const subjectId = await verifyState(state, env.STATE_SIGNING_SECRET);
  if (!subjectId) return html("ลิงก์หมดอายุหรือไม่ถูกต้อง กลับไปกดลิงก์ใหม่ใน LINE", 400);

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

  const groupId = groupIdFromSubject(subjectId);
  const existing = await getAccountLink(env.ACCOUNTS, subjectId);

  // A group's authorize link is posted into the shared chat, not DM'd
  // (unlike personal mode — see buildGroupUnlinkedPrompt), so unlike a
  // personal re-link (always expected to be the same person, re-authing
  // for more scope — safe to overwrite in place, see
  // buildCalendarRelinkPrompt), a *second* completed OAuth flow for an
  // already-linked group could easily be a different person entirely,
  // clicking the same still-valid link with their own separate Google
  // account. Overwriting refreshToken in that case would silently break
  // every future read/write — the new token has no access to the old
  // token's spreadsheet, since two different Google accounts made it.
  //
  // But blocking *every* further completion outright also permanently
  // dead-ends buildCalendarRelinkPrompt's rescope flow for groups (e.g.
  // when Calendar scope was never granted) — there'd be no way back in.
  // Distinguish the two cases the only way available (no LINE API exposes
  // "who clicked this"): try the new access token against the group's
  // existing spreadsheet. The same Google account re-consenting with
  // broader scope can still read it; a different member's own account
  // can't, since it's a different person's Drive. Only the former is
  // allowed to update the refreshToken in place — spreadsheetId always
  // stays the group's original one either way.
  if (groupId && existing) {
    const sameAccount = await canAccessSpreadsheet(tokens.access_token, existing.spreadsheetId);
    if (!sameAccount) {
      return html("กลุ่มนี้เชื่อมบัญชีไว้แล้ว ✅ ไม่ต้องเชื่อมซ้ำอีก ปิดหน้าต่างนี้แล้วกลับไปที่กลุ่มได้เลย");
    }
    await setAccountLink(env.ACCOUNTS, subjectId, {
      spreadsheetId: existing.spreadsheetId,
      refreshToken: tokens.refresh_token,
      displayName: existing.displayName,
    });
    return html(renderLinkedPage(true));
  }

  const defaultName = groupId ? await buildGroupSpreadsheetName(env, groupId) : "สมุดส่วนตัว";
  const spreadsheetId = existing?.spreadsheetId ?? (await createBookSpreadsheet(tokens.access_token, defaultName));

  await setAccountLink(env.ACCOUNTS, subjectId, {
    spreadsheetId,
    refreshToken: tokens.refresh_token,
    displayName: defaultName,
  });

  return html(renderLinkedPage(groupId !== null));
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

async function buildAuthorizeUrl(env: Env, subjectId: string, origin: string): Promise<string> {
  const state = await signState(subjectId, env.STATE_SIGNING_SECRET);
  return buildGoogleAuthorizeUrl({
    clientId: env.GOOGLE_CLIENT_ID,
    redirectUri: `${origin}/oauth/callback`,
    state,
  });
}

// Posted straight into the group (not DM'd, unlike the personal prompt) —
// the authorize link itself doesn't grant anything or expose anyone's
// data on its own, it only starts Google's own consent screen, and Google
// asks whoever actually clicks it which of *their* Google accounts to
// authorize. Whoever completes that step is simply who ends up as the
// group's linked account — there's no LINE API for "who is the group
// admin" to check against instead, so this is the natural, honest
// approach rather than trying to simulate a permission this bot can't see.
async function buildGroupUnlinkedPrompt(env: Env, groupId: string, origin: string): Promise<string> {
  const authorizeUrl = await buildAuthorizeUrl(env, groupSubjectId(groupId), origin);
  return `กลุ่มนี้ยังไม่ได้เชื่อมบัญชี Google เลย ใครก็ได้ในกลุ่มกดลิงก์นี้เพื่อเชื่อมบัญชีของตัวเองให้กลุ่มนี้ใช้ร่วมกัน (ข้อมูลจะเห็นเหมือนกันหมดทุกคนในกลุ่ม):\n${authorizeUrl}`;
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

// Same two functions as buildCalendarRelinkPrompt/CALENDAR_API_DISABLED_MESSAGE
// above, for the Tasks feature (PLAN.md 17.26) — accounts linked before this
// feature shipped only granted drive.file/calendar.events, not tasks.
async function buildTasksRelinkPrompt(env: Env, lineUserId: string, origin: string): Promise<string> {
  const authorizeUrl = await buildAuthorizeUrl(env, lineUserId, origin);
  return `ต้องเชื่อมบัญชี Google ใหม่อีกครั้งเพื่อขอสิทธิ์สิ่งที่ต้องทำเพิ่ม (บัญชีเดิมยังไม่มีสิทธิ์นี้) กดลิงก์นี้แล้วเลือกบัญชีเดิมได้เลย ข้อมูลเก่าจะไม่หายนะ\n${authorizeUrl}`;
}

const TASKS_API_DISABLED_MESSAGE =
  'สิ่งที่ต้องทำยังใช้ไม่ได้ เพราะ "Google Tasks API" ยังไม่ได้เปิดใช้งานในโปรเจกต์ Google Cloud (คนละเรื่องกับสิทธิ์ของบัญชีที่เชื่อมไว้ เชื่อมบัญชีใหม่ไม่ช่วย) ผู้ดูแลต้องไปที่ Google Cloud Console → APIs & Services → Library → ค้นหา "Google Tasks API" → กด Enable แล้วลองพิมพ์คำสั่งใหม่อีกครั้ง';

// Same two functions again, for Gmail (PLAN.md 17.28) — accounts linked
// before this feature shipped only granted drive.file/calendar.events/tasks,
// not gmail.readonly/gmail.send.
async function buildGmailRelinkPrompt(env: Env, lineUserId: string, origin: string): Promise<string> {
  const authorizeUrl = await buildAuthorizeUrl(env, lineUserId, origin);
  return `ต้องเชื่อมบัญชี Google ใหม่อีกครั้งเพื่อขอสิทธิ์อีเมลเพิ่ม (บัญชีเดิมยังไม่มีสิทธิ์นี้) กดลิงก์นี้แล้วเลือกบัญชีเดิมได้เลย ข้อมูลเก่าจะไม่หายนะ\n${authorizeUrl}`;
}

const GMAIL_API_DISABLED_MESSAGE =
  'อีเมลยังใช้ไม่ได้ เพราะ "Gmail API" ยังไม่ได้เปิดใช้งานในโปรเจกต์ Google Cloud (คนละเรื่องกับสิทธิ์ของบัญชีที่เชื่อมไว้ เชื่อมบัญชีใหม่ไม่ช่วย) ผู้ดูแลต้องไปที่ Google Cloud Console → APIs & Services → Library → ค้นหา "Gmail API" → กด Enable แล้วลองพิมพ์คำสั่งใหม่อีกครั้ง';

// Same two functions again, for Contacts (PLAN.md 17.34) — accounts linked
// before this feature shipped won't have contacts.readonly yet, needed both
// for the standalone "อีเมลของ<ชื่อ>" lookup and for resolving a name typed
// into "ส่งอีเมล ถึง <ชื่อ>".
async function buildContactsRelinkPrompt(env: Env, lineUserId: string, origin: string): Promise<string> {
  const authorizeUrl = await buildAuthorizeUrl(env, lineUserId, origin);
  return `ต้องเชื่อมบัญชี Google ใหม่อีกครั้งเพื่อขอสิทธิ์ผู้ติดต่อเพิ่ม (บัญชีเดิมยังไม่มีสิทธิ์นี้) กดลิงก์นี้แล้วเลือกบัญชีเดิมได้เลย ข้อมูลเก่าจะไม่หายนะ\n${authorizeUrl}`;
}

const CONTACTS_API_DISABLED_MESSAGE =
  'ผู้ติดต่อยังใช้ไม่ได้ เพราะ "People API" ยังไม่ได้เปิดใช้งานในโปรเจกต์ Google Cloud (คนละเรื่องกับสิทธิ์ของบัญชีที่เชื่อมไว้ เชื่อมบัญชีใหม่ไม่ช่วย) ผู้ดูแลต้องไปที่ Google Cloud Console → APIs & Services → Library → ค้นหา "People API" → กด Enable แล้วลองพิมพ์คำสั่งใหม่อีกครั้ง';

// Builds the ActionCtx factory shared by dispatch functions below — pulled
// out once so resolvePendingConfirmation, dispatchLegacyCommands, and
// runInterpretedIntent (the AI interpreter's own routing table) all build it
// identically.
function makeActionCtxFactory(env: Env, subjectId: string, link: AccountLink) {
  return (accessToken: string): ActionCtx => ({
    accessToken,
    kv: env.ACCOUNTS,
    lineUserId: subjectId,
    spreadsheetId: link.spreadsheetId,
    geminiApiKey: env.GEMINI_API_KEY,
  });
}

// A pending "ใช่/ไม่ใช่" confirmation (trip switch, calendar create/edit/
// delete, diary entry, transaction — PLAN.md 15.3/15.4/17.9) always resolves
// deterministically, checked before anything else including the AI
// interpreter below — an "ใช่" reply must always confirm the actual pending
// action via isAffirmative's exact-match check (confirmations.ts), never get
// re-read as free-form chitchat by the AI. Split out from the old
// dispatchCoreCommands (see dispatchLegacyCommands below) so the AI
// interpreter can be tried in between this and the legacy matcher chain.
async function resolvePendingConfirmation(
  env: Env,
  subjectId: string,
  link: AccountLink,
  text: string,
  origin: string,
  tokenCache: TokenCache | undefined
): Promise<string | null> {
  const actionCtx = makeActionCtxFactory(env, subjectId, link);
  try {
    const pendingConfirmation = await getPendingConfirmation(env.ACCOUNTS, subjectId);
    if (!pendingConfirmation) return null;
    const reply = await withFreshAccessToken(
      env,
      link.refreshToken,
      (accessToken) => resolveConfirmation(actionCtx(accessToken), text, pendingConfirmation),
      tokenCache
    );
    // null means "not an affirmative reply" — the pending question is
    // already cleared (see confirmations.ts), fall through and handle
    // `text` normally.
    return reply;
  } catch (err) {
    if (err instanceof CalendarApiDisabledError) return CALENDAR_API_DISABLED_MESSAGE;
    if (err instanceof InsufficientCalendarScopeError) return buildCalendarRelinkPrompt(env, subjectId, origin);
    if (err instanceof TasksApiDisabledError) return TASKS_API_DISABLED_MESSAGE;
    if (err instanceof InsufficientTasksScopeError) return buildTasksRelinkPrompt(env, subjectId, origin);
    if (err instanceof GmailApiDisabledError) return GMAIL_API_DISABLED_MESSAGE;
    if (err instanceof InsufficientGmailScopeError) return buildGmailRelinkPrompt(env, subjectId, origin);
    if (err instanceof ContactsApiDisabledError) return CONTACTS_API_DISABLED_MESSAGE;
    if (err instanceof InsufficientContactsScopeError) return buildContactsRelinkPrompt(env, subjectId, origin);
    throw err;
  }
}

// Executes whichever intent the AI interpreter (aiInterpreter.ts) decided on
// for a fresh message, routing to the exact same deterministic
// apply/prompt/answer functions the regex matchers below use — this never
// writes to Sheets/Calendar/Drive itself, and anything that saves data still
// goes through the normal confirm-before-save step (promptTransactionCreate/
// promptCalendarCreateFromDraft/etc. only ever set a pendingConfirmation,
// never call the apply* functions directly). `getAttribution` is lazy (only
// called for the "transaction" intent) so group mode doesn't pay for a group
// member profile lookup on every single message, only when a transaction is
// actually being logged — same reasoning as the original group draft path.
async function runInterpretedIntent(
  env: Env,
  subjectId: string,
  link: AccountLink,
  intent: InterpretedIntent,
  rawText: string,
  origin: string,
  tokenCache: TokenCache | undefined,
  getAttribution: () => Promise<TransactionAttribution>
): Promise<string> {
  const actionCtx = makeActionCtxFactory(env, subjectId, link);
  const withToken = <T>(fn: (ctx: ActionCtx) => Promise<T>): Promise<T> =>
    withFreshAccessToken(env, link.refreshToken, (accessToken) => fn(actionCtx(accessToken)), tokenCache);

  try {
    switch (intent.intent) {
      case "transaction": {
        const attribution = await getAttribution();
        return await promptTransactionCreate({ kv: env.ACCOUNTS, lineUserId: subjectId }, intent.transactions, rawText, attribution);
      }
      case "calendar_create":
        return await withToken((ctx) =>
          promptCalendarCreateFromDraft(ctx, {
            title: intent.calendarTitle,
            dateKey: intent.calendarDateKey,
            time: intent.calendarTime,
          })
        );
      case "calendar_delete":
        return await withToken((ctx) => promptCalendarDeleteByKeyword(ctx, intent.calendarKeyword));
      case "calendar_edit":
        return await withToken((ctx) =>
          promptCalendarEditByKeyword(ctx, intent.calendarKeyword, intent.calendarDateKey, intent.calendarTime)
        );
      case "calendar_query":
        return await withToken((ctx) =>
          answerCalendarQuery(ctx, intent.calendarRangeFromKey, intent.calendarRangeToKeyExclusive, intent.calendarRangeLabel)
        );
      case "diary_create":
        return await withToken((ctx) =>
          promptDiaryCreateFromDraft(ctx, { category: intent.diaryCategory, text: intent.diaryText })
        );
      case "diary_query_date":
        return await withToken((ctx) => answerDiaryByDate(ctx, intent.diaryDateKey));
      case "diary_query_month":
        return await withToken((ctx) => answerDiaryMonthSummary(ctx));
      case "diary_search":
        return await withToken((ctx) => answerDiarySearch(ctx, intent.diarySearchTerm));
      case "task_create":
        return await withToken((ctx) =>
          promptTaskCreate(ctx, { title: intent.taskTitle, dateKey: intent.taskDueDateKey, time: intent.taskDueTime })
        );
      case "task_complete":
        return await withToken((ctx) => promptTaskComplete(ctx, intent.taskKeyword));
      case "task_delete":
        return await withToken((ctx) => promptTaskDelete(ctx, intent.taskKeyword));
      case "task_list":
        return await withToken((ctx) => answerTaskList(ctx));
      case "email_check":
        return await withToken((ctx) => answerEmailCheck(ctx));
      case "email_send":
        return await withToken((ctx) =>
          promptEmailSendResolved(ctx, intent.emailTo, intent.emailSubject, intent.emailBody)
        );
      case "contact_lookup":
        return await withToken((ctx) => answerContactEmail(ctx, intent.contactName));
      case "find_nearby_places":
        // No withFreshAccessToken here on purpose, same reasoning as
        // set_province/matchPlacesCommand below — place search only needs
        // the flat Maps API key, never a per-user Google access token.
        return await promptPlaceSearch({ kv: env.ACCOUNTS, lineUserId: subjectId }, intent.placeKeyword);
      case "trip_start":
        return await withToken((ctx) => promptOrStartTrip(ctx, intent.tripName));
      case "trip_end":
        return await withToken((ctx) => endTrip(ctx));
      case "trip_status":
        return await withToken((ctx) => tripStatus(ctx));
      case "set_province":
        return await setProvinceByName(env.ACCOUNTS, subjectId, intent.provinceName);
      case "question":
        return await withToken((ctx) => answerQuestion(ctx, intent.question));
      case "help":
        return buildHelpText();
      case "view_link":
        return await buildViewLinkReply(env, subjectId, origin);
      case "chitchat":
      case "unclear":
        return intent.reply;
    }
  } catch (err) {
    if (err instanceof CalendarApiDisabledError) return CALENDAR_API_DISABLED_MESSAGE;
    if (err instanceof InsufficientCalendarScopeError) return buildCalendarRelinkPrompt(env, subjectId, origin);
    if (err instanceof TasksApiDisabledError) return TASKS_API_DISABLED_MESSAGE;
    if (err instanceof InsufficientTasksScopeError) return buildTasksRelinkPrompt(env, subjectId, origin);
    if (err instanceof GmailApiDisabledError) return GMAIL_API_DISABLED_MESSAGE;
    if (err instanceof InsufficientGmailScopeError) return buildGmailRelinkPrompt(env, subjectId, origin);
    if (err instanceof ContactsApiDisabledError) return CONTACTS_API_DISABLED_MESSAGE;
    if (err instanceof InsufficientContactsScopeError) return buildContactsRelinkPrompt(env, subjectId, origin);
    throw err;
  }
}

// Best-effort: recording a turn is a nice-to-have for future context, never
// something that should turn a successful reply into a failure — a KV
// hiccup here must not surface as an error to the user after their message
// already succeeded.
async function recordConversationTurn(env: Env, subjectId: string, userText: string, botText: string): Promise<void> {
  try {
    await appendConversationTurn(env.ACCOUNTS, subjectId, userText, botText);
  } catch (err) {
    console.error("recordConversationTurn failed", err);
  }
}

// The regex/keyword matcher-dispatch chain shared by personal mode
// (handleTextMessage) and group mode (handleGroupTextMessage) below — every
// command that both modes support, in the exact precedence order both rely
// on. This is now the *fallback* path (PLAN.md 17.11): tried only when the
// AI interpreter's own call fails outright (timeout, API error, malformed
// JSON) or wasn't attempted at all (a pending clarification is active — see
// handleTextMessage). Used to be two hand-copied ~90-line blocks that had to
// be kept in sync by hand on every change (a real risk: a fix or a new
// matcher applied to only one of the two silently makes the modes diverge,
// with no compiler or test signal beyond whichever mode someone happens to
// add a test for). Returns null when nothing matched, meaning "fall through
// to the chatEngine handling", which is genuinely different between the two
// modes and stays in each caller rather than being forced into this shared
// shape.
async function dispatchLegacyCommands(
  env: Env,
  subjectId: string,
  link: AccountLink,
  text: string,
  origin: string,
  tokenCache: TokenCache | undefined
): Promise<string | null> {
  const actionCtx = makeActionCtxFactory(env, subjectId, link);

  try {
    // Checked before every other matcher below, not just matchCommand's
    // report shortcuts: "ถาม"/"วิเคราะห์" is an explicit, unambiguous signal
    // that this message is for the AI, and several other matchers key off
    // a bare trigger *word* anywhere in the text rather than the message
    // starting with it — matchCalendarCommand's "นัด" check in particular
    // (see its own comment on why it can't just require the start) matches
    // "นัด" anywhere it appears after whitespace, so "ถาม นัดพรุ่งนี้มีไหม"
    // used to get swallowed as a failed appointment-creation attempt and
    // never reached the AI at all. Checking this first means "ถาม"/
    // "วิเคราะห์" always wins, regardless of what trigger words the rest of
    // the question happens to contain.
    const aiHandler = await matchAiCommand(text);
    if (aiHandler) {
      return await withFreshAccessToken(
        env,
        link.refreshToken,
        (accessToken) => aiHandler(actionCtx(accessToken)),
        tokenCache
      );
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

    // Task and Gmail are checked *before* Calendar here, even though
    // Calendar was wired up first historically — real bug found in
    // production: matchCalendarCommand's "นัด" trigger matches that word
    // anywhere in a message (see extractNadPayload's own comment), so a
    // task/email whose free text happened to contain "นัด" (a common Thai
    // word) got swallowed into a failed calendar-create attempt before ever
    // reaching matchTaskCommand/matchGmailCommand below. Task's and Gmail's
    // own matchers only fire on their own fixed, unambiguous prefixes
    // ("เพิ่มสิ่งที่ต้องทำ", "ทำเสร็จแล้ว", "ลบสิ่งที่ต้องทำ", "ส่งอีเมล", plus a
    // short fixed list of exact list/check phrases) — none of those overlap
    // with anything Calendar's own matcher recognizes, so checking them
    // first can never swallow a genuine calendar command; it only ever
    // stops Calendar's looser "นัด anywhere" trigger from swallowing *them*.
    const taskHandler = await matchTaskCommand(text);
    if (taskHandler) {
      return await withFreshAccessToken(
        env,
        link.refreshToken,
        (accessToken) => taskHandler(actionCtx(accessToken)),
        tokenCache
      );
    }

    const gmailHandler = await matchGmailCommand(text);
    if (gmailHandler) {
      return await withFreshAccessToken(
        env,
        link.refreshToken,
        (accessToken) => gmailHandler(actionCtx(accessToken)),
        tokenCache
      );
    }

    const contactsHandler = await matchContactsCommand(text);
    if (contactsHandler) {
      return await withFreshAccessToken(
        env,
        link.refreshToken,
        (accessToken) => contactsHandler(actionCtx(accessToken)),
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

    // No withFreshAccessToken here on purpose — setting a province only
    // touches KV and Open-Meteo (no Google auth needed at all), so wrapping
    // it the same way as the handlers above would fetch a Google access
    // token this command has no use for.
    const provinceHandler = matchProvinceCommand(text);
    if (provinceHandler) {
      return await provinceHandler(env.ACCOUNTS, subjectId);
    }

    // Same reasoning as the province handler above: Places search (PLAN.md
    // 17.30) only needs a flat Google Maps API key, not a per-user Google
    // access token, so there's nothing here for withFreshAccessToken to do.
    const placesHandler = await matchPlacesCommand(text);
    if (placesHandler) {
      return await placesHandler({ kv: env.ACCOUNTS, lineUserId: subjectId });
    }

    // Works in both modes (PLAN.md 17.7) — resolveViewSession (viewAuth.ts)
    // resolves a view token's subject through the same generic
    // getAccountLink group mode already relies on everywhere else, and none
    // of the /view pages read anything identity-specific off the session
    // besides accessToken/spreadsheetId. Same reasoning as the province
    // handler above for skipping withFreshAccessToken: minting a view-link
    // token only needs STATE_SIGNING_SECRET, no Google auth at all.
    if (matchViewLinkCommand(text)) {
      return await buildViewLinkReply(env, subjectId, origin);
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
      return buildCalendarRelinkPrompt(env, subjectId, origin);
    }
    if (err instanceof TasksApiDisabledError) {
      return TASKS_API_DISABLED_MESSAGE;
    }
    if (err instanceof InsufficientTasksScopeError) {
      return buildTasksRelinkPrompt(env, subjectId, origin);
    }
    if (err instanceof GmailApiDisabledError) {
      return GMAIL_API_DISABLED_MESSAGE;
    }
    if (err instanceof InsufficientGmailScopeError) {
      return buildGmailRelinkPrompt(env, subjectId, origin);
    }
    if (err instanceof ContactsApiDisabledError) {
      return CONTACTS_API_DISABLED_MESSAGE;
    }
    if (err instanceof InsufficientContactsScopeError) {
      return buildContactsRelinkPrompt(env, subjectId, origin);
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

  return null;
}

// Regression fix for a real report: once chatEngine asks "จำนวนเงินเท่าไหร่คะ"
// (pending.kind === "amount"), a reply that isn't a number and isn't an
// exact-match greeting used to stay stuck answering that same question
// forever — handleUserMessage's own "treat as a brand new message" fallback
// still runs it through chatEngine's parseMessage, which (correctly, for a
// money-only parser) treats *any* text with no digits as yet another
// incomplete expense needing an amount, so it just re-asks. That trap
// blocked every other feature (AI Q&A, calendar, shifts, ...) until the
// 10-minute TTL expired, since a pending clarification also skips the AI
// interpreter entirely (see the caller's own comment). A clarification only
// makes sense as "still in progress" if the reply could plausibly be
// answering it — for "amount", that means it contains a number; anything
// else means the user has moved on to something unrelated, so the stale
// clarification is dropped and the message re-enters the normal pipeline
// (AI interpreter first, same as any fresh message) instead of trapping it.
async function dropStaleAmountClarification(
  kv: KVNamespace,
  subjectId: string,
  pending: PendingClarification | null,
  text: string
): Promise<PendingClarification | null> {
  if (pending?.kind !== "amount" || isGreeting(text) || extractAmount(text) !== null) return pending;
  await setPending(kv, subjectId, null);
  return null;
}

export async function handleTextMessage(
  env: Env,
  lineUserId: string,
  text: string,
  origin: string,
  tokenCache?: TokenCache
): Promise<string> {
  const link = await getAccountLink(env.ACCOUNTS, lineUserId);
  if (!link) return buildUnlinkedPrompt(env, lineUserId, origin);

  const confirmationReply = await resolvePendingConfirmation(env, lineUserId, link, text, origin, tokenCache);
  if (confirmationReply !== null) {
    await recordConversationTurn(env, lineUserId, text, confirmationReply);
    return confirmationReply;
  }

  const pending = await getPending(env.ACCOUNTS, lineUserId);
  const effectivePending = await dropStaleAmountClarification(env.ACCOUNTS, lineUserId, pending, text);

  // PLAN.md 17.11: every fresh message is interpreted by AI first — full
  // free-form understanding plus recent conversation history, instead of
  // only recognizing known command phrases. Skipped only when a chatEngine
  // clarification is genuinely still in flight (`effectivePending`, e.g.
  // "จำนวนเงินเท่าไหร่คะ") — that specific continuation stays on the
  // deterministic path that originally asked it, below, rather than being
  // handed to the AI mid-clarification. Tried *before* the legacy matcher
  // chain (including "วิธีใช้"/greeting handling right below it) so the AI
  // genuinely gets first say over everything, exactly as requested — a
  // well-known phrase like "วิธีใช้" still resolves correctly either way,
  // since the AI interpreter's own "help" intent routes to the exact same
  // buildHelpText() the legacy path would have used (see runInterpretedIntent).
  if (!effectivePending) {
    const history = await getConversationHistory(env.ACCOUNTS, lineUserId).catch((err) => {
      console.error("getConversationHistory failed, continuing without history", err);
      return [];
    });
    const intent = await interpretMessage(env.GEMINI_API_KEY, text, history);
    if (intent) {
      const reply = await runInterpretedIntent(env, lineUserId, link, intent, text, origin, tokenCache, async () => ({
        addedBy: lineUserId,
        addedByName: "LINE",
      }));
      await recordConversationTurn(env, lineUserId, text, reply);
      return reply;
    }
    // interpretMessage returned null: the call itself failed (timeout, API
    // error, malformed/invalid JSON) — fall through to the same
    // deterministic matcher chain this codebase always used, so an AI
    // hiccup degrades to the old, fully rule-based behavior instead of ever
    // blocking a reply.
  }

  const legacyReply = await dispatchLegacyCommands(env, lineUserId, link, text, origin, tokenCache);
  if (legacyReply !== null) {
    await recordConversationTurn(env, lineUserId, text, legacyReply);
    return legacyReply;
  }

  // Checked after every deterministic command above (including matchCommand's
  // HELP_TEST branch inside dispatchLegacyCommands) so "วิธีใช้"/"help" (also
  // in chatEngine's GREETINGS) still gets the detailed list from matchCommand
  // instead of being shadowed by this shorter welcome blurb — and only when
  // there's no dangling money clarification, so a stray greeting mid-flow
  // still cancels it properly via chatEngine's own greeting handling instead
  // of leaving `pending` stuck in KV. The very first greeting this account
  // has ever sent still gets the original feature-list welcome (no context
  // yet for a weather/news briefing); the first greeting of each Bangkok
  // calendar day after that gets the full morning briefing (PLAN.md 15.11);
  // any later greeting the same day just gets a short prompt instead of
  // repeating it. This stateful once-a-day logic stays fully deterministic
  // rather than being handed to the AI interpreter to reinvent (PLAN.md
  // 17.11) — it's only reached here because the interpreter itself failed
  // (see the fallback comment above); when it succeeds, a greeting is one of
  // "chitchat"/"help" and is handled by the interpreter branch instead.
  if (!effectivePending && isGreeting(text)) {
    const greetingKind = await classifyGreeting(env.ACCOUNTS, lineUserId);
    const reply =
      greetingKind === "welcome"
        ? WELCOME_MESSAGE
        : greetingKind === "briefing"
          ? await buildMorningBriefing(env, env.ACCOUNTS, lineUserId)
          : buildReturnGreeting();
    await recordConversationTurn(env, lineUserId, text, reply);
    return reply;
  }

  const result = handleUserMessage(text, effectivePending, DEFAULT_CATEGORIES);
  await setPending(env.ACCOUNTS, lineUserId, result.pending);

  // transactionDrafts (plural) is set instead of transactionDraft when one
  // message contained several separate items — see parseMultilineTransactions
  // in chatEngine.ts. Both are handled the same way (promptTransactionCreate
  // takes the whole array). PLAN.md 17.9: a ready draft no longer saves
  // immediately, even when unambiguous — it always asks to confirm first,
  // same as every other create/delete action already did, so
  // result.botMessage (chatEngine's own "saved" text) is never used for a
  // successful draft; promptTransactionCreate's confirmation text replaces it.
  const drafts = result.transactionDrafts ?? (result.transactionDraft ? [result.transactionDraft] : []);
  if (drafts.length > 0) {
    const reply = await promptTransactionCreate(
      { kv: env.ACCOUNTS, lineUserId },
      drafts,
      text,
      { addedBy: lineUserId, addedByName: "LINE" }
    );
    await recordConversationTurn(env, lineUserId, text, reply);
    return reply;
  }

  await recordConversationTurn(env, lineUserId, text, result.botMessage);
  return result.botMessage;
}

// Group mode (PLAN.md 17) — now at near-full parity with personal mode's
// handleTextMessage (PLAN.md 17.7): money logging, the read-only report
// shortcuts, AI Q&A/analysis, calendar, diary, trip start/end/status, and
// ตั้งจังหวัด all use the exact same command matchers as personal mode,
// pointed at the group's own linked Google account via the same
// generalized subject-id trick (groupSubjectId) — none of them needed
// group-specific code beyond just being wired in here, since state.ts's
// functions and every matcher's ActionCtx parameter were already generic.
// view-link ("เปิดเว็บดูข้อมูล", PLAN.md 17.7) works here too, for the same
// reason: resolveViewSession (viewAuth.ts) already resolves a token's
// subject through the same generic getAccountLink, and none of the /view
// pages read anything identity-specific off the session besides its
// accessToken/spreadsheetId — buildViewLinkReply just tailors its message
// wording for the fact that a group's reply, unlike personal mode's, posts
// straight into the shared chat (so "visible to you alone" would be untrue).
// The one thing that's genuinely different from personal mode: trip
// *photos*. LINE's @mention feature only exists on text messages, so a
// group member can never address a photo to the bot the way they can
// address text — see the media-event handling in processWebhookEvents for
// how that's actually solved (auto-upload while a trip is active, no
// mention needed, silence otherwise).
export async function handleGroupTextMessage(
  env: Env,
  groupId: string,
  senderUserId: string | undefined,
  text: string,
  origin: string,
  tokenCache?: TokenCache
): Promise<string> {
  const subjectId = groupSubjectId(groupId);
  const link = await getAccountLink(env.ACCOUNTS, subjectId);
  if (!link) return buildGroupUnlinkedPrompt(env, groupId, origin);

  const confirmationReply = await resolvePendingConfirmation(env, subjectId, link, text, origin, tokenCache);
  if (confirmationReply !== null) {
    await recordConversationTurn(env, subjectId, text, confirmationReply);
    return confirmationReply;
  }

  // Pending clarifications (PENDING_TTL_SECONDS in state.ts) are shared by
  // the whole group, not just whoever the bot originally asked — anyone
  // replying "60" to "จำนวนเงินเท่าไหร่คะ" resolves it, matching how a
  // question posed to a group chat naturally works.
  const pending = await getPending(env.ACCOUNTS, subjectId);
  const effectivePending = await dropStaleAmountClarification(env.ACCOUNTS, subjectId, pending, text);

  // PLAN.md 17.11: same AI-interpreter-first flow as personal mode. No
  // group-specific greeting check to skip here first — group mode never had
  // one (see this function's own comment above), so this is the very next
  // gate after pendingConfirmation/pendingClarification. Attribution is
  // resolved lazily (only inside runInterpretedIntent's "transaction" case)
  // so an ordinary non-money message in a group doesn't pay for a member
  // profile lookup it doesn't need.
  if (!effectivePending) {
    const history = await getConversationHistory(env.ACCOUNTS, subjectId).catch((err) => {
      console.error("getConversationHistory failed, continuing without history", err);
      return [];
    });
    const intent = await interpretMessage(env.GEMINI_API_KEY, text, history);
    if (intent) {
      const reply = await runInterpretedIntent(env, subjectId, link, intent, text, origin, tokenCache, () =>
        resolveGroupAttribution(env, groupId, senderUserId)
      );
      await recordConversationTurn(env, subjectId, text, reply);
      return reply;
    }
  }

  const legacyReply = await dispatchLegacyCommands(env, subjectId, link, text, origin, tokenCache);
  if (legacyReply !== null) {
    await recordConversationTurn(env, subjectId, text, legacyReply);
    return legacyReply;
  }

  const result = handleUserMessage(text, effectivePending, DEFAULT_CATEGORIES);
  await setPending(env.ACCOUNTS, subjectId, result.pending);

  // PLAN.md 17.9: same as personal mode — asks to confirm before saving,
  // never immediately. Attribution is resolved now (whoever's message
  // actually completed this draft) and baked into the pending confirmation,
  // since it's stored until the group confirms — anyone can confirm it
  // (see the shared pending-clarification comment above), but credit always
  // stays with whoever actually entered the data.
  const drafts = result.transactionDrafts ?? (result.transactionDraft ? [result.transactionDraft] : []);
  if (drafts.length > 0) {
    const attribution = await resolveGroupAttribution(env, groupId, senderUserId);
    const reply = await promptTransactionCreate({ kv: env.ACCOUNTS, lineUserId: subjectId }, drafts, text, attribution);
    await recordConversationTurn(env, subjectId, text, reply);
    return reply;
  }

  await recordConversationTurn(env, subjectId, text, result.botMessage);
  return result.botMessage;
}

const UNKNOWN_GROUP_MEMBER_LABEL = "สมาชิกกลุ่ม";

async function resolveGroupAttribution(
  env: Env,
  groupId: string,
  senderUserId: string | undefined
): Promise<TransactionAttribution> {
  // senderUserId can be missing (see LineEventSource's comment in line.ts)
  // — degrades to a generic label rather than skipping attribution
  // entirely or blocking the save over what's a cosmetic detail.
  if (!senderUserId) return { addedBy: "unknown", addedByName: UNKNOWN_GROUP_MEMBER_LABEL };
  const profile = await getGroupMemberProfile(groupId, senderUserId, env.LINE_CHANNEL_ACCESS_TOKEN);
  return { addedBy: senderUserId, addedByName: profile?.displayName ?? UNKNOWN_GROUP_MEMBER_LABEL };
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
//
// Known, accepted tradeoff: this retries blindly rather than checking
// whether the "failed" attempt actually created the file in Drive before
// the error surfaced (e.g. the create succeeded but reading/parsing the
// response body afterward threw) — in that rare case a retry uploads a
// second copy rather than detecting the first one succeeded. A duplicate
// file is a strictly better failure mode than the one this retry replaces
// (the photo silently never arriving at all), and checking for an existing
// file first would cost another Drive subrequest per file — real budget
// that isn't worth spending to guard against an edge case this narrow.
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

function pushTargetId(source: LineEventSource): string {
  // A group's push target is the group itself, not whoever happened to
  // send the triggering message — there is no per-member push target
  // that would even make sense here.
  return source.type === "group" ? source.groupId : source.userId;
}

// The KV/account-state key for an event's sender — a real personal LINE
// userId for 1:1 chat, or the synthesized group subject id for a group
// (see groupSubjectId's own comment). Used to group both media events
// ("whose shared trip is this") and text events (see
// processWebhookEvents — every event for the same subject shares one
// pendingConfirmation slot in state.ts, so they need to run one at a time,
// not concurrently, to avoid racing on it).
function subjectIdForSource(source: LineEventSource): string {
  return source.type === "group" ? groupSubjectId(source.groupId) : source.userId;
}

// LINE reply tokens are single-use and short-lived. Sending several photos
// or clips together bundles many events into one webhook call, and each
// Drive upload takes real network time — replying to event N only after
// events 1..N-1 finished serially could push N's reply past its token's
// window, and a failed reply threw straight into the catch block below,
// which retried the *same* (still-expired) token and swallowed that
// failure too, producing total silence. Push messages target the userId
// (or groupId, in group mode) directly, so they're immune to token expiry
// — falling back to one here means the user always hears back even if the
// reply attempt lost the race.
//
// This is also the single choke point nearly every outgoing chat reply
// passes through (PLAN.md 17.9's persona layer), so the AI-styled text is
// computed once here and reused for both the reply attempt and its push
// fallback, rather than restyling twice (wasted Gemini quota) or, worse,
// styling it differently on each attempt.
async function replyOrPush(
  event: { replyToken: string; source: LineEventSource },
  text: string,
  env: Env
): Promise<void> {
  const styledText = await applyPersona(text, env.GEMINI_API_KEY);
  try {
    await replyToLine(event.replyToken, styledText, env.LINE_CHANNEL_ACCESS_TOKEN);
  } catch (err) {
    console.error("line reply failed, falling back to push", err);
    await pushToLine(pushTargetId(event.source), styledText, env.LINE_CHANNEL_ACCESS_TOKEN);
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

// Every media file, no matter the batch size, goes through the upload queue
// (uploadQueue.ts) rather than uploading inline within the webhook call — an
// earlier version uploaded small batches immediately for a faster reply, but
// that turned out to be unreliable in a way no amount of tuning fixed: LINE
// often splits one multi-select send into several separate webhook calls
// (e.g. one per file, when some take longer to finish uploading from the
// sender's phone than others), so "one combined reply per webhook call"
// didn't actually mean "one combined reply per send" — a user could still
// get a flood of separate one-file confirmations. Routing everything through
// the same queue+scheduled-drain path used for large batches means the
// drain naturally coalesces whatever's accumulated since it last ran into
// one summary, regardless of how many separate webhook calls LINE split the
// send into. The tradeoff, accepted deliberately: even a single photo now
// takes up to about a minute (the cron interval) to get its confirmation,
// instead of being instant.
//
// Kept below the ~50-external-subrequest ceiling a single invocation gets,
// sized for the *worst case* rather than the happy path: MAX_UPLOAD_ATTEMPTS
// means a file that fails once costs double (a fresh LINE fetch + Drive
// upload on retry) — 4 subrequests instead of 2 — and if failures are
// correlated rather than isolated (e.g. Drive has a brief outage or
// rate-limits a burst of requests, exactly the scenario the retry exists to
// ride out), most or all files in one drain could need a retry at once.
// Even fully pessimistic (every single item retries) — 10 × 4 + a couple of
// housekeeping requests ≈ low 40s — stays clear of the ceiling.
const DRAIN_BATCH_SIZE = 10;

// Resolves the account link and active trip once per sender instead of once
// per file, replying with the appropriate prompt and returning null if
// either is missing so the caller knows to stop.
async function resolveMediaBatchContext(
  env: Env,
  subjectId: string,
  events: Array<LineImageMessageEvent | LineVideoMessageEvent>,
  origin: string
): Promise<{ refreshToken: string; trip: ActiveTrip } | null> {
  // Group mode (PLAN.md 17.7): unlike personal chat, where every photo is
  // unambiguously meant for the bot, a group has ordinary unrelated
  // photo-sharing all the time, and LINE's @mention feature can't be
  // attached to a photo the way it can to text — there's no signal to gate
  // a reply on the way findSelfMention gates text commands. So neither
  // "not linked" nor "no active trip" gets a reply in a group; only a
  // genuinely active trip (started via an explicit *mentioned* text
  // command) is treated as consent to auto-collect what gets sent next.
  const isGroup = groupIdFromSubject(subjectId) !== null;

  const link = await getAccountLink(env.ACCOUNTS, subjectId);
  if (!link) {
    // .catch here (and on every other replyOrPush call in this file's media
    // handling) is deliberate: replyOrPush itself throws if BOTH the reply
    // and its push fallback fail. Left unguarded, that exception escapes
    // through an unawaited-for-errors Promise.all in handleWebhook and
    // crashes the *entire* invocation — silencing not just this batch but
    // every other event (text messages, other senders' batches) in the same
    // webhook call too. A real report matched this exactly: one batch got no
    // reply at all while an unrelated batch in a different webhook call
    // succeeded normally.
    if (!isGroup) {
      await replyOrPush(events[0], await buildUnlinkedPrompt(env, subjectId, origin), env).catch(() => undefined);
    }
    return null;
  }
  const trip = await getActiveTrip(env.ACCOUNTS, subjectId);
  if (!trip) {
    if (!isGroup) {
      await replyOrPush(
        events[0],
        'ยังไม่ได้เริ่มทริปอยู่เลย พิมพ์ "เริ่มทริป <ชื่อ>" ก่อนนะ แล้วค่อยส่งรูป/คลิปตามมาได้เลย',
        env
      ).catch(() => undefined);
    }
    return null;
  }
  return { refreshToken: link.refreshToken, trip };
}

async function handleQueuedMediaBatch(
  env: Env,
  subjectId: string,
  events: Array<LineImageMessageEvent | LineVideoMessageEvent>,
  origin: string
): Promise<void> {
  try {
    const ctx = await resolveMediaBatchContext(env, subjectId, events, origin);
    if (!ctx) return;
    const { trip } = ctx;

    const pushTarget = pushTargetId(events[0].source);
    const jobs: QueuedUpload[] = events.map((event) => ({
      lineUserId: subjectId,
      pushTarget,
      kind: isImageMessageEvent(event) ? "image" : "video",
      messageId: event.message.id,
      timestampMs: event.timestamp,
      tripFolderId: trip.folderId,
      tripName: trip.name,
    }));
    await enqueueUploads(env.ACCOUNTS, jobs);

    // Deliberately no "received, uploading in background" reply here — the
    // user only wants to hear back once files are actually done uploading.
    // drainUploadQueue below sends that confirmation once the cron drain
    // actually finishes the work. All of this batch's reply tokens are
    // simply left unused (LINE tokens that never get used just expire
    // quietly on their own; there's no cost to skipping them).
  } catch (err) {
    // Last line of defense: without this, a failure here (most likely
    // enqueueUploads, or a KV lookup inside resolveMediaBatchContext) would
    // escape uncaught through handleWebhook's Promise.allSettled and could
    // crash the whole invocation — silencing every other event in the same
    // webhook call, not just this batch. Best-effort only; if the fallback
    // reply below also fails there's genuinely nothing more that can be
    // done for this specific attempt.
    console.error("handleQueuedMediaBatch failed", err);
    await replyOrPush(events[0], "ขอโทษด้วย เกิดข้อผิดพลาดตอนรับไฟล์ ลองส่งรูป/คลิปใหม่อีกครั้งนะ", env).catch(
      () => undefined
    );
  }
}

// Reads and signature-verifies the raw request body, returning the parsed
// events or null if the signature didn't check out. Shared by handleWebhook
// (which processes events synchronously — used directly by tests, and by
// the fast-ack path below after backgrounding the real work) and the
// fast-ack path itself, so both stay in sync on how a request is validated.
async function verifyAndParseWebhookBody(request: Request, env: Env): Promise<LineWebhookBody | null> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");
  const valid = await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET);
  if (!valid) return null;
  return JSON.parse(rawBody) as LineWebhookBody;
}

// Group-mode addressing without a formal @mention (PLAN.md 17.12): returns
// the text with the bot's name removed if the message contains it anywhere,
// or null if it doesn't (meaning "not addressed to the bot" — same meaning
// findSelfMention/stripSelfMention's null/non-null pairing already has).
// Plain substring search rather than a word-boundary regex — Thai script has
// no whitespace between words in general, so there's no reliable notion of
// "word boundary" to anchor on the way there is in English; this is the same
// looseness matchCalendarCommand's own "นัด" search already accepts (see its
// comment). Only the *first* occurrence is removed, mirroring
// stripSelfMention's single-span removal — a message repeating the name
// keeps any later mentions as ordinary text, which no realistic case relies
// on stripping.
function stripBotNameMention(text: string): string | null {
  const index = text.indexOf(BOT_NAME);
  if (index === -1) return null;
  return (text.slice(0, index) + text.slice(index + BOT_NAME.length)).trim();
}

// One text/unsupported event, start to finish (matcher dispatch, reply).
// Extracted out of processWebhookEvents so it can be called from within a
// per-subject sequential loop there instead of as a flat concurrency-limited
// callback — see that call site's comment for why.
async function handleOneOtherEvent(
  event: LineWebhookBody["events"][number],
  env: Env,
  origin: string,
  tokenCache: TokenCache
): Promise<void> {
  try {
    if (isTextMessageEvent(event)) {
      if (event.source.type === "group") {
        // Every message in a group the bot belongs to reaches this
        // webhook, addressed to the bot or not — LINE does no filtering
        // on its side (PLAN.md 17). Silently skip anything that doesn't
        // address the bot, without touching any state at all, so ordinary
        // conversation between group members never gets treated as a
        // command or a pending-clarification answer. A formal LINE @mention
        // is checked first (unambiguous — LINE itself resolves it to this
        // exact bot account); calling the bot by name in plain text (no @)
        // is accepted too, requested directly so group members don't have
        // to reach for the @ picker every time (PLAN.md 17.12).
        const selfMention = findSelfMention(event.message);
        const text = selfMention
          ? stripSelfMention(event.message.text, selfMention)
          : stripBotNameMention(event.message.text);
        if (text === null) return;
        const reply = await handleGroupTextMessage(env, event.source.groupId, event.source.userId, text, origin, tokenCache);
        await replyOrPush(event, reply, env);
        return;
      }
      const reply = await handleTextMessage(env, event.source.userId, event.message.text, origin, tokenCache);
      await replyOrPush(event, reply, env);
    } else if (isLocationMessageEvent(event)) {
      // No reply at all when nothing was asked for (answerNearbySearch
      // returns null) — same silent default every other unprompted event in
      // this bot follows (an unmentioned group text, a group photo with no
      // active trip). LINE's location-share message can't carry an @mention
      // the way group text can, so "is a search actually pending for this
      // subject" is the only signal available for "was this meant for the
      // bot" — see placesCommands.ts's own comment.
      const subjectId = subjectIdForSource(event.source);
      const reply = await answerNearbySearch(
        env.ACCOUNTS,
        subjectId,
        env.GOOGLE_MAPS_API_KEY,
        event.message.latitude,
        event.message.longitude
      );
      if (reply !== null) {
        await replyOrPush(event, reply, env);
      }
    } else if (isUnsupportedMessageEvent(event)) {
      await replyOrPush(event, "ขอโทษด้วย ไฟล์ประเภทนี้ยังไม่รองรับนะ ตอนนี้รองรับแค่รูปภาพและวิดีโอ", env);
    }
  } catch (err) {
    if (isTextMessageEvent(event) || isLocationMessageEvent(event) || isUnsupportedMessageEvent(event)) {
      await replyOrPush(event, "ขอโทษด้วย เกิดข้อผิดพลาดตอนบันทึก ลองใหม่อีกครั้งนะ", env).catch(() => undefined);
    }
    console.error("webhook handling failed", err);
  }
}

// All the real work for one webhook call: uploading media, sending replies,
// everything. Split out from handleWebhook so the production fetch handler
// can run it via ctx.waitUntil() *after* already responding to LINE — see
// the comment on the fetch handler's /webhook branch for why that matters.
// handleWebhook below still awaits this directly (tests call handleWebhook
// and expect it to have fully finished before checking results), so nothing
// about the synchronous, fully-awaited behavior tests rely on has changed.
async function processWebhookEvents(body: LineWebhookBody, env: Env, origin: string): Promise<void> {
  // Shared across every event in this one webhook call — see the
  // TokenCache comment on withFreshAccessToken for why.
  const tokenCache: TokenCache = new Map();

  // Text/unsupported events are processed *before* media below — a text
  // command that starts a trip (e.g. group mode's mentioned "เริ่มทริป")
  // must land before any photos bundled into the same webhook call are
  // checked against the active trip, or those photos see "no active trip
  // yet" and, in group mode, get silently dropped with zero reply (see
  // resolveMediaBatchContext's isGroup handling) even though the trip
  // gets created moments later in this very call. LINE can bundle a
  // multi-select photo send together with a preceding text message into
  // one webhook body, so this ordering is a real, not just theoretical,
  // race.
  const mediaEvents = body.events.filter(
    (event): event is LineImageMessageEvent | LineVideoMessageEvent =>
      isImageMessageEvent(event) || isVideoMessageEvent(event)
  );
  const mediaEventSet = new Set<LineWebhookBody["events"][number]>(mediaEvents);
  const otherEvents = body.events.filter((event) => !mediaEventSet.has(event));

  // Grouped by subject (same subjectIdForSource used for media above) so
  // two events for the same subject can never run concurrently — found in
  // review: they'd otherwise race on the single shared pendingConfirmation
  // KV slot (state.ts) that money logging and calendar/diary/trip
  // confirmations all use, e.g. one event creating a fresh draft right as
  // another confirms an older one, silently confirming the wrong thing (or
  // losing the newer draft). LINE really can bundle several messages for
  // the same person/group into one webhook call — see the media-ordering
  // comment above for another real instance of this. Different subjects
  // still run concurrently, bounded by WEBHOOK_EVENT_CONCURRENCY — see its
  // own comment for why neither fully serial nor fully concurrent works —
  // so an ordinary batch (rarely more than a handful of distinct senders)
  // keeps the same throughput as before; only same-subject events are now
  // forced one at a time.
  const otherEventsBySubject = new Map<string, typeof otherEvents>();
  for (const event of otherEvents) {
    // Only text/location/unsupported events (the kinds handleOneOtherEvent
    // actually does anything with) have a real, typed `source` — LINE's
    // other event types (follow/unfollow/join/leave/etc., none of which
    // this bot handles) fall through isTextMessageEvent/
    // isLocationMessageEvent/isUnsupportedMessageEvent and get silently
    // ignored either way, so their grouping key doesn't matter. Location
    // events need the same one-at-a-time-per-subject treatment as text —
    // they read/clear the same place-search pending slot (state.ts) that a
    // preceding "หา...ใกล้ฉัน" text command in the same webhook call could
    // have just set, the identical bundling race the comment above already
    // covers for pendingConfirmation.
    const subjectId =
      isTextMessageEvent(event) || isLocationMessageEvent(event) || isUnsupportedMessageEvent(event)
        ? subjectIdForSource(event.source)
        : "unrecognized";
    const forSubject = otherEventsBySubject.get(subjectId) ?? [];
    forSubject.push(event);
    otherEventsBySubject.set(subjectId, forSubject);
  }
  await processWithConcurrencyLimit(
    [...otherEventsBySubject.values()],
    WEBHOOK_EVENT_CONCURRENCY,
    async (subjectEvents) => {
      for (const event of subjectEvents) {
        await handleOneOtherEvent(event, env, origin, tokenCache);
      }
    }
  );

  // Media events (image/video) are always queued (uploadQueue.ts) and never
  // uploaded inline here — grouped by sender, one combined reply per sender.
  // See DRAIN_BATCH_SIZE's comment for why every media file goes through the
  // queue unconditionally now, rather than small batches uploading inline
  // for a faster reply the way an earlier version did. Runs after the text
  // events above finish, not concurrently with them — see the comment where
  // mediaEvents/otherEvents are split out for why the ordering matters.
  if (mediaEvents.length > 0) {
    // Grouped by subject (personal userId, or the whole group for a
    // group-sourced event — see mediaSubjectId) — a webhook call is almost
    // always one sender's send, but handling it generally costs nothing
    // extra, and a group needs everyone's photos pooled into the same
    // batch/trip regardless of which member actually sent each one.
    const eventsBySubject = new Map<string, Array<LineImageMessageEvent | LineVideoMessageEvent>>();
    for (const event of mediaEvents) {
      const subjectId = subjectIdForSource(event.source);
      const forSubject = eventsBySubject.get(subjectId) ?? [];
      forSubject.push(event);
      eventsBySubject.set(subjectId, forSubject);
    }
    // allSettled, not all: handleQueuedMediaBatch already catches everything
    // internally (see its own try/catch), but this is defense in depth —
    // one sender's batch throwing must never take down every other sender's
    // batch in the same webhook call.
    const results = await Promise.allSettled(
      [...eventsBySubject.entries()].map(([subjectId, events]) =>
        handleQueuedMediaBatch(env, subjectId, events, origin)
      )
    );
    for (const result of results) {
      if (result.status === "rejected") console.error("media batch handling failed unexpectedly", result.reason);
    }
  }
}

// Fully synchronous: verifies, processes every event, and only then returns
// "ok". Kept for tests, which need to await full completion before checking
// results (e.g. driveUploads.length right after `await handleWebhook(...)`).
// Production traffic goes through the fetch handler's fast-ack path instead
// — see its comment for why the two need to differ.
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const body = await verifyAndParseWebhookBody(request, env);
  if (!body) return new Response("invalid signature", { status: 401 });
  const origin = new URL(request.url).origin;
  await processWebhookEvents(body, env, origin);
  return new Response("ok");
}

interface DrainUserSummary {
  lineUserId: string;
  tripName: string;
  pushTarget: string;
  succeeded: number;
  failed: number;
}

// Called on the cron trigger configured in wrangler.toml (see
// DRAIN_BATCH_SIZE above for the full story of why this exists). Each firing
// is its own Worker invocation with its own
// fresh subrequest/CPU budget, so working through a big backlog a bounded
// amount at a time — rather than trying to force it all through one webhook
// call's budget — is what actually gets every file uploaded reliably.
export async function drainUploadQueue(env: Env): Promise<void> {
  const entries = await listQueueBatch(env.ACCOUNTS, DRAIN_BATCH_SIZE);
  if (entries.length === 0) return;

  const tokenCache: TokenCache = new Map();
  // Keyed by lineUserId *and* tripFolderId, not lineUserId alone — a batch
  // can span two different trips for the same person/group (e.g. a group
  // closes one trip and opens another between drains, or right around the
  // same drain), and collapsing them into one summary would both merge
  // unrelated succeeded/failed counts and report the wrong trip name for
  // whichever files didn't belong to the last-processed job.
  const summaries = new Map<string, DrainUserSummary>();

  for (const { key, job } of entries) {
    const summaryKey = `${job.lineUserId} ${job.tripFolderId}`;
    const summary = summaries.get(summaryKey) ?? {
      lineUserId: job.lineUserId,
      tripName: job.tripName,
      // Jobs queued before this deploy have no pushTarget field at all
      // (KV queue entries persist across deploys) — lineUserId was always
      // the correct push target for every job before group mode split the
      // two, so it's the right fallback for that pre-existing data.
      pushTarget: job.pushTarget ?? job.lineUserId,
      succeeded: 0,
      failed: 0,
    };
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
    summaries.set(summaryKey, summary);
  }

  // One push per (subject, trip) summary — a batch spanning two trips for
  // the same subject now sends two separate confirmations instead of one
  // mislabeled combined one. "remaining" is a whole-subject queue depth
  // (not trip-specific — countQueuedForUser doesn't filter by trip), so it
  // reads the same across both pushes in that rare case, which is a minor
  // cosmetic wrinkle next to reporting the wrong trip name outright.
  for (const summary of summaries.values()) {
    const remaining = await countQueuedForUser(env.ACCOUNTS, summary.lineUserId);
    const parts = [`✅ อัปโหลดเพิ่ม ${summary.succeeded} ไฟล์เข้าทริป "${summary.tripName}" แล้ว`];
    if (summary.failed > 0) {
      parts.push(`(อีก ${summary.failed} ไฟล์อัปโหลดไม่สำเร็จ ลองส่งใหม่อีกครั้งได้นะ)`);
    }
    parts.push(remaining > 0 ? `เหลืออีก ${remaining} ไฟล์ กำลังทยอยอัปโหลดต่อ` : `อัปโหลดครบทุกไฟล์แล้ว`);
    // pushTarget, not lineUserId — a group's push target is the real
    // groupId, not the synthesized "group:<groupId>" subject id lineUserId
    // holds in that case (see QueuedUpload's own comment).
    const styledSummary = await applyPersona(parts.join(" "), env.GEMINI_API_KEY);
    await pushToLine(summary.pushTarget, styledSummary, env.LINE_CHANNEL_ACCESS_TOKEN).catch((err) =>
      console.error("drain summary push failed", err)
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/oauth/callback") return handleOAuthCallback(request, env);
    if (url.pathname === "/view") return handleViewAccountsRequest(request, env);
    if (url.pathname === "/view/calendar") return handleViewCalendarRequest(request, env);
    if (url.pathname === "/view/diary") return handleViewDiaryRequest(request, env);
    if (url.pathname === "/view/shifts") return handleViewShiftsRequest(request, env);
    if (url.pathname === "/view/trips" || url.pathname.startsWith("/view/trips/")) {
      return handleViewTripsRequest(request, env);
    }
    if (url.pathname.startsWith("/view/photo/")) return handleViewPhotoRequest(request, env);
    if (url.pathname === "/webhook" && request.method === "POST") {
      const body = await verifyAndParseWebhookBody(request, env);
      if (!body) return new Response("invalid signature", { status: 401 });
      // Acknowledge LINE's webhook delivery immediately instead of making it
      // wait for the real processing (fetching media, uploading to Drive,
      // sending replies) to finish. LINE — like most webhook senders — has
      // its own timeout on how long it'll wait for a response; Cloudflare's
      // own request logs confirmed a real invocation was cut short with
      // outcome "canceled" after LINE gave up and disconnected only ~2
      // seconds in, well under any CPU or subrequest limit this codebase had
      // been tuning against. Every earlier fix made the processing itself
      // more reliable, but none of them made the response come back fast
      // enough to avoid the disconnect in the first place. ctx.waitUntil
      // keeps processWebhookEvents running in the background after this
      // response has already gone out, so LINE never has a reason to hang up
      // on us mid-request again.
      ctx.waitUntil(processWebhookEvents(body, env, url.origin));
      return new Response("ok");
    }
    if (url.pathname === "/health") return new Response("ok");

    return new Response("not found", { status: 404 });
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(drainUploadQueue(env));
    // Runs on the same once-a-minute cron — broadcastMorningBriefings itself
    // is a no-op outside the 07:00 Bangkok minute (PLAN.md 17.21), so this
    // doesn't need its own separate cron trigger entry in wrangler.toml.
    ctx.waitUntil(broadcastMorningBriefings(env, env.ACCOUNTS));
  },
};
