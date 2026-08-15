// Morning briefing (PLAN.md 15.11): the first greeting ("สวัสดี", "กู๊ดมอร์นิ่ง",
// etc. — see chatEngine.ts's GREETINGS) of each Bangkok calendar day gets a
// full briefing (date, weather if a province is set, AI-summarized daily
// news); every later greeting that same day just gets a short "ว่าไง"
// prompt instead, so it doesn't repeat the whole briefing every time someone
// says hi.

import { listCalendarEvents } from "./calendar.ts";
import { askGemini } from "./gemini.ts";
import { refreshAccessToken } from "./googleAuth.ts";
import { groupIdFromSubject } from "./groupSubject.ts";
import { pushToLine } from "./line.ts";
import { buildGoldBtcLines, fetchMarketSnapshot } from "./marketData.ts";
import { fetchNewsSummary } from "./news.ts";
import { applyPersona } from "./persona.ts";
import { readAllDiaryEntries, readShiftGrid, SHIFT_TYPES } from "./sheets.ts";
import { listIncompleteTasks } from "./tasks.ts";
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
  if (province) {
    try {
      weatherLine = await fetchWeatherSummary(province);
    } catch (err) {
      console.error("buildBriefingBody: weather fetch failed", err);
    }
  }

  const newsBlock = sharedNewsBlock !== undefined ? sharedNewsBlock : await fetchDailyNewsBlock(env);

  const parts = [`สวัสดีตอนเช้า ☀️ วันนี้${dateLine}`];
  if (weatherLine) parts.push(weatherLine);
  else if (!province) parts.push('ยังไม่รู้พื้นที่ของคุณเลย พิมพ์ "ตั้งจังหวัด <ชื่อ>" ถ้าอยากให้บอกสภาพอากาศด้วยนะ');
  if (newsBlock) parts.push(`📰 ข่าวเช้านี้:\n${newsBlock}`);
  return parts.join("\n\n");
}

async function fetchDailyNewsBlock(env: Env): Promise<string | null> {
  try {
    return await fetchNewsSummary(env.GEMINI_API_KEY);
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

async function buildTodayCalendarLine(accessToken: string, today: string): Promise<string> {
  try {
    const events = await listCalendarEvents(
      accessToken,
      bangkokStartOfDayIso(today),
      bangkokStartOfDayIso(addDaysToDateKey(today, 1))
    );
    if (events.length === 0) return "📅 วันนี้ไม่มีนัดเลยนะ";
    const lines = events.map((e) => `${e.time || "-"} ${e.title}`);
    return ["📅 นัดวันนี้:", ...lines].join("\n");
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

// PLAN.md 17.35: today's due Google Tasks, same-day-heads-up treatment as
// buildTodayCalendarLine above — tasks with a due *time* also get a nearer,
// more-timely ping on their own (reminders.ts's pushTaskDueReminders), but
// showing every task due today here too isn't redundant, it's an overview
// of the whole day versus a just-in-time nudge for one item.
async function buildTodayDueTasksLine(accessToken: string, today: string): Promise<string> {
  try {
    const tasks = await listIncompleteTasks(accessToken);
    const dueToday = tasks.filter((t) => t.dueDateKey === today);
    if (dueToday.length === 0) return "✅ วันนี้ไม่มีสิ่งที่ต้องทำที่ครบกำหนดเลยนะ";
    const lines = dueToday.map((t) => (t.dueTime ? `${t.dueTime} ${t.title}` : t.title));
    return ["✅ สิ่งที่ต้องทำวันนี้:", ...lines].join("\n");
  } catch (err) {
    console.error("buildTodayDueTasksLine failed", err);
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
    const analysis = await askGemini(env.GEMINI_API_KEY, systemInstruction, diaryText);
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
  const newsBlock = await fetchDailyNewsBlock(env);
  const marketSnapshot = await fetchMarketSnapshot();
  const marketLines = buildGoldBtcLines(marketSnapshot);
  const marketBlock = marketLines.length > 0 ? marketLines.join("\n") : null;
  const yesterday = addDaysToDateKey(today, -1);

  await processInBatches(personalUserIds, BROADCAST_CONCURRENCY_LIMIT, async (lineUserId) => {
    try {
      const body = await buildBriefingBody(env, kv, lineUserId, newsBlock);
      const extras: string[] = [];
      if (marketBlock) extras.push(marketBlock);

      // The Calendar/shift/diary extras need a fresh Google access token —
      // unlike weather/news above, which need none at all. A failure here
      // (revoked/insufficient-scope refresh token, etc.) degrades to the
      // base weather/news briefing only, same best-effort spirit as every
      // other piece of this broadcast.
      const link = await getAccountLink(kv, lineUserId);
      if (link) {
        try {
          const accessToken = await refreshAccessToken({
            refreshToken: link.refreshToken,
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          });
          const [calendarLine, shiftLine, diaryLine, tasksLine] = await Promise.all([
            buildTodayCalendarLine(accessToken, today),
            buildTodayShiftLine(accessToken, link.spreadsheetId, kv, today),
            buildYesterdayDiaryLine(env, accessToken, link.spreadsheetId, kv, yesterday),
            buildTodayDueTasksLine(accessToken, today),
          ]);
          for (const line of [calendarLine, shiftLine, diaryLine, tasksLine]) if (line) extras.push(line);
        } catch (err) {
          console.error("broadcastMorningBriefings: refreshing access token failed, sending base briefing only", lineUserId, err);
        }
      }

      const fullBody = extras.length > 0 ? [body, ...extras].join("\n\n") : body;
      const styled = await applyPersona(fullBody, env.GEMINI_API_KEY);
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
