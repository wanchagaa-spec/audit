// AI-assisted Q&A / analysis (PLAN.md 15.10): "ถาม <คำถาม>" answers an
// open-ended question about this month's spending and diary; "วิเคราะห์"
// (with or without extra text) asks for a freeform read of the same data.
// This is the one feature in the whole bot that calls an external AI model
// (Google Gemini) — every other feature is deliberately rule-based (PLAN.md
// 3, 12, 15.2) to stay free and predictable. The guardrail that makes this
// an acceptable exception rather than a step back: Gemini is only ever
// handed numbers this file already computed with the same plain arithmetic
// commands.ts uses, labeled as authoritative — it narrates and reasons in
// natural language, it never sums a column itself. See gemini.ts for the
// other half of that guarantee.

import { listCalendarEvents, type CalendarEventSummary } from "./calendar.ts";
import { categoryLabel, formatBaht } from "./commands.ts";
import { askGeminiWithSearch, GeminiError, SEARCH_MAX_OUTPUT_TOKENS } from "./gemini.ts";
import { signViewToken } from "./signedState.ts";
import { buildSearchChatReply, saveSearchResult } from "./webSearch.ts";
import { fetchFinanceNewsSummary, fetchNewsSummary } from "./news.ts";
import { readAllDiaryEntries, readAllTransactions, readShiftGrid, SHIFT_TYPES, type DiaryRow, type ShiftGrid, type ShiftType, type TransactionRow } from "./sheets.ts";
import { getUserProvince, type ActionCtx } from "./state.ts";
import { addDaysToDateKey, bangkokDateKey, bangkokMonthKey, bangkokStartOfDayIso, formatThaiDateLabel } from "./thaiDate.ts";
import { fetchWeatherSummary } from "./weather.ts";

// How far ahead of today to pull real Calendar events for — calendar
// questions ("นัดพรุ่งนี้มีไหม", "เช็คนัดวันที่ ...") are inherently
// forward-looking, unlike money/diary which are scoped to the current month,
// so this uses its own today-relative window instead of bangkokMonthKey.
const CALENDAR_LOOKAHEAD_DAYS = 30;

type Handler = (ctx: ActionCtx) => Promise<string>;

const USAGE_HINT = 'พิมพ์คำถามต่อท้ายด้วยนะ เช่น "ถาม เดือนนี้ใช้เงินหมวดไหนเยอะสุด"';
const FALLBACK_MESSAGE =
  "ขอโทษด้วย ตอนนี้ระบบ AI ขัดข้องหรือโควตาฟรีเต็มพอดี ลองใหม่อีกครั้งในอีกสักครู่นะ";

// Caps how many individual rows go into the prompt — a month's worth of
// transactions/diary entries is normally well under this, but an unusually
// active month shouldn't be allowed to blow up the request size or cost.
// The precomputed totals/top-categories below stay accurate regardless,
// since those are computed from the full month's data, not the capped list.
const MAX_ROWS_IN_PROMPT = 200;

function parseAiRequest(text: string): { question: string } | null {
  const trimmed = text.trim();

  const askMatch = trimmed.match(/^ถาม\s*(.*)$/s);
  if (askMatch) {
    const question = askMatch[1].trim();
    return { question }; // empty question handled by the caller with USAGE_HINT
  }

  const analyzeMatch = trimmed.match(/^วิเคราะห์(?:การใช้จ่าย)?(?:เดือนนี้)?\s*(.*)$/s);
  if (analyzeMatch) {
    const extra = analyzeMatch[1].trim();
    return { question: extra || "ช่วยวิเคราะห์พฤติกรรมการใช้จ่ายและไดอารี่เดือนนี้ให้หน่อย มีอะไรน่าสังเกตบ้าง" };
  }

  return null;
}

// A question matching any of these routes to fetchFinanceNewsSummary
// instead of the personal-data Q&A pipeline below — "ถาม ข่าวหุ้น" and
// similar have nothing to do with the user's own money/calendar/diary, so
// there's no reason to fetch any of that just to answer them.
const FINANCE_KEYWORDS = [
  "ข่าวหุ้น", "หุ้นสหรัฐ", "ตลาดหุ้น", "หุ้นอเมริกา", "บิตคอยน์", "บิทคอยน์", "คริปโต",
  "ราคาทอง", "ข่าวทอง", "ข่าวการเงิน", "การเงินสหรัฐ", "เศรษฐกิจสหรัฐ",
  "bitcoin", "crypto", "nasdaq", "dow jones", "s&p", "wall street",
];

function isFinanceNewsQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  return FINANCE_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
}

// Same idea as FINANCE_KEYWORDS, for general Thai daily-news questions —
// "ถาม ข่าววันนี้" also has nothing to do with the user's own data. Checked
// after isFinanceNewsQuestion (below), so a more specific finance phrase
// like "ข่าวหุ้น" is never shadowed by the generic "ข่าว" catch-all here.
const DOMESTIC_NEWS_PHRASES = ["ข่าววันนี้", "ข่าวประจำวัน", "ข่าวไทย", "ข่าวในประเทศ", "ข่าวสารวันนี้", "ข่าวล่าสุด"];

// The bare "ข่าว" catch-all below is what makes "มีข่าวอะไรบ้าง" work without
// enumerating every phrasing — but on its own it's substring-matched against
// the whole question, so it also swallowed genuine personal-data questions
// that merely happen to contain the word ("เดือนนี้จ่ายค่าหนังสือพิมพ์กับข่าวสาร
// ไปเท่าไหร่"), answering with world news instead of the user's own numbers.
// These are the markers that say a question is about this account's data, in
// which case the catch-all stands down and the normal Q&A pipeline runs. The
// specific phrases above are unambiguous enough to skip this check entirely.
const PERSONAL_DATA_KEYWORDS = [
  "เงิน", "จ่าย", "รายรับ", "รายจ่าย", "ยอด", "งบ", "หมวด",
  "นัด", "ปฏิทิน", "ไดอารี่", "เวร", "สิ่งที่ต้องทำ", "ทริป",
];

function isDomesticNewsQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  if (DOMESTIC_NEWS_PHRASES.some((k) => lower.includes(k))) return true;
  if (!lower.includes("ข่าว")) return false;
  return !PERSONAL_DATA_KEYWORDS.some((k) => lower.includes(k));
}

function totals(rows: TransactionRow[]): { income: number; expense: number } {
  return {
    income: rows.filter((r) => r.type === "income").reduce((s, r) => s + r.amount, 0),
    expense: rows.filter((r) => r.type === "expense").reduce((s, r) => s + r.amount, 0),
  };
}

// Turns the checked-cell grid into per-day lines Gemini can read directly
// (e.g. "5: เวรเช้า, เวรบ่าย") — grouped by day rather than by shift type
// since questions are almost always day-first ("ใครอยู่เวรเช้าวันนี้",
// "วันนี้มีเวรอะไรบ้าง").
function formatShiftLines(grid: ShiftGrid): string[] {
  const byDay = new Map<number, ShiftType[]>();
  for (const type of SHIFT_TYPES) {
    for (const day of grid.checked[type]) {
      const list = byDay.get(day);
      if (list) list.push(type);
      else byDay.set(day, [type]);
    }
  }
  return Array.from(byDay.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([day, types]) => `${day}: ${types.join(", ")}`);
}

function topCategories(rows: TransactionRow[], limit = 5): string[] {
  const byCategory = new Map<string, number>();
  for (const r of rows) {
    if (r.type !== "expense") continue;
    byCategory.set(r.categoryId, (byCategory.get(r.categoryId) ?? 0) + r.amount);
  }
  return Array.from(byCategory.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([categoryId, amount]) => `${categoryLabel(categoryId)}: ${formatBaht(amount)} บาท`);
}

// Builds the whole prompt Gemini sees: authoritative precomputed numbers
// first (explicitly labeled as the only numbers it should quote back), then
// capped raw row lists for pattern/qualitative questions the totals alone
// can't answer (e.g. "ซื้อกาแฟกี่ครั้งแล้ว", "ช่วงนี้อารมณ์เป็นยังไงบ้าง").
// `calendarEvents` is `null` rather than `[]` when the fetch itself failed
// (see matchAiCommand) — kept distinct from "fetched fine, zero events" so
// the prompt can say "couldn't check" instead of implying a confirmed empty
// calendar, which would otherwise read as "you have no appointments."
function buildSystemInstruction(
  todayLabel: string,
  weatherLine: string | null,
  month: string,
  txRows: TransactionRow[],
  diaryRows: DiaryRow[],
  calendarEvents: CalendarEventSummary[] | null,
  calendarRangeLabel: string,
  shiftGrid: ShiftGrid
): string {
  const { income, expense } = totals(txRows);
  const top = topCategories(txRows);
  const txLines = txRows
    .slice(-MAX_ROWS_IN_PROMPT)
    .map((r) => `${r.date} ${r.type === "income" ? "รับ" : "จ่าย"} ${formatBaht(r.amount)} ${categoryLabel(r.categoryId)} — ${r.note || r.rawText}`);
  const diaryLines = diaryRows
    .slice(-MAX_ROWS_IN_PROMPT)
    .map((r) => `${r.date} [${r.category}] ${r.text}`);
  const calendarLines = (calendarEvents ?? [])
    .slice(-MAX_ROWS_IN_PROMPT)
    .map((e) => `${e.dateKey} ${e.time || "(ไม่ระบุเวลา)"} ${e.title}`);
  const shiftLines = formatShiftLines(shiftGrid);

  return [
    "คุณเป็นผู้ช่วยส่วนตัวในแชท LINE ที่ช่วยตอบคำถามเกี่ยวกับการเงิน นัดหมาย และไดอารี่ของผู้ใช้คนเดียว",
    "ตอบเป็นภาษาไทย น้ำเสียงเป็นกันเอง กระชับ ความยาวพอเหมาะสำหรับข้อความแชท (ไม่เกินสองสามย่อหน้าสั้นๆ)",
    "ข้อมูลสามชุดด้านล่าง (ตัวเลขการเงิน/นัดหมายในปฏิทิน/ไดอารี่) เป็นคนละแหล่งกัน ห้ามใช้ปนกัน — เช่น",
    "ห้ามหยิบข้อความในไดอารี่มาตอบคำถามว่ามีนัดหมายในปฏิทินจริงหรือไม่ ให้ใช้เฉพาะรายการนัดหมายที่ให้มา",
    "",
    // A model has no reliable notion of "now" on its own — without this, a
    // real user asked "วันนี้วันที่" and got a date one day off, since
    // Gemini was left to guess instead of being told outright. Same
    // guardrail principle as the money numbers below: never let it infer
    // something this code already knows for certain.
    `วันนี้คือวันที่ ${todayLabel} (ใช้วันที่นี้เท่านั้นเวลาตอบคำถามเกี่ยวกับ "วันนี้"/"พรุ่งนี้"/วันที่ปัจจุบัน ห้ามเดาหรือคำนวณเอง)`,
    "",
    weatherLine
      ? `สภาพอากาศตอนนี้ (ข้อมูลจริง ใช้ค่านี้เท่านั้นถ้าถามเรื่องอากาศ ห้ามเดาเอง): ${weatherLine}`
      : 'ยังไม่มีข้อมูลสภาพอากาศ (ผู้ใช้ยังไม่ได้ตั้งจังหวัด) — ถ้าถามเรื่องอากาศ ให้บอกว่ายังไม่รู้พื้นที่ แนะนำให้พิมพ์ "ตั้งจังหวัด <ชื่อ>" ก่อน',
    "",
    `ตัวเลขที่คำนวณไว้แล้วสำหรับเดือน ${month} (ใช้ตัวเลขชุดนี้เท่านั้นเวลาตอบคำถามเกี่ยวกับยอดเงิน ห้ามคำนวณหรือเดาตัวเลขเอง):`,
    `- รายรับรวม: ${formatBaht(income)} บาท`,
    `- รายจ่ายรวม: ${formatBaht(expense)} บาท`,
    `- คงเหลือ: ${formatBaht(income - expense)} บาท`,
    top.length > 0 ? `- หมวดที่จ่ายเยอะสุด: ${top.join(", ")}` : "- ยังไม่มีรายจ่ายเดือนนี้",
    "",
    `รายการรายรับ-รายจ่ายเดือนนี้ (ล่าสุด ${txLines.length} รายการ ใช้ดูรูปแบบ/พฤติกรรม ไม่ใช่ใช้คำนวณยอดรวมเอง):`,
    txLines.length > 0 ? txLines.join("\n") : "(ไม่มีรายการ)",
    "",
    `นัดหมายในปฏิทิน (Google Calendar) ช่วง ${calendarRangeLabel}:`,
    calendarEvents === null
      ? "(ไม่สามารถดึงข้อมูลปฏิทินได้ตอนนี้ — ถ้าคำถามเกี่ยวกับนัดหมาย ให้บอกตรงๆ ว่าตอนนี้เช็คปฏิทินไม่ได้ แทนที่จะเดาว่ามีหรือไม่มีนัด)"
      : calendarLines.length > 0
        ? calendarLines.join("\n")
        : "(ไม่มีนัดหมายในช่วงนี้ — เป็นข้อมูลจริงจากปฏิทิน ไม่ใช่ไม่มีข้อมูล)",
    "",
    `บันทึกไดอารี่เดือนนี้ (ล่าสุด ${diaryLines.length} รายการ):`,
    diaryLines.length > 0 ? diaryLines.join("\n") : "(ไม่มีบันทึก)",
    "",
    `ตารางเวรของผู้ใช้เดือน ${month} (จากตารางเวรที่ผู้ใช้ติ๊กไว้เอง แต่ละบรรทัดคือวันที่แล้วตามด้วยประเภทเวรที่ติ๊กในวันนั้น ใช้ข้อมูลชุดนี้เท่านั้นเวลาตอบคำถามเรื่องเวร ห้ามเดา):`,
    shiftLines.length > 0 ? shiftLines.join("\n") : "(ยังไม่ได้ติ๊กเวรไว้เลยเดือนนี้)",
    "",
    // Web search (PLAN.md 17.38). The split below is the whole rule, and it
    // matters in both directions. Personal data is never on the web, so
    // searching for a question about this user's own money/appointments/
    // diary/shifts could only ever produce a confident answer about someone
    // else's life — the old "say you don't have enough data" behaviour stays
    // exactly as it was for those. Everything else, the model was previously
    // forced to refuse or answer from stale training data; now it can look.
    "ถ้าคำถามเป็นเรื่องข้อมูลส่วนตัวของผู้ใช้ (เงิน นัดหมาย ไดอารี่ เวร) แล้วไม่มีอยู่ในข้อมูลที่ให้มาข้างบน ให้บอกตรงๆ ว่าไม่มีข้อมูลพอจะตอบ ห้ามเดา และห้ามใช้ Google Search หาข้อมูลส่วนตัวของผู้ใช้เด็ดขาด (เว็บไม่มีทางรู้ข้อมูลส่วนตัวของผู้ใช้)",
    "ถ้าเป็นคำถามความรู้ทั่วไป ข่าวสาร ราคา หรือข้อมูลอะไรก็ตามที่ไม่ได้อยู่ในข้อมูลส่วนตัวข้างบน ให้ใช้ Google Search ค้นหาข้อมูลจริงมาตอบ ห้ามตอบจากความจำของโมเดลเอง",
    // Nothing in the chat depends on this any more (the chat gets the link
    // alone — see buildSearchChatReply), but it still shapes the page well:
    // a reader who has just tapped through wants the answer in the first
    // line, not after three paragraphs of preamble.
    "เวลาตอบจากผลการค้นหาเว็บ ให้ย่อหน้าแรกเป็นคำตอบสั้นๆ ที่จบในตัวเอง (2-3 ประโยค อ่านแล้วเข้าใจโดยไม่ต้องอ่านต่อ) แล้วค่อยขยายรายละเอียดในย่อหน้าถัดไป",
  ].join("\n");
}

// Answers any free-form question about the user's own money/calendar/diary,
// or general finance/domestic news — the full pipeline behind "ถาม"/
// "วิเคราะห์" (matchAiCommand below), factored out so the AI interpreter's
// "question" intent (aiInterpreter.ts, dispatched in index.ts) can reuse the
// exact same guarded flow for a question it extracted itself from free-form
// text, instead of re-fetching data or re-building a system instruction.
export async function answerQuestion(ctx: ActionCtx, question: string): Promise<string> {
  // Checked before touching any of the user's own Sheets/Calendar/Diary
  // data — a finance-news question is a completely different kind of
  // request (world news, not personal data), so there's nothing to gain
  // from fetching any of that just to answer it.
  if (isFinanceNewsQuestion(question)) {
    try {
      const summary = await fetchFinanceNewsSummary(ctx.geminiApiKey);
      return summary ?? FALLBACK_MESSAGE;
    } catch (err) {
      console.error("fetchFinanceNewsSummary failed", err);
      return FALLBACK_MESSAGE;
    }
  }

  // Same reasoning as the finance branch above — general daily-news
  // questions aren't about the user's own money/calendar/diary either.
  if (isDomesticNewsQuestion(question)) {
    try {
      const summary = await fetchNewsSummary(ctx.geminiApiKey);
      return summary ?? FALLBACK_MESSAGE;
    } catch (err) {
      console.error("fetchNewsSummary failed", err);
      return FALLBACK_MESSAGE;
    }
  }

  const month = bangkokMonthKey();
  const today = bangkokDateKey();
  const rangeEndExclusive = addDaysToDateKey(today, CALENDAR_LOOKAHEAD_DAYS);
  const calendarRangeLabel = `${formatThaiDateLabel(today)} ถึง ${formatThaiDateLabel(
    addDaysToDateKey(today, CALENDAR_LOOKAHEAD_DAYS - 1)
  )}`;

  const [allTx, allDiary, shiftGrid] = await Promise.all([
    readAllTransactions(ctx.accessToken, ctx.spreadsheetId),
    readAllDiaryEntries(ctx.accessToken, ctx.spreadsheetId, ctx.kv),
    readShiftGrid(ctx.accessToken, ctx.spreadsheetId, ctx.kv, month),
  ]);
  // Calendar access needs its own OAuth scope some already-linked accounts
  // never granted, and can fail for other transient reasons too — fetched
  // separately (not in the Promise.all above) and caught locally so a
  // calendar hiccup degrades to "couldn't check calendar" instead of
  // blocking money/diary questions that don't even need it, the way it
  // would if this threw uncaught up to handleTextMessage's calendar-scope
  // handling (which would show a relink prompt instead of any AI answer).
  let calendarEvents: CalendarEventSummary[] | null;
  try {
    calendarEvents = await listCalendarEvents(
      ctx.accessToken,
      bangkokStartOfDayIso(today),
      bangkokStartOfDayIso(rangeEndExclusive)
    );
  } catch (err) {
    console.error("askGemini: fetching calendar events failed, continuing without them", err);
    calendarEvents = null;
  }

  // Same best-effort treatment as Calendar above: no province set at all is
  // a normal, expected state (not an error), and a transient weather API
  // failure must not block an unrelated money/calendar/diary question.
  let weatherLine: string | null = null;
  try {
    const province = await getUserProvince(ctx.kv, ctx.lineUserId);
    if (province) weatherLine = await fetchWeatherSummary(province);
  } catch (err) {
    console.error("askGemini: fetching weather failed, continuing without it", err);
  }

  const monthTx = allTx.filter((r) => r.date?.startsWith(month));
  const monthDiary = allDiary.filter((r) => r.date?.startsWith(month));
  const systemInstruction = buildSystemInstruction(
    formatThaiDateLabel(today),
    weatherLine,
    month,
    monthTx,
    monthDiary,
    calendarEvents,
    calendarRangeLabel,
    shiftGrid
  );

  // The first timeout this call has ever had. It was already the only Gemini
  // call in the codebase that could hang indefinitely, and offering the
  // search tool makes a slow request meaningfully more likely — the model
  // may run several real searches before it starts writing. Deliberately
  // generous: this is a guard against hanging forever, not a latency target.
  // A question is an explicit request where some waiting is expected, and a
  // reply slow enough to lose its LINE reply token still reaches the user as
  // a push (see replyOrPush in index.ts). Worth revisiting against real
  // numbers once there are some.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QUESTION_TIMEOUT_MS);
  try {
    const result = await askGeminiWithSearch(ctx.geminiApiKey, systemInstruction, question, {
      signal: controller.signal,
      maxOutputTokens: SEARCH_MAX_OUTPUT_TOKENS,
    });

    // No grounding means the model answered from the data already in the
    // prompt — an ordinary question about this account's own rows. That path
    // is unchanged: the whole answer goes straight into the chat, with no
    // page and no link, because there is nothing here Google requires be
    // displayed and nothing a page would add.
    if (!result.grounding) return result.text;

    return await buildGroundedReply(ctx, question, result.text, result.grounding);
  } catch (err) {
    console.error("answerQuestion failed", err);
    if (err instanceof GeminiError) return FALLBACK_MESSAGE;
    // An aborted fetch throws a DOMException rather than a GeminiError, and
    // a timed-out question should read the same to the user as a failed one.
    if (controller.signal.aborted) return FALLBACK_MESSAGE;
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

const QUESTION_TIMEOUT_MS = 15000;

// A grounded answer can't be delivered as a chat message at all: Google
// requires its Search Suggestions be shown alongside it and those are HTML,
// so the answer is stored and the chat gets only the link to the page that
// can display it (PLAN.md 17.38, see webSearch.ts and viewSearchPage.ts).
//
// If storing or signing fails there is a real answer in hand and nowhere
// permitted to put it, so this says the search failed rather than sending
// the answer inline. That loses an answer the user asked for, which is a
// genuine cost — but sending it would be displaying a grounded result with
// no Search Suggestions, the exact thing this whole two-surface design
// exists to avoid, and "sometimes we do it anyway when KV hiccups" is not a
// rule anyone can rely on. Rare enough to be the right trade: it takes KV
// itself failing, and the user can simply ask again.
async function buildGroundedReply(
  ctx: ActionCtx,
  question: string,
  answer: string,
  grounding: NonNullable<Awaited<ReturnType<typeof askGeminiWithSearch>>["grounding"]>
): Promise<string> {
  try {
    const id = await saveSearchResult(ctx.kv, ctx.lineUserId, {
      question,
      answer,
      sources: grounding.sources,
      searchEntryPointHtml: grounding.searchEntryPointHtml,
      createdAtIso: new Date().toISOString(),
    });
    const token = await signViewToken(ctx.lineUserId, ctx.stateSigningSecret);
    const pageUrl = `${ctx.origin}/view/search?token=${token}&id=${id}`;
    return buildSearchChatReply(pageUrl);
  } catch (err) {
    console.error("buildGroundedReply: storing the search result failed, no page to link to", err);
    return FALLBACK_MESSAGE;
  }
}

export async function matchAiCommand(text: string): Promise<Handler | null> {
  const request = parseAiRequest(text);
  if (!request) return null;

  if (!request.question) {
    return async () => USAGE_HINT;
  }

  return (ctx) => answerQuestion(ctx, request.question);
}
