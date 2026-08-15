// Google Places API helpers (PLAN.md 17.30) — the sixth Google integration
// this bot connects to, and the first that needs no per-user OAuth at all:
// place search is public data, not tied to any individual Google account,
// so this uses a flat Google Maps Platform API key (GOOGLE_MAPS_API_KEY)
// instead of the refresh-token dance every prior integration goes through.
// No re-link flow, no OAuth scope — just a project-level key like
// GEMINI_API_KEY.

const PLACES_BASE = "https://maps.googleapis.com/maps/api/place";

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
  const q = new URLSearchParams({
    location: `${lat},${lng}`,
    radius: "1500",
    keyword,
    language: "th",
    key: apiKey,
  });
  const res = await fetch(`${PLACES_BASE}/nearbysearch/json?${q}`);
  if (!res.ok) {
    throw new Error(`Google Places API error (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { status: string; error_message?: string; results?: any[] };
  // ZERO_RESULTS is a normal, successful "nothing nearby" outcome, not a
  // failure — only anything else counts as an actual API problem (bad key,
  // quota, disabled API, etc.).
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(`Google Places API error: ${data.status}${data.error_message ? ` — ${data.error_message}` : ""}`);
  }
  return (data.results ?? []).slice(0, 5).map((r) => ({
    name: r.name,
    address: r.vicinity ?? "",
    rating: typeof r.rating === "number" ? r.rating : undefined,
    mapsUrl: r.place_id
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name)}&query_place_id=${r.place_id}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name)}`,
  }));
}
