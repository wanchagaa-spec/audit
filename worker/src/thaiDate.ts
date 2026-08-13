// Rule-based Thai date/time parsing + Asia/Bangkok helpers for the calendar
// feature (PLAN.md 15.3). Deliberately only understands explicit formats
// ("12/1/2569 13:00", "12 ม.ค. 13.00") — no natural-language phrases like
// "พรุ่งนี้บ่ายสอง". PLAN.md 15.3 flags full NL parsing as the one place an
// AI fallback would actually be worth it later; this stays rule-based.

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

const MONTHS: Array<{ month: number; keywords: string[] }> = [
  { month: 1, keywords: ["มกราคม", "มกรา", "ม.ค."] },
  { month: 2, keywords: ["กุมภาพันธ์", "กุมภา", "ก.พ."] },
  { month: 3, keywords: ["มีนาคม", "มีนา", "มี.ค."] },
  { month: 4, keywords: ["เมษายน", "เมษา", "เม.ย."] },
  { month: 5, keywords: ["พฤษภาคม", "พฤษภา", "พ.ค."] },
  { month: 6, keywords: ["มิถุนายน", "มิถุนา", "มิ.ย."] },
  { month: 7, keywords: ["กรกฎาคม", "กรกฎา", "ก.ค."] },
  { month: 8, keywords: ["สิงหาคม", "สิงหา", "ส.ค."] },
  { month: 9, keywords: ["กันยายน", "กันยา", "ก.ย."] },
  { month: 10, keywords: ["ตุลาคม", "ตุลา", "ต.ค."] },
  { month: 11, keywords: ["พฤศจิกายน", "พฤศจิกา", "พ.ย."] },
  { month: 12, keywords: ["ธันวาคม", "ธันวา", "ธ.ค."] },
];

const MONTH_ABBR = MONTHS.map((m) => m.keywords[2]);
const MONTH_FULL = MONTHS.map((m) => m.keywords[0]);

const MONTH_LOOKUP = new Map<string, number>();
for (const { month, keywords } of MONTHS) {
  for (const kw of keywords) MONTH_LOOKUP.set(kw, month);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MONTH_PATTERN = Array.from(MONTH_LOOKUP.keys())
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join("|");

function toDateKey(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null; // rejects invalid dates like 30 กุมภาพันธ์ instead of silently rolling over
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

function christianYear(rawYear: number): number {
  return rawYear > 2400 ? rawYear - 543 : rawYear;
}

export interface ParsedDate {
  dateKey: string; // YYYY-MM-DD
  matchedText: string;
  index: number; // position of matchedText within the text that was searched
}

/** Extracts the first recognizable date in `text`. Returns null if none found. */
export function extractDate(text: string, defaultYear: number): ParsedDate | null {
  const numeric = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const year = christianYear(Number(numeric[3]));
    const dateKey = toDateKey(year, month, day);
    if (dateKey) return { dateKey, matchedText: numeric[0], index: numeric.index ?? 0 };
  }

  const named = text.match(new RegExp(`(\\d{1,2})\\s*(${MONTH_PATTERN})\\s*(\\d{4})?`));
  if (named) {
    const day = Number(named[1]);
    const month = MONTH_LOOKUP.get(named[2]);
    if (month) {
      const year = named[3] ? christianYear(Number(named[3])) : defaultYear;
      const dateKey = toDateKey(year, month, day);
      if (dateKey) return { dateKey, matchedText: named[0], index: named.index ?? 0 };
    }
  }

  return null;
}

export interface ParsedTime {
  time: string; // HH:MM, 24-hour
  matchedText: string;
}

/** Extracts the first HH:MM or HH.MM time in `text`. Returns null if none found. */
export function extractTime(text: string): ParsedTime | null {
  const m = text.match(/(\d{1,2})[:.](\d{2})\s*น\.?/) ?? text.match(/(\d{1,2})[:.](\d{2})/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return { time: `${pad(hour)}:${pad(minute)}`, matchedText: m[0] };
}

/**
 * Finds a date and a time together in `text`, preferring a time that appears
 * right after the date (the "<title> <date> <time>" command shape) over one
 * found anywhere in the string — otherwise a decimal number elsewhere in a
 * free-text title (e.g. "ประชุมงบ 12.5 ล้าน") can get misread as a time
 * before the real one is ever reached. Falls back to searching the text
 * before the date if nothing follows it.
 */
export function extractDateAndTime(
  text: string,
  defaultYear: number
): { date: ParsedDate; time: ParsedTime } | null {
  const date = extractDate(text, defaultYear);
  if (!date) return null;
  const after = text.slice(date.index + date.matchedText.length);
  const before = text.slice(0, date.index);
  const time = extractTime(after) ?? extractTime(before);
  if (!time) return null;
  return { date, time };
}

/** "2026-01-12" -> "12 ม.ค. 2569" (Buddhist year, Bangkok-local by construction). */
export function formatThaiDateLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return `${d} ${MONTH_ABBR[m - 1]} ${y + 543}`;
}

/** "2026-01-12" -> "12 มกราคม 2569" — full month name, used where the abbreviated form (formatThaiDateLabel) reads too terse (e.g. a finance-news report header). */
export function formatThaiDateLabelFull(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return `${d} ${MONTH_FULL[m - 1]} ${y + 543}`;
}

function toBangkok(d: Date): Date {
  return new Date(d.getTime() + BANGKOK_OFFSET_MS);
}

/** "YYYY-MM-DD" for the current moment in Asia/Bangkok time. */
export function bangkokDateKey(d: Date = new Date()): string {
  return toBangkok(d).toISOString().slice(0, 10);
}

/**
 * Current year in Asia/Bangkok time (Christian era). Use this instead of
 * `new Date().getUTCFullYear()` for anything date-related — the Worker runs
 * in UTC, so for roughly the last 7 hours of every Bangkok year, plain UTC
 * year is already the *next* year and would misdate an unqualified "1 ม.ค."
 */
export function bangkokYear(d: Date = new Date()): number {
  return Number(bangkokDateKey(d).slice(0, 4));
}

/** "YYYY-MM" for the current moment in Asia/Bangkok time. */
export function bangkokMonthKey(d: Date = new Date()): string {
  return bangkokDateKey(d).slice(0, 7);
}

/** Day-folder name like "1-1-2569" in Asia/Bangkok time with a Buddhist-era year. */
export function bangkokDateFolderName(timestampMs: number): string {
  const bk = toBangkok(new Date(timestampMs));
  return `${bk.getUTCDate()}-${bk.getUTCMonth() + 1}-${bk.getUTCFullYear() + 543}`;
}

/** 0 = Monday .. 6 = Sunday, in Asia/Bangkok time. */
export function bangkokWeekdayIndex(d: Date = new Date()): number {
  const day = toBangkok(d).getUTCDay(); // 0 = Sunday
  return day === 0 ? 6 : day - 1;
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** RFC3339 timestamp for 00:00 Asia/Bangkok time on `dateKey`. */
export function bangkokStartOfDayIso(dateKey: string): string {
  return `${dateKey}T00:00:00+07:00`;
}

function bangkokWallToUtcMs(dateKey: string, time: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - BANGKOK_OFFSET_MS;
}

function utcMsToRfc3339Bangkok(utcMs: number): string {
  const bk = new Date(utcMs + BANGKOK_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${bk.getUTCFullYear()}-${pad(bk.getUTCMonth() + 1)}-${pad(bk.getUTCDate())}T${pad(bk.getUTCHours())}:${pad(bk.getUTCMinutes())}:00+07:00`;
}

/** RFC3339 timestamp (with +07:00 offset) for `time` on `dateKey`, Bangkok-local. */
export function toRfc3339(dateKey: string, time: string): string {
  return utcMsToRfc3339Bangkok(bangkokWallToUtcMs(dateKey, time));
}

/** Same as `toRfc3339` but one hour later, correctly rolling over midnight. */
export function toRfc3339PlusOneHour(dateKey: string, time: string): string {
  return utcMsToRfc3339Bangkok(bangkokWallToUtcMs(dateKey, time) + 60 * 60 * 1000);
}
