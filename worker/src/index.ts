import { handleUserMessage, isGreeting, type PendingClarification } from "./chatEngine.ts";
import { extractAmount } from "./parser.ts";
import { DEFAULT_CATEGORIES } from "./categories.ts";
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
import { matchBudgetCommand, promptBudgetDelete, promptBudgetSet, answerBudgetList } from "./budgetCommands.ts";
import { buildCapabilityText, buildHelpReply, matchCommand } from "./commands.ts";
import { appendConversationTurn, getConversationHistory } from "./conversationHistory.ts";
import { isExplicitCancel, resolveConfirmation } from "./confirmations.ts";
import {
  answerDiaryByDate,
  answerDiaryMonthSummary,
  answerDiarySearch,
  matchDiaryCommand,
  promptDiaryCreateFromDraft,
} from "./diaryCommands.ts";
import { findUploadedMessageIds, uploadFileToFolder } from "./drive.ts";
import { buildGoogleAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken } from "./googleAuth.ts";
import {
  answerTaskList,
  matchTaskCommand,
  promptTaskComplete,
  promptTaskCreate,
  promptTaskDelete,
} from "./taskCommands.ts";
import { answerEmailCheck, matchGmailCommand, promptEmailSendResolved } from "./gmailCommands.ts";
import { answerContactEmail, answerContactList, matchContactsCommand } from "./contactsCommands.ts";
import { groupIdFromSubject, groupSubjectId } from "./groupSubject.ts";
import {
  broadcastMorningBriefings,
  buildMorningBriefing,
  buildReturnGreeting,
  classifyGreeting,
  answerAirQuality,
  matchAirQualityCommand,
  matchProvinceCommand,
  setProvinceByName,
} from "./greetingCommands.ts";
import {
  fetchLineMediaContent,
  findSelfMention,
  getGroupMemberProfile,
  getGroupSummary,
  isAudioMessageEvent,
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
  type LineAudioMessageEvent,
  type LineImageMessageEvent,
  type LineVideoMessageEvent,
  type LineWebhookBody,
} from "./line.ts";
import { answerNearbySearch, matchPlacesCommand, promptPlaceSearch } from "./placesCommands.ts";
import {
  answerRecurringList,
  matchRecurringCommand,
  promptRecurringDelete,
  promptRecurringPaid,
  promptRecurringSet,
} from "./recurringCommands.ts";
import {
  answerMovieDiscover,
  answerMovieList,
  answerMovieSearch,
  matchMovieCommand,
  type MovieCtx,
} from "./movieCommands.ts";
import { canAccessSpreadsheet, createBookSpreadsheet } from "./sheets.ts";
import { signState, verifyState } from "./signedState.ts";
import {
  getAccountLink,
  getActiveTrip,
  getPending,
  getPendingConfirmation,
  setAccountLink,
  setPending,
  setPendingConfirmation,
  type AccountLink,
  type ActionCtx,
  type ActiveTrip,
  type PendingConfirmation,
  type TransactionAttribution,
} from "./state.ts";
import { applyPersona } from "./persona.ts";
import { getBotSettings } from "./settings.ts";
import { bangkokDateFolderName, bangkokDateKey, formatThaiDateLabel } from "./thaiDate.ts";
import { matchTransactionCommand, promptTransactionCreate } from "./transactionCommands.ts";
import { answerFlightSearch, answerGroundSearch, answerHotelSearch, matchTravelCommand } from "./travelCommands.ts";
import { answerTripList, endTrip, matchTripCommand, promptOrStartTrip, tripStatus } from "./tripCommands.ts";
import { isWebSearchEnabled } from "./webSearch.ts";
// Safe to import as a runtime value (unlike the reverse direction): every
// view file imports Env from here as a *type* only, which TypeScript
// erases, so this doesn't create a real module cycle — see viewAuth.ts's
// own note on why it keeps a duplicate `html` helper rather than importing
// this file's.
import { renderErrorPage } from "./viewAuth.ts";
import { handlePrivacyRequest, handleTermsRequest } from "./legalPages.ts";
import { handleViewBudgetsRequest } from "./viewBudgetsPage.ts";
import { handleViewSettingsRequest } from "./viewSettingsPage.ts";
import { handleViewCalendarRequest } from "./viewCalendarPage.ts";
import { buildSettingsLinkReply, buildViewLinkReply, matchSettingsLinkCommand, matchViewLinkCommand } from "./viewCommands.ts";
import { answerLotteryCheck, answerLotteryResult, matchLotteryCommand } from "./lotteryCommands.ts";
import { formatBaht } from "./format.ts";
import { readImage, readLineImage, type AppointmentReading, type MoneyReading } from "./imageIntent.ts";
import { quickRepliesFor } from "./quickReplies.ts";
import { parseThaiTime } from "./thaiTime.ts";
import { transcribeVoiceMessage } from "./voice.ts";
import { handleViewDiaryRequest } from "./viewDiaryPage.ts";
import { handleViewHelpRequest } from "./viewHelpPage.ts";
import { handleViewMoviesRequest } from "./viewMoviesPage.ts";
import { handleViewSearchRequest } from "./viewSearchPage.ts";
import { handleViewShiftsRequest } from "./viewShiftsPage.ts";
import { handleViewAccountsRequest } from "./viewPages.ts";
import { handleViewTasksRequest } from "./viewTasksPage.ts";
import { handleViewPhotoRequest, handleViewTripsRequest } from "./viewTripsPage.ts";
import {
  clearQueuePending,
  deleteQueueEntry,
  enqueueUploads,
  shouldScanQueue,
  listQueueBatch,
  type QueueEntry,
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
  // Travelpayouts Data API token (PLAN.md 17.37) — optional, same
  // degrade-gracefully treatment as GOOGLE_MAPS_API_KEY: travel search
  // still sends booking links without it, it just can't show prices in
  // chat. (Originally Amadeus credentials — swapped before ever going
  // live, see travel.ts's own comment on the Amadeus portal shutdown.)
  TRAVELPAYOUTS_TOKEN: string;
  // Web search master switch (PLAN.md 17.42). Unset = off, which is the
  // working state on a free-tier Gemini key: Grounding with Google Search
  // needs billing enabled, and without it every grounded call 429s. Set to
  // the literal "true" once the project has billing to turn the feature on
  // without a code change.
  ENABLE_WEB_SEARCH: string | undefined;
  // TMDb API Read Access Token (PLAN.md 17.57) — optional, same
  // degrade-gracefully treatment as GOOGLE_MAPS_API_KEY and
  // TRAVELPAYOUTS_TOKEN: a flat project-level credential for public data,
  // tied to no account. The bearer token rather than the v3 `api_key`
  // query parameter — see movies.ts's tmdbFetch for why. Without it the
  // movie commands say the feature isn't set up yet; nothing else changes.
  TMDB_READ_TOKEN: string;
}

// A function rather than a constant since PLAN.md 17.48 — the bot's name is
// the account's to choose, and this message is the first place it says it.
const welcomeMessage = (botName: string) => [
  `สวัสดีค่ะ 👋 ฉันชื่อ${botName}นะ เป็นผู้ช่วยส่วนตัวในแชท ช่วยได้ 13 เรื่องหลักๆ:`,
  "",
  "💰 จดรายรับ-รายจ่ายประจำวัน พร้อมสรุปรายงาน",
  "📸 เก็บรูป/คลิปทริปอัตโนมัติขึ้น Google Drive",
  "📅 จดนัดหมายลง Google Calendar",
  "📔 บันทึกไดอารี่ประจำวัน",
  "🗓️ ตารางเวร",
  "✅ จัดการสิ่งที่ต้องทำ (Google Tasks)",
  "📧 เช็ค/ส่งอีเมล พร้อมค้นหาอีเมลผู้ติดต่อให้",
  "📍 หาร้าน/สถานที่ใกล้ตัวจากตำแหน่งจริง",
  "🎫 หาตั๋วเครื่องบิน/รถทัวร์/รถไฟ และที่พัก เทียบราคาพร้อมลิงก์กดจองเอง",
  "🎬 หาหนัง/ซีรีส์ใหม่ ค้นจากชื่อหรือเนื้อเรื่อง พร้อมบอกว่าดูได้ที่แอปไหน",
  "🤖 ถามคำถาม/วิเคราะห์การใช้จ่ายด้วย AI และค้นหา Google ให้ได้ด้วย",
  "☀️ สรุปวันที่/อากาศ/ข่าวให้ทุกเช้าอัตโนมัติ",
  "🌐 ดูบัญชี/ปฏิทิน/ไดอารี่/รูปทริป/ตารางเวร/สิ่งที่ต้องทำผ่านเว็บ",
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
function makeActionCtxFactory(env: Env, subjectId: string, link: AccountLink, origin: string) {
  return (accessToken: string): ActionCtx => ({
    accessToken,
    kv: env.ACCOUNTS,
    lineUserId: subjectId,
    spreadsheetId: link.spreadsheetId,
    geminiApiKey: env.GEMINI_API_KEY,
    origin,
    stateSigningSecret: env.STATE_SIGNING_SECRET,
    webSearchEnabled: isWebSearchEnabled(env.ENABLE_WEB_SEARCH),
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
  tokenCache: TokenCache | undefined,
  // Filled in with a money draft that was left in place rather than cleared,
  // so the caller can clear it if nothing downstream absorbed it.
  deferred?: { pending: PendingConfirmation | null }
): Promise<string | null> {
  const actionCtx = makeActionCtxFactory(env, subjectId, link, origin);
  try {
    const pendingConfirmation = await getPendingConfirmation(env.ACCOUNTS, subjectId);
    if (!pendingConfirmation) return null;
    // Recorded before resolveConfirmation runs, because that is where the
    // decision to keep a money draft alive is made (PLAN.md 17.84). The
    // caller has to finish the job: this draft is now outliving the message
    // that failed to answer it. Which kinds are actually kept is
    // finalizeDeferredDraft's call alone — a second copy of that rule here
    // would be one that could drift out of step with it.
    if (deferred) deferred.pending = pendingConfirmation;
    const reply = await withFreshAccessToken(
      env,
      link.refreshToken,
      (accessToken) => resolveConfirmation(actionCtx(accessToken), text, pendingConfirmation),
      tokenCache
    );
    // null means "not an affirmative reply" — the pending question is
    // already cleared (see confirmations.ts), fall through and handle
    // `text` normally.
    //
    // Except when the reply was an outright "no": the draft is gone either
    // way, but handing "ยกเลิก" onward as a fresh message got it answered
    // with "ยกเลิกอะไรคะ", telling the user the cancel had not worked when
    // it had (PLAN.md 17.75).
    if (reply === null && isExplicitCancel(text)) return "ยกเลิกแล้ว ไม่ได้บันทึกอะไรนะ";
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
  const actionCtx = makeActionCtxFactory(env, subjectId, link, origin);
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
      case "contact_list":
        return await withToken((ctx) => answerContactList(ctx));
      // No Google token: Open-Meteo needs no auth at all (PLAN.md 17.71).
      // Routed to the same handler the typed command uses, so both phrasings
      // give the identical answer rather than two that can drift apart.
      case "air_quality":
        return await answerAirQuality(env.ACCOUNTS, subjectId);
      // No Google token and no key of any kind (PLAN.md 17.73).
      case "trip_list":
        return await withToken((ctx) => answerTripList(ctx));
      case "lottery_result":
        return await answerLotteryResult();
      case "lottery_check":
        return await answerLotteryCheck(intent.lotteryNumber);
      case "contact_lookup":
        return await withToken((ctx) => answerContactEmail(ctx, intent.contactName));
      case "find_nearby_places":
        // No withFreshAccessToken here on purpose, same reasoning as
        // set_province/matchPlacesCommand below — place search only needs
        // the flat Maps API key, never a per-user Google access token.
        return await promptPlaceSearch({ kv: env.ACCOUNTS, lineUserId: subjectId }, intent.placeKeyword);
      // Movies (PLAN.md 17.57) — TMDb only, so no Google token here either.
      case "movie_list":
        return await answerMovieList(movieCtx(env, subjectId, origin), intent.mediaType, intent.movieListKind);
      case "movie_search":
        return await answerMovieSearch(movieCtx(env, subjectId, origin), intent.mediaType, intent.movieQuery);
      case "movie_discover":
        return await answerMovieDiscover(movieCtx(env, subjectId, origin), intent.mediaType, intent.movieDescription);
      // Travel search (PLAN.md 17.37) — read-only, no per-user Google auth
      // (an app-level Amadeus key at most), same no-withToken reasoning as
      // find_nearby_places above.
      case "flight_search":
        return await answerFlightSearch(env, {
          originCode: intent.flightOriginCode,
          destinationCode: intent.flightDestinationCode,
          originName: intent.flightOriginName,
          destinationName: intent.flightDestinationName,
          dateKey: intent.flightDateKey,
        });
      case "hotel_search":
        return await answerHotelSearch(env, {
          cityName: intent.hotelCityName,
          checkInDateKey: intent.hotelCheckInDateKey,
          checkOutDateKey: intent.hotelCheckOutDateKey,
        });
      case "ground_ticket_search":
        return answerGroundSearch({
          originName: intent.groundOriginName,
          destinationName: intent.groundDestinationName,
          originSlug: intent.groundOriginSlug,
          destinationSlug: intent.groundDestinationSlug,
          dateKey: intent.groundDateKey,
        });
      case "budget_set":
        return await withToken((ctx) => promptBudgetSet(ctx, intent.budgetCategoryId, intent.budgetLimitAmount));
      case "budget_delete":
        return await withToken((ctx) => promptBudgetDelete(ctx, intent.budgetCategoryId));
      // Recurring bills (PLAN.md 17.59)
      case "recurring_list":
        return await withToken((ctx) => answerRecurringList(ctx));
      case "recurring_set":
        return await withToken((ctx) =>
          promptRecurringSet(ctx, intent.recurringName, intent.recurringAmount, intent.recurringDay ?? 0)
        );
      case "recurring_delete":
        return await withToken((ctx) => promptRecurringDelete(ctx, intent.recurringName));
      case "recurring_paid":
        return await withToken((ctx) => promptRecurringPaid(ctx, intent.recurringName));
      case "budget_list":
        return await withToken((ctx) => answerBudgetList(ctx));
      case "trip_start":
        return await withToken((ctx) => promptOrStartTrip(ctx, intent.tripName));
      case "trip_end":
        return await withToken((ctx) => endTrip(ctx));
      case "trip_status":
        return await withToken((ctx) => tripStatus(ctx));
      case "set_province":
        return await setProvinceByName(env.ACCOUNTS, subjectId, intent.provinceName);
      // Straight back to the deterministic matcher (PLAN.md 17.49). The
      // model recognised "this is one of the canned money reports"; the
      // report itself is computed and formatted by the same code the typed
      // command has always used, so "รายการล่าสุด" gives the same five rows
      // however it was phrased.
      //
      // Falls through to a free-form answer if the matcher doesn't
      // recognise the wording after all — the model can be right that this
      // is a report request and still be looking at a phrasing commands.ts
      // has no test for, and answering is better than saying nothing.
      case "report": {
        const reportHandler = await matchCommand(rawText, origin);
        if (reportHandler) {
          return await withFreshAccessToken(
            env,
            link.refreshToken,
            (accessToken) => reportHandler(accessToken, link.spreadsheetId, env.ACCOUNTS),
            tokenCache
          );
        }
        return await withToken((ctx) => answerQuestion(ctx, rawText));
      }
      case "question":
        return await withToken((ctx) => answerQuestion(ctx, intent.question));
      case "help":
        return buildHelpReply(origin);
      case "capabilities":
        return buildCapabilityText();
      case "view_link":
        return await buildViewLinkReply(env, subjectId, origin);
      case "settings_link":
        return await buildSettingsLinkReply(env, subjectId, origin);
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
/** The narrow context the movie commands take (PLAN.md 17.57). A plain
 * function rather than a factory-of-factories like makeActionCtxFactory,
 * because none of these fields depends on a Google access token. */
function movieCtx(env: Env, subjectId: string, origin: string): MovieCtx {
  return {
    kv: env.ACCOUNTS,
    subjectId,
    origin,
    tmdbReadToken: env.TMDB_READ_TOKEN,
    geminiApiKey: env.GEMINI_API_KEY,
    signingSecret: env.STATE_SIGNING_SECRET,
  };
}

async function dispatchLegacyCommands(
  env: Env,
  subjectId: string,
  link: AccountLink,
  text: string,
  origin: string,
  tokenCache: TokenCache | undefined
): Promise<string | null> {
  const actionCtx = makeActionCtxFactory(env, subjectId, link, origin);

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

    // Same again: PM2.5 comes from Open-Meteo with no key and no Google
    // auth, so this needs no access token either (PLAN.md 17.71).
    const airQualityHandler = matchAirQualityCommand(text);
    if (airQualityHandler) {
      return await airQualityHandler(env.ACCOUNTS, subjectId);
    }

    // Same again — the lottery API needs no auth at all (PLAN.md 17.73).
    const lotteryHandler = matchLotteryCommand(text);
    if (lotteryHandler) {
      return await lotteryHandler();
    }

    // Same reasoning as the province handler above: Places search (PLAN.md
    // 17.30) only needs a flat Google Maps API key, not a per-user Google
    // access token, so there's nothing here for withFreshAccessToken to do.
    const placesHandler = await matchPlacesCommand(text);
    if (placesHandler) {
      return await placesHandler({ kv: env.ACCOUNTS, lineUserId: subjectId });
    }

    // Travel search (PLAN.md 17.37) — no per-user Google auth either (an
    // app-level Amadeus key at most, see travelCommands.ts). Ordering
    // matters twice here: after Places, so "หาที่พักใกล้ฉัน" stays a GPS
    // nearby-search; before matchCommand's report handler at the bottom,
    // whose transaction-search regex ("^(?:ค้นหา|หา)...") would otherwise
    // swallow every "หาตั๋ว..."/"หาที่พัก..." as a money-note search.
    const travelHandler = await matchTravelCommand(text);
    if (travelHandler) {
      return await travelHandler(env);
    }

    // Movies (PLAN.md 17.57) — TMDb only, no Google auth, so no
    // withFreshAccessToken here either. Placed before matchCommand's report
    // handler for the same reason travel is: "ค้นหาหนัง..." and
    // "หาหนังเรื่อง..." both start with that handler's search prefix and
    // would otherwise be read as a search of the user's own spending notes.
    const movieHandler = matchMovieCommand(text);
    if (movieHandler) {
      return await movieHandler(movieCtx(env, subjectId, origin));
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

    // Same shape, and for the same reason: minting a link needs only
    // STATE_SIGNING_SECRET, no Google auth (PLAN.md 17.50).
    if (matchSettingsLinkCommand(text)) {
      return await buildSettingsLinkReply(env, subjectId, origin);
    }

    // Recurring bills (PLAN.md 17.59) — before matchCommand for the same
    // reason as budgets below: its report matcher tests "สรุป" as a
    // substring, and "ค่าใช้จ่ายประจำ" contains none of this matcher's own
    // prefixes either way, so running it first can't swallow a report.
    const recurringHandler = matchRecurringCommand(text);
    if (recurringHandler) {
      return await withFreshAccessToken(
        env,
        link.refreshToken,
        (accessToken) => recurringHandler(actionCtx(accessToken)),
        tokenCache
      );
    }

    // Before matchCommand's report handler for two reasons: its
    // "งบเหลือเท่าไหร่" test is a substring check that would also catch
    // "ตั้งงบ..." phrasings, and its search regex ("^(?:ค้นหา|หา)...") takes
    // anything starting with หา. Neither overlaps with this matcher's own
    // fixed prefixes, so running it first can't swallow a report command.
    const budgetHandler = await matchBudgetCommand(text);
    if (budgetHandler) {
      return await withFreshAccessToken(
        env,
        link.refreshToken,
        (accessToken) => budgetHandler(actionCtx(accessToken)),
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

  const reportHandler = await matchCommand(text, origin);
  if (reportHandler) {
    return withFreshAccessToken(
      env,
      link.refreshToken,
      (accessToken) => reportHandler(accessToken, link.spreadsheetId, env.ACCOUNTS),
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
/**
 * The answer to "what time is the appointment?" (PLAN.md 17.80).
 *
 * Returns null when the reply was not a time at all, so the message falls
 * through and is handled as an ordinary one — the same convention the amount
 * clarification follows. Someone who answers a question with something else
 * has changed the subject, and holding them to the old question is worse
 * than dropping it.
 *
 * The pending slot is cleared either way. A question that stays open after
 * being answered would catch the *next* message too.
 */
async function resolveAppointmentTime(
  env: Env,
  subjectId: string,
  link: AccountLink,
  pending: { title: string; dateKey: string },
  text: string,
  origin: string,
  tokenCache?: TokenCache
): Promise<string | null> {
  const time = parseThaiTime(text);
  if (time === null) {
    await setPending(env.ACCOUNTS, subjectId, null);
    return null;
  }
  await setPending(env.ACCOUNTS, subjectId, null);
  return withFreshAccessToken(
    env,
    link.refreshToken,
    (accessToken) =>
      promptCalendarCreateFromDraft(makeActionCtxFactory(env, subjectId, link, origin)(accessToken), {
        title: pending.title,
        dateKey: pending.dateKey,
        time,
      }),
    tokenCache
  );
}

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

/**
 * Clears a money draft that survived a message which turned out not to be
 * about money (PLAN.md 17.84).
 *
 * confirmations.ts stops clearing a `transactionCreate` draft when the reply
 * is not an answer, so that another expense in the next message can be
 * merged into it instead of replacing it. Everything else still has to end
 * it — otherwise "จะบันทึก 60 บาท ใช่ไหม?", three unrelated messages, and a
 * stray "ใช่" would save a draft nobody remembers proposing.
 *
 * Whether anything absorbed it is decided by comparing the slot with what
 * was left there. A merge appends drafts and a replacement changes the kind,
 * so byte-identical means untouched — no extra field to persist, and no way
 * for the two to disagree.
 */
async function finalizeDeferredDraft(
  kv: KVNamespace,
  subjectId: string,
  deferred: PendingConfirmation | null,
  reply: string
): Promise<string> {
  if (deferred?.kind !== "transactionCreate") return reply;
  const still = await getPendingConfirmation(kv, subjectId);
  if (!still || JSON.stringify(still) !== JSON.stringify(deferred)) return reply;
  await setPendingConfirmation(kv, subjectId, null);
  return `${reply}\n(ยกเลิกคำถามก่อนหน้า ${deferred.drafts.length} รายการนะ)`;
}

export async function handleTextMessage(
  env: Env,
  lineUserId: string,
  text: string,
  origin: string,
  tokenCache?: TokenCache
): Promise<string> {
  const deferred: { pending: PendingConfirmation | null } = { pending: null };
  const reply = await handleTextMessageInner(env, lineUserId, text, origin, tokenCache, deferred);
  return finalizeDeferredDraft(env.ACCOUNTS, lineUserId, deferred.pending, reply);
}

async function handleTextMessageInner(
  env: Env,
  lineUserId: string,
  text: string,
  origin: string,
  tokenCache: TokenCache | undefined,
  deferred: { pending: PendingConfirmation | null }
): Promise<string> {
  const link = await getAccountLink(env.ACCOUNTS, lineUserId);
  if (!link) return buildUnlinkedPrompt(env, lineUserId, origin);

  // The account's own bot name and character (PLAN.md 17.48). Read once and
  // shared by the two places below that speak in the bot's own voice: the
  // AI interpreter's chitchat replies, and the first-ever welcome message
  // where it introduces itself by name.
  const settings = await getBotSettings(env.ACCOUNTS, lineUserId);

  const confirmationReply = await resolvePendingConfirmation(env, lineUserId, link, text, origin, tokenCache, deferred);
  if (confirmationReply !== null) {
    await recordConversationTurn(env, lineUserId, text, confirmationReply);
    return confirmationReply;
  }

  let pending = await getPending(env.ACCOUNTS, lineUserId);

  // Answered here rather than in chatEngine, which is the money engine and
  // has no business knowing about appointments (PLAN.md 17.80). Checked
  // before the AI interpreter too: the reply is an answer to a question the
  // bot just asked, not a fresh instruction to be interpreted.
  if (pending?.kind === "appointmentTime") {
    const appointmentReply = await resolveAppointmentTime(env, lineUserId, link, pending, text, origin, tokenCache);
    if (appointmentReply !== null) {
      await recordConversationTurn(env, lineUserId, text, appointmentReply);
      return appointmentReply;
    }
    // resolveAppointmentTime dropped the question, so the rest of this
    // function must not go on treating it as still open.
    pending = null;
  }

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
  // Whether Gemini answered at all this turn (PLAN.md 17.56). Drives two
  // things further down: whether the last-resort AI question is worth making,
  // and whether an "I don't understand" reply should say the message wasn't
  // understood or that the AI is unavailable — which are different problems
  // with different fixes, and used to read identically.
  let aiWasReachable = false;

  if (!effectivePending) {
    const history = await getConversationHistory(env.ACCOUNTS, lineUserId).catch((err) => {
      console.error("getConversationHistory failed, continuing without history", err);
      return [];
    });
    const outcome = await interpretMessage(env.GEMINI_API_KEY, text, history, settings, env.ACCOUNTS);
    aiWasReachable = outcome.kind !== "unavailable";
    if (outcome.kind === "intent") {
      const reply = await runInterpretedIntent(env, lineUserId, link, outcome.intent, text, origin, tokenCache, async () => ({
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
        ? welcomeMessage(settings.botName)
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

  if (result.unknown) {
    const reply = await answerUnrecognized(
      env, lineUserId, link, text, origin, tokenCache, aiWasReachable, result.botMessage
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
  const deferred: { pending: PendingConfirmation | null } = { pending: null };
  const reply = await handleGroupTextMessageInner(env, groupId, senderUserId, text, origin, tokenCache, deferred);
  return finalizeDeferredDraft(env.ACCOUNTS, groupSubjectId(groupId), deferred.pending, reply);
}

async function handleGroupTextMessageInner(
  env: Env,
  groupId: string,
  senderUserId: string | undefined,
  text: string,
  origin: string,
  tokenCache: TokenCache | undefined,
  deferred: { pending: PendingConfirmation | null }
): Promise<string> {
  const subjectId = groupSubjectId(groupId);
  const link = await getAccountLink(env.ACCOUNTS, subjectId);
  if (!link) return buildGroupUnlinkedPrompt(env, groupId, origin);

  // The group's shared settings — see the personal-mode call above.
  const settings = await getBotSettings(env.ACCOUNTS, subjectId);

  const confirmationReply = await resolvePendingConfirmation(env, subjectId, link, text, origin, tokenCache, deferred);
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
  // See handleTextMessage's own comment on this flag.
  let aiWasReachable = false;

  if (!effectivePending) {
    const history = await getConversationHistory(env.ACCOUNTS, subjectId).catch((err) => {
      console.error("getConversationHistory failed, continuing without history", err);
      return [];
    });
    const outcome = await interpretMessage(env.GEMINI_API_KEY, text, history, settings, env.ACCOUNTS);
    aiWasReachable = outcome.kind !== "unavailable";
    if (outcome.kind === "intent") {
      const reply = await runInterpretedIntent(env, subjectId, link, outcome.intent, text, origin, tokenCache, () =>
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

  if (result.unknown) {
    const reply = await answerUnrecognized(
      env, subjectId, link, text, origin, tokenCache, aiWasReachable, result.botMessage
    );
    await recordConversationTurn(env, subjectId, text, reply);
    return reply;
  }

  await recordConversationTurn(env, subjectId, text, result.botMessage);
  return result.botMessage;
}


// Last resort for a message nothing recognised (PLAN.md 17.56).
//
// The deterministic engine saying "I don't understand" is the end of the
// line, but it isn't always the honest end: the AI interpreter runs first
// and only hands over when it produced nothing usable, and *why* it produced
// nothing matters. If Gemini answered with something that failed validation,
// the model is up and worth asking in plain language — which is exactly the
// case a real user hit, asking for their contacts and being told the bot
// didn't understand. If Gemini wasn't reachable at all, a second call would
// only spend a request to fail the same way, so this says so instead of
// blaming the message.
async function answerUnrecognized(
  env: Env,
  subjectId: string,
  link: AccountLink,
  text: string,
  origin: string,
  tokenCache: TokenCache | undefined,
  aiWasReachable: boolean,
  deterministicReply: string
): Promise<string> {
  if (!aiWasReachable) {
    return "ตอนนี้ระบบ AI ตอบไม่ได้ชั่วคราว เลยเข้าใจข้อความนี้ไม่ได้นะ ลองใหม่อีกสักครู่ หรือพิมพ์คำสั่งตรงๆ ก็ได้ เช่น \"ค่ากาแฟ 60\" หรือ \"สรุปเดือนนี้\"";
  }
  const actionCtx = makeActionCtxFactory(env, subjectId, link, origin);
  try {
    return await withFreshAccessToken(
      env,
      link.refreshToken,
      (accessToken) => answerQuestion(actionCtx(accessToken), text),
      tokenCache
    );
  } catch (err) {
    // Never let the last resort be the thing that breaks the reply — the
    // deterministic answer was already good enough to send.
    console.error("answerUnrecognized: the fallback AI question failed too", err);
    return deterministicReply;
  }
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
  env: Env,
  // Voice replies skip the styling pass (PLAN.md 17.75). A voice message
  // already costs a Gemini call the typed path does not — transcribe, then
  // interpret, then style — and the free tier ran out mid-conversation
  // because of it, which turns the whole feature off. An unstyled reply is a
  // cosmetic loss; "ระบบ AI ตอบไม่ได้ชั่วคราว" is the feature not working.
  options: { skipPersona?: boolean } = {}
): Promise<void> {
  const subjectId = subjectIdForSource(event.source);
  const settings = await getBotSettings(env.ACCOUNTS, subjectId);
  // Read *after* the handler has run, so this is the question the bot is
  // asking now rather than the one it was asked (PLAN.md 17.82). Two KV
  // reads per outbound message: reads are the plentiful side of the free
  // plan's quota (100k/day against 1k writes), and this path adds none of
  // the scarce kind.
  const [confirmation, clarification] = await Promise.all([
    getPendingConfirmation(env.ACCOUNTS, subjectId),
    getPending(env.ACCOUNTS, subjectId),
  ]);
  const quickReply = quickRepliesFor(confirmation, clarification);
  const styledText = options.skipPersona
    ? text
    : await applyPersona(text, env.GEMINI_API_KEY, settings, env.ACCOUNTS);
  try {
    await replyToLine(event.replyToken, styledText, env.LINE_CHANNEL_ACCESS_TOKEN, quickReply);
  } catch (err) {
    console.error("line reply failed, falling back to push", err);
    await pushToLine(pushTargetId(event.source), styledText, env.LINE_CHANNEL_ACCESS_TOKEN, quickReply);
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
// Deliberately smaller than the subrequest budget would allow (PLAN.md
// 17.68). The cron fires every minute; a drain that takes longer than that
// is still running when the next one starts, and two drains working the same
// entries upload every one of them twice. Halving the batch halves the
// window a drain is exposed to that. It costs nothing in throughput that
// matters — 5 files a minute is 300 an hour, far past any real trip — and
// the Drive check in findAlreadyUploaded is what makes an overlap harmless
// rather than merely rarer.
const DRAIN_BATCH_SIZE = 5;

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
      // With no trip open, a photo is read as a receipt instead of being
      // turned away (PLAN.md 17.76). The open trip is what decides: while
      // one is running every photo belongs to the album, which is the
      // behaviour people already rely on and the one worth not breaking.
      await replyOrPush(events[0], await handlePhotoAsReceipt(env, events, link, origin), env).catch(() => undefined);
    }
    return null;
  }
  return { refreshToken: link.refreshToken, trip };
}

/**
 * Photos sent with no trip open, read as receipts (PLAN.md 17.76, 17.81).
 *
 * Every image in the batch is read, not just the first. The first-only rule
 * this replaced was justified by "proposing five confirmations they have to
 * answer one by one would be worse than proposing none" — which was never
 * true of this codebase: promptTransactionCreate has taken an *array* of
 * drafts and confirmed them in one message since the text path needed it.
 * The machinery was there; this layer just wasn't reaching it, and four of
 * five receipts vanished with nothing said about them.
 *
 * The reading is echoed back above the confirmation, for the same reason the
 * voice transcript is (PLAN.md 17.74): the confirm step is the last thing
 * between a misread total and a wrong number in someone's accounts, and it
 * only protects someone who can see what was read.
 */
/** Said for a photo the reader could not place, one whose numbers or dates
 * could not be read, and a failed lookup alike. They mean the same thing to
 * the person holding the phone, and distinguishing them would only invite a
 * retry of a photo that will fail the same way. */
/** Each photo is its own Gemini call, so a batch is a bill as well as a wait.
 * Five is more receipts than one shopping trip produces, and the ones past it
 * are named in the reply rather than dropped. */
const MAX_RECEIPTS_PER_BATCH = 5;

const UNREADABLE_PHOTO_MESSAGE =
  'อ่านรูปนี้ไม่ออกนะ ส่งใบเสร็จ สลิปโอนเงิน หรือบัตรนัดมาได้ · ถ้าจะจดเองก็พิมพ์ได้ เช่น "ค่ากาแฟ 60" · ถ้าจะเก็บรูปเข้าอัลบั้ม พิมพ์ "เริ่มทริป <ชื่อ>" ก่อน';

async function handlePhotoAsReceipt(
  env: Env,
  events: Array<LineImageMessageEvent | LineVideoMessageEvent>,
  link: AccountLink,
  origin: string
): Promise<string> {
  const subjectId = subjectIdForSource(events[0].source);
  const images = events.filter(isImageMessageEvent);
  if (images.length === 0) {
    return 'ยังไม่ได้เริ่มทริปอยู่เลย พิมพ์ "เริ่มทริป <ชื่อ>" ก่อนนะ แล้วค่อยส่งคลิปตามมาได้เลย';
  }
  const batch = images.slice(0, MAX_RECEIPTS_PER_BATCH);
  const overflow = images.length - batch.length;
  try {
    // One Gemini call per photo, run together rather than one after another:
    // five sequential reads is most of a minute of staring at a phone.
    const readings = await Promise.all(
      batch.map(async (image) => {
        try {
          const media = await readLineImage(image.message.id, env.LINE_CHANNEL_ACCESS_TOKEN);
          if (!media) return null;
          return await readImage(media, env.GEMINI_API_KEY, env.ACCOUNTS);
        } catch (err) {
          // One unreadable photo must not take down the others it was sent
          // with — the same allSettled reasoning gmail.ts's listRecentEmails
          // uses for a message that vanishes mid-read.
          console.error("handlePhotoAsReceipt: reading one photo failed, skipping it", err);
          return null;
        }
      })
    );
    const money = readings.filter((r): r is MoneyReading => r?.kind === "expense" || r?.kind === "income");
    const appointments = readings.filter((r): r is AppointmentReading => r?.kind === "appointment");
    const unreadable = readings.filter((r) => r === null).length;

    // Said whatever else happened. Photos that quietly did nothing were the
    // whole complaint: four of five receipts used to disappear in silence.
    const leftovers: string[] = [];
    if (overflow > 0) leftovers.push(`อีก ${overflow} รูปยังไม่ได้อ่าน ส่งตามมาอีกรอบได้`);
    if (unreadable > 0) leftovers.push(`อ่านไม่ออก ${unreadable} รูป`);
    const withLeftovers = (body: string, extra: string[] = []) =>
      [body, ...extra, ...leftovers].filter((s) => s !== "").join("\n");

    // Every branch below ends in the ordinary confirm step for whatever it
    // read, so a photo is a way of *filling in* an existing feature rather
    // than a feature of its own with its own rules.
    if (money.length > 0) {
      // Money wins a mixed batch: there is one pending slot, and the
      // appointment path is the one that can be redone a card at a time.
      const apptNote =
        appointments.length > 0 ? [`📅 มีบัตรนัด ${appointments.length} ใบด้วย ส่งมาทีละใบนะ`] : [];
      const drafts = money.map((r) => ({
        amount: r.amount,
        type: r.kind,
        categoryId: r.categoryId,
        note: r.merchant || (r.kind === "income" ? "เงินเข้า" : "ใบเสร็จ"),
      }));
      const prompt = await promptTransactionCreate(
        { kv: env.ACCOUNTS, lineUserId: subjectId },
        drafts,
        `(รูป) ${drafts.map((d) => `${d.note} ${d.amount}`).join(", ")}`,
        // Personal mode only — handlePhotoAsReceipt is reached behind an
        // `!isGroup` guard, so there is no group member to resolve.
        { addedBy: subjectId, addedByName: "LINE" }
      );
      // promptTransactionCreate already lists every draft when there is more
      // than one, so echoing the reading above it would only say it twice.
      if (drafts.length > 1) return withLeftovers(`🧾 อ่านได้ ${drafts.length} รูป\n\n${prompt}`, apptNote);
      const only = money[0];
      const label = only.kind === "income" ? "💰 อ่านสลิปเงินเข้าได้" : "🧾 อ่านใบเสร็จได้";
      const from = only.merchant ? ` จาก ${only.merchant}` : "";
      return withLeftovers(`${label} ${formatBaht(only.amount)} บาท${from}\n\n${prompt}`, apptNote);
    }

    if (appointments.length > 0) {
      const reading = appointments[0];
      const rest = appointments.length > 1 ? [`📅 อีก ${appointments.length - 1} ใบส่งตามมาทีละใบนะ`] : [];
      // Everything but the time was legible, so ask for the one missing
      // piece instead of throwing the whole card away (PLAN.md 17.80).
      // Refusing here made someone retype a subject and a date the bot had
      // already read correctly.
      if (reading.time === "") {
        await setPending(env.ACCOUNTS, subjectId, {
          kind: "appointmentTime",
          title: reading.title,
          dateKey: reading.dateKey,
        });
        return withLeftovers(
          `📅 อ่านบัตรนัดได้: ${reading.title} วันที่ ${formatThaiDateLabel(reading.dateKey)}\nแต่อ่านเวลานัดไม่ออก นัดกี่โมงคะ? (ตอบเช่น "09:30" หรือ "บ่าย 2")`,
          rest
        );
      }
      const prompt = await withFreshAccessToken(env, link.refreshToken, (accessToken) =>
        promptCalendarCreateFromDraft(makeActionCtxFactory(env, subjectId, link, origin)(accessToken), {
          title: reading.title,
          dateKey: reading.dateKey,
          time: reading.time,
        })
      );
      return withLeftovers(`📅 อ่านบัตรนัดได้: ${reading.title}\n\n${prompt}`, rest);
    }

    return UNREADABLE_PHOTO_MESSAGE;
  } catch (err) {
    console.error("handlePhotoAsReceipt failed", err);
    return UNREADABLE_PHOTO_MESSAGE;
  }
}

/**
 * A voice note, handled by turning it into text and then doing nothing
 * special with it (PLAN.md 17.74).
 *
 * The transcript is fed straight into handleTextMessage, so speaking
 * "ค่ากาแฟ 60" is the same event as typing it: same interpreter, same
 * confirm-before-save, same everything. Every feature this bot has works by
 * voice without any of them being told about audio.
 *
 * The transcript is echoed back above the answer. A misheard number is a
 * wrong amount in someone's accounts, and the confirm step can only protect
 * against that if the user can see what was heard — "60" misheard as "16"
 * produces a perfectly confident, perfectly wrong confirmation otherwise.
 */
async function handleAudioMessage(env: Env, event: LineAudioMessageEvent, origin: string): Promise<string> {
  const subjectId = subjectIdForSource(event.source);
  try {
    const transcript = await transcribeVoiceMessage(
      event.message.id,
      env.LINE_CHANNEL_ACCESS_TOKEN,
      env.GEMINI_API_KEY,
      env.ACCOUNTS
    );
    // Nothing heard is said plainly rather than guessed at. Acting on words
    // nobody spoke is the worst failure available to a bot that records
    // money.
    if (!transcript) {
      return "ฟังข้อความเสียงไม่ออกเลย ลองพูดใหม่อีกทีหรือพิมพ์มาก็ได้นะ";
    }
    const reply = await handleTextMessage(env, subjectId, transcript, origin);
    return `🎤 "${transcript}"\n\n${reply}`;
  } catch (err) {
    console.error("handleAudioMessage failed", err);
    return "ตอนนี้ฟังข้อความเสียงไม่ได้ ลองพิมพ์มาแทนได้นะ";
  }
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
function stripBotNameMention(text: string, botName: string): string | null {
  const index = text.indexOf(botName);
  if (index === -1) return null;
  return (text.slice(0, index) + text.slice(index + botName.length)).trim();
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
        // The group's own settings, since the name it answers to is the
        // group's to change (PLAN.md 17.48). Read before deciding whether
        // the message is even addressed to the bot, so a renamed bot starts
        // answering to the new name immediately.
        const groupSettings = await getBotSettings(env.ACCOUNTS, subjectIdForSource(event.source));
        const text = selfMention
          ? stripSelfMention(event.message.text, selfMention)
          : stripBotNameMention(event.message.text, groupSettings.botName);
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
    } else if (isAudioMessageEvent(event)) {
      await replyOrPush(event, await handleAudioMessage(env, event, origin), env, { skipPersona: true });
    } else if (isUnsupportedMessageEvent(event)) {
      await replyOrPush(event, "ขอโทษด้วย ไฟล์ประเภทนี้ยังไม่รองรับนะ ตอนนี้รองรับแค่รูปภาพ วิดีโอ และข้อความเสียง", env);
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

/**
 * The subset of a drain batch that is already in Drive.
 *
 * Best-effort by design: a failed lookup returns an empty set, so the drain
 * behaves exactly as it did before this check existed rather than stalling a
 * whole batch over a Drive hiccup. A duplicate is a nuisance; a photo that
 * never uploads is not.
 */
async function findAlreadyUploaded(env: Env, entries: QueueEntry[]): Promise<Set<string>> {
  const byFolder = new Map<string, { lineUserId: string; messageIds: string[] }>();
  for (const { job } of entries) {
    const group = byFolder.get(job.tripFolderId) ?? { lineUserId: job.lineUserId, messageIds: [] };
    group.messageIds.push(job.messageId);
    byFolder.set(job.tripFolderId, group);
  }

  const uploaded = new Set<string>();
  for (const [folderId, { lineUserId, messageIds }] of byFolder) {
    try {
      const link = await getAccountLink(env.ACCOUNTS, lineUserId);
      if (!link) continue;
      const found = await withFreshAccessToken(env, link.refreshToken, (accessToken) =>
        findUploadedMessageIds(accessToken, folderId, messageIds)
      );
      for (const id of found) uploaded.add(id);
    } catch (err) {
      console.error("upload queue: checking Drive for already-uploaded files failed", folderId, err);
    }
  }
  return uploaded;
}

// Called on the cron trigger configured in wrangler.toml (see
// DRAIN_BATCH_SIZE above for the full story of why this exists). Each firing
// is its own Worker invocation with its own
// fresh subrequest/CPU budget, so working through a big backlog a bounded
// amount at a time — rather than trying to force it all through one webhook
// call's budget — is what actually gets every file uploaded reliably.
export async function drainUploadQueue(env: Env, now: Date = new Date()): Promise<void> {
  // Most ticks stop here on a single KV read rather than a list (PLAN.md
  // 17.66) — see uploadQueue.ts's QUEUE_PENDING_KEY for why the cheap
  // question is worth asking first.
  const { scan, flagged } = await shouldScanQueue(env.ACCOUNTS, now);
  if (!scan) return;

  const { entries, truncated } = await listQueueBatch(env.ACCOUNTS, DRAIN_BATCH_SIZE);
  if (entries.length === 0) {
    // Only when the flag was actually set — on a sweep of an already-empty
    // queue there is nothing to clear, and deleting a key that isn't there
    // still spends one of the 1,000 daily deletes.
    if (flagged) await clearQueuePending(env.ACCOUNTS);
    return;
  }

  const tokenCache: TokenCache = new Map();
  // Keyed by lineUserId *and* tripFolderId, not lineUserId alone — a batch
  // can span two different trips for the same person/group (e.g. a group
  // closes one trip and opens another between drains, or right around the
  // same drain), and collapsing them into one summary would both merge
  // unrelated succeeded/failed counts and report the wrong trip name for
  // whichever files didn't belong to the last-processed job.
  const summaries = new Map<string, DrainUserSummary>();

  // One Drive lookup for the whole batch, before any of it is uploaded:
  // which of these files are already in their trip folder? See
  // findUploadedMessageIds for why KV alone cannot answer this.
  const alreadyUploaded = await findAlreadyUploaded(env, entries);

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
      // Already in Drive — uploading again is exactly how a duplicate gets
      // made, so drop the queue entry and say nothing. Not counted as
      // succeeded: the drain that actually uploaded it already told the
      // user, and counting it twice would inflate the very totals that made
      // this bug visible.
      if (alreadyUploaded.has(job.messageId)) {
        console.log(`upload queue: ${job.messageId} is already in Drive, skipping`);
        continue;
      }
      const link = await getAccountLink(env.ACCOUNTS, job.lineUserId);
      // A missing link means this file cannot be uploaded at all (the
      // account was unlinked while the file sat in the queue) — it must
      // count as a failure, not a success. Counting it as succeeded, as an
      // earlier version did, told the user "✅ อัปโหลดเพิ่ม N ไฟล์แล้ว" while
      // the `finally` below dropped the queue entry, silently losing the
      // photo with no way to notice, let alone recover it.
      if (!link) throw new Error(`no account link for ${job.lineUserId}, cannot upload ${job.messageId}`);
      await withFreshAccessToken(
        env,
        link.refreshToken,
        (accessToken) =>
          uploadTripMedia(env, accessToken, job.tripFolderId, job.messageId, job.timestampMs, job.kind),
        tokenCache
      );
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
  // mislabeled combined one.
  //
  // Whether anything is left comes from the listing this drain already did,
  // not from a fresh count (PLAN.md 17.67). Counting afterwards asked KV a
  // question it cannot answer honestly: the entries were deleted seconds
  // earlier and `list` can still return deleted keys for up to a minute, so
  // the count included ghosts and the bot said "เหลืออีก 4 ไฟล์" with an
  // empty queue. `truncated` is a fact about the page that was read, needs
  // no extra list operation, and cannot drift.
  //
  // It is a whole-queue signal rather than a per-trip one, so in the rare
  // two-trip batch both pushes say the same thing — the same cosmetic
  // wrinkle the old count had, and still far better than a wrong number.
  for (const summary of summaries.values()) {
    const parts = [`✅ อัปโหลดเพิ่ม ${summary.succeeded} ไฟล์เข้าทริป "${summary.tripName}" แล้ว`];
    if (summary.failed > 0) {
      parts.push(`(อีก ${summary.failed} ไฟล์อัปโหลดไม่สำเร็จ ลองส่งใหม่อีกครั้งได้นะ)`);
    }
    // No number on the "more coming" side on purpose: the only count
    // available here is the stale one this change exists to remove.
    parts.push(truncated ? `ยังมีอีก กำลังทยอยอัปโหลดต่อให้นะ` : `อัปโหลดครบทุกไฟล์แล้ว`);
    // pushTarget, not lineUserId — a group's push target is the real
    // groupId, not the synthesized "group:<groupId>" subject id lineUserId
    // holds in that case (see QueuedUpload's own comment).
    const summarySettings = await getBotSettings(env.ACCOUNTS, summary.lineUserId);
    const styledSummary = await applyPersona(parts.join(" "), env.GEMINI_API_KEY, summarySettings, env.ACCOUNTS);
    await pushToLine(summary.pushTarget, styledSummary, env.LINE_CHANNEL_ACCESS_TOKEN).catch((err) =>
      console.error("drain summary push failed", err)
    );
  }
}

// Every route below already handles its own *expected* failures (an
// unreadable spreadsheet, a Drive hiccup, an expired token) with a worded
// Thai page. This is the net under the unexpected ones: without it any
// escaping exception becomes Cloudflare's bare "Internal Server Error",
// which a real user reads as "the whole bot is broken" rather than "that
// one link didn't work". Kept deliberately generic — anything specific
// enough to word better belongs in the route that knows what happened.
const UNEXPECTED_ERROR_MESSAGE = "เกิดข้อผิดพลาดที่ไม่คาดคิด ลองใหม่อีกครั้งนะ ถ้ายังไม่ได้ให้แจ้งผู้ดูแลบอท";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.error("unhandled error while routing request", new URL(request.url).pathname, err);
      return html(renderErrorPage("เกิดข้อผิดพลาด", UNEXPECTED_ERROR_MESSAGE), 500);
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Both of these run on the same once-a-minute cron and both open by
    // deciding they have nothing to do — broadcastMorningBriefings on a clock
    // check costing no KV at all (PLAN.md 17.21), drainUploadQueue on a single
    // KV read (PLAN.md 17.66). The minute granularity exists for the 07:00
    // briefing; the drain is what has to be cheap enough to ride along.
    ctx.waitUntil(drainUploadQueue(env));
    ctx.waitUntil(broadcastMorningBriefings(env, env.ACCOUNTS));
  },
};

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  // Public and tokenless, like /view/help — a LINE or Google reviewer has to
  // be able to open these without a LINE account (PLAN.md 17.53). Kept at the
  // root rather than under /view/ so the URLs are short enough to paste into
  // a verification form and read back.
  if (url.pathname === "/privacy") return handlePrivacyRequest(env);
  if (url.pathname === "/privacy/en") return handlePrivacyRequest(env, "en");
  if (url.pathname === "/terms") return handleTermsRequest(env);
  if (url.pathname === "/terms/en") return handleTermsRequest(env, "en");

  if (url.pathname === "/oauth/callback") return handleOAuthCallback(request, env);
  if (url.pathname === "/view") return handleViewAccountsRequest(request, env);
  if (url.pathname === "/view/budgets") return handleViewBudgetsRequest(request, env);
  if (url.pathname === "/view/calendar") return handleViewCalendarRequest(request, env);
  if (url.pathname === "/view/diary") return handleViewDiaryRequest(request, env);
  // No token, no env — the guide is the same for everyone and holds no
  // account data (see viewHelpPage.ts).
  if (url.pathname === "/view/help") return handleViewHelpRequest(env);
  if (url.pathname === "/view/movies") return handleViewMoviesRequest(request, env);
  if (url.pathname === "/view/search") return handleViewSearchRequest(request, env);
  if (url.pathname === "/view/settings") return handleViewSettingsRequest(request, env);
  if (url.pathname === "/view/shifts") return handleViewShiftsRequest(request, env);
  if (url.pathname === "/view/tasks") return handleViewTasksRequest(request, env);
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
}
