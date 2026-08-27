import {
  readAllTransactions,
  readMonthTransactionsAndBudgets,
  readMonthSummaryData,
  readTransactionsForMonth,
  readTransactionsFrom,
  type TransactionRow,
} from "./sheets.ts";
import { categoryLabel, formatBaht } from "./format.ts";
import { buildRecurringStatus, recurringSummaryBlock } from "./recurring.ts";
import { addDaysToDateKey, bangkokDateKey, bangkokMonthKey, bangkokWeekdayIndex } from "./thaiDate.ts";

// Moved to format.ts to break an import cycle (see that file); re-exported
// here so the eight modules importing them from commands.ts are untouched.
export { categoryLabel, formatBaht } from "./format.ts";

// Bangkok time, not UTC. These used to slice `new Date().toISOString()`,
// which is seven hours behind: between midnight and 07:00 Bangkok, "today"
// resolved to yesterday and — on the 1st of a month — "this month" resolved
// to the one that just ended. Every report in this file keys off these, so
// an early-morning "สรุปวันนี้" silently answered about yesterday, and a
// budget check on the 1st compared this month's spending against last
// month's limits. Everything else in the codebase already went through
// thaiDate.ts; this file was the holdout.
function todayKey(): string {
  return bangkokDateKey();
}

function currentMonthKey(): string {
  return bangkokMonthKey();
}

// The same seven-hour shift as todayKey/currentMonthKey above, in the three
// other date helpers this file's reports run on. Computed from the Bangkok
// date *string* rather than from a Date's UTC fields, so there's no timezone
// left in the arithmetic to get wrong.
function lastMonthKey(): string {
  const [y, m] = currentMonthKey().split("-").map(Number);
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return `${prev.y}-${String(prev.m).padStart(2, "0")}`;
}

function startOfWeekKey(): string {
  // bangkokWeekdayIndex is 0 = Monday (see WEEKDAY_TH in greetingCommands.ts),
  // which is already the offset back to the start of the week.
  return addDaysToDateKey(todayKey(), -bangkokWeekdayIndex());
}

function daysElapsedInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  if (month === currentMonthKey()) return Number(todayKey().slice(8, 10));
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // days in that month
}

function totals(rows: TransactionRow[]): { income: number; expense: number } {
  return {
    income: rows.filter((r) => r.type === "income").reduce((s, r) => s + r.amount, 0),
    expense: rows.filter((r) => r.type === "expense").reduce((s, r) => s + r.amount, 0),
  };
}

function summaryText(label: string, rows: TransactionRow[]): string {
  if (rows.length === 0) return `${label}ยังไม่มีรายการเลยนะ`;
  const { income, expense } = totals(rows);
  return [
    label,
    `รายรับ: ${formatBaht(income)} บาท`,
    `รายจ่าย: ${formatBaht(expense)} บาท`,
    `คงเหลือ: ${formatBaht(income - expense)} บาท`,
  ].join("\n");
}

function topCategoriesBlock(rows: TransactionRow[]): string[] {
  const byCategory = new Map<string, number>();
  for (const r of rows) {
    if (r.type !== "expense") continue;
    byCategory.set(r.categoryId, (byCategory.get(r.categoryId) ?? 0) + r.amount);
  }
  const top5 = Array.from(byCategory.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([categoryId, total]) => `${categoryLabel(categoryId)}: ${formatBaht(total)} บาท`);
  return top5.length > 0 ? ["", "5 หมวดที่จ่ายเยอะสุด:", ...top5] : [];
}

// ---- Command matching -------------------------------------------------

// `kv` arrived with the month-windowed reads (PLAN.md 17.47), which look up
// where the month starts before asking Google for it. Handlers that answer
// about all of history — "เหลือเงินเท่าไหร่", "ค้นหา", "รายการล่าสุด" —
// still read the whole tab and simply don't declare the parameter.
type Handler = (accessToken: string, spreadsheetId: string, kv: KVNamespace) => Promise<string>;

function includesAny(text: string, phrases: string[]): boolean {
  const t = text.trim();
  return phrases.some((p) => t.includes(p));
}

function searchMatch(text: string): string | null {
  const m = text.trim().match(/^(?:ค้นหา|หา)\s*(.+)$/s);
  return m ? m[1].trim() : null;
}

const HELP_TEST = (t: string) => includesAny(t, ["วิธีใช้", "คำสั่ง", "help", "ช่วยเหลือ"]);

// "ทำอะไรได้บ้าง" (PLAN.md 17.48) — a different question from "วิธีใช้",
// and it was getting the same answer: a link to a guide long enough to need
// its own web page. Someone asking what the bot *is* wants a list they can
// read in one glance, not a manual.
//
// Matched on exact-ish whole phrases rather than a loose substring, unlike
// HELP_TEST above. This codebase has been bitten three times by short Thai
// substrings swallowing unrelated messages ("นัด", "ข่าว", "ยา"), and a
// fragment like "ทำอะไรได้" sits inside plenty of ordinary sentences —
// "พรุ่งนี้ทำอะไรได้บ้างที่เชียงใหม่" is a travel question, not this.
const CAPABILITY_PHRASES = [
  "ทำอะไรได้บ้าง",
  "ทำอะไรได้บ้างคะ",
  "ทำอะไรได้บ้างครับ",
  "ช่วยอะไรได้บ้าง",
  "ทำอะไรเป็นบ้าง",
  "คุณทำอะไรได้บ้าง",
  "บอททำอะไรได้บ้าง",
];

const CAPABILITY_TEST = (t: string) => CAPABILITY_PHRASES.includes(t.trim().replace(/[?？!]/g, "").trim());

/** The short answer. One line per thing, no explanation of how to type any
 * of it — that's what "วิธีใช้" is for, and the last line says so. */
export function buildCapabilityText(): string {
  return [
    "ฉันช่วยได้ประมาณนี้:",
    "",
    "💰 จดบัญชี รายรับ-รายจ่าย + ตั้งงบ",
    "📔 จดไดอารี่",
    "📅 นัดหมาย + สิ่งที่ต้องทำ",
    "✈️ หาตั๋วเครื่องบิน + ที่พัก",
    "📍 หาร้าน/สถานที่ใกล้ตัว",
    "📧 เช็ค/ส่งอีเมล + หาอีเมลผู้ติดต่อ",
    "📸 เก็บรูปทริปขึ้น Google Drive",
    "🎬 หาหนัง/ซีรีส์ ดูว่ามีอะไรใหม่ และดูได้ที่แอปไหน",
    "🔁 เก็บค่าใช้จ่ายประจำเดือน + เตือนวันครบกำหนด",
    "🎫 ตรวจผลสลากกินแบ่งรัฐบาล",
    "🎤 ส่งข้อความเสียงมาก็ได้ ไม่ต้องพิมพ์",
    "🧾 ถ่ายรูปใบเสร็จส่งมา จดรายจ่ายให้เลย",
    "🗓️ ตารางเวร",
    "☀️ ทักตอนเช้า บอกอากาศ/ฝุ่น PM2.5/ข่าว/ราคาทอง-บิตคอยน์",
    "",
    'อยากรู้ว่าพิมพ์ยังไง พิมพ์ "วิธีใช้" ได้เลย',
  ].join("\n");
}

// `webSearchEnabled` gates exactly one bullet (PLAN.md 17.42). The guide is
// the bot's own promise about what it can do, so a feature that's switched
// off must not appear in it — a user who reads "บอทค้น Google ให้" and then
// gets told the question is outside its data has been misled by this file,
// not by the model.
export function buildHelpText(webSearchEnabled: boolean): string {
  const sections = [
    "💰 จดเงิน",
    "• พิมพ์รายการธรรมชาติได้เลย เช่น \"ซื้อกาแฟ 60\", \"เงินเดือนเข้า 25000\" หลายรายการในข้อความเดียวก็ได้ เช่น \"ค่ากาแฟ 60 ค่าข้าว 120\" ข้อมูลไม่ครบจะถามกลับก่อนเสมอ",
    "• ทุกรายการต้องพิมพ์ \"ใช่\" ยืนยันก่อนบันทึกจริง กันจดผิด ลบรายการล่าสุด (หรือ ยกเลิกรายการล่าสุด) ถ้าจดผิดไปแล้ว",
    "",
    "📊 ดูรายงาน",
    "• สรุปวันนี้ / สรุปสัปดาห์นี้ / สรุปเดือนนี้ / สรุปเดือนที่แล้ว / เหลือเงินเท่าไหร่ / รายรับเดือนนี้เท่าไหร่ / รายจ่ายเดือนนี้เท่าไหร่",
    "• วันไหนใช้เงินเยอะที่สุด / หมวดไหนใช้เงินเยอะที่สุด / ซื้ออะไรบ่อยที่สุด / เฉลี่ยใช้เงินต่อวันเท่าไหร่",
    "• งบเหลือเท่าไหร่ — เทียบกับงบที่ตั้งไว้ แจ้งเตือนถ้าเกินงบ / ดูงบ — ดูงบที่ตั้งไว้เดือนนี้",
    "• ทุกครั้งที่จดรายจ่ายในหมวดที่ตั้งงบไว้ จะบอกว่าเหลือเท่าไหร่ และ**เตือนตั้งแต่ใช้ไป 80%** ไม่ต้องรอให้เกินก่อน",
    "• สรุปเช้า 7 โมงจะเตือนงบที่ใกล้หมดหรือเกินแล้วให้ด้วย ถ้าทุกงบยังสบายๆ จะไม่ขึ้นอะไรเลย",
    "• ตั้งงบ <หมวด> <จำนวน> เช่น \"ตั้งงบ อาหาร 5000\" (ถามยืนยันก่อนเสมอ) / ลบงบ <หมวด> — ตั้งหลายหมวดพร้อมกันได้ที่แท็บ \"งบ\" ในเว็บ",
    "• ค้นหา <คำ> เช่น \"ค้นหากาแฟ\" / รายการล่าสุด — ดู 5 รายการล่าสุด",
    "• ลงเลขผิด? เปิดเว็บดูข้อมูล จะเห็นรายการเดือนนี้เป็นตาราง กด \"แก้\" ท้ายแถวเพื่อแก้ตัวเลข/หมวด/วันที่ หรือ \"ลบ\" (ถามยืนยันก่อน) — ในแชทลบได้เฉพาะรายการล่าสุด",
    "",
    "🔁 ค่าใช้จ่ายประจำทุกเดือน (ค่าเช่าบ้าน ค่าเน็ต ค่างวด ประกัน)",
    "• ตั้งค่าใช้จ่ายประจำ <ชื่อ> <จำนวน> เช่น \"ตั้งค่าใช้จ่ายประจำ ค่าเน็ต 599\" ใส่วันครบกำหนดด้วยก็ได้ \"...ค่าเช่าบ้าน 6000 ทุกวันที่ 5\"",
    "• ค่าใช้จ่ายประจำ — ดูทั้งหมดพร้อมยอดรวม และเดือนนี้จ่ายไปแล้วกี่รายการ",
    "• จ่าย<ชื่อ>แล้ว เช่น \"จ่ายค่าเน็ตแล้ว\" — บันทึกเป็นรายจ่ายให้ด้วยในครั้งเดียว (ถามยืนยันก่อน)",
    "• ลบค่าใช้จ่ายประจำ <ชื่อ> — เอาออกจากรายการ",
    "• บอทไม่ลงรายการให้เองอัตโนมัติ และไม่เดาว่าจ่ายหรือยัง ต้องบอกเองเสมอ",
    "• \"สรุปเดือนนี้\" จะบอกท้ายข้อความว่ายังเหลือบิลไหนไม่ได้จ่าย",
    "• ถ้าใส่วันครบกำหนดไว้ สรุปเช้า 7 โมงจะเตือนให้เองวันที่ครบกำหนด และเตือนซ้ำทุกเช้าถ้าเลยกำหนดแล้วยังไม่ได้จ่าย (บิลที่ไม่ได้ใส่วันครบกำหนดจะไม่เตือน)",
    "",
    "📸 อัลบั้มรูปทริป",
    "• เริ่มทริป <ชื่อ> แล้วส่งรูป/คลิปวิดีโอเข้ามาได้เลย อัปโหลดขึ้น Google Drive อัตโนมัติ แยกโฟลเดอร์ตามทริป+วันที่ถ่าย",
    "• ทริปตอนนี้ — เช็คทริปที่เปิดค้างอยู่ / จบทริป — ปิดทริป เริ่มทริปใหม่ทับของเดิมจะถามยืนยันก่อนสลับให้",
    "• ทริปทั้งหมด (หรือ รายชื่อทริป) — ดูอัลบั้มทริปที่เคยเก็บไว้ทั้งหมด อันที่เปิดอยู่จะมี ▶ นำหน้า",
    "• **เปิดทริปเก่าต่อได้** — พิมพ์ \"เริ่มทริป <ชื่อเดิม>\" รูปจะไปรวมกับรูปเก่าในอัลบั้มเดียวกัน ไม่สร้างอัลบั้มใหม่ซ้ำชื่อ",
    "• ในกลุ่ม: ทุกคนส่งรูปเข้าทริปเดียวกันได้เลย ไม่ต้องแท็กบอท",
    "",
    "📅 ปฏิทิน (เตือนผ่าน Google Calendar)",
    "• นัด <เรื่อง> <วันที่> <เวลา> เช่น \"นัด ประชุมทีม 12/1/2569 13:00\" ต้องมีทั้งวันที่และเวลา พิมพ์แบบภาษาพูดก็ได้ เช่น \"นัดพรุ่งนี้บ่ายสองประชุมทีม\" AI แปลงให้เอง",
    "• มีนัดอะไรวันนี้ (หรือพรุ่งนี้/สัปดาห์นี้) / ลบนัด <คำค้น> / แก้นัด <คำค้น> เป็น <วันเวลาใหม่> — สร้าง/ลบ/แก้ ถามยืนยันก่อนเสมอ",
    "",
    "📔 ไดอารี่",
    "• ไดอารี่ <ข้อความ> เช่น \"ไดอารี่ #งาน วันนี้ประชุมเสร็จเร็ว\" (ใส่ #หมวด ก็ได้ ไม่ใส่ก็ได้)",
    "• ไดอารี่เดือนนี้มีอะไรบ้าง (สรุปแยกหมวด+วันที่) / ไดอารี่วันที่ <วันที่> (รายละเอียดวันนั้น) / ค้นหาไดอารี่ <คำ>",
    "• แก้ไข/ลบบันทึกเก่าทำผ่านหน้าเว็บเท่านั้น (พิมพ์ \"เปิดเว็บดูข้อมูล\" แล้วไปแท็บ \"ไดอารี่\") ไม่มีคำสั่งแก้/ลบผ่านแชท",
    "",
    "🗓️ ตารางเวร",
    // Ticking happens on the web page (write-capable, unlike every other
    // /view/* page — see PLAN.md 17.18), but asking about it stays a plain
    // chat question through the same AI Q&A pipeline as money/calendar/diary
    // questions — nothing here needs its own separate matcher.
    "• เปิดเว็บดูข้อมูล แล้วไปแท็บ \"ตารางเวร\" เพื่อติ๊กวันที่เข้าเวรของตัวเอง (เวร 7.00/เวรเช้า/เวรบ่าย/เวรดึก)",
    "• ถามผ่านแชทได้เลย เช่น \"มีเวรมั้ย\" / \"ใครอยู่เวรเช้าวันนี้\" / \"พรุ่งนี้ได้ขึ้นเวรไหม\"",
    "",
    "✅ สิ่งที่ต้องทำ (Google Tasks)",
    // Date/time attached is optional (PLAN.md 17.27) — a to-do list, still
    // distinct from ปฏิทิน above which always needs a date+time.
    "• เพิ่มสิ่งที่ต้องทำ <ข้อความ> [วันที่] [เวลา] เช่น \"เพิ่มสิ่งที่ต้องทำ ซื้อของเข้าบ้าน\" หรือ \"...จ่ายค่าไฟ 20/1/2569 14:00\" (ไม่ระบุวันที่/เวลาก็ได้ ต่างจากปฏิทิน)",
    "• สิ่งที่ต้องทำ (หรือ รายการที่ต้องทำ) ดูที่ยังไม่เสร็จ / ทำเสร็จแล้ว <คำ> / ลบสิ่งที่ต้องทำ <คำ> — ทุกอย่างถามยืนยันก่อนเสมอ",
    "• ดูรายการทั้งหมดผ่านหน้าเว็บได้ด้วย (พิมพ์ \"เปิดเว็บดูข้อมูล\" แล้วไปแท็บ \"สิ่งที่ต้องทำ\") แบบ read-only ยังต้องจัดการผ่านแชทเหมือนเดิม",
    "",
    "📧 อีเมล (Gmail) และผู้ติดต่อ (Contacts)",
    // v1 scope (PLAN.md 17.28), narrower than every other Google integration
    // on purpose: read (inbox summaries only, no full body) + send only, no
    // reply/archive/delete/mark-as-read — see gmail.ts's own comment.
    "• เช็คอีเมล — ดูอีเมลใหม่ที่ยังไม่ได้อ่านสูงสุด 5 ฉบับ (ผู้ส่ง/หัวข้อ/ตัวอย่างเนื้อหา)",
    "• ส่งอีเมล ถึง <ผู้รับ> เรื่อง <หัวข้อ> ข้อความ <เนื้อหา> — ผู้รับพิมพ์เป็นชื่อผู้ติดต่อแทนอีเมลก็ได้ (ต้องมีในสมุดผู้ติดต่อ Google) เจอชื่อซ้ำจะถามให้เจาะจงก่อน",
    "• อีเมลของ<ชื่อผู้ติดต่อ> — ค้นหาอีเมลผู้ติดต่อเฉยๆ ไม่ต้องส่งก็ได้",
    "• ขอรายชื่ออีเมล (หรือ \"มีอีเมลใครบ้าง\") — ดูผู้ติดต่อที่มีอีเมลทั้งหมด",
    "• ก่อนส่งจะถามยืนยันเสมอ พร้อมโชว์ที่อยู่อีเมลจริงที่จะส่งไป (แม้พิมพ์เป็นชื่อมา) เพราะส่งแล้วเรียกคืนไม่ได้",
    "",
    "📍 หาสถานที่ใกล้ตัว (Google Maps)",
    // Only the "ask for GPS via LINE's own location-sharing" flow (PLAN.md
    // 17.30) — no OAuth needed at all, just a flat Maps API key, unlike
    // every other Google integration above.
    "• หา<สิ่งที่จะหา>ใกล้ฉัน เช่น \"หาร้านกาแฟใกล้ฉัน\" แล้วแชร์ตำแหน่งปัจจุบันตามที่บอทขอ (กดไอคอน + ข้างช่องพิมพ์ในไลน์ > ตำแหน่งที่ตั้ง)",
    "• ได้รายชื่อร้าน/สถานที่จริงใกล้ตำแหน่งที่แชร์ พร้อมคะแนนรีวิว (ถ้ามี) และลิงก์เปิดดูใน Google Maps",
    "",
    "🎬 หนังและซีรีส์ (ข้อมูลจาก TMDB)",
    // The four ready-made lists plus the two searches, for both media types
    // (PLAN.md 17.57/17.58). Deliberately shows the exact trigger phrases:
    // natural phrasing works too via the AI interpreter, but the phrases are
    // what always works. Every phrase below works with "ซีรีส์" in place of
    // "หนัง", which is why they are listed once rather than twice.
    "• หนังใหม่ — หนังที่กำลังฉายในโรงหนังไทยตอนนี้ (ซีรีส์ใหม่ = ซีรีส์ที่กำลังฉายอยู่)",
    "• หนังกำลังจะเข้า / ซีรีส์กำลังจะมา — ที่ยังไม่เริ่มฉาย",
    "• หนังมาแรง / ซีรีส์มาแรง — ที่ฮิตประจำสัปดาห์",
    "• หนังสตรีมมิ่ง / ซีรีส์สตรีมมิ่ง — ของใหม่ใน Netflix / Prime Video / Disney+ / Apple TV+ / Viu",
    "• หนังเรื่อง<ชื่อ> / ซีรีส์เรื่อง<ชื่อ> — ค้นหาจากชื่อ",
    "• หนังแนว<แนว> หรือ หนังเกี่ยวกับ<เนื้อเรื่อง> เช่น \"หนังเกี่ยวกับเดินทางข้ามเวลา\" — ค้นจากแนวหรือเนื้อเรื่องได้เลย (ซีรีส์ก็ได้)",
    "• เวลาถามซีรีส์หรือของในสตรีมมิ่ง จะบอกด้วยว่าดูได้ที่แอปไหน และเสียงต้นฉบับเป็นภาษาอะไร",
    "• แต่ TMDb ไม่มีข้อมูลพากย์ไทย/ซับไทย ต้องกดลิงก์ไปเช็คในแอปเอง",
    "• ทุกคำสั่งจะแนบลิงก์หน้าเว็บที่มีโปสเตอร์ เรื่องย่อ และดูได้ที่แอปไหนบ้าง",
    "",
    "🎫 หาตั๋วเดินทาง/ที่พัก (เทียบราคา + ลิงก์กดจองเอง)",
    // PLAN.md 17.37 — read-only like Places: the bot never books anything,
    // it prices (best-effort, Amadeus) and links (always).
    "• หาตั๋วเครื่องบิน <ต้นทาง> ไป <ปลายทาง> <วันที่> เช่น \"หาตั๋วเครื่องบิน กรุงเทพ ไป เชียงใหม่ 20/12/2569\" หรือพิมพ์ธรรมดา เช่น \"หาตั๋วไปเชียงใหม่พรุ่งนี้\" — โชว์ราคาจริงในแชท + ลิงก์ Google Flights/Skyscanner",
    "• หาที่พัก <เมือง> <เช็คอิน> ถึง <เช็คเอาท์> เช่น \"หาที่พัก เชียงใหม่ 20/12/2569 ถึง 22/12/2569\" (ไม่ใส่วันเช็คเอาท์ = 1 คืน) — โชว์ราคาถูกสุดก่อน + ลิงก์ Agoda/Booking",
    "• หาตั๋วรถทัวร์ (หรือ หาตั๋วรถไฟ) <ต้นทาง> ไป <ปลายทาง> [วันที่] — ส่งลิงก์ 12Go ที่กรอกเส้นทางไว้แล้ว (เส้นทางภาคพื้นไม่มีราคาในแชท ดูในลิงก์)",
    "• บอทไม่จองให้เอง กดลิงก์ไปจองเองทุกกรณี ราคาจริงยึดตามหน้าเว็บตอนจอง",
    "",
    "🤖 ถามคำถาม/วิเคราะห์ (AI)",
    "• ถาม <คำถาม> เช่น \"ถาม เดือนนี้ใช้เงินหมวดไหนเยอะสุด\" — ถามอะไรก็ได้เกี่ยวกับเงิน/นัดหมาย/ไดอารี่/เวรที่บันทึกไว้ / ถาม สภาพอากาศวันนี้เป็นไง (ต้องตั้งจังหวัดก่อน)",
    // PLAN.md 17.38. Listed right after the personal-data line above because
    // that's the actual distinction: the bot decides per question which of
    // the two it is, and the user never has to say which one they want.
    ...(webSearchEnabled
      ? ["• ถามเรื่องนอกข้อมูลของคุณก็ได้ เช่น \"ถาม รถไฟฟ้าสายสีส้มเปิดยัง\" — บอทไปค้น Google มาตอบให้เอง คำตอบสั้นๆ ตอบในแชทเลย ถ้ายาวจะส่งลิงก์หน้าเว็บที่มีคำตอบเต็มพร้อมแหล่งอ้างอิงให้แทน"]
      : []),
    "• ถาม ข่าวหุ้น (หรือบิตคอยน์/ทอง/การเงินสหรัฐ) — สรุปข่าวการเงินพร้อมราคาจริง / ถาม ข่าววันนี้ — สรุปข่าวในประเทศไทย",
    "• วิเคราะห์ (พิมพ์เฉยๆ ก็ได้) — สรุปพฤติกรรมการใช้จ่าย+ไดอารี่เดือนนี้แบบเจาะลึกให้",
    "",
    "☀️ ทักทายตอนเช้า",
    "• ทัก \"สวัสดี\" ครั้งแรกของวัน สรุปวันที่/อากาศ/ฝุ่น PM2.5/ข่าวให้ ทักครั้งต่อไปในวันเดียวกันแค่ทักธรรมดา",
    // PLAN.md 17.21/17.22: doesn't need the user to say anything at all
    // anymore — worth calling out here since every other line in this help
    // text describes something the user has to type first.
    "• ไม่ต้องทักก็ได้ — 7 โมงเช้าทุกวันได้บทสรุปอัตโนมัติ (วันที่/อากาศ/ฝุ่น PM2.5/ข่าว/ราคาทอง-บิตคอยน์/นัดวันนี้/เวรวันนี้/บิลที่ครบกำหนดวันนี้/วิเคราะห์ไดอารี่เมื่อวาน) เฉพาะแชทส่วนตัว ไม่ส่งเข้ากลุ่ม",
    "• ตั้งจังหวัด <ชื่อ> เช่น \"ตั้งจังหวัด เชียงใหม่\" เพื่อให้บอกสภาพอากาศกับค่าฝุ่นได้",
    "• ฝุ่น (หรือ ค่าฝุ่น / PM2.5) — ถามค่าฝุ่นตอนนี้ได้ทุกเมื่อ ไม่ต้องรอสรุปเช้า พร้อมบอกว่าอยู่ระดับสีไหนตามเกณฑ์กรมควบคุมมลพิษ",
    "",
    "🧾 ถ่ายใบเสร็จ",
    "• ถ่ายรูปใบเสร็จ/สลิปส่งมาตอนที่**ไม่ได้เปิดทริป** บอทจะอ่านยอดรวมแล้วเสนอบันทึกเป็นรายจ่ายให้ ยืนยันด้วย \"ใช่\" เหมือนพิมพ์เอง",
    "• บอทจะบอกก่อนว่าอ่านได้เท่าไหร่ ถ้าอ่านผิดจะเห็นทันที แล้วกด ไม่ใช่ ได้เลย",
    "• ระหว่างเปิดทริปอยู่ รูปทุกใบจะเข้าอัลบั้มทริปเหมือนเดิม ไม่ถูกอ่านเป็นใบเสร็จ",
    "",
    "🎤 ข้อความเสียง",
    "• อัดเสียงส่งมาแทนการพิมพ์ได้เลย ใช้ได้กับทุกอย่างที่พิมพ์ได้ เช่น พูดว่า \"ค่ากาแฟ 60\" หรือ \"ฝุ่นวันนี้เป็นไง\"",
    "• บอทจะแสดงสิ่งที่ได้ยินกลับมาให้ดูก่อนเสมอ ถ้าฟังผิดจะเห็นทันที แล้วค่อยกด ไม่ใช่",
    "",
    "🎫 สลากกินแบ่งรัฐบาล",
    "• ผลหวย (หรือ หวยออกอะไร) — ผลงวดล่าสุด รางวัลที่ 1 + เลขหน้า 3 ตัว + เลขท้าย 3 ตัว + เลขท้าย 2 ตัว",
    "• ตรวจหวย <เลข> เช่น \"ตรวจหวย 735867\" — บอกว่าถูกรางวัลอะไรบ้าง ใส่ 2 หรือ 3 หลักเพื่อตรวจเฉพาะเลขท้าย/เลขหน้าก็ได้",
    "• ผลที่ได้ดึงจากเว็บข่าว ไม่ใช่ประกาศทางการ ถ้าถูกรางวัลให้เช็คกับสำนักงานสลากฯ อีกครั้ง",
    "",
    "🌐 ดูข้อมูลผ่านเว็บ",
    // No "เห็นเฉพาะคุณคนเดียว" claim here (unlike an earlier version) — this
    // help text is shared between personal and group mode (PLAN.md 17.7),
    // and a group's reply posts straight into the shared chat, so the link
    // is visible to whoever's in the group, not just whoever asked for it.
    "• เปิดเว็บดูข้อมูล — ขอลิงก์ดูบัญชี/ปฏิทิน/ไดอารี่/รูปทริป/ตารางเวร/สิ่งที่ต้องทำ ในหน้าเดียว (ใช้ได้ 1 ชั่วโมง หมดอายุแล้วพิมพ์ใหม่ได้เลย) — กลุ่มขอลิงก์ของสมุดกลุ่มเองได้เหมือนกัน",
    "• แท็บ \"ไดอารี่\" แก้ไข/ลบบันทึกเก่าได้ตรงนั้นเลย",
    "",
    "⚙️ ตั้งค่า",
    // Its own section rather than a bullet under the web viewer since
    // PLAN.md 17.50 — it has a rich-menu tile of its own now, and one of the
    // three things a tap can reach shouldn't be buried inside another
    // feature's list.
    "• ตั้งค่า — ขอลิงก์หน้าตั้งค่า: ชื่อบอท, คาแรคเตอร์ (น้ำเสียงที่ใช้ตอบ), ชื่อที่อยากให้บอทเรียกเรา, จังหวัดพยากรณ์อากาศ",
    "• ตั้งคนละแบบได้ทุกคน ใครเชื่อมบัญชีก็มีบอทเป็นของตัวเอง (ในกลุ่มใช้ค่าเดียวกันทั้งกลุ่ม)",
    "• ล้างรายรับ-รายจ่ายเพื่อเริ่มใหม่ก็อยู่หน้านี้ — ต้องใส่รหัสที่ส่งไปทางอีเมลของบัญชี Google ที่เป็นเจ้าของสมุดก่อน และลบเฉพาะเงิน ไม่แตะไดอารี่/งบ/ปฏิทิน/รูปทริป",
    "",
    "❓ ไม่แน่ใจว่าถามอะไรได้",
    "• พิมพ์ \"ทำอะไรได้บ้าง\" ได้ลิสต์สั้นๆ ว่าฉันช่วยอะไรได้บ้าง",
    "",
    "🔒 ความเป็นส่วนตัว",
    "• ข้อมูลทุกอย่างบันทึกลงบัญชี Google ของคุณเอง ผู้พัฒนาไม่มีสำเนาและเข้าถึงไม่ได้",
    "• อ่านนโยบายความเป็นส่วนตัวและข้อกำหนดฉบับเต็มได้ที่ท้ายหน้าคู่มือนี้",
  ];
  // The menu holds three of these now (วิธีใช้ / เปิดเว็บดูข้อมูล / ตั้งค่า),
  // so it's worth saying what a tap actually reaches rather than just that
  // a menu exists (PLAN.md 17.50).
  return [
    "ฉันช่วยได้ 14 เรื่อง — พิมพ์คำสั่งด้านล่างได้เลย",
    "(เมนูใต้ช่องพิมพ์มี 3 ปุ่ม: วิธีใช้ / เปิดเว็บดูข้อมูล / ตั้งค่า)",
    "",
    ...sections,
  ].join("\n");
}

const COMMANDS: Array<{ test: (text: string) => boolean; handle: Handler }> = [
  {
    test: (t) => includesAny(t, ["สรุปวันนี้", "วันนี้ใช้ไปเท่าไหร่", "วันนี้จ่ายไปเท่าไหร่", "ยอดวันนี้"]),
    handle: async (accessToken, spreadsheetId, kv) => {
      const all = await readTransactionsForMonth(accessToken, spreadsheetId, kv, currentMonthKey());
      const rows = all.filter((r) => r.date === todayKey());
      return summaryText("สรุปวันนี้", rows);
    },
  },
  {
    test: (t) => includesAny(t, ["สรุปสัปดาห์นี้", "อาทิตย์นี้ใช้ไปเท่าไหร่", "สัปดาห์นี้ใช้ไปเท่าไหร่"]),
    handle: async (accessToken, spreadsheetId, kv) => {
      const start = startOfWeekKey();
      // The week starts on Monday, so about four days in thirty it began in
      // last month. Opening the window at the month the week started in
      // covers both cases in one read — a window runs to the end of the
      // sheet, so it always includes today as well.
      const all = await readTransactionsFrom(accessToken, spreadsheetId, kv, start.slice(0, 7));
      const rows = all.filter((r) => r.date >= start);
      return summaryText("สรุปสัปดาห์นี้", rows);
    },
  },
  {
    test: (t) => includesAny(t, ["สรุปเดือนที่แล้ว", "เดือนที่แล้วใช้ไปเท่าไหร่", "เดือนก่อนใช้ไปเท่าไหร่"]),
    handle: async (accessToken, spreadsheetId, kv) => {
      const month = lastMonthKey();
      const rows = await readTransactionsForMonth(accessToken, spreadsheetId, kv, month);
      return summaryText(`สรุปเดือนที่แล้ว (${month})`, rows) + topCategoriesBlock(rows).join("\n");
    },
  },
  {
    test: (t) => includesAny(t, ["สรุปเดือนนี้", "สรุป"]),
    handle: async (accessToken, spreadsheetId, kv) => {
      const month = currentMonthKey();
      // Recurring bills are appended only to *this* month's summary
      // (PLAN.md 17.59). Last month's is a closed record, and "ยังไม่จ่าย"
      // about a month that has ended reads as a bill still owed rather than
      // as history. The block is empty for anyone with none set up, so the
      // most-read message this bot sends is unchanged for them — and it
      // rides along in the same request the transactions already cost, so
      // it is unchanged in request count for everyone.
      const { transactions: rows, recurring, paid } = await readMonthSummaryData(
        accessToken,
        spreadsheetId,
        kv,
        month
      );
      const recurringLines = recurringSummaryBlock(buildRecurringStatus(recurring, paid, month));
      return (
        summaryText(`สรุปเดือนนี้ (${month})`, rows) +
        topCategoriesBlock(rows).join("\n") +
        recurringLines.join("\n")
      );
    },
  },
  {
    test: (t) => includesAny(t, ["เหลือเงินเท่าไหร่", "ยอดคงเหลือ", "คงเหลือเท่าไหร่", "มีเงินเหลือเท่าไหร่"]),
    // Whole tab on purpose: a cumulative balance is every month there has
    // ever been, so no window can answer it (PLAN.md 17.47).
    handle: async (accessToken, spreadsheetId) => {
      const all = await readAllTransactions(accessToken, spreadsheetId);
      if (all.length === 0) return "ยังไม่มีรายการเลยนะ";
      const { income, expense } = totals(all);
      return `ยอดคงเหลือสะสมทั้งหมด: ${formatBaht(income - expense)} บาท\n(รายรับรวม ${formatBaht(income)} / รายจ่ายรวม ${formatBaht(expense)} บาท)`;
    },
  },
  {
    test: (t) => includesAny(t, ["รายรับเดือนนี้"]),
    handle: async (accessToken, spreadsheetId, kv) => {
      const month = currentMonthKey();
      const all = await readTransactionsForMonth(accessToken, spreadsheetId, kv, month);
      const income = all.filter((r) => r.type === "income").reduce((s, r) => s + r.amount, 0);
      return `รายรับเดือนนี้: ${formatBaht(income)} บาท`;
    },
  },
  {
    test: (t) => includesAny(t, ["รายจ่ายเดือนนี้"]),
    handle: async (accessToken, spreadsheetId, kv) => {
      const month = currentMonthKey();
      const all = await readTransactionsForMonth(accessToken, spreadsheetId, kv, month);
      const expense = all.filter((r) => r.type === "expense").reduce((s, r) => s + r.amount, 0);
      return `รายจ่ายเดือนนี้: ${formatBaht(expense)} บาท`;
    },
  },
  {
    test: (t) => includesAny(t, ["วันไหนใช้เงินเยอะที่สุด", "วันไหนจ่ายเยอะสุด", "วันที่ใช้เงินเยอะที่สุด"]),
    handle: async (accessToken, spreadsheetId, kv) => {
      const month = currentMonthKey();
      const all = await readTransactionsForMonth(accessToken, spreadsheetId, kv, month);
      const byDay = new Map<string, number>();
      for (const r of all) {
        if (r.type !== "expense") continue; // already scoped to `month` by the read
        byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.amount);
      }
      if (byDay.size === 0) return "เดือนนี้ยังไม่มีรายจ่ายเลยนะ";
      const [date, amount] = Array.from(byDay.entries()).sort((a, b) => b[1] - a[1])[0];
      return `วันที่ใช้เงินเยอะที่สุดเดือนนี้คือ ${date} ใช้ไป ${formatBaht(amount)} บาท`;
    },
  },
  {
    test: (t) => includesAny(t, ["ซื้ออะไรบ่อยที่สุด", "หมวดไหนใช้บ่อยที่สุด", "จ่ายอะไรบ่อยสุด"]),
    handle: async (accessToken, spreadsheetId, kv) => {
      const month = currentMonthKey();
      const all = await readTransactionsForMonth(accessToken, spreadsheetId, kv, month);
      const counts = new Map<string, number>();
      for (const r of all) {
        if (r.type !== "expense") continue; // already scoped to `month` by the read
        counts.set(r.categoryId, (counts.get(r.categoryId) ?? 0) + 1);
      }
      if (counts.size === 0) return "เดือนนี้ยังไม่มีรายจ่ายเลยนะ";
      const [categoryId, count] = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
      return `หมวดที่ใช้บ่อยที่สุดเดือนนี้คือ ${categoryLabel(categoryId)} (${count} ครั้ง)`;
    },
  },
  {
    test: (t) => includesAny(t, ["หมวดไหนใช้เงินเยอะที่สุด", "จ่ายหมวดไหนเยอะสุด", "ใช้เงินหมวดไหนมากที่สุด"]),
    handle: async (accessToken, spreadsheetId, kv) => {
      const month = currentMonthKey();
      const all = await readTransactionsForMonth(accessToken, spreadsheetId, kv, month);
      const byCategory = new Map<string, number>();
      for (const r of all) {
        if (r.type !== "expense") continue; // already scoped to `month` by the read
        byCategory.set(r.categoryId, (byCategory.get(r.categoryId) ?? 0) + r.amount);
      }
      if (byCategory.size === 0) return "เดือนนี้ยังไม่มีรายจ่ายเลยนะ";
      const [categoryId, amount] = Array.from(byCategory.entries()).sort((a, b) => b[1] - a[1])[0];
      return `หมวดที่ใช้เงินเยอะที่สุดเดือนนี้คือ ${categoryLabel(categoryId)} รวม ${formatBaht(amount)} บาท`;
    },
  },
  {
    test: (t) => includesAny(t, ["เฉลี่ยวันละเท่าไหร่", "ใช้เงินเฉลี่ยต่อวันเท่าไหร่", "เฉลี่ยใช้จ่ายต่อวัน"]),
    handle: async (accessToken, spreadsheetId, kv) => {
      const month = currentMonthKey();
      const all = await readTransactionsForMonth(accessToken, spreadsheetId, kv, month);
      const expense = all.filter((r) => r.type === "expense").reduce((s, r) => s + r.amount, 0);
      const days = daysElapsedInMonth(month);
      return `เฉลี่ยใช้จ่ายวันละ ${formatBaht(expense / days)} บาท (จากรายจ่ายรวม ${formatBaht(expense)} บาท ใน ${days} วัน)`;
    },
  },
  {
    test: (t) => includesAny(t, ["งบเหลือเท่าไหร่", "งบที่ตั้งไว้เหลือเท่าไหร่", "ใช้งบไปเท่าไหร่แล้ว"]),
    handle: async (accessToken, spreadsheetId, kv) => {
      const month = currentMonthKey();
      // One request for both tabs (PLAN.md 17.45), and only this month's rows
      // of the big one (PLAN.md 17.47).
      const { transactions: all, budgets } = await readMonthTransactionsAndBudgets(
        accessToken,
        spreadsheetId,
        kv,
        month
      );
      const monthBudgets = budgets.filter((b) => b.month === month);
      if (monthBudgets.length === 0) {
        return 'ยังไม่ได้ตั้งงบไว้เลยนะ ตั้งได้เลยเช่น "ตั้งงบ อาหาร 5000" หรือตั้งหลายหมวดพร้อมกันที่แท็บ "งบ" ในเว็บ';
      }
      const spentByCategory = new Map<string, number>();
      for (const r of all) {
        if (r.type !== "expense") continue; // already scoped to `month` by the read
        spentByCategory.set(r.categoryId, (spentByCategory.get(r.categoryId) ?? 0) + r.amount);
      }
      const lines = monthBudgets.map((b) => {
        const spent = spentByCategory.get(b.categoryId) ?? 0;
        const remaining = b.limitAmount - spent;
        const flag = remaining < 0 ? " ⚠️ เกินงบแล้ว" : "";
        return `${categoryLabel(b.categoryId)}: เหลือ ${formatBaht(remaining)} บาท (ใช้ไป ${formatBaht(spent)} จาก ${formatBaht(b.limitAmount)}${flag})`;
      });
      return lines.join("\n");
    },
  },
  {
    test: (t) => includesAny(t, ["รายการล่าสุด"]),
    // Whole tab on purpose (PLAN.md 17.47): five most recent across all time,
    // and on the 1st of a month a window would have fewer than five in it.
    handle: async (accessToken, spreadsheetId) => {
      const all = await readAllTransactions(accessToken, spreadsheetId);
      if (all.length === 0) return "ยังไม่มีรายการเลยนะ";
      const recent = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
      const lines = recent.map((r) => {
        const sign = r.type === "income" ? "+" : "-";
        return `${r.date} ${categoryLabel(r.categoryId)} ${sign}${formatBaht(r.amount)} บาท`;
      });
      return ["5 รายการล่าสุด:", ...lines].join("\n");
    },
  },
];

/**
 * The chat reply for "วิธีใช้" — a link, not the guide itself (PLAN.md
 * 17.39). buildHelpText above is still the single source of the content; it
 * is just rendered by /view/help now instead of being pushed through a chat
 * message that LINE silently truncates at 5,000 characters. That ceiling had
 * started dictating what the guide was allowed to say, which is the wrong
 * way round.
 *
 * No token in the URL, unlike every other /view link this bot hands out:
 * the guide is identical for everyone and holds no account data, so the link
 * needs no authorising and never expires (viewHelpPage.ts).
 */
export function buildHelpReply(origin: string): string {
  return [
    "📖 วิธีใช้ทั้งหมดอยู่ในหน้านี้เลย กดอ่านได้ (เปิดได้ตลอด ไม่มีวันหมดอายุ เก็บลิงก์ไว้ได้):",
    `${origin}/view/help`,
  ].join("\n");
}

export async function matchCommand(text: string, origin: string): Promise<Handler | null> {
  // Checked before HELP_TEST so "ทำอะไรได้บ้าง" gets the short list rather
  // than the guide link. They don't currently overlap, but the phrase list
  // is the more specific of the two and belongs first either way.
  if (CAPABILITY_TEST(text)) {
    return async () => buildCapabilityText();
  }

  if (HELP_TEST(text)) {
    return async () => buildHelpReply(origin);
  }

  const searchTerm = searchMatch(text);
  if (searchTerm) {
    // Whole tab on purpose (PLAN.md 17.47): searching only the current month
    // would quietly stop finding things, which is worse than being slower.
    return async (accessToken, spreadsheetId) => {
      const all = await readAllTransactions(accessToken, spreadsheetId);
      const matches = all.filter(
        (r) => r.note.includes(searchTerm) || r.rawText.includes(searchTerm)
      );
      if (matches.length === 0) return `ไม่พบรายการที่มีคำว่า "${searchTerm}" เลยนะ`;
      const total = matches.reduce((s, r) => s + (r.type === "expense" ? r.amount : 0), 0);
      const lines = matches
        .slice(-10)
        .reverse()
        .map((r) => {
          const sign = r.type === "income" ? "+" : "-";
          return `${r.date} ${categoryLabel(r.categoryId)} ${sign}${formatBaht(r.amount)} บาท — ${r.note}`;
        });
      return [
        `พบ ${matches.length} รายการที่มีคำว่า "${searchTerm}" รวมรายจ่าย ${formatBaht(total)} บาท`,
        "",
        ...lines,
      ].join("\n");
    };
  }

  const found = COMMANDS.find((c) => c.test(text));
  return found ? found.handle : null;
}
