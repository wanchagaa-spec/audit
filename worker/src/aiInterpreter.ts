// Full AI message interpretation (PLAN.md 17.11) — the primary way every
// fresh message (not a pending "ใช่/ไม่ใช่" confirmation, not a dangling
// chatEngine clarification, not an exact-match greeting) gets understood
// now, replacing "only known command phrases get recognized" with "Gemini
// reads the whole sentence plus recent conversation history and decides what
// it means." This is a deliberate, explicitly user-confirmed reversal of
// this codebase's original core guarantee (PLAN.md 15.10: money is never
// computed or decided by the AI) — see PLAN.md 17.11 for the full
// confirm-core-changes record of that decision.
//
// What still holds regardless: every action this file's output can trigger
// is the *same* deterministic function commands.ts/calendarCommands.ts/
// diaryCommands.ts/tripCommands.ts/transactionCommands.ts always used —
// interpretMessage never writes to Sheets/Calendar/Drive itself, it only
// ever returns a structured intent for index.ts's runInterpretedIntent to
// route. Anything that saves data (a transaction, a calendar event, a diary
// entry) still goes through the exact same confirm-before-save step
// (PLAN.md 17.9) as before — this file decides *what* the user meant, never
// *whether* to actually commit it. And validateIntent below never trusts the
// model's JSON blindly: an intent with a malformed/out-of-range field is
// rejected outright (treated the same as a failed call), same "verify, don't
// just trust" pattern as persona.ts's quotedSpans check and aiCommands.ts's
// guarded numbers.

import { DEFAULT_CATEGORIES } from "../../app/src/data/defaultCategories.ts";
import type { EntryType } from "../../app/src/types.ts";
import { askGemini, GeminiError } from "./gemini.ts";
import { formatHistoryForPrompt, type ConversationTurn } from "./conversationHistory.ts";
import { EMAIL_RE } from "./gmail.ts";
import { BOT_NAME } from "./persona.ts";
import { bangkokDateKey } from "./thaiDate.ts";

export interface InterpretedTransaction {
  amount: number;
  type: EntryType;
  categoryId: string;
  note: string;
}

export type InterpretedIntent =
  | { intent: "transaction"; transactions: InterpretedTransaction[] }
  | { intent: "calendar_create"; calendarTitle: string; calendarDateKey: string; calendarTime: string }
  | { intent: "calendar_delete"; calendarKeyword: string }
  | { intent: "calendar_edit"; calendarKeyword: string; calendarDateKey?: string; calendarTime?: string }
  | { intent: "calendar_query"; calendarRangeFromKey: string; calendarRangeToKeyExclusive: string; calendarRangeLabel: string }
  | { intent: "diary_create"; diaryText: string; diaryCategory: string }
  | { intent: "diary_query_date"; diaryDateKey: string }
  | { intent: "diary_query_month" }
  | { intent: "diary_search"; diarySearchTerm: string }
  | { intent: "task_create"; taskTitle: string; taskDueDateKey?: string; taskDueTime?: string }
  | { intent: "task_complete"; taskKeyword: string }
  | { intent: "task_delete"; taskKeyword: string }
  | { intent: "task_list" }
  | { intent: "email_check" }
  | { intent: "email_send"; emailTo: string; emailSubject: string; emailBody: string }
  | { intent: "trip_start"; tripName: string }
  | { intent: "trip_end" }
  | { intent: "trip_status" }
  | { intent: "set_province"; provinceName: string }
  | { intent: "question"; question: string }
  | { intent: "help" }
  | { intent: "view_link" }
  | { intent: "chitchat"; reply: string }
  | { intent: "unclear"; reply: string };

// A slow/hanging call must never stall a reply for long — same reasoning as
// persona.ts's PERSONA_TIMEOUT_MS, kept in the same ballpark. This now sits
// *before* persona styling in the pipeline (interpret, act, then style the
// final reply), so a message can involve two sequential Gemini calls;
// accepted latency/quota tradeoff, recorded in PLAN.md 17.11.
const INTERPRETER_TIMEOUT_MS = 3000;

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function isValidDateKey(s: unknown): s is string {
  if (typeof s !== "string" || !DATE_KEY_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isValidTime(s: unknown): s is string {
  if (typeof s !== "string" || !TIME_RE.test(s)) return false;
  const [h, min] = s.split(":").map(Number);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

function isNonEmptyString(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

function validateTransaction(raw: unknown): InterpretedTransaction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const amount = typeof r.amount === "number" ? r.amount : Number(r.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (r.type !== "income" && r.type !== "expense") return null;
  if (typeof r.categoryId !== "string") return null;
  const category = DEFAULT_CATEGORIES.find((c) => c.id === r.categoryId && c.type === r.type);
  if (!category) return null;
  const note = typeof r.note === "string" ? r.note : "";
  return { amount, type: r.type, categoryId: r.categoryId, note };
}

// Rejects anything that doesn't match one of InterpretedIntent's exact
// shapes, including a well-formed-JSON-but-wrong-fields response — a model
// can emit syntactically valid JSON that's still semantically wrong (an
// invented categoryId, an impossible date), and this is the one place that
// stands between that and an action actually firing.
export function validateIntent(raw: unknown): InterpretedIntent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  switch (r.intent) {
    case "transaction": {
      if (!Array.isArray(r.transactions) || r.transactions.length === 0) return null;
      const transactions = r.transactions.map(validateTransaction);
      if (transactions.some((t) => t === null)) return null;
      return { intent: "transaction", transactions: transactions as InterpretedTransaction[] };
    }
    case "calendar_create": {
      if (!isNonEmptyString(r.calendarTitle) || !isValidDateKey(r.calendarDateKey) || !isValidTime(r.calendarTime)) {
        return null;
      }
      return { intent: "calendar_create", calendarTitle: r.calendarTitle, calendarDateKey: r.calendarDateKey, calendarTime: r.calendarTime };
    }
    case "calendar_delete": {
      if (!isNonEmptyString(r.calendarKeyword)) return null;
      return { intent: "calendar_delete", calendarKeyword: r.calendarKeyword };
    }
    case "calendar_edit": {
      if (!isNonEmptyString(r.calendarKeyword)) return null;
      const calendarDateKey = isValidDateKey(r.calendarDateKey) ? r.calendarDateKey : undefined;
      const calendarTime = isValidTime(r.calendarTime) ? r.calendarTime : undefined;
      if (!calendarDateKey && !calendarTime) return null;
      return { intent: "calendar_edit", calendarKeyword: r.calendarKeyword, calendarDateKey, calendarTime };
    }
    case "calendar_query": {
      if (!isValidDateKey(r.calendarRangeFromKey) || !isValidDateKey(r.calendarRangeToKeyExclusive)) return null;
      const calendarRangeLabel = isNonEmptyString(r.calendarRangeLabel) ? r.calendarRangeLabel : "ที่ถามถึง";
      return {
        intent: "calendar_query",
        calendarRangeFromKey: r.calendarRangeFromKey,
        calendarRangeToKeyExclusive: r.calendarRangeToKeyExclusive,
        calendarRangeLabel,
      };
    }
    case "diary_create": {
      if (!isNonEmptyString(r.diaryText)) return null;
      const diaryCategory = isNonEmptyString(r.diaryCategory) ? r.diaryCategory : "อื่นๆ";
      return { intent: "diary_create", diaryText: r.diaryText, diaryCategory };
    }
    case "diary_query_date": {
      if (!isValidDateKey(r.diaryDateKey)) return null;
      return { intent: "diary_query_date", diaryDateKey: r.diaryDateKey };
    }
    case "diary_query_month":
      return { intent: "diary_query_month" };
    case "diary_search": {
      if (!isNonEmptyString(r.diarySearchTerm)) return null;
      return { intent: "diary_search", diarySearchTerm: r.diarySearchTerm };
    }
    case "task_create": {
      if (!isNonEmptyString(r.taskTitle)) return null;
      const taskDueDateKey = isValidDateKey(r.taskDueDateKey) ? r.taskDueDateKey : undefined;
      const taskDueTime = isValidTime(r.taskDueTime) ? r.taskDueTime : undefined;
      return { intent: "task_create", taskTitle: r.taskTitle, taskDueDateKey, taskDueTime };
    }
    case "task_complete": {
      if (!isNonEmptyString(r.taskKeyword)) return null;
      return { intent: "task_complete", taskKeyword: r.taskKeyword };
    }
    case "task_delete": {
      if (!isNonEmptyString(r.taskKeyword)) return null;
      return { intent: "task_delete", taskKeyword: r.taskKeyword };
    }
    case "task_list":
      return { intent: "task_list" };
    case "email_check":
      return { intent: "email_check" };
    case "email_send": {
      if (typeof r.emailTo !== "string" || !EMAIL_RE.test(r.emailTo)) return null;
      if (!isNonEmptyString(r.emailSubject) || !isNonEmptyString(r.emailBody)) return null;
      return { intent: "email_send", emailTo: r.emailTo, emailSubject: r.emailSubject, emailBody: r.emailBody };
    }
    case "trip_start": {
      if (!isNonEmptyString(r.tripName)) return null;
      return { intent: "trip_start", tripName: r.tripName };
    }
    case "trip_end":
      return { intent: "trip_end" };
    case "trip_status":
      return { intent: "trip_status" };
    case "set_province": {
      if (!isNonEmptyString(r.provinceName)) return null;
      return { intent: "set_province", provinceName: r.provinceName };
    }
    case "question": {
      if (!isNonEmptyString(r.question)) return null;
      return { intent: "question", question: r.question };
    }
    case "help":
      return { intent: "help" };
    case "view_link":
      return { intent: "view_link" };
    case "chitchat": {
      if (!isNonEmptyString(r.reply)) return null;
      return { intent: "chitchat", reply: r.reply };
    }
    case "unclear": {
      if (!isNonEmptyString(r.reply)) return null;
      return { intent: "unclear", reply: r.reply };
    }
    default:
      return null;
  }
}

function buildCategoryList(): string {
  return DEFAULT_CATEGORIES.map((c) => `${c.id} | ${c.type === "income" ? "รายรับ" : "รายจ่าย"} | ${c.icon} ${c.name}`).join(
    "\n"
  );
}

// Unique phrase used by the test harness (test-flow.mjs) to tell an
// interpreter call apart from a persona-styling call or an AI Q&A call, the
// same way persona.ts's system instruction has its own marker string.
function buildSystemInstruction(today: string, history: ConversationTurn[]): string {
  return [
    `คุณคือระบบตีความข้อความแชทสำหรับผู้ช่วยส่วนตัวชื่อ "${BOT_NAME}" (จดเงิน/นัดหมาย/ไดอารี่/ทริปเก็บรูป/ตารางเวร/สิ่งที่ต้องทำ/อีเมล/ถามคำถาม)`,
    `วันนี้คือ ${today} (รูปแบบ YYYY-MM-DD ปี ค.ศ.) ใช้วันที่นี้เป็นฐานเวลาคำนวณ "วันนี้"/"พรุ่งนี้"/"ศุกร์หน้า" ฯลฯ ห้ามเดาเอง`,
    "",
    "ประวัติการคุยล่าสุด (เรียงเก่าไปใหม่ ใช้แก้ความกำกวมของข้อความล่าสุด เช่น คำถามต่อเนื่อง หรือ 'เพิ่มอีก 20'):",
    formatHistoryForPrompt(history),
    "",
    "รายการหมวดหมู่เงิน (categoryId | ประเภท | ชื่อ) — เวลาระบุ categoryId ต้องเลือกจากลิสต์นี้เท่านั้น ห้ามสร้างขึ้นเอง:",
    buildCategoryList(),
    "",
    "อ่านข้อความล่าสุดของผู้ใช้ (ข้อความเดียว ไม่ใช่ทั้งประวัติ) แล้วตอบกลับเป็น JSON ล้วนๆ เท่านั้น (ห้ามมี markdown, ห้ามมีคำอธิบายอื่นนอก JSON) ตาม schema ต่อไปนี้ โดยเลือก intent ที่ตรงที่สุดหนึ่งอย่าง:",
    "",
    '{"intent":"transaction","transactions":[{"amount":number,"type":"income"หรือ"expense","categoryId":string,"note":string}]} — มีจำนวนเงินเกี่ยวข้อง (ซื้อของ รายรับ รายจ่าย) note คือคำอธิบายสั้นๆของรายการ',
    '{"intent":"calendar_create","calendarTitle":string,"calendarDateKey":"YYYY-MM-DD","calendarTime":"HH:MM"} — สร้างนัดใหม่ ต้องรู้ทั้งวันที่และเวลาแน่ชัด',
    '{"intent":"calendar_delete","calendarKeyword":string} — ลบนัดที่มีคำค้นหานี้',
    '{"intent":"calendar_edit","calendarKeyword":string,"calendarDateKey"?:"YYYY-MM-DD","calendarTime"?:"HH:MM"} — แก้วันที่/เวลาของนัดที่มีคำค้นหานี้',
    '{"intent":"calendar_query","calendarRangeFromKey":"YYYY-MM-DD","calendarRangeToKeyExclusive":"YYYY-MM-DD","calendarRangeLabel":string} — ถามว่ามีนัดอะไรบ้างในช่วงเวลาหนึ่ง (toKeyExclusive คือวันถัดจากวันสุดท้ายของช่วง) เฉพาะนัดหมายใน Google Calendar เท่านั้น — คำถามเรื่อง "เวร"/"ตารางเวร" ไม่ใช่ intent นี้ (ดูกติกาด้านล่าง)',
    '{"intent":"diary_create","diaryText":string,"diaryCategory":string} — บันทึกไดอารี่ใหม่ (diaryCategory ถ้าไม่ได้ระบุหมวดให้ใช้ "อื่นๆ")',
    '{"intent":"diary_query_date","diaryDateKey":"YYYY-MM-DD"} — ขอดูไดอารี่วันที่ระบุ',
    '{"intent":"diary_query_month"} — ขอดูสรุปไดอารี่เดือนนี้',
    '{"intent":"diary_search","diarySearchTerm":string} — ค้นหาไดอารี่ที่มีคำนี้',
    '{"intent":"task_create","taskTitle":string,"taskDueDateKey"?:"YYYY-MM-DD","taskDueTime"?:"HH:MM"} — เพิ่มสิ่งที่ต้องทำใหม่ในลิสต์ จะมีวันที่/เวลากำกับหรือไม่ก็ได้ (ใส่เฉพาะตอนผู้ใช้ระบุมาจริงๆ ห้ามเดา)',
    '{"intent":"task_complete","taskKeyword":string} — ทำเครื่องหมายว่าสิ่งที่ต้องทำที่มีคำค้นหานี้เสร็จแล้ว',
    '{"intent":"task_delete","taskKeyword":string} — ลบสิ่งที่ต้องทำที่มีคำค้นหานี้ออกจากลิสต์',
    '{"intent":"task_list"} — ขอดูรายการสิ่งที่ต้องทำทั้งหมดที่ยังไม่เสร็จ',
    '{"intent":"email_check"} — ขอเช็คอีเมลใหม่ที่ยังไม่ได้อ่าน',
    '{"intent":"email_send","emailTo":string,"emailSubject":string,"emailBody":string} — ส่งอีเมลใหม่ ต้องรู้ที่อยู่อีเมลผู้รับ หัวข้อ และเนื้อหาแน่ชัดทั้งหมด (ดูกติกาด้านล่างเรื่องห้ามเดาที่อยู่อีเมล)',
    '{"intent":"trip_start","tripName":string} — เริ่มทริปเก็บรูปใหม่',
    '{"intent":"trip_end"} — จบทริปที่เปิดอยู่',
    '{"intent":"trip_status"} — ถามว่าตอนนี้เปิดทริปอะไรอยู่',
    '{"intent":"set_province","provinceName":string} — ตั้งจังหวัด/เมืองสำหรับพยากรณ์อากาศ',
    '{"intent":"question","question":string} — คำถามเกี่ยวกับเงิน/นัดหมาย/ไดอารี่/เวร/สภาพอากาศ/ข่าวของผู้ใช้ (เขียน question ให้เป็นประโยคคำถามที่สมบูรณ์ในตัวเอง ไม่ต้องพึ่งประวัติการคุยอีก)',
    '{"intent":"help"} — ขอดูวิธีใช้/คำสั่งทั้งหมด',
    '{"intent":"view_link"} — ขอลิงก์เปิดดูข้อมูล/บัญชี/ปฏิทิน/ไดอารี่/รูปทริปผ่านเว็บเบราว์เซอร์ (เช่น "เปิดเว็บ", "ขอลิงก์เว็บ", "ดูเว็บไซต์หน่อย", "เปิดดูเว็บข้อมูล") — มีฟีเจอร์นี้จริง อย่าตอบว่าทำไม่ได้',
    '{"intent":"chitchat","reply":string} — พูดคุยทั่วไปที่ไม่ใช่คำสั่งอะไร (ทักทาย ชม คุยเล่น) ให้ตอบกลับตามธรรมชาติสั้นๆใน reply',
    '{"intent":"unclear","reply":string} — ข้อมูลสำคัญไม่ครบจะตัดสินใจ (เช่น มีจำนวนเงินแต่ไม่รู้ว่าซื้ออะไร, บอกจะนัดแต่ไม่มีวันที่/เวลา) ให้ reply เป็นคำถามกลับไปถามข้อมูลที่ขาดเท่านั้น',
    "",
    "กติกาสำคัญที่ห้ามฝ่าฝืน:",
    "- ห้ามสร้างตัวเลข วันที่ เวลา หรือข้อมูลใดๆ ที่ไม่ได้อยู่ในข้อความหรือบริบทการคุยจริงๆ ถ้าขาดข้อมูลสำคัญให้ใช้ intent unclear แทนการเดา",
    // Email is the one action this bot can take that leaves its own system
    // the instant it's confirmed — a mistaken calendar event or task can
    // just be deleted again, a sent email can't be unsent, and an invented
    // or misheard address means a stranger's inbox, not the bot's data.
    // General guessing is already banned above; spelled out again here
    // specifically for email_send because the cost of getting it wrong is
    // categorically different from every other intent in this list.
    '- ที่อยู่อีเมลใน email_send ต้องเป็นข้อความที่ผู้ใช้พิมพ์มาเป๊ะๆ เท่านั้น ห้ามเดา ห้ามแต่งขึ้นเอง ห้ามอนุมานจากชื่อคน/ความสัมพันธ์ (เช่น "แฟน", "หัวหน้า") เด็ดขาด ถ้าข้อความไม่มีที่อยู่อีเมลชัดเจนที่พิมพ์มาเอง ให้ใช้ intent unclear ถามที่อยู่อีเมลก่อนเสมอ แม้จะเคยคุยถึงอีเมลของคนนั้นในประวัติมาก่อนก็ตาม (ต่างจากกติกาการรวมข้อมูลจากประวัติของ calendar_create/transaction ด้านล่าง — เรื่องอีเมลไม่ใช้กติกานั้น)',
    "- categoryId ต้องเป็นค่าที่มีอยู่จริงในลิสต์หมวดหมู่ข้างบนเท่านั้น และต้อง type ตรงกับ income/expense ที่เลือก",
    // Found in a real report: "พรุ่งนี้เค้ามีเวรมั้ย"/"พรุ่งนี้ได้ขึ้นเวรมั้ย" got
    // classified as calendar_query and answered from Google Calendar
    // ("ไม่มีนัดพรุ่งนี้เลยนะคะ") — "เวร" (a personal shift-duty roster the
    // user fills in on its own web page, PLAN.md 17.18) is a completely
    // different data source from "นัด" (a real Calendar event), but nothing
    // told the model that, so it collapsed the unfamiliar concept into the
    // closest one it already knew about. Same shape of bug as 17.13's
    // missing view_link intent: an unlisted feature silently answers as if
    // it doesn't exist / is something else instead.
    '- "เวร"/"ตารางเวร" (ตารางเวรทำงานส่วนตัว) กับ "นัด" (Google Calendar) เป็นข้อมูลคนละชุดกัน ห้ามใช้ calendar_query/calendar_create/calendar_edit/calendar_delete ตอบคำถามเรื่องเวรเด็ดขาด คำถามเรื่องเวร (เช่น "มีเวรมั้ย", "ใครอยู่เวรเช้า", "พรุ่งนี้ได้ขึ้นเวรมั้ย") ให้ใช้ intent "question" เท่านั้น',
    // Preemptive version of the same 17.20 lesson, applied to a brand-new
    // feature from day one instead of waiting for a real report to catch
    // it. Originally written when a to-do could never carry a date at all,
    // so "has no date" was a safe stand-in for "must be task_create, never
    // calendar_create" — that stand-in broke once task_create gained
    // optional taskDueDateKey/taskDueTime (PLAN.md 17.27), since a to-do
    // with a due date now looks exactly like an appointment by that one
    // signal alone. Rewritten around the real distinguishing question
    // instead: is this a personal to-do/reminder (task_create, due date
    // optional either way), or an actual scheduled meeting/appointment
    // (calendar_create, always needs both a date and a time)?
    '- "สิ่งที่ต้องทำ" (to-do/reminder ส่วนตัว เช่น "จ่ายบิลค่าน้ำ", "โทรหาหมอ" — จะมีกำหนดวันที่/เวลากำกับด้วยหรือไม่ก็ได้) กับ "นัด" (Google Calendar เป็นนัดหมาย/การประชุม/การไปพบใครสักคน ต้องมีวันที่+เวลาเสมอ) เป็นข้อมูลคนละชุดกัน ห้ามตัดสินจาก "มี/ไม่มีวันที่" อย่างเดียว ให้ดูจากลักษณะของเรื่องว่าเป็นสิ่งที่ต้องทำ/เตือนตัวเองหรือเป็นนัดหมายจริง แม้ผู้ใช้จะระบุวันที่/เวลามาด้วยตอนบอกให้ "เพิ่มสิ่งที่ต้องทำ" ก็ยังใช้ task_create เหมือนเดิม (ใส่ taskDueDateKey/taskDueTime ตามที่ระบุมา) ห้ามใช้ calendar_create แทนเด็ดขาด และห้ามเดาวันที่ให้เพื่อยัดใส่ calendar_create',
    // Found in a real report: the bot proposed creating a calendar event
    // ("จะสร้างนัด: ... ใช่ไหม?"), the user replied restating one detail
    // ("ฉันนัดตอน 17.00 นะ") instead of the exact "ใช่" word the confirm step
    // needs — that decline silently clears the draft (confirmations.ts), and
    // without this rule the interpreter re-asked for the appointment's name
    // AND date from scratch, ignoring that both were right there in the
    // previous turn. Reconstructing the same intent from history costs
    // nothing safety-wise: it still only ever produces a fresh
    // confirm-before-save prompt (PLAN.md 17.9), never a direct save.
    '- ถ้าข้อความบอทล่าสุดในประวัติเป็นคำถามยืนยัน (ลงท้ายด้วย "ใช่ไหม?" หรือมี "(พิมพ์ \\"ใช่\\" เพื่อยืนยัน)") และข้อความล่าสุดของผู้ใช้ดูเหมือนกำลังตอบ/แก้ไข/เสริมรายละเอียดของสิ่งเดียวกัน (ไม่ใช่หัวข้อใหม่) ให้รวมข้อมูลเดิมจากคำถามนั้นเข้ากับข้อความใหม่ แล้วสร้าง intent เดิมขึ้นใหม่ทั้งหมด (เช่น calendar_create/transaction) แทนที่จะถามข้อมูลที่มีอยู่แล้วซ้ำ — ใช้ intent unclear เฉพาะตอนข้อมูลยังขาดจริงๆ แม้รวมกับประวัติแล้ว',
    // Found in the same report: a persona-styling pass afterward (persona.ts)
    // sometimes drifted the character's voice to male pronouns (ผม/ครับ)
    // when restyling a reply generated here — giving it the right voice from
    // the start reduces how much that second pass needs to change.
    `- เวลาแต่งข้อความเองใน reply (chitchat/unclear) ให้ใช้น้ำเสียงคาแรคเตอร์ "${BOT_NAME}" ผู้หญิงน่ารัก สรรพนาม "ฉัน" ลงท้ายด้วย "ค่ะ"/"นะคะ" เท่านั้น ห้ามใช้ "ผม"/"ครับ" หรือสรรพนามผู้ชายเด็ดขาด และต้องเป็นประโยคภาษาไทยที่ถูกต้อง อ่านเข้าใจง่าย ห้ามแต่งคำที่ไม่มีความหมาย`,
    "- ตอบเป็น JSON ล้วนๆ เท่านั้น ไม่มีข้อความอื่นใดๆ ก่อนหรือหลัง JSON",
  ].join("\n");
}

export async function interpretMessage(
  geminiApiKey: string,
  text: string,
  history: ConversationTurn[]
): Promise<InterpretedIntent | null> {
  const systemInstruction = buildSystemInstruction(bangkokDateKey(), history);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTERPRETER_TIMEOUT_MS);
  try {
    const raw = await askGemini(geminiApiKey, systemInstruction, text, controller.signal, true);
    const parsed: unknown = JSON.parse(raw);
    const intent = validateIntent(parsed);
    if (!intent) {
      console.error("interpretMessage: model returned a well-formed but invalid/unrecognized intent, falling back", raw);
    }
    return intent;
  } catch (err) {
    if (!(err instanceof GeminiError) && !(err instanceof SyntaxError)) {
      console.error("interpretMessage failed unexpectedly, falling back to deterministic parser", err);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Distinctive phrase in buildSystemInstruction above, used by the test
// harness (test-flow.mjs) to tell an interpreter call apart from a
// persona-styling call (persona.ts) or an AI Q&A call (aiCommands.ts) in its
// Gemini mock — the same marker-string trick persona.ts's own comment
// documents for PERSONA_SYSTEM_INSTRUCTION.
export const INTERPRETER_MARKER = "ระบบตีความข้อความแชท";
