import { handleUserMessage } from "../../app/src/lib/chatEngine.ts";
import { DEFAULT_CATEGORIES } from "../../app/src/data/defaultCategories.ts";
import { buildGoogleAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken } from "./googleAuth.ts";
import { isTextMessageEvent, replyToLine, verifyLineSignature, type LineWebhookBody } from "./line.ts";
import { renderLiffPage, renderLinkedPage } from "./liffPage.ts";
import { appendTransaction, createBookSpreadsheet } from "./sheets.ts";
import { getAccountLink, getPending, setAccountLink, setPending } from "./state.ts";
import { signState, verifyState } from "./signedState.ts";
import { buildMonthlySummaryText, isSummaryCommand } from "./commands.ts";

export interface Env {
  ACCOUNTS: KVNamespace;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  STATE_SIGNING_SECRET: string;
  LIFF_ID: string;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function handleLinkInit(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const lineUserId = url.searchParams.get("lineUserId");
  if (!lineUserId) return new Response("missing lineUserId", { status: 400 });

  const state = await signState(lineUserId, env.STATE_SIGNING_SECRET);
  const redirectUri = `${url.origin}/oauth/callback`;
  const authorizeUrl = buildGoogleAuthorizeUrl({
    clientId: env.GOOGLE_CLIENT_ID,
    redirectUri,
    state,
  });
  return new Response(JSON.stringify({ url: authorizeUrl }), {
    headers: { "content-type": "application/json" },
  });
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

export async function handleTextMessage(
  env: Env,
  lineUserId: string,
  text: string,
  origin: string
): Promise<string> {
  const link = await getAccountLink(env.ACCOUNTS, lineUserId);
  if (!link) {
    return `ยังไม่ได้เชื่อมบัญชี Google เลย กดลิงก์นี้เพื่อเชื่อมก่อนเริ่มใช้งานนะ\n${origin}/liff`;
  }

  if (isSummaryCommand(text)) {
    return withFreshAccessToken(env, link.refreshToken, (accessToken) =>
      buildMonthlySummaryText(accessToken, link.spreadsheetId)
    );
  }

  const pending = await getPending(env.ACCOUNTS, lineUserId);
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

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");
  const valid = await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET);
  if (!valid) return new Response("invalid signature", { status: 401 });

  const body = JSON.parse(rawBody) as LineWebhookBody;
  const origin = new URL(request.url).origin;

  for (const event of body.events) {
    if (!isTextMessageEvent(event)) continue;
    try {
      const reply = await handleTextMessage(env, event.source.userId, event.message.text, origin);
      await replyToLine(event.replyToken, reply, env.LINE_CHANNEL_ACCESS_TOKEN);
    } catch (err) {
      await replyToLine(
        event.replyToken,
        "ขอโทษด้วย เกิดข้อผิดพลาดตอนบันทึก ลองใหม่อีกครั้งนะ",
        env.LINE_CHANNEL_ACCESS_TOKEN
      ).catch(() => undefined);
      console.error("webhook handling failed", err);
    }
  }

  return new Response("ok");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/liff") return html(renderLiffPage(env.LIFF_ID));
    if (url.pathname === "/link/init") return handleLinkInit(request, env);
    if (url.pathname === "/oauth/callback") return handleOAuthCallback(request, env);
    if (url.pathname === "/webhook" && request.method === "POST") return handleWebhook(request, env);
    if (url.pathname === "/health") return new Response("ok");

    return new Response("not found", { status: 404 });
  },
};
