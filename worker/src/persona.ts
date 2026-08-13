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

const PERSONA_SYSTEM_INSTRUCTION = [
  "คุณคือคาแรคเตอร์แชทบอทผู้หญิงน่ารัก อายุ 23 ปี ชอบสีชมพู กำลังเรียนภาษาญี่ปุ่นอยู่",
  "หน้าที่ของคุณคือเรียบเรียงข้อความที่ได้รับมาใหม่ด้วยน้ำเสียงของคาแรคเตอร์นี้ สดใส น่ารัก เป็นกันเอง แทรกอีโมจิที่เข้ากับคาแรคเตอร์ได้บ้าง (เช่น 🌸💗✨) แต่พอดี ไม่เยอะจนอ่านยาก",
  "กฎที่ห้ามฝ่าฝืนเด็ดขาด: ห้ามเปลี่ยนตัวเลข จำนวนเงิน วันที่ เวลา ชื่อหมวดหมู่ ลิงก์ หรือข้อเท็จจริงใดๆ ในข้อความเดิม ต้องคงไว้เป๊ะทุกตัวอักษร ห้ามเพิ่มข้อมูลใหม่ที่ไม่มีในข้อความเดิม ห้ามตัดข้อมูลสำคัญออก ห้ามเปลี่ยนความหมาย แค่ปรับน้ำเสียงการพูดเท่านั้น",
  // Some replies are asking the user to type an exact word back (e.g. a
  // confirmation prompt ending in '(พิมพ์ "ใช่" เพื่อยืนยัน)') — the system
  // that reads the reply back only recognizes a fixed set of words, so
  // rephrasing this instruction (even just dropping the quotes, or
  // suggesting a different word) can make a user's correct answer fail to
  // register.
  "ถ้าข้อความมีคำสั่งหรือคำที่อยู่ในเครื่องหมายคำพูด (เช่น \"ใช่\") ที่บอกให้ผู้ใช้พิมพ์กลับมา ห้ามเปลี่ยนคำในเครื่องหมายคำพูดนั้นเด็ดขาด ต้องคงคำเดิมไว้ตรงตัวทุกตัวอักษร จะเสริมประโยคน่ารักๆ รอบๆ ได้ แต่คำในเครื่องหมายคำพูดต้องเหมือนเดิม",
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

// Any "..." span in the original text is always one of this codebase's
// instructional command words (e.g. `(พิมพ์ "ใช่" เพื่อยืนยัน)`) — never
// arbitrary user data (transaction notes/diary text never get quoted this
// way in a reply). The system instruction above tells the model not to
// touch these, but an instruction is not a guarantee — found in review:
// verify it actually didn't, rather than just trusting it did, and fall
// back to the unstyled original if even one quoted word went missing.
// isAffirmative's own exact-match check is exactly what a dropped/reworded
// "ใช่" here would silently break.
function quotedSpans(text: string): string[] {
  return text.match(/"[^"]+"/g) ?? [];
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
    return styled;
  } catch (err) {
    console.error("applyPersona failed, sending the original reply unstyled", err);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
