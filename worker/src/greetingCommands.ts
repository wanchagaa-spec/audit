// Morning briefing (PLAN.md 15.11): the first greeting ("สวัสดี", "กู๊ดมอร์นิ่ง",
// etc. — see chatEngine.ts's GREETINGS) of each Bangkok calendar day gets a
// full briefing (date, weather if a province is set, AI-summarized daily
// news); every later greeting that same day just gets a short "ว่าไง"
// prompt instead, so it doesn't repeat the whole briefing every time someone
// says hi.

import { fetchNewsSummary } from "./news.ts";
import { geocodeProvince, fetchWeatherSummary } from "./weather.ts";
import { getLastGreetingDate, getUserProvince, setLastGreetingDate, setUserProvince } from "./state.ts";
import { bangkokDateKey, bangkokWeekdayIndex, formatThaiDateLabel } from "./thaiDate.ts";
import type { Env } from "./index.ts";

const WEEKDAY_TH = ["วันจันทร์", "วันอังคาร", "วันพุธ", "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์", "วันอาทิตย์"];

// Unlike the trip/calendar/diary command handlers, this doesn't need a
// Google access token at all (just KV, plus Open-Meteo which needs no auth
// of its own) — so it deliberately isn't shaped like ActionCtx-based
// Handler the way those are, to avoid making callers fetch a Google token
// this command has no use for.
export function matchProvinceCommand(text: string): ((kv: KVNamespace, lineUserId: string) => Promise<string>) | null {
  const m = text.trim().match(/^ตั้งจังหวัด\s+(.+)$/s);
  if (!m) return null;
  const requested = m[1].trim();

  return async (kv, lineUserId) => {
    let geocoded;
    try {
      geocoded = await geocodeProvince(requested);
    } catch (err) {
      console.error("matchProvinceCommand: geocoding failed", err);
      return "ขอโทษด้วย ตอนนี้ระบบค้นหาจังหวัดขัดข้อง ลองใหม่อีกครั้งนะ";
    }
    if (!geocoded) {
      return `หาจังหวัด/เมือง "${requested}" ไม่เจอนะ ลองพิมพ์เป็นภาษาอังกฤษหรือสะกดแบบอื่นดู`;
    }
    await setUserProvince(kv, lineUserId, geocoded);
    return `ตั้งพื้นที่พยากรณ์อากาศเป็น "${geocoded.name}" ให้แล้วนะ จะใช้บอกสภาพอากาศตอนทักทายครั้งแรกของวัน`;
  };
}

// Best-effort: weather and news are independent nice-to-haves, so one
// failing must never take the other down with it, and neither should ever
// block the greeting itself from going out — see the try/catches below.
async function buildBriefingBody(env: Env, kv: KVNamespace, lineUserId: string): Promise<string> {
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

  let newsBlock: string | null = null;
  try {
    newsBlock = await fetchNewsSummary(env.GEMINI_API_KEY);
  } catch (err) {
    console.error("buildBriefingBody: news summary failed", err);
  }

  const parts = [`สวัสดีตอนเช้า ☀️ วันนี้${dateLine}`];
  if (weatherLine) parts.push(weatherLine);
  else if (!province) parts.push('ยังไม่รู้พื้นที่ของคุณเลย พิมพ์ "ตั้งจังหวัด <ชื่อ>" ถ้าอยากให้บอกสภาพอากาศด้วยนะ');
  if (newsBlock) parts.push(`📰 ข่าวเช้านี้:\n${newsBlock}`);
  return parts.join("\n\n");
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
