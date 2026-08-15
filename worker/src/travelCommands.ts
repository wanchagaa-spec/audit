// Travel search (PLAN.md 17.37): "ค้นหา/เทียบราคาแล้วส่งลิงก์ให้กดจองเอง" —
// flights and hotels get real prices in chat (Amadeus, travel.ts) when the
// key is configured, ground transport (bus/train) gets a prefilled 12Go
// link since no free price API exists for those. Booking always happens on
// the linked sites, never through the bot — so, like Places search, this
// is read-only and never confirms-before-anything: nothing is created,
// changed, sent, or spent on the user's behalf.
//
// The links are the product; the prices are decoration. Every reply
// includes booking/comparison links built purely from the parsed route and
// dates, and every failure mode of the price lookup (no key configured,
// quota exhausted, API down, route not covered) degrades to those same
// links with a one-line note — a search must never come back empty-handed
// just because the price API did.

import {
  AMADEUS_DEFAULT_BASE_URL,
  getAmadeusToken,
  searchFlightOffers,
  searchHotelOffers,
} from "./travel.ts";
import { addDaysToDateKey, bangkokYear, extractDate, formatThaiDateLabel } from "./thaiDate.ts";
import type { Env } from "./index.ts";

// Thai low-cost carriers (AirAsia, Nok Air, Thai Lion) mostly aren't in
// Amadeus' inventory, so the in-chat prices can miss the cheapest actual
// option on domestic routes — the links always show them. Said once per
// flight reply so a user never mistakes the in-chat list for exhaustive.
const FLIGHT_COVERAGE_NOTE = "หมายเหตุ: สายการบินโลว์คอสต์บางเจ้าอาจไม่โชว์ราคาตรงนี้ กดลิงก์ดูได้ครบกว่า และราคาจริงยึดตามหน้าเว็บตอนจอง";

const PRICES_NOT_CONFIGURED_NOTE = "(ยังไม่ได้ตั้งค่า Amadeus API key เลยยังโชว์ราคาในแชทไม่ได้ — กดลิงก์ดูราคาได้เลย)";
const PRICES_FAILED_NOTE = "(ดึงราคามาโชว์ตรงนี้ไม่สำเร็จตอนนี้ — กดลิงก์ดูราคาได้เลย)";

// Legacy-command city table: Thai name -> IATA code + 12Go slug + English
// label. Deliberately small — just the routes a Thai user hits constantly.
// The AI-interpreter path (the primary way in, PLAN.md 17.11) maps any
// city the model knows to codes itself and isn't limited to this list;
// this table only serves the deterministic "หาตั๋วเครื่องบิน ..." fallback
// commands, same division of labor as everywhere else in this bot.
const CITY_TABLE: Record<string, { iata: string; slug: string; en: string }> = {
  กรุงเทพ: { iata: "BKK", slug: "bangkok", en: "Bangkok" },
  กทม: { iata: "BKK", slug: "bangkok", en: "Bangkok" },
  เชียงใหม่: { iata: "CNX", slug: "chiang-mai", en: "Chiang Mai" },
  เชียงราย: { iata: "CEI", slug: "chiang-rai", en: "Chiang Rai" },
  ภูเก็ต: { iata: "HKT", slug: "phuket", en: "Phuket" },
  กระบี่: { iata: "KBV", slug: "krabi", en: "Krabi" },
  หาดใหญ่: { iata: "HDY", slug: "hat-yai", en: "Hat Yai" },
  สมุย: { iata: "USM", slug: "koh-samui", en: "Koh Samui" },
  เกาะสมุย: { iata: "USM", slug: "koh-samui", en: "Koh Samui" },
  ขอนแก่น: { iata: "KKC", slug: "khon-kaen", en: "Khon Kaen" },
  อุดรธานี: { iata: "UTH", slug: "udon-thani", en: "Udon Thani" },
  อุดร: { iata: "UTH", slug: "udon-thani", en: "Udon Thani" },
  อุบลราชธานี: { iata: "UBP", slug: "ubon-ratchathani", en: "Ubon Ratchathani" },
  อุบล: { iata: "UBP", slug: "ubon-ratchathani", en: "Ubon Ratchathani" },
  สุราษฎร์ธานี: { iata: "URT", slug: "surat-thani", en: "Surat Thani" },
  พัทยา: { iata: "UTP", slug: "pattaya", en: "Pattaya" },
  หัวหิน: { iata: "HHQ", slug: "hua-hin", en: "Hua Hin" },
  พิษณุโลก: { iata: "PHS", slug: "phitsanulok", en: "Phitsanulok" },
};

function lookupCity(name: string): { iata: string; slug: string; en: string } | null {
  return CITY_TABLE[name.trim()] ?? null;
}

// ---- Booking/comparison links -------------------------------------------
// Built from documented, long-stable URL query formats. If a site ever
// drops a param, its search page still opens (just unprefilled) — a
// degraded link, never a broken feature.

function buildFlightLinks(originCode: string, destinationCode: string, dateKey: string): string[] {
  const gf = `https://www.google.com/travel/flights?q=${encodeURIComponent(
    `flights from ${originCode} to ${destinationCode} on ${dateKey}`
  )}`;
  const yymmdd = dateKey.slice(2).replace(/-/g, "");
  const sky = `https://www.skyscanner.co.th/transport/flights/${originCode.toLowerCase()}/${destinationCode.toLowerCase()}/${yymmdd}/`;
  return [`• Google Flights: ${gf}`, `• Skyscanner: ${sky}`];
}

function buildHotelLinks(cityName: string, checkInDateKey: string, checkOutDateKey: string): string[] {
  const agoda = `https://www.agoda.com/search?textToSearch=${encodeURIComponent(cityName)}&checkIn=${checkInDateKey}&checkOut=${checkOutDateKey}&rooms=1&adults=2`;
  const booking = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(cityName)}&checkin=${checkInDateKey}&checkout=${checkOutDateKey}&group_adults=2`;
  return [`• Agoda: ${agoda}`, `• Booking.com: ${booking}`];
}

function build12GoLink(originSlug: string, destinationSlug: string, dateKey?: string): string {
  const base = `https://12go.asia/th/travel/${originSlug}/${destinationSlug}`;
  return dateKey ? `${base}?date=${dateKey}&people=1` : base;
}

// ---- Answers --------------------------------------------------------------

export interface FlightSearchRequest {
  originCode: string;
  destinationCode: string;
  originName: string;
  destinationName: string;
  dateKey: string;
}

export async function answerFlightSearch(env: Env, req: FlightSearchRequest): Promise<string> {
  const header = `✈️ ตั๋วเครื่องบิน ${req.originName} (${req.originCode}) → ${req.destinationName} (${req.destinationCode}) วันที่ ${formatThaiDateLabel(req.dateKey)}`;
  const links = ["เทียบราคา/กดจองได้เลย:", ...buildFlightLinks(req.originCode, req.destinationCode, req.dateKey)];

  let priceBlock: string[];
  if (!env.AMADEUS_CLIENT_ID || !env.AMADEUS_CLIENT_SECRET) {
    priceBlock = [PRICES_NOT_CONFIGURED_NOTE];
  } else {
    try {
      const baseUrl = env.AMADEUS_BASE_URL || AMADEUS_DEFAULT_BASE_URL;
      const token = await getAmadeusToken(baseUrl, env.AMADEUS_CLIENT_ID, env.AMADEUS_CLIENT_SECRET);
      const offers = await searchFlightOffers(baseUrl, token, req.originCode, req.destinationCode, req.dateKey);
      priceBlock =
        offers.length === 0
          ? ["ไม่เจอราคาเที่ยวบินในระบบสำหรับเส้นทาง/วันนี้ (กดลิงก์ดูอาจมีตัวเลือกมากกว่า)"]
          : [
              "ราคาที่เจอ (ต่อคน เที่ยวเดียว):",
              ...offers.map(
                (o, i) =>
                  `${i + 1}. ${o.airline} ${o.departTime}→${o.arriveTime}${o.stops === 0 ? " บินตรง" : ` ต่อเครื่อง ${o.stops} ครั้ง`} — ${o.priceLabel}`
              ),
            ];
    } catch (err) {
      console.error("answerFlightSearch: price lookup failed", err);
      priceBlock = [PRICES_FAILED_NOTE];
    }
  }

  return [header, "", ...priceBlock, "", ...links, "", FLIGHT_COVERAGE_NOTE].join("\n");
}

export interface HotelSearchRequest {
  cityCode: string;
  cityName: string;
  checkInDateKey: string;
  checkOutDateKey: string;
}

export async function answerHotelSearch(env: Env, req: HotelSearchRequest): Promise<string> {
  const header = `🏨 ที่พักใน${req.cityName} เช็คอิน ${formatThaiDateLabel(req.checkInDateKey)} เช็คเอาท์ ${formatThaiDateLabel(req.checkOutDateKey)}`;
  const links = ["เทียบราคา/กดจองได้เลย:", ...buildHotelLinks(req.cityName, req.checkInDateKey, req.checkOutDateKey)];

  let priceBlock: string[];
  if (!env.AMADEUS_CLIENT_ID || !env.AMADEUS_CLIENT_SECRET) {
    priceBlock = [PRICES_NOT_CONFIGURED_NOTE];
  } else {
    try {
      const baseUrl = env.AMADEUS_BASE_URL || AMADEUS_DEFAULT_BASE_URL;
      const token = await getAmadeusToken(baseUrl, env.AMADEUS_CLIENT_ID, env.AMADEUS_CLIENT_SECRET);
      const offers = await searchHotelOffers(baseUrl, token, req.cityCode, req.checkInDateKey, req.checkOutDateKey);
      priceBlock =
        offers.length === 0
          ? ["ไม่เจอราคาที่พักในระบบสำหรับเมือง/ช่วงวันที่นี้ (กดลิงก์ดูมีตัวเลือกครบกว่าแน่นอน)"]
          : [
              "ราคาที่เจอ (รวมทั้งช่วงพัก ถูกสุดก่อน):",
              ...offers.map((o, i) => `${i + 1}. ${o.name} — ${o.priceLabel}`),
            ];
    } catch (err) {
      console.error("answerHotelSearch: price lookup failed", err);
      priceBlock = [PRICES_FAILED_NOTE];
    }
  }

  return [
    header,
    "",
    ...priceBlock,
    "",
    ...links,
    "",
    "หมายเหตุ: ที่พักในระบบราคามีจำกัด ลิงก์ด้านบนมีตัวเลือก/โปรครบกว่า และราคาจริงยึดตามหน้าเว็บตอนจอง",
  ].join("\n");
}

export interface GroundSearchRequest {
  originName: string;
  destinationName: string;
  originSlug: string;
  destinationSlug: string;
  dateKey?: string;
}

/** Bus/train/ferry — no free price API exists for these, so this is the
 * links-only tier by design (told to the user in the reply itself, not
 * silently). 12Go covers Thai intercity bus/train/ferry/van routes well. */
export function answerGroundSearch(req: GroundSearchRequest): string {
  const dateLabel = req.dateKey ? ` วันที่ ${formatThaiDateLabel(req.dateKey)}` : "";
  return [
    `🚌🚆 ตั๋วรถทัวร์/รถไฟ ${req.originName} → ${req.destinationName}${dateLabel}`,
    "",
    "เส้นทางภาคพื้นยังไม่มีระบบราคาให้ดึงมาโชว์ในแชทได้ฟรี เลยส่งลิงก์ที่กรอกเส้นทางไว้ให้แล้ว กดเข้าไปเทียบราคา/รอบเวลา แล้วจองได้เลย:",
    `• 12Go: ${build12GoLink(req.originSlug, req.destinationSlug, req.dateKey)}`,
    "",
    "ในลิงก์มีทั้งรถทัวร์ รถไฟ รถตู้ และเรือ (ถ้าเส้นทางนั้นมี) เทียบกันในหน้าเดียว",
  ].join("\n");
}

// ---- Legacy command matchers ----------------------------------------------
// Fixed, unambiguous prefixes only — the AI interpreter handles natural
// phrasings. "หาตั๋ว"/"หาที่พัก" would also match commands.ts's
// transaction-search regex ("^(?:ค้นหา|หา)..."), so index.ts checks this
// matcher before that one (it already checks Places' "หา...ใกล้ฉัน" earlier
// still, which keeps "หาที่พักใกล้ฉัน" routed to GPS search, not here).

type Handler = (env: Env) => Promise<string>;

function parseRoute(payload: string): { origin: string; destination: string; rest: string } | null {
  // "<ต้นทาง> ไป <ปลายทาง> [วันที่...]" — the "ไป" separator keeps
  // multi-word-free Thai city names unambiguous.
  const m = payload.match(/^(\S+)\s+ไป\s+(\S+)\s*(.*)$/s);
  if (!m) return null;
  return { origin: m[1], destination: m[2], rest: m[3].trim() };
}

const UNKNOWN_CITY_REPLY = (name: string) =>
  `ยังไม่รู้จักเมือง "${name}" ในโหมดคำสั่งตรงนะ ลองพิมพ์เป็นประโยคธรรมดาแทน เช่น "หาตั๋วเครื่องบินจาก${name}ไปเชียงใหม่พรุ่งนี้" เดี๋ยว AI ช่วยตีความให้`;

export async function matchTravelCommand(text: string): Promise<Handler | null> {
  const trimmed = text.trim();

  const flightMatch = trimmed.match(/^หาตั๋วเครื่องบิน\s+(.+)$/s);
  if (flightMatch) {
    const route = parseRoute(flightMatch[1]);
    if (!route) {
      return async () => 'พิมพ์แบบ "หาตั๋วเครื่องบิน กรุงเทพ ไป เชียงใหม่ 20/12/2569" นะ (ต้องมีคำว่า "ไป" คั่น และระบุวันที่)';
    }
    const origin = lookupCity(route.origin);
    const destination = lookupCity(route.destination);
    if (!origin) return async () => UNKNOWN_CITY_REPLY(route.origin);
    if (!destination) return async () => UNKNOWN_CITY_REPLY(route.destination);
    const date = extractDate(route.rest, bangkokYear());
    if (!date) {
      return async () => 'ไม่พบวันที่ในข้อความนะ ลองพิมพ์แบบ "หาตั๋วเครื่องบิน กรุงเทพ ไป เชียงใหม่ 20/12/2569" ดู';
    }
    return (env) =>
      answerFlightSearch(env, {
        originCode: origin.iata,
        destinationCode: destination.iata,
        originName: route.origin,
        destinationName: route.destination,
        dateKey: date.dateKey,
      });
  }

  const groundMatch = trimmed.match(/^หาตั๋ว(?:รถทัวร์|รถไฟ|รถ)\s+(.+)$/s);
  if (groundMatch) {
    const route = parseRoute(groundMatch[1]);
    if (!route) {
      return async () => 'พิมพ์แบบ "หาตั๋วรถทัวร์ กรุงเทพ ไป เชียงใหม่ 20/12/2569" นะ (ต้องมีคำว่า "ไป" คั่น วันที่ใส่หรือไม่ใส่ก็ได้)';
    }
    const origin = lookupCity(route.origin);
    const destination = lookupCity(route.destination);
    if (!origin) return async () => UNKNOWN_CITY_REPLY(route.origin);
    if (!destination) return async () => UNKNOWN_CITY_REPLY(route.destination);
    const date = extractDate(route.rest, bangkokYear());
    return async () =>
      answerGroundSearch({
        originName: route.origin,
        destinationName: route.destination,
        originSlug: origin.slug,
        destinationSlug: destination.slug,
        dateKey: date?.dateKey,
      });
  }

  // Checked by index.ts only after Places' own matcher, so "หาที่พักใกล้ฉัน"
  // never reaches here — see this section's top comment.
  const hotelMatch = trimmed.match(/^หาที่พัก\s+(.+)$/s);
  if (hotelMatch) {
    const payload = hotelMatch[1].trim();
    const m = payload.match(/^(\S+)\s+(.*)$/s);
    const cityText = m ? m[1] : payload;
    const city = lookupCity(cityText);
    if (!city) return async () => UNKNOWN_CITY_REPLY(cityText);
    const restText = m ? m[2] : "";
    const checkIn = extractDate(restText, bangkokYear());
    if (!checkIn) {
      return async () => 'ไม่พบวันที่เช็คอินนะ ลองพิมพ์แบบ "หาที่พัก เชียงใหม่ 20/12/2569 ถึง 22/12/2569" ดู (ไม่ใส่วันเช็คเอาท์ = พัก 1 คืน)';
    }
    const afterCheckIn = restText.slice(restText.indexOf(checkIn.matchedText) + checkIn.matchedText.length);
    const checkOut = extractDate(afterCheckIn, bangkokYear());
    const checkOutDateKey = checkOut ? checkOut.dateKey : addDaysToDateKey(checkIn.dateKey, 1);
    return (env) =>
      answerHotelSearch(env, {
        cityCode: city.iata,
        cityName: cityText,
        checkInDateKey: checkIn.dateKey,
        checkOutDateKey,
      });
  }

  return null;
}
