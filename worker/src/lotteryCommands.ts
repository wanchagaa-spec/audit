// Chat layer for ผลสลากกินแบ่งรัฐบาล (PLAN.md 17.73). See lottery.ts for the
// data layer and for why the source's provenance is stated to the user.

import { fetchLatestDraw, findMatches, normalizeTicket, type LotteryDraw } from "./lottery.ts";

const FETCH_FAILED =
  "ตอนนี้ดึงผลสลากไม่ได้ ลองใหม่อีกทีนะ (ถ้ายังไม่ได้ เช็คที่เว็บสำนักงานสลากฯ ได้เลย)";

/** Said only on a "you won" answer, not on the plain results listing.
 * A disclaimer attached to every reply is one nobody reads by the time it
 * matters; attached to the one reply someone might act on financially, it
 * still gets read. The upstream scrapes a news site — accurate in practice,
 * but not the office's own record. */
const VERIFY_NOTE = "เช็คกับสำนักงานสลากฯ อีกครั้งก่อนนะ ผลตรงนี้ดึงมาจากเว็บข่าว ไม่ใช่ประกาศทางการ";

function formatDraw(draw: LotteryDraw): string {
  const lines = [`🎫 ผลสลากงวด ${draw.date}`, ""];
  // First prize and the running numbers are what people actually look for;
  // the rest is a wall of numbers that would push it past what anyone reads
  // in a chat bubble. The full list is one tap away on the official site.
  const first = draw.prizes.find((p) => p.name.includes("รางวัลที่ 1"));
  if (first) lines.push(`รางวัลที่ 1: ${first.numbers.join(", ")}`);
  for (const running of draw.runningNumbers) {
    lines.push(`${running.name}: ${running.numbers.join(", ")}`);
  }
  return lines.join("\n");
}

export async function answerLotteryResult(): Promise<string> {
  try {
    const draw = await fetchLatestDraw();
    if (!draw) return FETCH_FAILED;
    return formatDraw(draw);
  } catch (err) {
    console.error("answerLotteryResult: fetching the draw failed", err);
    return FETCH_FAILED;
  }
}

export async function answerLotteryCheck(rawTicket: string): Promise<string> {
  const ticket = normalizeTicket(rawTicket);
  if (!ticket) {
    return "เลขสลากต้องเป็นตัวเลข 6 หลัก (หรือ 2-3 หลักถ้าจะตรวจเฉพาะเลขท้าย/เลขหน้า) ลองพิมพ์ใหม่นะ";
  }
  try {
    const draw = await fetchLatestDraw();
    if (!draw) return FETCH_FAILED;
    const matches = findMatches(draw, ticket);
    // The draw date is on both answers, not just the winning one: "ไม่ถูก"
    // against last month's draw is a wrong answer that reads exactly like a
    // right one.
    if (matches.length === 0) {
      return `🎫 เลข ${ticket} ไม่ถูกรางวัลในงวด ${draw.date} นะ ไว้ลุ้นงวดหน้า`;
    }
    const lines = [`🎉 เลข ${ticket} ถูกรางวัลในงวด ${draw.date}`, ""];
    for (const match of matches) {
      const reward = match.reward ? ` — ${Number(match.reward).toLocaleString("th-TH")} บาท` : "";
      lines.push(`${match.prizeName} (${match.matchedNumber})${reward}`);
    }
    lines.push("", VERIFY_NOTE);
    return lines.join("\n");
  } catch (err) {
    console.error("answerLotteryCheck: fetching the draw failed", err);
    return FETCH_FAILED;
  }
}

const RESULT_PHRASES = [
  "ผลหวย",
  "ผลสลาก",
  "หวยออกอะไร",
  "หวยงวดนี้",
  "ผลหวยงวดล่าสุด",
  "ตรวจหวย",
  "ตรวจสลาก",
];

/**
 * Whole-phrase for the plain lookup, and an explicit prefix for the check.
 *
 * "หวย" alone is deliberately not a trigger, unlike "ฝุ่น" in 17.71: it sits
 * inside "ซื้อหวย 200", which is an expense this bot already records, and
 * swallowing that would break a feature people use far more often than this
 * one.
 */
export function matchLotteryCommand(text: string): (() => Promise<string>) | null {
  const trimmed = text.trim().replace(/[?？!]/g, "").trim();
  const checkMatch = trimmed.match(/^(?:ตรวจหวย|ตรวจสลาก|เช็คหวย|เช็คสลาก)\s+(.+)$/s);
  if (checkMatch) return () => answerLotteryCheck(checkMatch[1]);
  if (RESULT_PHRASES.includes(trimmed)) return () => answerLotteryResult();
  return null;
}
