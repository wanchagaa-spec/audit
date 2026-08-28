// Morning briefing (PLAN.md 15.11): the first greeting ("สวัสดี", "กู๊ดมอร์นิ่ง",
// etc. — see chatEngine.ts's GREETINGS) of each Bangkok calendar day gets a
// full briefing (date, weather if a province is set, AI-summarized daily
// news); every later greeting that same day just gets a short "ว่าไง"
// prompt instead, so it doesn't repeat the whole briefing every time someone
// says hi.

import { listCalendarEvents } from "./calendar.ts";
import { ANSWER_MAX_OUTPUT_TOKENS, askGemini } from "./gemini.ts";
import { refreshAccessToken } from "./googleAuth.ts";
import { groupIdFromSubject } from "./groupSubject.ts";
import { pushToLine } from "./line.ts";
import { buildGoldBtcLines, fetchMarketSnapshot } from "./marketData.ts";
import { fetchNewsSummary } from "./news.ts";
import { applyPersona } from "./persona.ts";
import { budgetLevel } from "./budgetCommands.ts";
import { categoryLabel, formatBaht } from "./format.ts";
import { buildRecurringStatus, recurringDueLines } from "./recurring.ts";
import { readAllDiaryEntries, readMonthTransactionsAndBudgets, readRecurringWithPaid, readShiftGrid, SHIFT_TYPES } from "./sheets.ts";
import { listStuckUploads, type StuckUploads } from "./uploadQueue.ts";
import { getBotSettings, wantsMorningBriefing } from "./settings.ts";
import { fetchAirQuality, formatAirQualityLine } from "./airQuality.ts";
import { geocodeProvince, fetchWeatherSummary } from "./weather.ts";
import {
  getAccountLink,
  getLastBroadcastDate,
  getLastGreetingDate,
  getUserProvince,
  setLastBroadcastDate,
  setLastGreetingDate,
  setUserProvince,
} from "./state.ts";
import {
  addDaysToDateKey,
  bangkokDateKey,
  bangkokHourMinute,
  bangkokStartOfDayIso,
  bangkokWeekdayIndex,
  formatThaiDateLabel,
} from "./thaiDate.ts";
import type { Env } from "./index.ts";

const WEEKDAY_TH = ["วันจันทร์", "วันอังคาร", "วันพุธ", "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์", "วันอาทิตย์"];

// Unlike the trip/calendar/diary command handlers, this doesn't need a
// Google access token at all (just KV, plus Open-Meteo which needs no auth
// of its own) — so it deliberately isn't shaped like ActionCtx-based
// Handler the way those are, to avoid making callers fetch a Google token
// this command has no use for.
// Shared by the regex matcher below and the AI interpreter's "set_province"
// intent (aiInterpreter.ts, dispatched in index.ts).
export async function setProvinceByName(kv: KVNamespace, lineUserId: string, requested: string): Promise<string> {
  let geocoded;
  try {
    geocoded = await geocodeProvince(requested);
  } catch (err) {
    console.error("setProvinceByName: geocoding failed", err);
    return "ขอโทษด้วย ตอนนี้ระบบค้นหาจังหวัดขัดข้อง ลองใหม่อีกครั้งนะ";
  }
  if (!geocoded) {
    return `หาจังหวัด/เมือง "${requested}" ไม่เจอนะ ลองพิมพ์เป็นภาษาอังกฤษหรือสะกดแบบอื่นดู`;
  }
  await setUserProvince(kv, lineUserId, geocoded);
  return `ตั้งพื้นที่พยากรณ์อากาศเป็น "${geocoded.name}" ให้แล้วนะ จะใช้บอกสภาพอากาศตอนทักทายครั้งแรกของวัน`;
}

/**
 * "ฝุ่นวันนี้" / "PM2.5" — the air-quality line on demand (PLAN.md 17.71).
 *
 * The briefing already carries it once a day, but the question people
 * actually ask is "is it bad *right now*, before I go out" — and in the
 * north that changes hour to hour during burning season. A once-a-morning
 * number cannot answer it.
 *
 * Whole-phrase matching, not a substring. This codebase has been bitten
 * three times by short Thai fragments swallowing unrelated messages ("นัด",
 * "ข่าว", "ยา"), and "ฝุ่น" alone sits inside plenty of ordinary sentences
 * — "ซื้อผ้าเช็ดฝุ่น 50" is an expense, not a weather question.
 */
const AIR_QUALITY_PHRASES = [
  "ฝุ่น",
  "ฝุ่นวันนี้",
  "ค่าฝุ่น",
  "ค่าฝุ่นวันนี้",
  "ฝุ่นเป็นไง",
  "ฝุ่นเป็นยังไง",
  "ฝุ่นวันนี้เป็นไง",
  "ฝุ่นวันนี้เป็นยังไง",
  "pm2.5",
  "pm25",
  "อากาศเป็นพิษไหม",
];

/**
 * The answer itself, shared by the typed command and the AI interpreter's
 * `air_quality` intent (PLAN.md 17.72).
 *
 * One function for both on purpose: the matcher only ever catches the exact
 * phrases listed above, and the interpreter is what catches everything else
 * someone might say. Two implementations would drift, and the phrasing that
 * got the worse one would look like a different feature.
 */
export async function answerAirQuality(kv: KVNamespace, lineUserId: string): Promise<string> {
  const province = await getUserProvince(kv, lineUserId);
  if (!province) return 'ยังไม่รู้พื้นที่ของคุณเลย พิมพ์ "ตั้งจังหวัด <ชื่อ>" ก่อนนะ แล้วจะบอกค่าฝุ่นให้ได้';
  try {
    const reading = await fetchAirQuality(province);
    // No number rather than a stale or invented one: this is the input to a
    // decision about going outside.
    if (!reading) return `ตอนนี้ดึงค่าฝุ่นที่${province.name}ไม่ได้ ลองใหม่อีกทีนะ`;
    const pm10Part = reading.pm10 !== null ? `\n(PM10 ${reading.pm10.toFixed(1)} µg/m³)` : "";
    return `${formatAirQualityLine(reading, province.name)}${pm10Part}`;
  } catch (err) {
    console.error("answerAirQuality: air quality fetch failed", err);
    return `ตอนนี้ดึงค่าฝุ่นที่${province.name}ไม่ได้ ลองใหม่อีกทีนะ`;
  }
}

export function matchAirQualityCommand(
  text: string
): ((kv: KVNamespace, lineUserId: string) => Promise<string>) | null {
  const normalized = text.trim().toLowerCase().replace(/[?？!]/g, "").trim();
  if (!AIR_QUALITY_PHRASES.includes(normalized)) return null;
  return answerAirQuality;
}

export function matchProvinceCommand(text: string): ((kv: KVNamespace, lineUserId: string) => Promise<string>) | null {
  const m = text.trim().match(/^ตั้งจังหวัด\s+(.+)$/s);
  if (!m) return null;
  const requested = m[1].trim();
  return (kv, lineUserId) => setProvinceByName(kv, lineUserId, requested);
}

// Best-effort: weather and news are independent nice-to-haves, so one
// failing must never take the other down with it, and neither should ever
// block the greeting itself from going out — see the try/catches below.
//
// `sharedNewsBlock`: the reactive per-user path (buildMorningBriefing) leaves
// this undefined and fetches its own news, since it only ever runs for one
// user at a time. The 7:00 broadcast (broadcastMorningBriefings below) fetches
// the news once for the whole run and passes the same block to every user
// instead — the news itself isn't personalized, so N users would otherwise
// mean N identical Gemini calls fired within the same minute.
async function buildBriefingBody(
  env: Env,
  kv: KVNamespace,
  lineUserId: string,
  sharedNewsBlock?: string | null
): Promise<string> {
  const today = bangkokDateKey();
  const dateLine = `${WEEKDAY_TH[bangkokWeekdayIndex()]} ที่ ${formatThaiDateLabel(today)}`;

  const province = await getUserProvince(kv, lineUserId);
  let weatherLine: string | null = null;
  let airLine: string | null = null;
  if (province) {
    // In parallel, and each failing on its own: the two answer different
    // questions ("will I get rained on" / "can I breathe out there"), and
    // losing one is no reason to lose the other.
    const [weather, air] = await Promise.allSettled([
      fetchWeatherSummary(province),
      fetchAirQuality(province),
    ]);
    if (weather.status === "fulfilled") weatherLine = weather.value;
    else console.error("buildBriefingBody: weather fetch failed", weather.reason);
    if (air.status === "fulfilled") {
      airLine = air.value ? formatAirQualityLine(air.value, province.name) : null;
    } else {
      console.error("buildBriefingBody: air quality fetch failed", air.reason);
    }
  }

  const newsBlock = sharedNewsBlock !== undefined ? sharedNewsBlock : await fetchDailyNewsBlock(env, kv);

  const parts = [`สวัสดีตอนเช้า ☀️ วันนี้${dateLine}`];
  if (weatherLine) parts.push(weatherLine);
  else if (!province) parts.push('ยังไม่รู้พื้นที่ของคุณเลย พิมพ์ "ตั้งจังหวัด <ชื่อ>" ถ้าอยากให้บอกสภาพอากาศกับค่าฝุ่นด้วยนะ');
  // Right after the weather, because it is the same decision: what to wear
  // and whether to go out.
  if (airLine) parts.push(airLine);
  if (newsBlock) parts.push(`📰 ข่าวเช้านี้:\n${newsBlock}`);
  return parts.join("\n\n");
}

async function fetchDailyNewsBlock(env: Env, kv: KVNamespace): Promise<string | null> {
  try {
    return await fetchNewsSummary(env.GEMINI_API_KEY, kv);
  } catch (err) {
    console.error("fetchDailyNewsBlock: news summary failed", err);
    return null;
  }
}

/** Full morning briefing — call only when this is the first greeting of the
 * Bangkok calendar day for this user (see shouldSendBriefing). */
export async function buildMorningBriefing(env: Env, kv: KVNamespace, lineUserId: string): Promise<string> {
  return buildBriefingBody(env, kv, lineUserId);
}

/** Short reply for any greeting after the first one on the same day. */
export function buildReturnGreeting(): string {
  return "ว่าไง ให้ฉันช่วยอะไรดี 😊";
}

export type GreetingKind =
  | "welcome" // never greeted this account before — the original feature-list intro fits better
  // than a weather/news briefing they have no context for yet (no province set, no idea why
  // they're suddenly getting news)
  | "briefing" // first greeting of the Bangkok calendar day, but not the very first ever
  | "return"; // any later greeting the same day

/** Also records today as the last-greeted date for "welcome"/"briefing" (not
 * "return", which doesn't change anything) — the caller uses the result to
 * pick which of buildMorningBriefing/buildReturnGreeting/the original
 * welcome message to send. */
export async function classifyGreeting(kv: KVNamespace, lineUserId: string): Promise<GreetingKind> {
  const today = bangkokDateKey();
  const last = await getLastGreetingDate(kv, lineUserId);
  if (last === today) return "return";
  await setLastGreetingDate(kv, lineUserId, today);
  return last === null ? "welcome" : "briefing";
}

// Keeps steady load on LINE/weather/Gemini regardless of how many accounts
// are linked — same shape as index.ts's processWithConcurrencyLimit, kept as
// its own tiny copy here rather than imported, since index.ts itself imports
// from this file (buildMorningBriefing, classifyGreeting, ...) and importing
// a runtime value back the other way would create an actual import cycle.
const BROADCAST_CONCURRENCY_LIMIT = 5;

async function processInBatches<T>(items: T[], limit: number, handler: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.allSettled(items.slice(i, i + limit).map(handler));
  }
}

// Personal `link:<lineUserId>` KV keys only — state.ts doesn't export this
// prefix as a constant (getAccountLink/setAccountLink just inline it), so
// this must stay in sync with those if that ever changes.
const ACCOUNT_LINK_PREFIX = "link:";

// Broadcast-only extras (PLAN.md 17.22): gold/BTC price, today's Calendar
// appointments, today's shift, and a short AI reflection on yesterday's
// diary — added only to the 7:00 broadcast below, not the reactive "สวัสดี"
// greeting (buildMorningBriefing above), since these all need the account's
// own Google access token, unlike weather/news which need none at all. Each
// is independently best-effort: a failure here degrades to omitting just
// that one line, exactly like weather/news above, never blocking the rest
// of the broadcast for that user.

/**
 * Today's appointments, and tomorrow's when there are any (PLAN.md 17.81).
 *
 * Today alone gave an 08:00 appointment an hour's notice — too late to move
 * a shift, refill a prescription or find the card. Tomorrow costs nothing
 * extra: it is the same single Calendar call with the window one day wider,
 * inside a message that was going out regardless, the same trade that made
 * the bill and budget lines affordable (PLAN.md 17.59, 17.61).
 *
 * The tomorrow block is omitted entirely when it is empty. "พรุ่งนี้ไม่มีนัด"
 * every single morning is a line people stop reading, which costs the
 * today block its readership too.
 */
async function buildTodayCalendarLine(accessToken: string, today: string): Promise<string> {
  const tomorrow = addDaysToDateKey(today, 1);
  try {
    const events = await listCalendarEvents(
      accessToken,
      bangkokStartOfDayIso(today),
      bangkokStartOfDayIso(addDaysToDateKey(today, 2))
    );
    // listCalendarEvents spans two days now, so each event has to be placed
    // rather than assumed to be today's — the bug this split exists to avoid
    // is tomorrow's dentist appearing under "นัดวันนี้".
    const todayEvents = events.filter((e) => e.dateKey === today);
    const tomorrowEvents = events.filter((e) => e.dateKey === tomorrow);
    const format = (e: { time: string; title: string }) => `${e.time || "-"} ${e.title}`;
    const blocks: string[] = [];
    blocks.push(
      todayEvents.length === 0
        ? "📅 วันนี้ไม่มีนัดเลยนะ"
        : ["📅 นัดวันนี้:", ...todayEvents.map(format)].join("\n")
    );
    if (tomorrowEvents.length > 0) {
      blocks.push(["🔜 พรุ่งนี้:", ...tomorrowEvents.map(format)].join("\n"));
    }
    return blocks.join("\n");
  } catch (err) {
    console.error("buildTodayCalendarLine failed", err);
    return "";
  }
}

async function buildTodayShiftLine(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  today: string
): Promise<string> {
  try {
    const monthKey = today.slice(0, 7);
    const day = Number(today.slice(8, 10));
    const grid = await readShiftGrid(accessToken, spreadsheetId, kv, monthKey);
    const todayTypes = SHIFT_TYPES.filter((t) => grid.checked[t].includes(day));
    return todayTypes.length > 0 ? `🗓️ วันนี้เข้าเวร: ${todayTypes.join(", ")}` : "🗓️ วันนี้ไม่มีเวรนะ";
  } catch (err) {
    console.error("buildTodayShiftLine failed", err);
    return "";
  }
}

/**
 * Photos that should have uploaded by now (PLAN.md 17.70).
 *
 * The one line here that reports on the bot rather than on the day. It
 * exists because the KV quota failure went unnoticed for an unknown number
 * of days — the queue stalled every night and nothing said so, until
 * Cloudflare sent an email. The evidence was in the bot's own queue the
 * whole time.
 *
 * Deliberately outside the Google-token block below: a revoked or expired
 * refresh token is itself a reason uploads stop, and a warning that
 * disappears exactly when one of its causes fires is not a warning.
 */
function buildStuckUploadsLine(stuck: StuckUploads | undefined, now: Date): string {
  if (!stuck) return "";
  const hours = Math.floor((now.getTime() - stuck.oldestQueuedAtMs) / (60 * 60 * 1000));
  // "ตั้งแต่เมื่อวาน" reads better than "24 ชั่วโมง" and is the case that
  // actually matters — a queue that has survived a whole night is stalled,
  // not busy. Entries with no recorded time land here too (see
  // listStuckUploads), which is the honest reading of "we don't know, but
  // it predates the deploy".
  const since = hours >= 24 || stuck.oldestQueuedAtMs === 0 ? "ตั้งแต่เมื่อวาน" : `มา ${Math.max(hours, 1)} ชั่วโมงแล้ว`;
  return `⚠️ มีรูป/คลิป ${stuck.count} ไฟล์ค้างอยู่ในคิวอัปโหลด${since} ปกติควรขึ้น Drive ภายในไม่กี่นาที — บอทจะพยายามอัปต่อให้เอง ถ้าพรุ่งนี้ยังเห็นข้อความนี้อยู่แปลว่ามีอะไรผิดปกติจริง`;
}

/**
 * Budgets that are nearly or already spent, for the 7:00 briefing
 * (PLAN.md 17.77).
 *
 * The per-save warning only speaks when you happen to log something in that
 * category. Spend the month's food budget across a fortnight of small
 * entries and the last one tells you — which is late, and only because you
 * logged it. This is the half that reaches you on a morning you have not
 * bought anything yet, while there is still a month left to change.
 *
 * Says nothing at all when every budget is comfortable, the same discipline
 * as the stuck-uploads line: a section that appears every morning is one
 * people stop reading by the morning it matters.
 */
async function buildBudgetWarningLine(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  today: string
): Promise<string> {
  try {
    const month = today.slice(0, 7);
    const { transactions, budgets } = await readMonthTransactionsAndBudgets(accessToken, spreadsheetId, kv, month);
    const thisMonth = budgets.filter((b) => b.month === month);
    if (thisMonth.length === 0) return "";

    const spentByCategory = new Map<string, number>();
    for (const row of transactions) {
      if (row.type !== "expense" || !row.date?.startsWith(month)) continue;
      spentByCategory.set(row.categoryId, (spentByCategory.get(row.categoryId) ?? 0) + row.amount);
    }

    const lines: string[] = [];
    for (const budget of thisMonth) {
      const spent = spentByCategory.get(budget.categoryId) ?? 0;
      const level = budgetLevel(spent, budget.limitAmount);
      if (level === "ok") continue;
      const remaining = budget.limitAmount - spent;
      lines.push(
        remaining < 0
          ? `• ${categoryLabel(budget.categoryId)} เกินแล้ว ${formatBaht(-remaining)} บาท`
          : `• ${categoryLabel(budget.categoryId)} เหลือ ${formatBaht(remaining)} บาท จาก ${formatBaht(budget.limitAmount)}`
      );
    }
    if (lines.length === 0) return "";
    return [`💸 งบเดือนนี้ที่ต้องระวัง:`, ...lines].join("\n");
  } catch (err) {
    console.error("buildBudgetWarningLine failed", err);
    return "";
  }
}

/** Due and overdue bills for the 7:00 briefing (PLAN.md 17.61). Best-effort
 * like every other line here: a failure omits this one line rather than
 * costing the user their whole briefing. */
async function buildDueBillsLine(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  today: string
): Promise<string> {
  try {
    const { recurring, paid } = await readRecurringWithPaid(accessToken, spreadsheetId, kv);
    const status = buildRecurringStatus(recurring, paid, today.slice(0, 7));
    return recurringDueLines(status, today).join("\n");
  } catch (err) {
    console.error("buildDueBillsLine failed", err);
    return "";
  }
}

async function buildYesterdayDiaryLine(
  env: Env,
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  yesterday: string
): Promise<string> {
  try {
    const all = await readAllDiaryEntries(accessToken, spreadsheetId, kv);
    const entries = all.filter((r) => r.date === yesterday);
    if (entries.length === 0) return "📔 เมื่อวานไม่ได้เขียนไดอารี่ไว้เลยนะ";
    const diaryText = entries.map((r) => `[${r.category}] ${r.text}`).join("\n");
    const systemInstruction = [
      "คุณเป็นผู้ช่วยส่วนตัวที่เป็นมิตร กำลังอ่านบันทึกไดอารี่ของผู้ใช้เมื่อวานที่ผ่านมา",
      "เขียนสรุป/ข้อสังเกตสั้นๆ 2-3 ประโยค ให้กำลังใจหรือชวนคิดต่อได้ ห้ามเดาเติมเรื่องที่ไม่ได้เขียนไว้ในบันทึกจริง",
      "ตอบเป็นภาษาไทยล้วนๆ ตอบเนื้อความเลย ไม่ต้องมีหัวข้อหรือคำนำ",
    ].join("\n");
    const analysis = await askGemini(env.GEMINI_API_KEY, systemInstruction, diaryText, {
      kv,
      maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
    });
    return `📔 ไดอารี่เมื่อวาน:\n${analysis}`;
  } catch (err) {
    console.error("buildYesterdayDiaryLine failed", err);
    return "";
  }
}

/** Daily 7:00 broadcast (PLAN.md 17.21): pushes the same morning briefing
 * every personal account would otherwise only get reactively, on their own
 * first "สวัสดี" of the day, to every linked personal account without
 * waiting for anyone to say hi first. Called from index.ts's `scheduled`
 * handler on every once-a-minute cron firing — a no-op outside the 07:00
 * minute or once today's broadcast has already gone out.
 *
 * Personal accounts only, not groups (confirmed with the user, not
 * assumed) — a group already gets plenty of unrelated chatter, and an
 * unsolicited daily push there is more likely noise than a personal DM is.
 *
 * `now` defaults to the real current time in production — overridable so
 * tests can exercise the 07:00 gate deterministically instead of only
 * passing when the test suite happens to run during that exact minute. */
export async function broadcastMorningBriefings(env: Env, kv: KVNamespace, now: Date = new Date()): Promise<void> {
  const { hour, minute } = bangkokHourMinute(now);
  if (hour !== 7 || minute !== 0) return;

  const today = bangkokDateKey(now);
  if ((await getLastBroadcastDate(kv)) === today) return;
  await setLastBroadcastDate(kv, today);

  // Same list-once, no-cursor-pagination approach as uploadQueue.ts's
  // listQueueBatch — caps at KV's own 1000-keys-per-call limit, which a
  // personal bot's total linked-account count is nowhere near.
  const { keys } = await kv.list({ prefix: ACCOUNT_LINK_PREFIX });
  const personalUserIds = keys
    .map((k) => k.name.slice(ACCOUNT_LINK_PREFIX.length))
    .filter((subjectId) => groupIdFromSubject(subjectId) === null);

  // Fetched once for the whole run and shared across every user (see
  // buildBriefingBody's own comment) — neither the news nor the gold/BTC
  // price is personalized, only the weather (and the Calendar/shift/diary
  // extras below) is.
  const newsBlock = await fetchDailyNewsBlock(env, kv);
  const marketSnapshot = await fetchMarketSnapshot();
  const marketLines = buildGoldBtcLines(marketSnapshot);
  const marketBlock = marketLines.length > 0 ? marketLines.join("\n") : null;
  const yesterday = addDaysToDateKey(today, -1);
  // One KV list for the whole broadcast, alongside the other shared fetches
  // above rather than one per person (PLAN.md 17.70).
  const stuckUploads = await listStuckUploads(kv, now).catch((err) => {
    console.error("broadcastMorningBriefings: checking for stuck uploads failed", err);
    return new Map<string, StuckUploads>();
  });

  await processInBatches(personalUserIds, BROADCAST_CONCURRENCY_LIMIT, async (lineUserId) => {
    try {
      const body = await buildBriefingBody(env, kv, lineUserId, newsBlock);
      const extras: string[] = [];
      if (marketBlock) extras.push(marketBlock);
      // Needs no Google token, so it is pushed here rather than inside the
      // block below — see buildStuckUploadsLine.
      const stuckLine = buildStuckUploadsLine(stuckUploads.get(lineUserId), now);
      if (stuckLine) extras.push(stuckLine);

      // The Calendar/shift/diary extras need a fresh Google access token —
      // unlike weather/news above, which need none at all. A failure here
      // (revoked/insufficient-scope refresh token, etc.) degrades to the
      // base weather/news briefing only, same best-effort spirit as every
      // other piece of this broadcast.
      const link = await getAccountLink(kv, lineUserId);
      const settings = await getBotSettings(kv, lineUserId);
      // Opted out, or a new account that never opted in (PLAN.md 17.54).
      // Checked here rather than when building the recipient list so the
      // shared news/market fetch above still happens once for whoever is
      // left, and so this reads next to the push it prevents.
      if (!wantsMorningBriefing(settings, link ?? {})) return;
      if (link) {
        try {
          const accessToken = await refreshAccessToken({
            refreshToken: link.refreshToken,
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          });
          const [calendarLine, shiftLine, billsLine, budgetLine, diaryLine] = await Promise.all([
            buildTodayCalendarLine(accessToken, today),
            buildTodayShiftLine(accessToken, link.spreadsheetId, kv, today),
            // Costs one more Sheets read per person per day, and no extra
            // LINE push at all — this message was going out regardless, which
            // is the whole reason a bill reminder is affordable here and was
            // not affordable as its own notification (PLAN.md 17.59).
            buildDueBillsLine(accessToken, link.spreadsheetId, kv, today),
            // One more Sheets read a day, and still no extra push — the same
            // trade that made the bill reminder affordable (PLAN.md 17.61).
            buildBudgetWarningLine(accessToken, link.spreadsheetId, kv, today),
            buildYesterdayDiaryLine(env, accessToken, link.spreadsheetId, kv, yesterday),
          ]);
          // Bills before the diary reflection: it is the only line here that
          // asks the reader to go and do something today.
          for (const line of [calendarLine, shiftLine, billsLine, budgetLine, diaryLine]) if (line) extras.push(line);
        } catch (err) {
          console.error("broadcastMorningBriefings: refreshing access token failed, sending base briefing only", lineUserId, err);
        }
      }

      const fullBody = extras.length > 0 ? [body, ...extras].join("\n\n") : body;
      const styled = await applyPersona(fullBody, env.GEMINI_API_KEY, settings, kv);
      await pushToLine(lineUserId, styled, env.LINE_CHANNEL_ACCESS_TOKEN);
      // Marks today as already-greeted for this user too, same as the
      // reactive path's classifyGreeting — a "สวัสดี" later the same day
      // should get the short return-greeting, not a duplicate full briefing.
      await setLastGreetingDate(kv, lineUserId, today);
    } catch (err) {
      console.error("broadcastMorningBriefings: failed for one user, continuing with the rest", lineUserId, err);
    }
  });
}
