// "เปิดเว็บดูข้อมูล" (PLAN.md 16) — mints a short-lived signed link to the
// read-only web viewer instead of requiring a separate Google sign-in in
// the browser. No new Google consent, no LIFF (PLAN.md 14.2 already ruled
// LIFF out for this exact reason: its userId doesn't match the Messaging
// API userId this bot actually keys everything on) — just the same
// HMAC-signed-token pattern already used for the OAuth `state` param, now
// scoped to "view" (see signedState.ts's top comment for why the purpose
// tag matters here).

import { signViewToken } from "./signedState.ts";
import type { Env } from "./index.ts";

const VIEW_LINK_TRIGGER = "เปิดเว็บดูข้อมูล";

export function matchViewLinkCommand(text: string): boolean {
  return text.trim() === VIEW_LINK_TRIGGER;
}

export async function buildViewLinkReply(env: Env, lineUserId: string, origin: string): Promise<string> {
  const token = await signViewToken(lineUserId, env.STATE_SIGNING_SECRET);
  return [
    "เปิดลิงก์นี้เพื่อดูสรุปบัญชีของคุณผ่านเว็บ (เห็นได้เฉพาะคุณคนเดียว ลิงก์นี้ใช้ได้ 1 ชั่วโมง หมดอายุแล้วพิมพ์คำสั่งนี้ใหม่ได้เลย):",
    `${origin}/view?token=${token}`,
  ].join("\n");
}
