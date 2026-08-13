// Forex Factory economic calendar (PLAN.md 15.13, extending the finance-news
// summary) — real, scheduled US macro events that can move the gold price,
// fetched from the same kind of free no-key community feed the rest of
// marketData.ts already relies on. Same guardrail shape as everywhere else
// in this codebase: real event titles/times are fetched here and handed to
// Gemini as labeled ground truth in news.ts's fetchFinanceNewsSummary — the
// model only ever selects/narrates from this real list (which of these
// events actually tends to move gold — rate decisions, employment,
// inflation — is a judgment call worth delegating), it never invents an
// event, a time, or a fact not present in what's fetched here.

const FF_CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

export interface EconomicEvent {
  title: string;
  impact: string; // "High" | "Medium" as reported by the feed
  timeThai: string; // "HH:MM", Bangkok-local
}

function bangkokDateKeyOf(d: Date): string {
  return new Date(d.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

function formatBangkokTime(d: Date): string {
  const bangkok = new Date(d.getTime() + BANGKOK_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(bangkok.getUTCHours())}:${pad(bangkok.getUTCMinutes())}`;
}

/** Today's (Bangkok calendar day) medium/high-impact USD economic events —
 * the kind that can realistically move gold. USD-only because gold trades
 * primarily off US monetary policy/macro data; medium+high impact (not just
 * high) so a weekly release like unemployment claims — often rated Medium —
 * isn't excluded, matching what was explicitly asked for.
 *
 * Returns null if the feed itself couldn't be fetched or didn't parse at
 * all — distinct from "fetched fine, nothing scheduled today" ([]), so the
 * caller can tell "couldn't check" apart from a confirmed empty calendar. */
export async function fetchTodayUsEconomicEvents(): Promise<EconomicEvent[] | null> {
  try {
    const res = await fetch(FF_CALENDAR_URL);
    if (!res.ok) return null;
    const data: any = await res.json();
    if (!Array.isArray(data)) return null;

    const todayBangkok = bangkokDateKeyOf(new Date());
    const events: EconomicEvent[] = [];
    for (const item of data) {
      if (typeof item?.title !== "string") continue;
      if (item?.country !== "USD") continue;
      if (item?.impact !== "High" && item?.impact !== "Medium") continue;
      if (typeof item?.date !== "string") continue;
      const eventDate = new Date(item.date);
      if (Number.isNaN(eventDate.getTime())) continue;
      if (bangkokDateKeyOf(eventDate) !== todayBangkok) continue;
      events.push({ title: item.title, impact: item.impact, timeThai: formatBangkokTime(eventDate) });
    }
    return events;
  } catch (err) {
    console.error("fetchTodayUsEconomicEvents failed", err);
    return null;
  }
}
