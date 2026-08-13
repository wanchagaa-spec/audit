// Real-number market data for "ถาม ข่าวหุ้น" (PLAN.md 15.12 extension, format
// revised in 15.13). Unlike news.ts's RSS headlines — which are only safe to
// summarize qualitatively, never as a source of "the current price" — these
// are actual live numbers from free, no-API-key endpoints. Same guardrail
// principle used everywhere else in this codebase (money totals, today's
// date, calendar events, weather): fetch the real number in code and never
// ask the model to guess or compute one itself. As of 15.13 this goes a step
// further for market data specifically: the price/change/movers lines are
// now built as plain deterministic text (buildMarketHeaderBlock) instead of
// being handed to Gemini to restate — removing any chance of the model
// paraphrasing/rounding/mistyping a number, for the one part of this
// feature that's pure formatting with no summarization judgment involved.
//
// Every fetch below degrades independently to null/[] on failure (bad
// response, network error, upstream API shape change) — none of these are
// official, versioned APIs with a stability guarantee, so a broken one must
// never take the other numbers or the headline summary down with it.

export interface MoverQuote {
  symbol: string;
  changePercent: number;
}

export interface Quote {
  price: number;
  // null when the source didn't include a change figure (or it didn't parse
  // as a number) — the price itself is still shown, just without a % line.
  changePercent: number | null;
}

export interface MarketSnapshot {
  gold: Quote | null;
  btc: Quote | null;
  topGainers: MoverQuote[];
  topLosers: MoverQuote[];
}

// Sent on every market-data fetch below, not just Yahoo's — found in a real
// report: gold and BTC both came back empty in production while movers
// (already sent with this header) worked fine. A bare Cloudflare Workers
// fetch() sends no User-Agent at all, and several of these free/unofficial
// endpoints appear to reject or bot-filter requests that look nothing like a
// browser — the same reasoning Yahoo's endpoints already needed this for.
const BROWSER_LIKE_HEADERS = { "User-Agent": "Mozilla/5.0" };

async function fetchBitcoinQuote(): Promise<Quote | null> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
      { headers: BROWSER_LIKE_HEADERS }
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const price = data?.bitcoin?.usd;
    if (typeof price !== "number") return null;
    const changePercent = data?.bitcoin?.usd_24h_change;
    return { price, changePercent: typeof changePercent === "number" ? changePercent : null };
  } catch (err) {
    console.error("fetchBitcoinQuote failed", err);
    return null;
  }
}

async function fetchGoldQuote(): Promise<Quote | null> {
  try {
    const res = await fetch("https://data-asg.goldprice.org/dbXRates/USD", { headers: BROWSER_LIKE_HEADERS });
    if (!res.ok) return null;
    const data: any = await res.json();
    const item = data?.items?.[0];
    const price = item?.xauPrice;
    if (typeof price !== "number") return null;
    const changePercent = item?.pcXau;
    return { price, changePercent: typeof changePercent === "number" ? changePercent : null };
  } catch (err) {
    console.error("fetchGoldQuote failed", err);
    return null;
  }
}

async function fetchMovers(scrId: "day_gainers" | "day_losers", count: number): Promise<MoverQuote[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=${count}&scrIds=${scrId}&lang=en-US&region=US`;
    const res = await fetch(url, { headers: BROWSER_LIKE_HEADERS });
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

/** Best-effort snapshot of gold/BTC (each with % change when the source
 * provides one) plus up to 2 top US gainers and 2 top US losers — every
 * field fetched in parallel and independently allowed to come back empty. */
export async function fetchMarketSnapshot(): Promise<MarketSnapshot> {
  const [gold, btc, topGainers, topLosers] = await Promise.all([
    fetchGoldQuote(),
    fetchBitcoinQuote(),
    fetchMovers("day_gainers", 2),
    fetchMovers("day_losers", 2),
  ]);
  return { gold, btc, topGainers, topLosers };
}

function formatPercent(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

/** Builds the deterministic, plain-text header block for the finance-news
 * reply (PLAN.md 15.13's requested format) — date line, then gold/BTC/movers
 * as "* "-prefixed bullets, with movers listed unbulleted underneath their
 * own header line. Never touched by Gemini; whatever this function outputs
 * is exactly what gets sent to the user for these lines. */
export function buildMarketHeaderBlock(snapshot: MarketSnapshot, todayLabel: string): string {
  const lines = [`ข้อมูล ณ วันที่ ${todayLabel}`, ""];

  if (snapshot.gold) {
    const pct = snapshot.gold.changePercent !== null ? ` (${formatPercent(snapshot.gold.changePercent)})` : "";
    const price = snapshot.gold.price.toLocaleString("en-US", { maximumFractionDigits: 2 });
    lines.push(`* ทองคำ : $${price}${pct}`);
  }
  if (snapshot.btc) {
    const pct = snapshot.btc.changePercent !== null ? ` (${formatPercent(snapshot.btc.changePercent)})` : "";
    const price = snapshot.btc.price.toLocaleString("en-US", { maximumFractionDigits: 0 });
    lines.push(`* บิตคอยน์ : $${price}${pct}`);
  }
  if (snapshot.topGainers.length > 0 || snapshot.topLosers.length > 0) {
    lines.push("* หุ้นสหรัฐฯ เคลื่อนไหวมากที่สุด");
    for (const q of snapshot.topGainers) lines.push(`${q.symbol} (${formatPercent(q.changePercent)})`);
    for (const q of snapshot.topLosers) lines.push(`${q.symbol} (${formatPercent(q.changePercent)})`);
  }

  return lines.join("\n");
}
