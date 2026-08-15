// Nearby-place search via LINE's native location-sharing (PLAN.md 17.30):
// "หา<คำ>ใกล้ฉัน" asks the user to share their current location; the location
// message that follows (handled directly in index.ts, not a text command at
// all — LINE's location-sharing UI carries no text/mention) resolves it via
// answerNearbySearch. Unlike every write-capable feature in this bot, this
// never confirms-before-save — it only ever reads back public place data,
// nothing is created, changed, or sent on the user's behalf.

import { searchNearbyPlaces } from "./places.ts";
import { getPendingPlaceSearch, setPendingPlaceSearch } from "./state.ts";

type Handler = (ctx: { kv: KVNamespace; lineUserId: string }) => Promise<string>;

const NEARBY_RE = /^หา(.+?)(?:ใกล้ฉัน|ใกล้ตัว|แถวนี้|ใกล้ๆ)$/;

export async function matchPlacesCommand(text: string): Promise<Handler | null> {
  const trimmed = text.trim();
  const m = trimmed.match(NEARBY_RE);
  if (!m) return null;
  const keyword = m[1].trim();
  if (!keyword) return null;
  return async (ctx) => {
    await setPendingPlaceSearch(ctx.kv, ctx.lineUserId, { keyword });
    return `แชร์ตำแหน่งปัจจุบันมาได้เลยนะ (กดไอคอน + ข้างช่องพิมพ์ในไลน์ > ตำแหน่งที่ตั้ง) เดี๋ยวหา "${keyword}" ใกล้ๆ ให้`;
  };
}

/** Called from index.ts when a LINE location message arrives. Returns null
 * (meaning: send no reply at all) when nobody asked for a search — the same
 * "stay silent, nothing was clearly meant for the bot" default every other
 * unprompted event in this bot already follows (an unmentioned group photo
 * with no active trip, an unmentioned group text). */
export async function answerNearbySearch(
  kv: KVNamespace,
  subjectId: string,
  mapsApiKey: string,
  lat: number,
  lng: number
): Promise<string | null> {
  const pending = await getPendingPlaceSearch(kv, subjectId);
  if (!pending) return null;
  await setPendingPlaceSearch(kv, subjectId, null);

  if (!mapsApiKey) {
    return "ฟีเจอร์ค้นหาสถานที่ยังไม่พร้อมใช้งาน (ยังไม่ได้ตั้งค่า Google Maps API key) แจ้งผู้ดูแลบอทดูนะ";
  }

  let places;
  try {
    places = await searchNearbyPlaces(mapsApiKey, lat, lng, pending.keyword);
  } catch (err) {
    // No per-user remediation makes sense here (unlike Calendar/Tasks/
    // Gmail's re-link vs. enable-API split) — a bad key, quota, or disabled
    // Places API can only ever be fixed by whoever runs the bot, so this
    // just degrades to one generic message rather than a specific error
    // class the caller would have to classify.
    console.error("searchNearbyPlaces failed", err);
    return "ค้นหาสถานที่ไม่สำเร็จ ลองใหม่อีกครั้งนะ";
  }

  if (places.length === 0) return `ไม่พบ "${pending.keyword}" ใกล้ๆ ตำแหน่งที่แชร์มาเลยนะ`;
  const lines = places.map((p, i) => `${i + 1}. ${p.name}${p.rating ? ` (⭐${p.rating})` : ""} — ${p.address}\n${p.mapsUrl}`);
  return [`${pending.keyword}ใกล้ๆ ตำแหน่งที่แชร์มา:`, ...lines].join("\n");
}
