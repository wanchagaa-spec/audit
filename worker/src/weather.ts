// Weather for the morning briefing (PLAN.md 15.11). Uses Open-Meteo
// (open-meteo.com) — chosen because both its geocoding and forecast
// endpoints are free with no API key or account at all, which fits this
// project's "free forever" approach better than any key-based weather API
// would (see PLAN.md 3 for the same reasoning applied to every other piece
// of this bot). Rule-based end to end: no AI involved in fetching or
// formatting weather, unlike the news summary in news.ts.

export interface GeocodedProvince {
  name: string;
  lat: number;
  lon: number;
}

/** Resolves a Thai province/city name to coordinates, or null if not found. */
export async function geocodeProvince(name: string): Promise<GeocodedProvince | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    name
  )}&count=1&language=th&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo geocoding error (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { results?: Array<{ name: string; latitude: number; longitude: number }> };
  const first = data.results?.[0];
  if (!first) return null;
  return { name: first.name, lat: first.latitude, lon: first.longitude };
}

// WMO weather codes (the standard the forecast API returns) collapsed into
// the handful of Thai-language buckets a casual daily briefing actually
// needs — full precision (e.g. distinguishing "light" vs "moderate"
// drizzle) doesn't matter for a one-line summary. See
// https://open-meteo.com/en/docs for the full code table this is based on.
function describeWeatherCode(code: number): string {
  if (code === 0) return "☀️ ท้องฟ้าแจ่มใส";
  if (code <= 2) return "🌤️ มีเมฆบางส่วน";
  if (code === 3) return "☁️ เมฆมาก";
  if (code === 45 || code === 48) return "🌫️ มีหมอก";
  if (code >= 51 && code <= 57) return "🌦️ ฝนตกปรอยๆ";
  if (code >= 61 && code <= 67) return "🌧️ ฝนตก";
  if (code >= 71 && code <= 77) return "🌨️ หิมะตก";
  if (code >= 80 && code <= 82) return "🌦️ ฝนตกเป็นช่วงๆ";
  if (code >= 85 && code <= 86) return "🌨️ หิมะตกเป็นช่วงๆ";
  if (code >= 95) return "⛈️ พายุฝนฟ้าคะนอง";
  return "🌡️ อากาศทั่วไป";
}

/** One-line weather summary for `province`, or null if the forecast fetch fails. */
export async function fetchWeatherSummary(province: GeocodedProvince): Promise<string | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${province.lat}&longitude=${province.lon}` +
    `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=Asia%2FBangkok`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    current?: { temperature_2m?: number; weather_code?: number };
    daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
  };
  const temp = data.current?.temperature_2m;
  const code = data.current?.weather_code;
  if (temp === undefined || code === undefined) return null;
  const max = data.daily?.temperature_2m_max?.[0];
  const min = data.daily?.temperature_2m_min?.[0];
  const rangePart = max !== undefined && min !== undefined ? ` (สูงสุด ${Math.round(max)}° ต่ำสุด ${Math.round(min)}°)` : "";
  return `${describeWeatherCode(code)} ที่${province.name} ${Math.round(temp)}°C${rangePart}`;
}
