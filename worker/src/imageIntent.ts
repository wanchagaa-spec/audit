// รูปที่ส่งเข้ามาคืออะไร แล้วควรทำอะไรกับมัน (PLAN.md 17.76, ขยายใน 17.79).
//
// Started as "is this a receipt?" and became "what is this photo?". The
// change costs nothing — one Gemini call either way — and turns a photo from
// the entrance to one feature into the entrance to several. Anything the
// model cannot place is still refused rather than guessed at.
//
// The single thing that matters for money is which number becomes the
// amount. A Thai receipt carries a subtotal, VAT, a grand total, cash
// tendered and change, and four of those five are wrong. Reading
// "เงินสด 1000" off a 320-baht meal does not look like an error afterwards —
// it looks like a meal that cost a thousand baht.

import { askGemini, type GeminiInlineMedia } from "./gemini.ts";
import { DEFAULT_CATEGORIES } from "./categories.ts";
import { fetchLineMediaContent, toBase64 } from "./line.ts";

/** Well under Gemini's 20 MB request ceiling, with room for base64's third
 * on top. LINE already compresses what it forwards, so a phone photo arrives
 * far below this; what it stops is something that is not a photo at all. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const EXPENSE_CATEGORY_IDS = DEFAULT_CATEGORIES.filter((c) => c.type === "expense").map((c) => c.id);
const INCOME_CATEGORY_IDS = DEFAULT_CATEGORIES.filter((c) => c.type === "income").map((c) => c.id);

const READ_INSTRUCTION = [
  "คุณเป็นระบบอ่านรูปภาษาไทย ตอบเป็น JSON เท่านั้น",
  '{"kind":"expense"|"income"|"appointment"|"other","amount":number,"merchant":string,"categoryId":string,"title":string,"dateKey":"YYYY-MM-DD","time":"HH:MM"}',
  "",
  "kind = expense → ใบเสร็จ บิล สลิปที่**จ่ายเงินออก**",
  "kind = income → สลิป/เอกสารที่บอกชัดว่า**เงินเข้าบัญชี** เช่น สลิปเงินเดือน แจ้งเตือนเงินเข้า ใบรับเงิน",
  // The image cannot say whose account is whose, so a plain transfer slip is
  // genuinely ambiguous. Defaulting to expense is the direction that matches
  // what people photograph most (their own outgoing payment), and either way
  // the confirmation says "รายรับ"/"รายจ่าย" out loud before anything saves.
  "ถ้าเป็นสลิปโอนเงินธรรมดาที่ดูไม่ออกว่าเข้าหรือออก ให้ตอบ expense",
  "kind = appointment → บัตรนัด ใบนัดหมอ ใบนัดหมาย ที่มีวันและเวลานัดชัดเจน",
  "kind = other → อย่างอื่นทั้งหมด เช่น รูปวิว รูปคน รูปอาหาร หรืออ่านไม่ออก",
  "",
  "สำหรับ expense/income:",
  "**amount ต้องเป็นยอดที่จ่าย/รับจริงทั้งหมด** (ยอดสุทธิ/รวมทั้งสิ้น/Total/ยอดชำระ/จำนวนเงิน)",
  "**ห้าม**เอายอดก่อนภาษี ยอดภาษี เงินสดที่จ่าย หรือเงินทอน มาเป็น amount เด็ดขาด",
  "ถ้ามีทั้งยอดรวมและเงินสด/เงินทอน ให้ใช้ยอดรวมเสมอ",
  "merchant คือชื่อร้าน/ผู้โอน ถ้าไม่มีให้ใส่สตริงว่าง",
  `categoryId ของ expense เลือกจาก: ${EXPENSE_CATEGORY_IDS.join(", ")}`,
  `categoryId ของ income เลือกจาก: ${INCOME_CATEGORY_IDS.join(", ")}`,
  "",
  "สำหรับ appointment:",
  "title คือเรื่องที่นัด เช่น ชื่อคลินิก/แผนก/หมอ",
  "**dateKey ต้องเป็น ค.ศ. เสมอ** ถ้าบนบัตรเป็น พ.ศ. (เช่น 2569) ให้ลบ 543 ก่อน (2569 → 2026)",
  "time เป็น 24 ชั่วโมง เช่น 09:30 ถ้าบัตรไม่ได้ระบุเวลา ให้ตอบ kind = other",
].join("\n");

export interface MoneyReading {
  kind: "expense" | "income";
  amount: number;
  merchant: string;
  categoryId: string;
}

export interface AppointmentReading {
  kind: "appointment";
  title: string;
  dateKey: string;
  time: string;
}

export type ImageReading = MoneyReading | AppointmentReading;

export async function readLineImage(
  messageId: string,
  channelAccessToken: string
): Promise<GeminiInlineMedia | null> {
  const { body, contentType } = await fetchLineMediaContent(messageId, channelAccessToken);
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  return { mimeType: contentType.split(";")[0].trim(), data: toBase64(bytes) };
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A Buddhist-era year that slipped through the prompt.
 *
 * Thai appointment cards are printed in พ.ศ. far more often than not, and a
 * model told to convert will sometimes not. 2569 as a calendar year is not a
 * date anyone meant, and creating an event 543 years out is worse than
 * refusing — it is a real event on a real calendar that nobody will ever see
 * again.
 */
function normalizeThaiYear(dateKey: string): string {
  const year = Number(dateKey.slice(0, 4));
  if (year < 2400) return dateKey;
  return `${year - 543}${dateKey.slice(4)}`;
}

/**
 * What the photo is, or null when it is nothing this bot can act on.
 *
 * Null covers "not one of the kinds", a total that could not be read, a
 * date that could not be read, and a category the model invented. They all
 * mean the same thing to the caller — there is nothing here worth proposing
 * — and proposing something anyway would put a number nobody wrote in front
 * of a "ใช่" button.
 */
export async function readImage(
  media: GeminiInlineMedia,
  geminiApiKey: string,
  kv: KVNamespace
): Promise<ImageReading | null> {
  const raw = await askGemini(geminiApiKey, READ_INSTRUCTION, "รูปนี้คืออะไร", {
    kv,
    media,
    jsonMode: true,
    maxOutputTokens: 512,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("readImage: model did not return JSON", raw);
    return null;
  }
  const r = parsed as Record<string, unknown>;

  if (r.kind === "appointment") {
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const rawDate = typeof r.dateKey === "string" ? r.dateKey : "";
    const time = typeof r.time === "string" ? r.time : "";
    if (title === "" || !DATE_KEY_RE.test(rawDate) || !TIME_RE.test(time)) return null;
    const dateKey = normalizeThaiYear(rawDate);
    // Re-checked after the year shift, so a malformed conversion cannot
    // produce a date the calendar layer will not understand.
    if (!DATE_KEY_RE.test(dateKey)) return null;
    return { kind: "appointment", title, dateKey, time };
  }

  if (r.kind !== "expense" && r.kind !== "income") return null;
  const kind = r.kind;
  const amount = typeof r.amount === "number" ? r.amount : Number(r.amount);
  // Verified rather than trusted, the same rule aiInterpreter.ts's
  // validateIntent follows for every number the model hands back.
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const allowed = kind === "income" ? INCOME_CATEGORY_IDS : EXPENSE_CATEGORY_IDS;
  const categoryId = typeof r.categoryId === "string" ? r.categoryId : "";
  // An invented category — or a perfectly real one from the *other* side of
  // the ledger — would land the row somewhere every reader downstream treats
  // as impossible. Falls back rather than failing the whole read: the amount
  // is the part worth keeping.
  const safeCategory = allowed.includes(categoryId) ? categoryId : kind === "income" ? "other-income" : "other-expense";
  const merchant = typeof r.merchant === "string" ? r.merchant.trim() : "";
  return { kind, amount, merchant, categoryId: safeCategory };
}
