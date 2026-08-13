// News summary for the morning briefing (PLAN.md 15.11). Pulls headlines
// from Bangkok Post's official RSS feed (bangkokpost.com/rss/ documents
// this as a supported, no-key-required feature of the site — no
// registration needed, unlike most news APIs) and asks Gemini to translate
// and summarize them into a short Thai briefing. Deliberately not the
// AI-as-oracle pattern aiCommands.ts guards against: Gemini isn't handed
// anything to compute or a fact to get right or wrong, it's summarizing
// text that's handed to it in full — the same kind of task summarizing a
// news article is normally used for.

import { askGemini, GeminiError } from "./gemini.ts";

const RSS_URL = "https://www.bangkokpost.com/rss/data/topstories.xml";
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

/** Short Thai daily-news summary, or null if the feed/AI step fails. */
export async function fetchNewsSummary(geminiApiKey: string): Promise<string | null> {
  let headlines: string[];
  try {
    const res = await fetch(RSS_URL);
    if (!res.ok) return null;
    headlines = extractHeadlines(await res.text(), MAX_HEADLINES);
  } catch (err) {
    console.error("fetchNewsSummary: RSS fetch failed", err);
    return null;
  }
  if (headlines.length === 0) return null;

  const systemInstruction = [
    "คุณช่วยสรุปข่าวประจำวันให้ผู้ใช้แชท LINE อ่านตอนเช้า",
    "ด้านล่างคือหัวข้อข่าวล่าสุดจาก Bangkok Post (ภาษาอังกฤษ)",
    "สรุปเป็นภาษาไทย 3-5 หัวข้อสั้นๆ แบบ bullet ไม่ต้องมีคำนำหรือสรุปท้าย ไม่ต้องแปลตรงตัว",
    "ให้เข้าใจง่ายและเป็นธรรมชาติ",
  ].join("\n");
  const prompt = headlines.map((h, i) => `${i + 1}. ${h}`).join("\n");

  try {
    return await askGemini(geminiApiKey, systemInstruction, prompt);
  } catch (err) {
    if (err instanceof GeminiError) {
      console.error("fetchNewsSummary: Gemini summarization failed", err);
      return null;
    }
    throw err;
  }
}
