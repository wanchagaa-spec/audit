// Gmail chat commands (PLAN.md 17.28): "เช็คอีเมล" / "ส่งอีเมล ถึง ... เรื่อง
// ... ข้อความ ...". Sending always confirms first, same discipline as every
// other write action in this bot — with an explicit "ส่งแล้วเรียกคืนไม่ได้"
// warning in the prompt, since email is the one action here that leaves the
// bot's own system the moment it's confirmed (a wrong calendar event or task
// can just be deleted again; a sent email can't be unsent).

import { resolveEmailRecipient } from "./contactsCommands.ts";
import { listRecentEmails, sendEmail } from "./gmail.ts";
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

// Shared by both callers below: the regex matcher's "ถึง <token>" capture
// and aiInterpreter.ts's email_send intent (PLAN.md 17.34) — a token that's
// already a real email address is used as-is; anything else is resolved
// against the account's Google Contacts first. Either way the confirm
// prompt above always shows the final resolved address before anything is
// actually sent, so a wrong contact match still gets caught before it does
// any damage, not after.
export async function promptEmailSendResolved(ctx: ActionCtx, toToken: string, subject: string, body: string): Promise<string> {
  const resolved = await resolveEmailRecipient(ctx.accessToken, toToken);
  if ("message" in resolved) return resolved.message;
  return promptEmailSend(ctx, { to: resolved.email, subject, body });
}

const CHECK_PHRASES = ["เช็คอีเมล", "เช็คเมล", "อีเมลใหม่", "มีอีเมลใหม่ไหม", "มีเมลใหม่ไหม"];

export async function matchGmailCommand(text: string): Promise<Handler | null> {
  const trimmed = text.trim();

  if (CHECK_PHRASES.includes(trimmed)) {
    return (ctx) => answerEmailCheck(ctx);
  }

  if (/^ส่งอีเมล(\s|$)/.test(trimmed)) {
    // "ถึง <token>" is non-greedy up to "เรื่อง" (not \S+) so a multi-word
    // contact name ("สมชาย ใจดี") works the same as a plain email address —
    // resolveEmailRecipient (contactsCommands.ts) sorts out which one it is.
    const m = trimmed.match(/^ส่งอีเมล\s+ถึง\s+(.+?)\s+เรื่อง\s+(.+?)\s+ข้อความ\s+(.+)$/s);
    if (!m) {
      return async () =>
        'รูปแบบไม่ถูกต้องนะ ลองพิมพ์แบบ "ส่งอีเมล ถึง someone@email.com เรื่อง หัวข้อที่จะส่ง ข้อความ เนื้อหาอีเมล" หรือ "ส่งอีเมล ถึง ชื่อผู้ติดต่อ เรื่อง ... ข้อความ ..." ดู';
    }
    const [, toToken, subject, body] = m;
    return (ctx) => promptEmailSendResolved(ctx, toToken.trim(), subject.trim(), body.trim());
  }

  return null;
}

export async function applyEmailSend(ctx: ActionCtx, pending: EmailDraft): Promise<string> {
  await sendEmail(ctx.accessToken, pending.to, pending.subject, pending.body);
  return `ส่งอีเมลถึง ${pending.to} เรื่อง "${pending.subject}" แล้วนะ`;
}
