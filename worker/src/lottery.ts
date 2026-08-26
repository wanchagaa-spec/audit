// ผลสลากกินแบ่งรัฐบาล (PLAN.md 17.73).
//
// Source: rayriffy/thai-lotto-api — free, no key, no account, matching the
// same rule every other integration here follows. It is a *community*
// service that scrapes a news site, not the Government Lottery Office's own
// feed, and that distinction is load-bearing rather than trivia: this is the
// only thing the bot says that someone might act on financially. Every
// "you won" answer therefore carries the draw date it was checked against
// and a pointer to the official source, and every failure says it failed
// instead of guessing.
//
// The matching rules below are the real ones, not an approximation:
//   • รางวัลที่ 1-5 และรางวัลข้างเคียง — ตรงทั้ง 6 หลัก
//   • เลขหน้า 3 ตัว — ตรง 3 หลักแรก
//   • เลขท้าย 3 ตัว — ตรง 3 หลักท้าย
//   • เลขท้าย 2 ตัว — ตรง 2 หลักท้าย
// One ticket can win in more than one category at once, so a check reports
// every match rather than stopping at the first.

import { fetchWithTimeout, NETWORK_TIMEOUTS } from "./timeouts.ts";

const LOTTO_LATEST_URL = "https://lotto.api.rayriffy.com/latest";

interface RawPrize {
  id?: string;
  name?: string;
  reward?: string;
  number?: string[];
}

export interface LotteryPrize {
  /** The upstream's stable category id (`prizeFirst`, `runningNumberBackTwo`,
   * …). Carried through parsing rather than dropped, because the matching
   * rules key off it — see matchesTicket. */
  id: string;
  name: string;
  /** Baht per winning ticket, as the upstream reports it. */
  reward: string;
  numbers: string[];
}

export interface LotteryDraw {
  /** Thai-formatted draw date, e.g. "16 สิงหาคม 2569". Passed through as
   * given rather than re-parsed: it is the upstream's own label for which
   * draw this is, and reformatting it risks saying a different date than the
   * one the numbers came from. */
  date: string;
  prizes: LotteryPrize[];
  runningNumbers: LotteryPrize[];
}

function parsePrizes(raw: unknown): LotteryPrize[] {
  if (!Array.isArray(raw)) return [];
  const prizes: LotteryPrize[] = [];
  for (const item of raw as RawPrize[]) {
    const numbers = Array.isArray(item?.number) ? item.number.filter((n) => typeof n === "string") : [];
    if (!item?.name || numbers.length === 0) continue;
    prizes.push({
      id: typeof item.id === "string" ? item.id : "",
      name: item.name,
      reward: typeof item.reward === "string" ? item.reward : "",
      numbers,
    });
  }
  return prizes;
}

/** The latest draw, or null if it can't be fetched or parsed. Null rather
 * than a partial result on purpose — half a draw looks exactly like a whole
 * one to a reader checking a number against it. */
export async function fetchLatestDraw(): Promise<LotteryDraw | null> {
  const res = await fetchWithTimeout("Lottery API", NETWORK_TIMEOUTS.lottery, LOTTO_LATEST_URL);
  if (!res.ok) return null;
  const data = (await res.json()) as { status?: string; response?: { date?: string; prizes?: unknown; runningNumbers?: unknown } };
  if (data.status !== "success" || !data.response) return null;
  const date = data.response.date;
  if (typeof date !== "string" || date === "") return null;
  const prizes = parsePrizes(data.response.prizes);
  const runningNumbers = parsePrizes(data.response.runningNumbers);
  // A draw with no numbers at all is a broken scrape, not an empty draw.
  if (prizes.length === 0 && runningNumbers.length === 0) return null;
  return { date, prizes, runningNumbers };
}

export interface LotteryMatch {
  prizeName: string;
  reward: string;
  matchedNumber: string;
}

/** Which of the ticket's digits a given prize category is compared against.
 * Driven off the upstream's stable `id` values, not its display names, so a
 * wording change on the news site it scrapes cannot silently turn a
 * last-two-digits prize into a full-number one. */
function matchesTicket(prizeId: string, prizeNumber: string, ticket: string): boolean {
  if (prizeId === "runningNumberFrontThree") return ticket.slice(0, 3) === prizeNumber;
  if (prizeId === "runningNumberBackThree") return ticket.slice(-3) === prizeNumber;
  if (prizeId === "runningNumberBackTwo") return ticket.slice(-2) === prizeNumber;
  return ticket === prizeNumber;
}

/**
 * Every prize `ticket` wins in this draw.
 *
 * Takes the parsed LotteryDraw, the same object the chat layer holds. An
 * earlier version took the upstream's raw JSON shape instead, and matched
 * nothing at all in production while passing its tests: the tests handed it
 * the raw fixture, and the only caller handed it a parsed draw whose fields
 * are named differently. One shape, so there is no second one for a test to
 * be right about.
 *
 * A short ticket is checked only against the categories it can possibly win:
 * two digits against เลขท้าย 2 ตัว, three against the two three-digit
 * categories. Checking a 2-digit entry against รางวัลที่ 1 would compare
 * "02" to "735867" — never a match, but it would also mean a 6-digit prize
 * could never be reported for what the user actually asked about.
 */
export function findMatches(draw: LotteryDraw, ticket: string): LotteryMatch[] {
  const matches: LotteryMatch[] = [];
  for (const prize of [...draw.prizes, ...draw.runningNumbers]) {
    // No length filtering here on purpose. Each category compares the slice
    // of the ticket that category is defined on, so a short entry simply
    // fails the ones it cannot win: "67" against รางวัลที่ 1 compares "67"
    // to "735867", and against เลขหน้า 3 ตัว compares "67" to "701".
    //
    // An earlier version guarded on length anyway, and one of those guards
    // was not merely redundant but wrong: it stopped a 3-digit entry from
    // being reported for เลขท้าย 2 ตัว. Someone whose last three digits are
    // 867 *does* have 67 as their last two, so they did win it — suppressing
    // that told them they had won less than they had.
    for (const number of prize.numbers) {
      if (matchesTicket(prize.id, number, ticket)) {
        matches.push({ prizeName: prize.name, reward: prize.reward, matchedNumber: number });
      }
    }
  }
  return matches;
}

/** 2, 3 or 6 digits — the only lengths a Thai lottery ticket can be checked
 * at. Anything else is a typo, and guessing which digits were meant is how a
 * "you didn't win" gets reported for a number nobody entered. */
export function normalizeTicket(raw: string): string | null {
  const digits = raw.replace(/[\s,\-]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length !== 2 && digits.length !== 3 && digits.length !== 6) return null;
  return digits;
}
