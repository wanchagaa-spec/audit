// "เปิดเว็บดูข้อมูล" (PLAN.md 16) — mints a short-lived signed link to the
// read-only web viewer instead of requiring a separate Google sign-in in
// the browser. No new Google consent, no LIFF (PLAN.md 14.2 already ruled
// LIFF out for this exact reason: its userId doesn't match the Messaging
// API userId this bot actually keys everything on) — just the same
// HMAC-signed-token pattern already used for the OAuth `state` param, now
// scoped to "view" (see signedState.ts's top comment for why the purpose
// tag matters here).

import { groupIdFromSubject } from "./groupSubject.ts";
import { signViewToken } from "./signedState.ts";
import type { Env } from "./index.ts";

const VIEW_LINK_TRIGGER = "เปิดเว็บดูข้อมูล";

export function matchViewLinkCommand(text: string): boolean {
  return text.trim() === VIEW_LINK_TRIGGER;
}

// A direct link to the settings page (PLAN.md 17.50), so the rich menu can
// hold a tile for it — a tap just sends this text as an ordinary message,
// so the tile needs a phrase the bot actually understands.
//
// Whole phrases, not a substring test, for the reason this codebase keeps
// relearning: "ตั้งค่า" would otherwise sit inside plenty of ordinary
// sentences. It does *not* collide with the "ตั้งงบ"/"ตั้งจังหวัด" prefixes
// either way, but exact matching is what keeps that true if someone adds a
// "ตั้งค่าเริ่มต้น..." command later.
const SETTINGS_LINK_TRIGGERS = ["ตั้งค่า", "การตั้งค่า", "ตั้งค่าบอท", "settings"];

export function matchSettingsLinkCommand(text: string): boolean {
  return SETTINGS_LINK_TRIGGERS.includes(text.trim().toLowerCase());
}

export async function buildSettingsLinkReply(env: Env, subjectId: string, origin: string): Promise<string> {
  const token = await signViewToken(subjectId, env.STATE_SIGNING_SECRET);
  const isGroup = groupIdFromSubject(subjectId) !== null;
  // Same one-hour token as the viewer link above, and the same difference in
  // wording between a 1:1 chat and a group — but here it carries a warning
  // the read-only pages don't need: this page can wipe the book's money, and
  // in a group everyone can see the link.
  const intro = isGroup
    ? "เปิดลิงก์นี้เพื่อตั้งค่าบอทของกลุ่ม — ชื่อบอท คาแรคเตอร์ จังหวัด และล้างข้อมูลรายรับ-รายจ่าย (ใครในกลุ่มก็เปิดได้ ลิงก์ใช้ได้ 1 ชั่วโมง):"
    : "เปิดลิงก์นี้เพื่อตั้งค่าบอท — ชื่อบอท คาแรคเตอร์ ชื่อที่อยากให้เรียก จังหวัด และล้างข้อมูลรายรับ-รายจ่าย (ลิงก์ใช้ได้ 1 ชั่วโมง):";
  return [intro, `${origin}/view/settings?token=${token}`].join("\n");
}

export async function buildViewLinkReply(env: Env, subjectId: string, origin: string): Promise<string> {
  const token = await signViewToken(subjectId, env.STATE_SIGNING_SECRET);
  // Wording differs by mode: personal mode's reply lands in a 1:1 chat,
  // so "visible to you alone" is true. A group's reply posts straight into
  // the shared chat (same as every other group reply — see
  // buildGroupUnlinkedPrompt's comment for why it's never DM'd), so the
  // link is visible to, and meant for, whoever's in the group.
  const isGroup = groupIdFromSubject(subjectId) !== null;
  const intro = isGroup
    ? "เปิดลิงก์นี้เพื่อดูข้อมูลบัญชีของกลุ่มผ่านเว็บ (ใครในกลุ่มก็เปิดดูได้ ลิงก์นี้ใช้ได้ 1 ชั่วโมง หมดอายุแล้วพิมพ์คำสั่งนี้ใหม่ได้เลย):"
    : "เปิดลิงก์นี้เพื่อดูสรุปบัญชีของคุณผ่านเว็บ (เห็นได้เฉพาะคุณคนเดียว ลิงก์นี้ใช้ได้ 1 ชั่วโมง หมดอายุแล้วพิมพ์คำสั่งนี้ใหม่ได้เลย):";
  return [intro, `${origin}/view?token=${token}`].join("\n");
}
