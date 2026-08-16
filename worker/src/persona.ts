// AI persona layer (PLAN.md 17.9) — restyles every reply the bot actually
// sends to LINE in a fixed character voice, requested explicitly: a cute,
// pink-loving 23-year-old studying Japanese. Applied at the true outgoing
// boundary (replyOrPush / drainUploadQueue's push in index.ts), never
// inside handleTextMessage/handleGroupTextMessage themselves — those keep
// returning the exact deterministic text they always did (numbers computed
// by plain arithmetic, dates computed by plain code, confirmations built
// from real Sheets/Calendar data), so this only ever touches *how* an
// already-decided message is phrased, never *what* it says or *whether* to
// save something. The system instruction explicitly forbids changing any
// number/date/amount, and any failure (timeout, API error, empty response)
// falls back to the original text untouched — a persona hiccup must never
// turn into a broken, missing, or numerically wrong reply.

import { askGemini } from "./gemini.ts";

// The bot's name (requested directly) — shared with aiInterpreter.ts (so
// chitchat replies it composes are self-aware) and index.ts's group-mode
// mention gating (so calling the name in plain text, no formal LINE
// @mention required, is enough to address the bot in a group).
export const BOT_NAME = "ไพโรจน์";

const PERSONA_SYSTEM_INSTRUCTION = [
  `คุณคือคาแรคเตอร์แชทบอทชื่อ "${BOT_NAME}" ผู้หญิงน่ารัก อายุ 23 ปี ชอบสีชมพู กำลังเรียนภาษาญี่ปุ่นอยู่`,
  "หน้าที่ของคุณคือเรียบเรียงข้อความที่ได้รับมาใหม่ด้วยน้ำเสียงของคาแรคเตอร์นี้ สดใส น่ารัก เป็นกันเอง แทรกอีโมจิที่เข้ากับคาแรคเตอร์ได้บ้าง (เช่น 🌸💗✨) แต่พอดี ไม่เยอะจนอ่านยาก",
  "กฎที่ห้ามฝ่าฝืนเด็ดขาด: ห้ามเปลี่ยนตัวเลข จำนวนเงิน วันที่ เวลา ชื่อหมวดหมู่ ลิงก์ หรือข้อเท็จจริงใดๆ ในข้อความเดิม ต้องคงไว้เป๊ะทุกตัวอักษร ห้ามเพิ่มข้อมูลใหม่ที่ไม่มีในข้อความเดิม ห้ามตัดข้อมูลสำคัญออก ห้ามเปลี่ยนความหมาย แค่ปรับน้ำเสียงการพูดเท่านั้น",
  // Some replies are asking the user to type an exact word back (e.g. a
  // confirmation prompt ending in '(พิมพ์ "ใช่" เพื่อยืนยัน)') — the system
  // that reads the reply back only recognizes a fixed set of words, so
  // rephrasing this instruction (even just dropping the quotes, or
  // suggesting a different word) can make a user's correct answer fail to
  // register.
  "ถ้าข้อความมีคำสั่งหรือคำที่อยู่ในเครื่องหมายคำพูด (เช่น \"ใช่\") ที่บอกให้ผู้ใช้พิมพ์กลับมา ห้ามเปลี่ยนคำในเครื่องหมายคำพูดนั้นเด็ดขาด ต้องคงคำเดิมไว้ตรงตัวทุกตัวอักษร จะเสริมประโยคน่ารักๆ รอบๆ ได้ แต่คำในเครื่องหมายคำพูดต้องเหมือนเดิม",
  // Found in a real report: a restyled reply drifted into male pronouns
  // (ผม/ครับ) and produced garbled, barely-grammatical Thai — likely because
  // the input it was restyling (an AI-composed chitchat/unclear reply from
  // aiInterpreter.ts) was already free-form text rather than a rigid
  // deterministic string, giving the model more room to drift on a second
  // pass. Spelling the gender/pronoun rule out explicitly, and requiring
  // the result to actually be correct, readable Thai, targets that directly.
  `ใช้สรรพนาม "ฉัน" ลงท้ายประโยคด้วย "ค่ะ"/"นะคะ"/"คะ" เท่านั้น ห้ามใช้ "ผม"/"ครับ" หรือสรรพนาม/คำลงท้ายเพศชายเด็ดขาดไม่ว่ากรณีใด — ${BOT_NAME} เป็นผู้หญิงเสมอ`,
  "ผลลัพธ์ต้องเป็นประโยคภาษาไทยที่ถูกไวยากรณ์ อ่านเข้าใจง่าย ห้ามแต่งคำหรือประโยคที่ไม่มีความหมาย ถ้าไม่มั่นใจว่าจะปรับโทนยังไงให้ยังคงความถูกต้อง ให้ปรับน้อยที่สุดเท่าที่จำเป็นแทนที่จะเสี่ยงแต่งประโยคที่ผิดเพี้ยน",
  "ตอบกลับเป็นข้อความที่ปรับโทนแล้วอย่างเดียว ห้ามมีคำอธิบายหรือคำนำอื่นใดๆ ทั้งสิ้น",
].join("\n");

// A slow/hanging Gemini call must never stall an actual LINE reply for
// long — unlike the AI Q&A command (an explicit, user-initiated request,
// where waiting longer is expected), persona styling now sits in the path
// of *every* reply, including time-sensitive ones like a reply-token race
// (see replyOrPush's own comment on why that race matters). Kept short
// (well under LINE's reply-token window) so persona styling can only ever
// add a small, bounded delay before falling back to the unstyled text —
// never turn into the reason a reply misses its token.
const PERSONA_TIMEOUT_MS = 2500;

// A "..." span in the original text is usually one of this codebase's
// instructional command words (e.g. `(พิมพ์ "ใช่" เพื่อยืนยัน)`), and those
// are the ones that actually matter here — isAffirmative's own exact-match
// check is precisely what a dropped or reworded "ใช่" would silently break.
// Some spans are user/AI data rather than an instruction (an email subject
// in gmailCommands.ts, a place keyword in placesCommands.ts, a province
// name in greetingCommands.ts); those don't need protecting, but they cost
// nothing to include and telling the two apart reliably isn't worth the
// machinery. The system instruction above tells the model not to touch any
// of this, but an instruction is not a guarantee — verify, don't trust.
function quotedSpans(text: string): string[] {
  return text.match(/"[^"]+"/g) ?? [];
}

// Links get the same verify-don't-trust treatment as quoted spans above,
// and for a sharper reason: travel search (PLAN.md 17.37) and nearby-place
// search (17.30) build replies whose *entire point* is the URLs — travel's
// own header comment puts it as "the links are the product, the prices are
// decoration". Those replies contain no quoted spans at all, so the check
// above gave them zero coverage, while they're also the longest replies the
// bot sends (a five-offer flight reply runs ~600 characters of mostly Thai
// text plus two long URLs, close enough to gemini.ts's maxOutputTokens that
// a truncated restyling is a live possibility, quite apart from the model
// simply rewriting a link). Either way the result is a reply that looks
// fine and whose links are broken — the one failure this feature cannot
// degrade to. A URL that didn't survive verbatim means fall back.
//
// Matches greedily to whitespace, exactly how these URLs are laid out in
// the replies that build them (one per line, or after "• Google Flights: ").
function urlSpans(text: string): string[] {
  return text.match(/https?:\/\/\S+/g) ?? [];
}

export async function applyPersona(text: string, geminiApiKey: string): Promise<string> {
  if (!text.trim()) return text;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PERSONA_TIMEOUT_MS);
  try {
    const styled = await askGemini(geminiApiKey, PERSONA_SYSTEM_INSTRUCTION, text, controller.signal);
    const missingQuote = quotedSpans(text).some((q) => !styled.includes(q));
    if (missingQuote) {
      console.error("applyPersona dropped or reworded a quoted instruction, sending the original reply unstyled");
      return text;
    }
    const missingUrl = urlSpans(text).some((u) => !styled.includes(u));
    if (missingUrl) {
      console.error("applyPersona dropped or altered a link, sending the original reply unstyled");
      return text;
    }
    return styled;
  } catch (err) {
    console.error("applyPersona failed, sending the original reply unstyled", err);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
