// News summaries (PLAN.md 15.11/15.12). Pulls headlines from a source's
// official RSS feed (no API key needed for either source below — a real
// news API with a comparable free tier is hard to find, RSS is the
// actually-free option) and asks Gemini to translate and summarize them
// into short Thai text. Deliberately not the AI-as-oracle pattern
// aiCommands.ts guards against for money/dates: Gemini isn't handed
// anything to compute or a fact to get right or wrong on its own, it's
// summarizing text that's handed to it in full — the same kind of task
// summarizing a news article is normally used for. This also means it's
// safe for headlines (qualitative, "what happened") but deliberately NOT
// used for anything that needs a precise current number (a stock price, a
// BTC quote, a gold price) — an RSS headline saying "gold hits record
// high" is safe to summarize; asking Gemini "so what's the price" would
// tempt it to state a number from stale training data as if it were live,
// exactly the failure mode the rest of this codebase works hard to avoid.
// The finance summary below is the one exception: it also pulls real numbers
// from marketData.ts (gold/BTC/top movers, each from a free no-key
// endpoint). As of PLAN.md 15.13, those numbers are no longer handed to
// Gemini to restate at all — they're formatted as plain deterministic text
// (marketData.ts's buildMarketHeaderBlock) and prepended to Gemini's output,
// removing any chance of the model paraphrasing/rounding a price. What
// Gemini *is* still handed as labeled ground truth: today's US economic
// calendar (forexCalendar.ts, real events/times from Forex Factory) — which
// of those actually tends to move gold is a genuine judgment call, worth
// delegating, but the events/times themselves are never invented.

import { ANSWER_MAX_OUTPUT_TOKENS, askGemini, GeminiError } from "./gemini.ts";
import { fetchTodayUsEconomicEvents, type EconomicEvent } from "./forexCalendar.ts";
import { buildMarketHeaderBlock, fetchMarketSnapshot } from "./marketData.ts";
import { bangkokDateKey, formatThaiDateLabelFull } from "./thaiDate.ts";

const DAILY_NEWS_RSS_URL = "https://www.bangkokpost.com/rss/data/topstories.xml";
const FINANCE_NEWS_RSS_URL = "https://www.cnbc.com/id/10000664/device/rss/rss.html";
const MAX_HEADLINES = 8;

/** Pulls out <item><title>...</title> values from an RSS 2.0 feed — a
 * regex-based extraction rather than a full XML parser, which is overkill
 * for reading a handful of plain-text titles out of a feed this simple. */
function extractHeadlines(rssXml: string, limit: number): string[] {
  const titles: string[] = [];
  const itemPattern = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemPattern.exec(rssXml)) !== null && titles.length < limit) {
    const titleMatch = itemMatch[1].match(/<title\b[^>]*>([\s\S]*?)<\/title>/);
    if (!titleMatch) continue;
    const raw = titleMatch[1].trim();
    const withoutCdata = raw.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1").trim();
    const decoded = withoutCdata
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;/g, "'");
    if (decoded) titles.push(decoded);
  }
  return titles;
}

async function fetchHeadlines(rssUrl: string): Promise<string[] | null> {
  try {
    const res = await fetch(rssUrl);
    if (!res.ok) return null;
    return extractHeadlines(await res.text(), MAX_HEADLINES);
  } catch (err) {
    console.error("fetchHeadlines: RSS fetch failed", rssUrl, err);
    return null;
  }
}

async function summarizePrompt(
  geminiApiKey: string,
  prompt: string,
  systemInstruction: string,
  kv?: KVNamespace
): Promise<string | null> {
  try {
    return await askGemini(geminiApiKey, systemInstruction, prompt, {
      kv,
      maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
    });
  } catch (err) {
    if (err instanceof GeminiError) {
      console.error("summarizePrompt: Gemini summarization failed", err);
      return null;
    }
    throw err;
  }
}

/** Short Thai daily-news summary for the morning briefing, or null if the
 * feed/AI step fails. */
export async function fetchNewsSummary(geminiApiKey: string, kv?: KVNamespace): Promise<string | null> {
  const headlines = await fetchHeadlines(DAILY_NEWS_RSS_URL);
  if (!headlines || headlines.length === 0) return null;
  const prompt = headlines.map((h, i) => `${i + 1}. ${h}`).join("\n");
  return summarizePrompt(
    geminiApiKey,
    prompt,
    [
      "คุณช่วยสรุปข่าวประจำวันให้ผู้ใช้แชท LINE อ่านตอนเช้า",
      "ด้านล่างคือหัวข้อข่าวล่าสุดจาก Bangkok Post (ภาษาอังกฤษ)",
      "สรุปเป็นภาษาไทย 3-5 หัวข้อสั้นๆ แบบ bullet ไม่ต้องมีคำนำหรือสรุปท้าย ไม่ต้องแปลตรงตัว",
      "ให้เข้าใจง่ายและเป็นธรรมชาติ",
    ].join("\n"),
    kv
  );
}

// Bracketed all-caps markers, not natural Thai sentences — found in a real
// report: the model copied an earlier, more sentence-like version of this
// "no data" placeholder verbatim into its reply (a long parenthetical the
// user never should have seen). A marker that reads unmistakably as
// internal/non-prose data, paired with an explicit "never echo bracketed
// markers" rule in FINANCE_SYSTEM_INSTRUCTION below, closes that off — the
// model is told exactly what short Thai sentence to write for each one
// instead of being left to improvise from the label text itself.
const CALENDAR_STATUS_UNAVAILABLE = "[CALENDAR_STATUS: UNAVAILABLE]";
const CALENDAR_STATUS_NONE_TODAY = "[CALENDAR_STATUS: NONE_TODAY]";

/** Formats today's economic-events list for the prompt, or a status marker
 * distinguishing "couldn't check" (fetch failed) from "checked, confirmed
 * empty" the same way calendar/weather prompts elsewhere in this codebase
 * do, so Gemini reports the right one instead of silently treating both
 * the same. */
function formatEconomicEventsForPrompt(events: EconomicEvent[] | null): string {
  if (events === null) return CALENDAR_STATUS_UNAVAILABLE;
  if (events.length === 0) return CALENDAR_STATUS_NONE_TODAY;
  return events.map((e) => `- เวลาไทย ${e.timeThai} น. ${e.title} (ผลกระทบ: ${e.impact})`).join("\n");
}

const FINANCE_SYSTEM_INSTRUCTION = [
  "คุณช่วยสรุปข่าวการเงิน/ตลาดหุ้นให้ผู้ใช้แชท LINE อ่าน เกี่ยวกับตลาดหุ้นสหรัฐ คริปโต ทองคำ และเศรษฐกิจสหรัฐ",
  "ตอบเป็นภาษาไทยเท่านั้น ไม่ต้องมีคำนำหรือคำลงท้าย ตอบตามโครงสร้างนี้เป๊ะๆ:",
  // Explicit "แปล" here, not just the general Thai-only rule above — found
  // in a real report: without this, the model just re-listed the English
  // CNBC titles as bullets verbatim instead of translating them.
  '1) แปลและสรุปหัวข้อข่าวจาก "หัวข้อข่าวล่าสุดจาก CNBC" ด้านล่าง (ภาษาอังกฤษ) ให้เป็นภาษาไทยล้วนๆ เป็น bullet ขึ้นต้นแต่ละบรรทัดด้วย "* " จำนวน 3-5 หัวข้อสั้นๆ ห้ามคัดลอกประโยคภาษาอังกฤษมาทั้งดุ้นโดยไม่แปล',
  '2) เว้นบรรทัดว่าง 1 บรรทัด แล้วขึ้นบรรทัดใหม่ว่า "* ข่าวเศรษฐกิจสหรัฐที่ส่งผลต่อทองวันนี้"',
  // The events/times here are real (forexCalendar.ts) — Gemini's only job
  // is picking which ones are actually gold-relevant, never inventing one.
  `3) ใต้บรรทัดนั้น ดูรายการใน "ปฏิทินข่าวเศรษฐกิจสหรัฐวันนี้จาก Forex Factory" ด้านล่าง:
   - ถ้าเจอ ${CALENDAR_STATUS_UNAVAILABLE} ให้เขียนบรรทัดเดียวสั้นๆ ว่า "ตอนนี้เช็คปฏิทินข่าวเศรษฐกิจไม่ได้นะ"
   - ถ้าเจอ ${CALENDAR_STATUS_NONE_TODAY} ให้เขียนบรรทัดเดียวสั้นๆ ว่า "วันนี้ยังไม่มีข่าวเศรษฐกิจที่ส่งผลต่อทองเลยนะ"
   - ถ้าเป็นรายการข่าวจริง ให้เลือกเฉพาะรายการที่น่าจะส่งผลต่อราคาทองจริงๆ เท่านั้น (เช่น การประกาศ/มติดอกเบี้ยของเฟด ถ้อยแถลงประธานเฟด ตัวเลขการจ้างงาน/คนว่างงาน เงินเฟ้อ/CPI/PCE) แต่ละรายการขึ้นบรรทัดใหม่ รูปแบบ "เวลาไทย <เวลาที่ให้มา> น. <ชื่อข่าวแปลเป็นไทยสั้นๆ>" ห้ามเปลี่ยนเวลาจากที่ให้มา ถ้าไม่มีรายการไหนเข้าเกณฑ์เลยในลิสต์ ให้เขียนบรรทัดเดียวสั้นๆ ว่า "วันนี้ยังไม่มีข่าวเศรษฐกิจที่ส่งผลต่อทองเลยนะ" แทน`,
  // Guards the exact failure mode found in the report: the model must never
  // paste a bracketed status marker straight into the reply.
  "ห้ามพิมพ์ข้อความในวงเล็บเหลี่ยม [ ] หรือป้ายกำกับสถานะใดๆ ลงในคำตอบเด็ดขาด ป้ายพวกนี้มีไว้บอกสถานะให้คุณอ่านเท่านั้น ไม่ใช่ข้อความสำหรับผู้ใช้ ให้เขียนประโยคของตัวเองตามกติกาข้อ 3 แทนเสมอ",
  "ห้ามระบุตัวเลขราคา/ดัชนีใดๆ เพิ่มเติมนอกจากที่ปรากฏในหัวข้อข่าวหรือปฏิทินที่ให้มา ห้ามสร้างข่าว เวลา หรือเหตุการณ์ที่ไม่มีในข้อมูลที่ให้มาเด็ดขาด",
].join("\n");

/** Short Thai financial-news summary ("ถาม ข่าวหุ้น") — covers whatever
 * shows up in CNBC's finance headlines (US stocks, crypto, commodities,
 * general market news), not just literally "หุ้น". Composed of two parts
 * (PLAN.md 15.13): a deterministic header (today's date, gold/BTC/top-mover
 * prices — built by marketData.ts, never touched by Gemini) followed by an
 * AI-composed body (a short news summary, plus a curated list of today's
 * gold-relevant US economic events from forexCalendar.ts). Returns null
 * only if the headline fetch/AI step itself fails — a failed market-data or
 * economic-calendar fetch just means that part degrades gracefully, the
 * headlines are the one part this can't run without. */
export async function fetchFinanceNewsSummary(geminiApiKey: string, kv?: KVNamespace): Promise<string | null> {
  const [headlines, snapshot, economicEvents] = await Promise.all([
    fetchHeadlines(FINANCE_NEWS_RSS_URL),
    fetchMarketSnapshot(),
    fetchTodayUsEconomicEvents(),
  ]);
  if (!headlines || headlines.length === 0) return null;

  const headerBlock = buildMarketHeaderBlock(snapshot, formatThaiDateLabelFull(bangkokDateKey()));
  const headlinesBlock = headlines.map((h, i) => `${i + 1}. ${h}`).join("\n");
  const economicEventsBlock = formatEconomicEventsForPrompt(economicEvents);

  const prompt = [
    `หัวข้อข่าวล่าสุดจาก CNBC (ภาษาอังกฤษ):\n${headlinesBlock}`,
    `ปฏิทินข่าวเศรษฐกิจสหรัฐวันนี้จาก Forex Factory (เวลาไทยแล้ว, มีเฉพาะข่าวผลกระทบระดับกลาง-สูง):\n${economicEventsBlock}`,
  ].join("\n\n");

  const body = await summarizePrompt(geminiApiKey, prompt, FINANCE_SYSTEM_INSTRUCTION, kv);
  if (body === null) return null;
  return [headerBlock, "", body].join("\n");
}
