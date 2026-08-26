// PM2.5 for the morning briefing and for "ฝุ่นวันนี้" (PLAN.md 17.71).
//
// Open-Meteo's Air Quality API, the same provider weather.ts already uses
// and for the same reason: free, no API key, no account, no quota. That
// matters more than it sounds — every other integration this bot has gained
// (TMDb, Travelpayouts) needed a signup and a GitHub secret before it worked
// at all, and one of them shipped broken because the secret never reached
// the Worker. This one needs nothing from the user.
//
// It also needs no new plumbing: the per-user province is already stored
// with its coordinates (state.ts's `province:<user>`), which is exactly what
// this endpoint takes.
//
// Rule-based end to end, like weather.ts and unlike the news summary — a
// number and a band, with no model in the loop to soften or embellish it.

import { fetchWithTimeout, NETWORK_TIMEOUTS } from "./timeouts.ts";
import type { GeocodedProvince } from "./weather.ts";

export interface AirQualityReading {
  /** µg/m³. The number Thai people actually quote to each other. */
  pm25: number;
  pm10: number | null;
}

/**
 * Thailand's own five colour bands (ดัชนีคุณภาพอากาศ พ.ศ. 2566), not the US
 * or European AQI the same endpoint can return.
 *
 * A Thai reader knows what "ฝุ่นสีส้ม" means and does not know what "US AQI
 * 142" means; translating into a scale nobody here uses would be accurate
 * and useless at once.
 *
 * Boundary provenance, because this ends in health advice: the 15, 37.5 and
 * 75.1 boundaries are all confirmed against the Pollution Control
 * Department's 2566 announcement — 37.5 is the new 24-hour standard, 15 the
 * new annual one, and the red band is stated as starting at 75.1. The 25.0
 * green/yellow boundary could not be read from a primary source here (the
 * sandbox's egress proxy blocks pcd.go.th and every Thai government mirror
 * of the table), and is the widely published figure. It is also the only
 * boundary where being wrong is harmless: it separates "ดีมาก" from "ดี",
 * and the advice on both sides is the same. Every boundary that changes what
 * someone should *do* is verified.
 */
export interface Pm25Band {
  label: string;
  emoji: string;
  /** Empty for the two clean bands: there is nothing to do, and inventing an
   * instruction for a good air day is how a daily line becomes noise. */
  advice: string;
}

export function pm25Band(pm25: number): Pm25Band {
  if (pm25 <= 15) return { label: "ดีมาก", emoji: "💙", advice: "" };
  if (pm25 <= 25) return { label: "ดี", emoji: "💚", advice: "" };
  if (pm25 <= 37.5) return { label: "ปานกลาง", emoji: "💛", advice: "คนที่แพ้ฝุ่นง่ายเลี่ยงออกกำลังกายกลางแจ้งนานๆ" };
  if (pm25 <= 75) return { label: "เริ่มมีผลต่อสุขภาพ", emoji: "🧡", advice: "ใส่หน้ากากกันฝุ่นถ้าต้องอยู่กลางแจ้งนาน" };
  return { label: "มีผลต่อสุขภาพ", emoji: "❤️", advice: "เลี่ยงกิจกรรมกลางแจ้ง ใส่หน้ากาก N95 ถ้าต้องออกไป" };
}

/** Current PM2.5 for `province`, or null if the fetch fails or the response
 * has no reading — the caller drops the line rather than guessing a number,
 * the same rule fetchWeatherSummary follows. */
export async function fetchAirQuality(province: GeocodedProvince): Promise<AirQualityReading | null> {
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${province.lat}&longitude=${province.lon}` +
    `&current=pm2_5,pm10&timezone=Asia%2FBangkok`;
  const res = await fetchWithTimeout("Air quality API", NETWORK_TIMEOUTS.weather, url);
  if (!res.ok) return null;
  const data = (await res.json()) as { current?: { pm2_5?: number | null; pm10?: number | null } };
  const pm25 = data.current?.pm2_5;
  // Explicit against null and non-finite, not a falsy check: a genuine
  // reading of 0 is clean air and must not be discarded as "missing".
  if (typeof pm25 !== "number" || !Number.isFinite(pm25)) return null;
  const pm10 = data.current?.pm10;
  return { pm25, pm10: typeof pm10 === "number" && Number.isFinite(pm10) ? pm10 : null };
}

/** The briefing/chat line. One decimal because that is how the number is
 * quoted here and how the band boundaries are written (37.5, 75.1) — rounded
 * to whole numbers, a reading of 37.6 would print as "38" next to a band
 * whose boundary is 37.5 and look like a contradiction. */
export function formatAirQualityLine(reading: AirQualityReading, provinceName: string): string {
  const band = pm25Band(reading.pm25);
  const head = `${band.emoji} ฝุ่น PM2.5 ที่${provinceName} ${reading.pm25.toFixed(1)} µg/m³ — ${band.label}`;
  return band.advice ? `${head}\n${band.advice}` : head;
}
