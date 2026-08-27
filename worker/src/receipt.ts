// รูปใบเสร็จ → รายจ่าย (PLAN.md 17.76).
//
// Photos already had a home — the trip album — but only while a trip is
// open. Outside one, a photo got "ยังไม่ได้เริ่มทริปอยู่เลย" and was thrown
// away. That is the gap this fills: with no trip open, a photo is read as a
// receipt and proposed as an expense, through the same confirm step typed
// expenses go through.
//
// The single thing that matters here is which number becomes the amount. A
// Thai receipt carries a subtotal, VAT, a grand total, cash tendered and
// change, and four of those five are wrong. Reading "เงินสด 1000" off a
// 320-baht meal does not look like an error afterwards — it looks like a
// meal that cost a thousand baht.

import { askGemini, type GeminiInlineMedia } from "./gemini.ts";
import { DEFAULT_CATEGORIES } from "./categories.ts";
import { fetchLineMediaContent, toBase64 } from "./line.ts";

/** Well under Gemini's 20 MB request ceiling, with room for base64's third
 * on top. LINE already compresses what it forwards, so a phone photo arrives
 * far below this; what it stops is something that is not a photo at all. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const EXPENSE_CATEGORY_IDS = DEFAULT_CATEGORIES.filter((c) => c.type === "expense").map((c) => c.id);

const READ_INSTRUCTION = [
  "คุณเป็นระบบอ่านใบเสร็จภาษาไทย ตอบเป็น JSON เท่านั้น",
  '{"amount":number,"merchant":string,"categoryId":string,"isReceipt":boolean}',
  "",
  "**amount ต้องเป็นยอดที่จ่ายจริงทั้งหมด** (ยอดสุทธิ/รวมทั้งสิ้น/Total/Grand Total/ยอดชำระ)",
  "**ห้าม**เอายอดก่อนภาษี ยอดภาษี เงินสดที่จ่าย หรือเงินทอน มาเป็น amount เด็ดขาด",
  "ถ้ามีทั้งยอดรวมและเงินสด/เงินทอน ให้ใช้ยอดรวมเสมอ",
  "",
  "merchant คือชื่อร้าน ถ้าไม่มีให้ใส่สตริงว่าง",
  `categoryId ต้องเลือกจาก: ${EXPENSE_CATEGORY_IDS.join(", ")}`,
  "",
  "isReceipt = false ถ้ารูปนี้ไม่ใช่ใบเสร็จ/สลิป/บิล เช่น รูปวิว รูปคน รูปอาหาร หรืออ่านยอดไม่ออก",
  "ถ้า isReceipt = false ให้ใส่ amount เป็น 0",
].join("\n");

export interface ReceiptReading {
  amount: number;
  merchant: string;
  categoryId: string;
}

export async function readLineImage(
  messageId: string,
  channelAccessToken: string
): Promise<GeminiInlineMedia | null> {
  const { body, contentType } = await fetchLineMediaContent(messageId, channelAccessToken);
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  return { mimeType: contentType.split(";")[0].trim(), data: toBase64(bytes) };
}

/**
 * The expense a receipt photo describes, or null when there isn't one.
 *
 * Null covers a photo that is not a receipt, a total that could not be read,
 * and a category the model invented. All three mean the same thing to the
 * caller — there is nothing here worth proposing — and proposing something
 * anyway would put a number nobody wrote in front of a "ใช่" button.
 */
export async function readReceipt(
  media: GeminiInlineMedia,
  geminiApiKey: string,
  kv: KVNamespace
): Promise<ReceiptReading | null> {
  const raw = await askGemini(geminiApiKey, READ_INSTRUCTION, "อ่านใบเสร็จนี้", {
    kv,
    media,
    jsonMode: true,
    maxOutputTokens: 512,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("readReceipt: model did not return JSON", raw);
    return null;
  }
  const r = parsed as Record<string, unknown>;
  if (r.isReceipt !== true) return null;
  const amount = typeof r.amount === "number" ? r.amount : Number(r.amount);
  // Verified rather than trusted, the same rule aiInterpreter.ts's
  // validateIntent follows for every number the model hands back.
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const categoryId = typeof r.categoryId === "string" ? r.categoryId : "";
  // An invented category would land the expense somewhere every reader
  // downstream treats as impossible, so an unknown one falls back rather
  // than failing the whole read — the amount is the part worth keeping.
  const safeCategory = EXPENSE_CATEGORY_IDS.includes(categoryId) ? categoryId : "other-expense";
  const merchant = typeof r.merchant === "string" ? r.merchant.trim() : "";
  return { amount, merchant, categoryId: safeCategory };
}
