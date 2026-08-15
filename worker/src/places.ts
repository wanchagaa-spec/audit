// Google Places API (New) helpers (PLAN.md 17.30/17.31) — the sixth Google
// integration this bot connects to, and the first that needs no per-user
// OAuth at all: place search is public data, not tied to any individual
// Google account, so this uses a flat Google Maps Platform API key
// (GOOGLE_MAPS_API_KEY) instead of the refresh-token dance every prior
// integration goes through. No re-link flow, no OAuth scope — just a
// project-level key like GEMINI_API_KEY.
//
// Uses Text Search (New), not Nearby Search (New): Nearby Search (New) only
// takes a fixed enum of place types (includedTypes: ["restaurant", ...]),
// not arbitrary free text — this bot needs to search whatever Thai keyword
// the user actually typed ("ร้านกาแฟ", "ที่จอดรถ", ...), which only Text
// Search's `textQuery` field supports. locationRestriction (a hard circle,
// not just a bias) keeps the original "within ~1.5km" semantics the older
// Nearby Search radius parameter had.

const SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";

// Only ask for the fields actually used below — Places API (New) bills by
// which fields are requested via this header, so requesting more than
// needed costs more for no benefit.
const FIELD_MASK = "places.displayName,places.formattedAddress,places.rating,places.googleMapsUri";

export interface NearbyPlace {
  name: string;
  address: string;
  rating?: number;
  mapsUrl: string;
}

/** Places within ~1.5km of (lat, lng) matching `keyword`, nearest few only
 * (capped client-side) — this bot only ever shows a short list in a LINE
 * reply, never a full paginated result set. */
export async function searchNearbyPlaces(
  apiKey: string,
  lat: number,
  lng: number,
  keyword: string
): Promise<NearbyPlace[]> {
  const res = await fetch(SEARCH_TEXT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: keyword,
      languageCode: "th",
      maxResultCount: 5,
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: 1500.0,
        },
      },
    }),
  });
  if (!res.ok) {
    // Places API (New) uses plain HTTP status + a standard Google error
    // body for failures (bad key, quota, disabled API, ...) — no separate
    // in-body "status" field to check the way the legacy API had, and no
    // special-casing needed for "nothing found": that's just a 200 with an
    // empty/missing `places` array below, not an error at all.
    throw new Error(`Google Places API error (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { places?: any[] };
  return (data.places ?? []).slice(0, 5).map((p) => ({
    name: p.displayName?.text ?? "(ไม่ทราบชื่อ)",
    address: p.formattedAddress ?? "",
    rating: typeof p.rating === "number" ? p.rating : undefined,
    mapsUrl: p.googleMapsUri ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.displayName?.text ?? keyword)}`,
  }));
}
