import { handleUserMessage, isGreeting } from "../../app/src/lib/chatEngine.ts";
import { DEFAULT_CATEGORIES } from "../../app/src/data/defaultCategories.ts";
import { CalendarApiDisabledError, InsufficientCalendarScopeError } from "./calendar.ts";
import { matchCalendarCommand } from "./calendarCommands.ts";
import { matchCommand } from "./commands.ts";
import { resolveConfirmation } from "./confirmations.ts";
import { matchDiaryCommand } from "./diaryCommands.ts";
import { findOrCreateFolderCached, uploadImageToFolder } from "./drive.ts";
import { buildGoogleAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken } from "./googleAuth.ts";
import {
  fetchLineImageContent,
  isImageMessageEvent,
  isTextMessageEvent,
  replyToLine,
  verifyLineSignature,
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
} from "./state.ts";
import { bangkokDateFolderName } from "./thaiDate.ts";
import { matchTripCommand } from "./tripCommands.ts";

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
  "📸 เก็บรูปทริปอัตโนมัติ ขึ้น Google Drive แยกโฟลเดอร์ตามทริป/วันที่",
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

async function withFreshAccessToken<T>(
  env: Env,
  refreshToken: string,
  fn: (accessToken: string) => Promise<T>
): Promise<T> {
  const accessToken = await refreshAccessToken({
    refreshToken,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  });
  return fn(accessToken);
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
  origin: string
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
      const reply = await withFreshAccessToken(env, link.refreshToken, (accessToken) =>
        resolveConfirmation(actionCtx(accessToken), text, pendingConfirmation)
      );
      if (reply) return reply;
      // Not an affirmative reply — the pending question is already cleared
      // (see confirmations.ts), fall through and handle `text` normally.
    }

    const tripHandler = await matchTripCommand(text);
    if (tripHandler) {
      return await withFreshAccessToken(env, link.refreshToken, (accessToken) => tripHandler(actionCtx(accessToken)));
    }

    const calendarHandler = await matchCalendarCommand(text);
    if (calendarHandler) {
      return await withFreshAccessToken(env, link.refreshToken, (accessToken) =>
        calendarHandler(actionCtx(accessToken))
      );
    }

    const diaryHandler = await matchDiaryCommand(text);
    if (diaryHandler) {
      return await withFreshAccessToken(env, link.refreshToken, (accessToken) => diaryHandler(actionCtx(accessToken)));
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
    return withFreshAccessToken(env, link.refreshToken, (accessToken) =>
      reportHandler(accessToken, link.spreadsheetId)
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
    await withFreshAccessToken(env, link.refreshToken, (accessToken) =>
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
      })
    );
  }

  return result.botMessage;
}

export async function handleImageMessage(
  env: Env,
  lineUserId: string,
  messageId: string,
  timestampMs: number,
  origin: string
): Promise<string> {
  const link = await getAccountLink(env.ACCOUNTS, lineUserId);
  if (!link) return buildUnlinkedPrompt(env, lineUserId, origin);

  const trip = await getActiveTrip(env.ACCOUNTS, lineUserId);
  if (!trip) {
    return 'ยังไม่ได้เริ่มทริปอยู่เลย พิมพ์ "เริ่มทริป <ชื่อ>" ก่อนนะ แล้วค่อยส่งรูปตามมาได้เลย';
  }

  return withFreshAccessToken(env, link.refreshToken, async (accessToken) => {
    const { bytes, contentType } = await fetchLineImageContent(messageId, env.LINE_CHANNEL_ACCESS_TOKEN);
    const dateFolder = bangkokDateFolderName(timestampMs);
    const dayFolderCacheKey = `dayfolder:${lineUserId}:${trip.folderId}:${dateFolder}`;
    const dayFolderId = await findOrCreateFolderCached(
      accessToken,
      env.ACCOUNTS,
      dayFolderCacheKey,
      dateFolder,
      trip.folderId
    );
    const ext = contentType.includes("png") ? "png" : "jpg";
    await uploadImageToFolder(accessToken, dayFolderId, `${messageId}.${ext}`, bytes, contentType);
    return `📸 เก็บรูปในทริป "${trip.name}" วันที่ ${dateFolder} แล้ว`;
  });
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");
  const valid = await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET);
  if (!valid) return new Response("invalid signature", { status: 401 });

  const body = JSON.parse(rawBody) as LineWebhookBody;
  const origin = new URL(request.url).origin;

  for (const event of body.events) {
    try {
      if (isTextMessageEvent(event)) {
        const reply = await handleTextMessage(env, event.source.userId, event.message.text, origin);
        await replyToLine(event.replyToken, reply, env.LINE_CHANNEL_ACCESS_TOKEN);
      } else if (isImageMessageEvent(event)) {
        const reply = await handleImageMessage(
          env,
          event.source.userId,
          event.message.id,
          event.timestamp,
          origin
        );
        await replyToLine(event.replyToken, reply, env.LINE_CHANNEL_ACCESS_TOKEN);
      }
    } catch (err) {
      if (isTextMessageEvent(event) || isImageMessageEvent(event)) {
        await replyToLine(
          event.replyToken,
          "ขอโทษด้วย เกิดข้อผิดพลาดตอนบันทึก ลองใหม่อีกครั้งนะ",
          env.LINE_CHANNEL_ACCESS_TOKEN
        ).catch(() => undefined);
      }
      console.error("webhook handling failed", err);
    }
  }

  return new Response("ok");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/oauth/callback") return handleOAuthCallback(request, env);
    if (url.pathname === "/webhook" && request.method === "POST") return handleWebhook(request, env);
    if (url.pathname === "/health") return new Response("ok");

    return new Response("not found", { status: 404 });
  },
};
