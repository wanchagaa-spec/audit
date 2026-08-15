// Amadeus Self-Service API wrapper (PLAN.md 17.37) — powers the real
// flight/hotel prices shown in chat by the travel search feature
// (travelCommands.ts). Prices here are strictly best-effort decoration on
// top of the booking links that always go out either way: a missing key,
// an exhausted quota, or any API failure degrades to links-only, never to
// a dead reply. Like GOOGLE_MAPS_API_KEY (places.ts), this is a flat
// app-level credential pair, not per-user OAuth — so, also like Places,
// there are no per-user remediation error classes here (re-linking a
// Google account can't fix an Amadeus problem; only the bot admin can).
//
// Base URL is configurable (AMADEUS_BASE_URL) because Amadeus runs two
// environments: test.api.amadeus.com (free, no billing info, but limited/
// cached data on a subset of routes) and api.amadeus.com (production —
// still has a free monthly request quota, but requires promoting the app
// in their dashboard). Defaults to the test environment since that's the
// zero-setup one; see worker/README.md for the trade-off.

export const AMADEUS_DEFAULT_BASE_URL = "https://test.api.amadeus.com";

async function amadeusFetch(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Amadeus API error (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/** OAuth2 client-credentials token — short-lived (~30 min). Fetched per
 * search invocation rather than cached in KV: a search is 1-3 API calls
 * within the same request, and token calls don't count against the search
 * quotas that actually matter. */
export async function getAmadeusToken(baseUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const data = await amadeusFetch(`${baseUrl}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return data.access_token as string;
}

export interface FlightOfferSummary {
  airline: string; // validating airline's IATA code, e.g. "TG"
  departTime: string; // "08:00", local to the departure airport
  arriveTime: string; // local to the arrival airport
  stops: number; // 0 = direct
  priceLabel: string; // e.g. "1,540 THB" — currency echoed from the API, never assumed
}

/** One-way offers, cheapest-first (the API's own default sort), capped at
 * `max`. `origin`/`destination` are IATA codes the caller has already
 * validated. */
export async function searchFlightOffers(
  baseUrl: string,
  token: string,
  origin: string,
  destination: string,
  dateKey: string,
  max = 5
): Promise<FlightOfferSummary[]> {
  const q = new URLSearchParams({
    originLocationCode: origin,
    destinationLocationCode: destination,
    departureDate: dateKey,
    adults: "1",
    currencyCode: "THB",
    max: String(max),
  });
  const data = await amadeusFetch(`${baseUrl}/v2/shopping/flight-offers?${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return ((data.data ?? []) as any[]).map((offer) => {
    const segments = offer.itineraries?.[0]?.segments ?? [];
    const first = segments[0] ?? {};
    const last = segments[segments.length - 1] ?? {};
    const price = offer.price ?? {};
    const amount = Number(price.grandTotal ?? price.total ?? 0);
    return {
      airline: offer.validatingAirlineCodes?.[0] ?? first.carrierCode ?? "?",
      departTime: String(first.departure?.at ?? "").slice(11, 16) || "--:--",
      arriveTime: String(last.arrival?.at ?? "").slice(11, 16) || "--:--",
      stops: Math.max(0, segments.length - 1),
      priceLabel: `${amount.toLocaleString("th-TH", { maximumFractionDigits: 0 })} ${price.currency ?? "THB"}`,
    };
  });
}

export interface HotelOfferSummary {
  name: string;
  priceLabel: string; // total for the whole stay, e.g. "2,300 THB"
}

// The hotel-offers endpoint takes hotel ids, not a city — so a city search
// is a two-step: list the city's hotel ids first, then price a batch of
// them. 20 ids per offers call keeps the URL well under length limits
// while giving the price sort below enough candidates to be meaningful.
const HOTEL_ID_BATCH = 20;

/** Cheapest `max` bookable offers in the city for the stay. `cityCode` is
 * an IATA city code the caller has already validated. */
export async function searchHotelOffers(
  baseUrl: string,
  token: string,
  cityCode: string,
  checkInDateKey: string,
  checkOutDateKey: string,
  max = 5
): Promise<HotelOfferSummary[]> {
  const authHeaders = { Authorization: `Bearer ${token}` };
  const listQ = new URLSearchParams({ cityCode });
  const listData = await amadeusFetch(`${baseUrl}/v1/reference-data/locations/hotels/by-city?${listQ}`, {
    headers: authHeaders,
  });
  const hotelIds = ((listData.data ?? []) as any[])
    .map((h) => h.hotelId as string | undefined)
    .filter((id): id is string => !!id)
    .slice(0, HOTEL_ID_BATCH);
  if (hotelIds.length === 0) return [];

  const offersQ = new URLSearchParams({
    hotelIds: hotelIds.join(","),
    checkInDate: checkInDateKey,
    checkOutDate: checkOutDateKey,
    adults: "1",
    currency: "THB",
    bestRateOnly: "true",
  });
  const offersData = await amadeusFetch(`${baseUrl}/v3/shopping/hotel-offers?${offersQ}`, {
    headers: authHeaders,
  });
  const offers = ((offersData.data ?? []) as any[])
    .map((entry) => {
      const price = entry.offers?.[0]?.price ?? {};
      const amount = Number(price.total ?? 0);
      return {
        name: (entry.hotel?.name as string | undefined) ?? "(ไม่ทราบชื่อ)",
        amount,
        priceLabel: `${amount.toLocaleString("th-TH", { maximumFractionDigits: 0 })} ${price.currency ?? "THB"}`,
      };
    })
    .filter((o) => o.amount > 0);
  offers.sort((a, b) => a.amount - b.amount);
  return offers.slice(0, max).map(({ name, priceLabel }) => ({ name, priceLabel }));
}
