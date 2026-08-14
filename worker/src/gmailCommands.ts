// Gmail chat commands (PLAN.md 17.28): "เช็คอีเมล" / "ส่งอีเมล ถึง ... เรื่อง
// ... ข้อความ ...". Sending always confirms first, same discipline as every
// other write action in this bot — with an explicit "ส่งแล้วเรียกคืนไม่ได้"
// warning in the prompt, since email is the one action here that leaves the
// bot's own system the moment it's confirmed (a wrong calendar event or task
// can just be deleted again; a sent email can't be unsent).

import { EMAIL_RE, listRecentEmails, sendEmail } from "./gmail.ts";
import { setPendingConfirmation, type ActionCtx } from "./state.ts";

type Handler = (ctx: ActionCtx) => Promise<string>;

export interface EmailDraft {
  to: string;
  subject: string;
  body: string;
}

export async function answerEmailCheck(ctx: ActionCtx): Promise<string> {
  const emails = await listRecentEmails(ctx.accessToken, { unreadOnly: true, maxResults: 5 });
  if (emails.length === 0) return "ไม่มีอีเมลใหม่ที่ยังไม่ได้อ่านเลยนะ";
  const lines = emails.map((e, i) => `${i + 1}. จาก: ${e.from}\n   เรื่อง: ${e.subject}\n   ${e.snippet}`);
  return ["อีเมลใหม่ที่ยังไม่ได้อ่าน:", ...lines].join("\n");
}

export async function promptEmailSend(ctx: ActionCtx, draft: EmailDraft): Promise<string> {
  await setPendingConfirmation(ctx.kv, ctx.lineUserId, { kind: "emailSend", ...draft });
  return [
    `จะส่งอีเมลถึง: ${draft.to}`,
    `เรื่อง: ${draft.subject}`,
    "---",
    draft.body,
    "---",
    'ส่งเลยใช่ไหม? ส่งแล้วเรียกคืนไม่ได้นะ (พิมพ์ "ใช่" เพื่อยืนยัน)',
  ].join("\n");
}

const CHECK_PHRASES = ["เช็คอีเมล", "เช็คเมล", "อีเมลใหม่", "มีอีเมลใหม่ไหม", "มีเมลใหม่ไหม"];

export async function matchGmailCommand(text: string): Promise<Handler | null> {
  const trimmed = text.trim();

  if (CHECK_PHRASES.includes(trimmed)) {
    return (ctx) => answerEmailCheck(ctx);
  }

  if (/^ส่งอีเมล(\s|$)/.test(trimmed)) {
    const m = trimmed.match(/^ส่งอีเมล\s+ถึง\s+(\S+)\s+เรื่อง\s+(.+?)\s+ข้อความ\s+(.+)$/s);
    if (!m) {
      return async () =>
        'รูปแบบไม่ถูกต้องนะ ลองพิมพ์แบบ "ส่งอีเมล ถึง someone@email.com เรื่อง หัวข้อที่จะส่ง ข้อความ เนื้อหาอีเมล" ดู';
    }
    const [, to, subject, body] = m;
    if (!EMAIL_RE.test(to)) {
      return async () => `ที่อยู่อีเมล "${to}" ดูไม่ถูกต้องนะ ลองเช็คอีกทีดู`;
    }
    return (ctx) => promptEmailSend(ctx, { to, subject: subject.trim(), body: body.trim() });
  }

  return null;
}

export async function applyEmailSend(ctx: ActionCtx, pending: EmailDraft): Promise<string> {
  await sendEmail(ctx.accessToken, pending.to, pending.subject, pending.body);
  return `ส่งอีเมลถึง ${pending.to} เรื่อง "${pending.subject}" แล้วนะ`;
}
