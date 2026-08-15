// Travelpayouts (Aviasales/Hotellook) Data API wrapper (PLAN.md 17.37) —
// powers the real flight/hotel prices shown in chat by the travel search
// feature (travelCommands.ts). Prices here are strictly best-effort
// decoration on top of the booking links that always go out either way: a
// missing token, an exhausted quota, or any API failure degrades to
// links-only, never to a dead reply. Like GOOGLE_MAPS_API_KEY (places.ts),
// this is a flat app-level credential, not per-user OAuth — so, also like
// Places, there are no per-user remediation error classes here (re-linking
// a Google account can't fix a Travelpayouts problem; only the bot admin
// can).
//
// Why Travelpayouts and not Amadeus: this feature originally shipped
// against Amadeus Self-Service — then turned out to be unusable before it
// was ever merged, because Amadeus decommissioned that whole portal on
// 2026-07-17 (new registrations closed earlier; existing keys disabled).
// Verified via web search when the user's signup attempt found no Register
// button at all. Travelpayouts' Data API is the surviving free option:
// simple token auth, and its Aviasales search cache actually covers Thai
// low-cost carriers (AirAsia/Nok Air) that Amadeus' GDS inventory mostly
// missed. The trade-off, stated in every reply: these are *cached* prices
// from recent searches, not a live availability check — fine for
// comparing, the linked sites are the source of truth at booking time.

const AVIASALES_PRICES_URL = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates";
const HOTELLOOK_CACHE_URL = "https://engine.hotellook.com/api/v2/cache.json";

async function travelFetch(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { "X-Access-Token": token } });
  if (!res.ok) {
    throw new Error(`Travelpayouts API error (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export interface FlightOfferSummary {
  airline: string; // marketing airline's IATA code, e.g. "TG" or "FD"
  departTime: string; // "08:00", local to the departure airport
  stops: number; // 0 = direct ("transfers" in the API)
  priceLabel: string; // e.g. "1,540 บาท" — the API returns the requested currency
}

/** One-way cached offers for the date, cheapest-first, capped at `max`.
 * `origin`/`destination` are IATA codes the caller has already validated. */
export async function searchFlightOffers(
  token: string,
  origin: string,
  destination: string,
  dateKey: string,
  max = 5
): Promise<FlightOfferSummary[]> {
  const q = new URLSearchParams({
    origin,
    destination,
    departure_at: dateKey,
    one_way: "true",
    currency: "thb",
    sorting: "price",
    limit: String(max),
  });
  const data = await travelFetch(`${AVIASALES_PRICES_URL}?${q}`, token);
  return ((data.data ?? []) as any[]).map((offer) => {
    const amount = Number(offer.price ?? 0);
    return {
      airline: (offer.airline as string | undefined) ?? "?",
      departTime: String(offer.departure_at ?? "").slice(11, 16) || "--:--",
      stops: Number(offer.transfers ?? 0),
      priceLabel: `${amount.toLocaleString("th-TH", { maximumFractionDigits: 0 })} บาท`,
    };
  });
}

export interface HotelOfferSummary {
  name: string;
  stars: number; // 0 when unrated
  priceLabel: string; // "from" price for the whole stay, e.g. "เริ่ม 2,300 บาท"
}

/** Cheapest cached hotel prices in the city for the stay. `cityName` is a
 * free-text location for Hotellook's own resolver (it handles Thai and
 * English city names), not an IATA code — unlike flights above. */
export async function searchHotelOffers(
  token: string,
  cityName: string,
  checkInDateKey: string,
  checkOutDateKey: string,
  max = 5
): Promise<HotelOfferSummary[]> {
  const q = new URLSearchParams({
    location: cityName,
    checkIn: checkInDateKey,
    checkOut: checkOutDateKey,
    currency: "thb",
    limit: String(max),
  });
  const data = await travelFetch(`${HOTELLOOK_CACHE_URL}?${q}`, token);
  // Unlike the Aviasales endpoint's {data: [...]} envelope, Hotellook's
  // cache endpoint returns a bare array.
  const entries = (Array.isArray(data) ? data : []) as any[];
  return entries
    .map((h) => {
      const amount = Number(h.priceFrom ?? 0);
      return {
        name: (h.hotelName as string | undefined) ?? "(ไม่ทราบชื่อ)",
        stars: Number(h.stars ?? 0),
        amount,
        priceLabel: `เริ่ม ${amount.toLocaleString("th-TH", { maximumFractionDigits: 0 })} บาท`,
      };
    })
    .filter((h) => h.amount > 0)
    .sort((a, b) => a.amount - b.amount)
    .slice(0, max)
    .map(({ name, stars, priceLabel }) => ({ name, stars, priceLabel }));
}
