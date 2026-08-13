// Real-number market data for "ถาม ข่าวหุ้น" (PLAN.md 15.12 extension).
// Unlike news.ts's RSS headlines — which are only safe to summarize
// qualitatively, never as a source of "the current price" — these are
// actual live numbers from free, no-API-key endpoints. Same guardrail
// principle used everywhere else in this file's guardrail lineage (money
// totals, today's date, calendar events, weather): fetch the real number in
// code, hand it to Gemini as a labeled fact it must quote back exactly, and
// never ask the model to guess or compute one itself.
//
// Every fetch below degrades independently to null/[] on failure (bad
// response, network error, upstream API shape change) — none of these are
// official, versioned APIs with a stability guarantee, so a broken one must
// never take the other numbers or the headline summary down with it.

export interface MoverQuote {
  symbol: string;
  changePercent: number;
}

export interface MarketSnapshot {
  btcUsd: number | null;
  goldUsd: number | null;
  sp500: number | null;
  topGainers: MoverQuote[];
  topLosers: MoverQuote[];
}

const YAHOO_HEADERS = { "User-Agent": "Mozilla/5.0" };

async function fetchBitcoinPriceUsd(): Promise<number | null> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
    if (!res.ok) return null;
    const data: any = await res.json();
    const price = data?.bitcoin?.usd;
    return typeof price === "number" ? price : null;
  } catch (err) {
    console.error("fetchBitcoinPriceUsd failed", err);
    return null;
  }
}

async function fetchGoldPriceUsd(): Promise<number | null> {
  try {
    const res = await fetch("https://api.gold-api.com/price/XAU");
    if (!res.ok) return null;
    const data: any = await res.json();
    const price = data?.price;
    return typeof price === "number" ? price : null;
  } catch (err) {
    console.error("fetchGoldPriceUsd failed", err);
    return null;
  }
}

async function fetchSp500Index(): Promise<number | null> {
  try {
    const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC", {
      headers: YAHOO_HEADERS,
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof price === "number" ? price : null;
  } catch (err) {
    console.error("fetchSp500Index failed", err);
    return null;
  }
}

async function fetchMovers(scrId: "day_gainers" | "day_losers", count: number): Promise<MoverQuote[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=${count}&scrIds=${scrId}&lang=en-US&region=US`;
    const res = await fetch(url, { headers: YAHOO_HEADERS });
    if (!res.ok) return [];
    const data: any = await res.json();
    const quotes = data?.finance?.result?.[0]?.quotes;
    if (!Array.isArray(quotes)) return [];
    const movers: MoverQuote[] = [];
    for (const q of quotes) {
      if (typeof q?.symbol === "string" && typeof q?.regularMarketChangePercent === "number") {
        movers.push({ symbol: q.symbol, changePercent: q.regularMarketChangePercent });
      }
    }
    return movers;
  } catch (err) {
    console.error(`fetchMovers(${scrId}) failed`, err);
    return [];
  }
}

/** Best-effort snapshot of BTC/gold/S&P 500 plus up to 2 top US gainers and
 * 2 top US losers (yesterday's close vs. the prior session) — every field
 * fetched in parallel and independently allowed to come back empty. */
export async function fetchMarketSnapshot(): Promise<MarketSnapshot> {
  const [btcUsd, goldUsd, sp500, topGainers, topLosers] = await Promise.all([
    fetchBitcoinPriceUsd(),
    fetchGoldPriceUsd(),
    fetchSp500Index(),
    fetchMovers("day_gainers", 2),
    fetchMovers("day_losers", 2),
  ]);
  return { btcUsd, goldUsd, sp500, topGainers, topLosers };
}

/** Renders a snapshot into labeled lines for the Gemini prompt, or "" if
 * every field came back empty (caller decides what to do with that). */
export function formatMarketSnapshotForPrompt(snapshot: MarketSnapshot): string {
  const lines: string[] = [];
  if (snapshot.btcUsd !== null) {
    lines.push(`บิตคอยน์ (BTC/USD): $${snapshot.btcUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
  }
  if (snapshot.goldUsd !== null) {
    lines.push(`ทองคำ (XAU ต่อออนซ์, USD): $${snapshot.goldUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
  }
  if (snapshot.sp500 !== null) {
    lines.push(`ดัชนี S&P 500: ${snapshot.sp500.toLocaleString("en-US", { maximumFractionDigits: 2 })} จุด`);
  }
  if (snapshot.topGainers.length > 0) {
    const list = snapshot.topGainers.map((q) => `${q.symbol} (+${q.changePercent.toFixed(2)}%)`).join(", ");
    lines.push(`หุ้นสหรัฐฯ ที่ขึ้นแรงสุดหลังปิดตลาดล่าสุด: ${list}`);
  }
  if (snapshot.topLosers.length > 0) {
    const list = snapshot.topLosers.map((q) => `${q.symbol} (${q.changePercent.toFixed(2)}%)`).join(", ");
    lines.push(`หุ้นสหรัฐฯ ที่ลงแรงสุดหลังปิดตลาดล่าสุด: ${list}`);
  }
  return lines.join("\n");
}
