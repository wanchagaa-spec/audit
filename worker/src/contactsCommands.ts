// Contact lookup + name-to-email resolution (PLAN.md 17.34): "อีเมลของ<ชื่อ>"
// looks up a contact directly; resolveEmailRecipient is used by
// gmailCommands.ts so "ส่งอีเมล ถึง <ชื่อ>" can accept a name instead of a
// full email address. Read-only — this never writes to the user's Google
// Contacts, and (like Places search) never confirms-before-anything on its
// own, since a lookup alone changes nothing; the actual write it feeds into
// (sending an email) still goes through its own confirm-before-send step.

import { EMAIL_RE } from "./gmail.ts";
import { listContacts } from "./contacts.ts";
import type { ActionCtx } from "./state.ts";

type Handler = (ctx: ActionCtx) => Promise<string>;

async function findMatchingContacts(accessToken: string, nameQuery: string) {
  const contacts = await listContacts(accessToken);
  return contacts.filter((c) => c.name.includes(nameQuery));
}

export async function answerContactEmail(ctx: ActionCtx, nameQuery: string): Promise<string> {
  const matches = await findMatchingContacts(ctx.accessToken, nameQuery);
  if (matches.length === 0) return `ไม่พบผู้ติดต่อชื่อ "${nameQuery}" เลยนะ`;
  if (matches.length > 1) {
    return [`พบหลายคนที่ชื่อมี "${nameQuery}" พิมพ์ให้เจาะจงกว่านี้หน่อยนะ:`, ...matches.map((c) => `- ${c.name}`)].join("\n");
  }
  const [contact] = matches;
  if (!contact.email) return `เจอ "${contact.name}" แล้ว แต่ไม่มีอีเมลบันทึกไว้ในรายชื่อผู้ติดต่อเลยนะ`;
  return `อีเมลของ ${contact.name}: ${contact.email}`;
}

const EMAIL_LOOKUP_RE = /^อีเมลของ(.+)$/;

export async function matchContactsCommand(text: string): Promise<Handler | null> {
  const trimmed = text.trim();
  const m = trimmed.match(EMAIL_LOOKUP_RE);
  if (!m) return null;
  const nameQuery = m[1].trim();
  if (!nameQuery) return null;
  return (ctx) => answerContactEmail(ctx, nameQuery);
}

/** Resolves a "ถึง <token>" recipient for email sending — a literal email
 * address is used as-is; anything else is treated as a contact name and
 * resolved via the same client-side lookup as answerContactEmail (same
 * "found exactly one, or ask to disambiguate" shape as
 * findExactlyOneTask/findExactlyOne in the other command modules). Never
 * guesses — an unmatched or ambiguous name returns a message asking for
 * clarification instead of a resolved address, so a bad match can never
 * silently become the confirm-before-send prompt's recipient. */
export async function resolveEmailRecipient(
  accessToken: string,
  token: string
): Promise<{ email: string } | { message: string }> {
  if (EMAIL_RE.test(token)) return { email: token };
  const matches = await findMatchingContacts(accessToken, token);
  if (matches.length === 0) {
    return { message: `ไม่พบผู้ติดต่อชื่อ "${token}" เลยนะ ลองพิมพ์อีเมลเต็มๆ แทนได้` };
  }
  if (matches.length > 1) {
    return {
      message: [
        `พบหลายคนที่ชื่อมี "${token}" พิมพ์ให้เจาะจงกว่านี้ หรือพิมพ์อีเมลเต็มๆ แทน:`,
        ...matches.map((c) => `- ${c.name}`),
      ].join("\n"),
    };
  }
  const [contact] = matches;
  if (!contact.email) {
    return { message: `เจอ "${contact.name}" แล้ว แต่ไม่มีอีเมลบันทึกไว้เลยนะ ลองพิมพ์อีเมลเต็มๆ แทน` };
  }
  return { email: contact.email };
}
