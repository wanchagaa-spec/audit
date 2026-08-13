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

import { askGemini, GeminiError } from "./gemini.ts";

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

async function summarizeHeadlines(
  geminiApiKey: string,
  headlines: string[],
  systemInstruction: string
): Promise<string | null> {
  const prompt = headlines.map((h, i) => `${i + 1}. ${h}`).join("\n");
  try {
    return await askGemini(geminiApiKey, systemInstruction, prompt);
  } catch (err) {
    if (err instanceof GeminiError) {
      console.error("summarizeHeadlines: Gemini summarization failed", err);
      return null;
    }
    throw err;
  }
}

/** Short Thai daily-news summary for the morning briefing, or null if the
 * feed/AI step fails. */
export async function fetchNewsSummary(geminiApiKey: string): Promise<string | null> {
  const headlines = await fetchHeadlines(DAILY_NEWS_RSS_URL);
  if (!headlines || headlines.length === 0) return null;
  return summarizeHeadlines(
    geminiApiKey,
    headlines,
    [
      "คุณช่วยสรุปข่าวประจำวันให้ผู้ใช้แชท LINE อ่านตอนเช้า",
      "ด้านล่างคือหัวข้อข่าวล่าสุดจาก Bangkok Post (ภาษาอังกฤษ)",
      "สรุปเป็นภาษาไทย 3-5 หัวข้อสั้นๆ แบบ bullet ไม่ต้องมีคำนำหรือสรุปท้าย ไม่ต้องแปลตรงตัว",
      "ให้เข้าใจง่ายและเป็นธรรมชาติ",
    ].join("\n")
  );
}

/** Short Thai financial-news summary ("ถาม ข่าวหุ้น") — covers whatever
 * shows up in CNBC's finance headlines (US stocks, crypto, commodities,
 * general market news), not just literally "หุ้น". Returns null if the
 * feed/AI step fails. */
export async function fetchFinanceNewsSummary(geminiApiKey: string): Promise<string | null> {
  const headlines = await fetchHeadlines(FINANCE_NEWS_RSS_URL);
  if (!headlines || headlines.length === 0) return null;
  return summarizeHeadlines(
    geminiApiKey,
    headlines,
    [
      "คุณช่วยสรุปข่าวการเงิน/ตลาดหุ้นให้ผู้ใช้แชท LINE อ่าน",
      "ด้านล่างคือหัวข้อข่าวล่าสุดจาก CNBC (ภาษาอังกฤษ) เกี่ยวกับตลาดหุ้นสหรัฐ คริปโต ทองคำ และเศรษฐกิจสหรัฐ",
      "สรุปเป็นภาษาไทย 3-5 หัวข้อสั้นๆ แบบ bullet ไม่ต้องมีคำนำหรือสรุปท้าย",
      // The one guardrail that matters here: headlines are safe to
      // summarize qualitatively, but a specific number (a price, an index
      // level, a percentage) in the source headlines could already be
      // stale by the time this runs, and Gemini has no way to know that —
      // stating it as current would misrepresent it as live data this
      // pipeline never actually verified.
      "ห้ามระบุตัวเลขราคา/ดัชนีที่แน่นอนเป็นราคาปัจจุบัน (เช่น ราคาทอง, ราคาบิตคอยน์, ดัชนีหุ้น) แม้จะเห็นตัวเลขในหัวข้อข่าว " +
        "เพราะข่าวอาจไม่ใช่ข้อมูลล่าสุด ณ ตอนนี้ — พูดถึงทิศทาง/เหตุการณ์ได้ (เช่น \"ทองคำปรับตัวขึ้น\") แต่อย่าฟันธงราคาล่าสุด",
    ].join("\n")
  );
}
