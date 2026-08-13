// Exercises the core LINE message-handling flow against real code
// (state.ts, chatEngine.ts, sheets.ts, googleAuth.ts) with a fake KV store
// and a mocked `fetch` standing in for Google/LINE, since we don't have
// real credentials in this environment. Run with:
//   node --experimental-strip-types scripts/test-flow.mjs

class FakeKV {
  constructor() {
    this.store = new Map();
    this.metadataStore = new Map();
  }
  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  async put(key, value, options = {}) {
    if (simulateQueuePutFailureOnce && key.startsWith("upload-queue:")) {
      simulateQueuePutFailureOnce = false;
      throw new Error("simulated KV put failure");
    }
    this.store.set(key, value);
    if (options.metadata) this.metadataStore.set(key, options.metadata);
    else this.metadataStore.delete(key);
  }
  async delete(key) {
    this.store.delete(key);
    this.metadataStore.delete(key);
  }
  async list({ prefix = "", limit = 1000 } = {}) {
    const keys = [...this.store.keys()]
      .filter((name) => name.startsWith(prefix))
      .sort()
      .slice(0, limit)
      .map((name) => ({ name, metadata: this.metadataStore.get(name) }));
    return { keys, list_complete: true, cursor: "" };
  }
}

// Minimal stand-in for Cloudflare's real ExecutionContext, just enough to
// test the fetch handler's ctx.waitUntil(...) fast-ack behavior: collects
// backgrounded promises so a test can explicitly wait for them after
// checking that the response itself didn't wait.
class FakeExecutionContext {
  constructor() {
    this.waitUntilPromises = [];
  }
  waitUntil(promise) {
    this.waitUntilPromises.push(promise);
  }
  async drain() {
    await Promise.all(this.waitUntilPromises);
    this.waitUntilPromises = [];
  }
}

const sheetRows = []; // simulates the Transactions tab
const budgetRows = []; // simulates the Budgets tab
const replies = []; // captures what would have been sent back to LINE
const pushes = []; // captures push messages (the reply-token-expired fallback)

const driveFolders = []; // simulates Drive folders: {id, name, parentId}
const driveUploads = []; // simulates uploaded files: {id, folderId}
let driveIdSeq = 0;
function nextDriveId(prefix) {
  driveIdSeq += 1;
  return `${prefix}-${driveIdSeq}`;
}
let simulatePhotoFetchFailure = false; // makes the next Drive file-content (alt=media) request fail, to exercise graceful degradation

const calendarEvents = []; // simulates Google Calendar: {id, summary, start:{dateTime}, end:{dateTime}}
let calendarIdSeq = 0;
let simulateInsufficientCalendarScope = false;
let simulateCalendarApiDisabled = false;

let diaryTabExists = false;
let diaryTabMetaCalls = 0; // counts spreadsheets.get calls, to verify the KV cache actually skips them
const diaryRows = []; // simulates the Diary tab

let simulateDriveUploadFailureCount = 0; // decremented each time; while > 0, fails the next Drive media upload request(s)
let simulatePushFailureToo = false; // one-shot: fails the next push too (pair with an "expired" replyToken to simulate total messaging failure)
let simulateQueuePutFailureOnce = false; // one-shot: fails the next KV put to the upload queue, to exercise handleQueuedMediaBatch's outer catch
let simulateGeminiFailure = false; // one-shot: fails the next Gemini request, to exercise the AI command's fallback message
const geminiRequests = []; // captures {systemInstruction, question, apiKey} per call, so tests can assert the right data context was sent
let simulateWeatherFetchFailure = false; // makes the next Open-Meteo forecast request fail, to exercise graceful degradation
let simulateNewsFetchFailure = false; // makes the next Bangkok Post RSS request fail, to exercise graceful degradation
let simulateFinanceNewsFetchFailure = false; // makes the next CNBC RSS request fail, to exercise graceful degradation
let simulateMarketDataFetchFailure = false; // makes the next batch of market-data requests (BTC/gold/S&P 500/movers) fail, to exercise graceful degradation
const GEOCODE_RESULTS = {
  เชียงใหม่: { name: "เชียงใหม่", latitude: 18.7883, longitude: 98.9853 },
};
let driveUploadRequestCount = 0; // counts requests to the media-upload mock, to verify it's 1-per-file
let activeDriveUploadRequests = 0; // in-flight count, to verify webhook concurrency stays bounded
let maxConcurrentDriveUploadRequests = 0;

const realFetch = fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);

  if (u.includes("oauth2.googleapis.com/token")) {
    return new Response(JSON.stringify({ access_token: "fake-access-token", expires_in: 3600 }), {
      status: 200,
    });
  }
  if (u.endsWith("/v4/spreadsheets")) {
    return new Response(JSON.stringify({ spreadsheetId: "fake-sheet-id" }), { status: 200 });
  }
  if (u.includes("?fields=sheets.properties") && !u.includes(".title")) {
    return new Response(
      JSON.stringify({
        sheets: [
          { properties: { sheetId: 0, title: "Transactions" } },
          { properties: { sheetId: 1, title: "Categories" } },
          { properties: { sheetId: 2, title: "Budgets" } },
        ],
      }),
      { status: 200 }
    );
  }
  if (u.includes(":batchUpdate")) {
    const body = init.body ? JSON.parse(init.body) : {};
    const deleteReq = (body.requests ?? []).find((r) => r.deleteDimension);
    if (deleteReq) {
      const { startIndex, endIndex } = deleteReq.deleteDimension.range;
      // sheetRows holds only data rows (no header), matching the real sheet's
      // row 2 = index 0 offset already applied by the real code under test.
      sheetRows.splice(startIndex - 1, endIndex - startIndex);
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }
  if (u.includes("Transactions!A1:append")) {
    const body = JSON.parse(init.body);
    sheetRows.push(...body.values);
    return new Response(JSON.stringify({}), { status: 200 });
  }
  if (u.includes("Transactions!A2:J100000")) {
    return new Response(JSON.stringify({ values: sheetRows }), { status: 200 });
  }
  if (u.includes("Budgets!A2:D10000")) {
    return new Response(JSON.stringify({ values: budgetRows }), { status: 200 });
  }
  if (u.includes("api.line.me/v2/bot/message/reply")) {
    const body = JSON.parse(init.body);
    // Simulates an expired/already-used reply token: any replyToken
    // containing "expired" fails, so tests can exercise the push fallback.
    if (body.replyToken.includes("expired")) {
      return new Response(JSON.stringify({ message: "Invalid reply token" }), { status: 400 });
    }
    replies.push(body.messages[0].text);
    return new Response("{}", { status: 200 });
  }
  if (u.includes("api.line.me/v2/bot/message/push")) {
    if (simulatePushFailureToo) {
      simulatePushFailureToo = false;
      return new Response(JSON.stringify({ message: "simulated push failure" }), { status: 500 });
    }
    const body = JSON.parse(init.body);
    pushes.push({ to: body.to, text: body.messages[0].text });
    return new Response("{}", { status: 200 });
  }
  if (u.startsWith("https://api-data.line.me/v2/bot/message/") && u.endsWith("/content")) {
    const isVideo = u.includes("vid-");
    // messageIds containing "big-" simulate a longer clip, to exercise the
    // streaming upload path with something bigger than a few bytes.
    const isBig = u.includes("big-");
    const payload = isBig ? new Uint8Array(2 * 1024 * 1024).fill(7) : new Uint8Array([1, 2, 3, 4]);
    return new Response(payload.buffer, {
      status: 200,
      headers: {
        "content-type": isVideo ? "video/mp4" : "image/jpeg",
        "content-length": String(payload.byteLength),
      },
    });
  }
  if (u.startsWith("https://www.googleapis.com/drive/v3/files")) {
    const parsed = new URL(u);
    const idMatch = parsed.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);

    // GET /files/:id?fields=name — viewTripsPage's getFileName (looking up
    // a trip folder's own display name).
    if (idMatch && parsed.searchParams.get("fields") === "name" && (!init.method || init.method === "GET")) {
      const folder = driveFolders.find((f) => f.id === idMatch[1]);
      if (!folder) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ name: folder.name }), { status: 200 });
    }

    // GET /files/:id?alt=media — viewTripsPage's photo proxy.
    if (idMatch && parsed.searchParams.get("alt") === "media") {
      if (simulatePhotoFetchFailure) {
        simulatePhotoFetchFailure = false;
        return new Response("simulated photo fetch failure", { status: 500 });
      }
      const file = driveUploads.find((f) => f.id === idMatch[1]);
      if (!file) return new Response("not found", { status: 404 });
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }

    if (!init.method || init.method === "GET") {
      const q = parsed.searchParams.get("q") ?? "";
      const nameMatch = q.match(/name='((?:[^'\\]|\\.)*)'/);
      const parentMatch = q.match(/'([^']+)' in parents/);
      const name = nameMatch ? nameMatch[1].replace(/\\'/g, "'") : null;
      const parentId = parentMatch ? parentMatch[1] : null;

      // listFilesInFolder excludes folders (mimeType!=...) and, unlike the
      // findFolder/getOrCreateAlbumRoot queries below, matches real
      // uploaded files (driveUploads), not folders.
      if (q.includes("mimeType!=")) {
        const files = driveUploads.filter((f) => f.parentId === parentId);
        return new Response(
          JSON.stringify({ files: files.map((f) => ({ id: f.id, name: f.name, mimeType: "image/jpeg" })) }),
          { status: 200 }
        );
      }

      // listTripFolders has no name='...' clause (it wants every folder
      // under the parent, not one specific name) — findFolder/
      // getOrCreateAlbumRoot always do, so `name` being null is what tells
      // these two cases apart.
      if (name === null) {
        const matches = driveFolders.filter((f) => f.parentId === parentId);
        return new Response(JSON.stringify({ files: matches.map((f) => ({ id: f.id, name: f.name })) }), {
          status: 200,
        });
      }

      const matches = driveFolders.filter((f) => f.name === name && f.parentId === parentId);
      return new Response(JSON.stringify({ files: matches.map((f) => ({ id: f.id })) }), { status: 200 });
    }
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      const id = nextDriveId("folder");
      driveFolders.push({ id, name: body.name, parentId: body.parents?.[0] ?? "root" });
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
  }
  if (u.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
    driveUploadRequestCount++;
    activeDriveUploadRequests++;
    maxConcurrentDriveUploadRequests = Math.max(maxConcurrentDriveUploadRequests, activeDriveUploadRequests);
    try {
      if (simulateDriveUploadFailureCount > 0) {
        simulateDriveUploadFailureCount--;
        return new Response(JSON.stringify({ error: "simulated content upload failure" }), { status: 500 });
      }
      // Single-request streamed multipart upload: metadata + binary content
      // in one body, assembled as a stream (see concatStreams in drive.ts)
      // rather than a fully-buffered Blob. Decoded as latin1 here (not the
      // default UTF-8), which maps each byte to one code point 1:1 — the
      // only way to losslessly round-trip arbitrary binary content back out
      // of a JS string so the byte-count regression check below stays
      // accurate.
      const contentType = init.headers?.["Content-Type"] ?? "";
      const boundary = contentType.match(/boundary=(.+)$/)?.[1];
      const bodyBuffer = init.body ? Buffer.from(await new Response(init.body).arrayBuffer()) : Buffer.alloc(0);
      const text = bodyBuffer.toString("latin1");
      const marker = `--${boundary}`;
      let name;
      let parentId;
      let payloadSize = 0;
      try {
        const metaPart = text.split(marker)[1];
        const metaJson = metaPart.split("\r\n\r\n")[1].split("\r\n--")[0];
        const meta = JSON.parse(metaJson);
        name = meta.name;
        parentId = meta.parents?.[0];

        const secondBoundaryIndex = text.indexOf(marker, text.indexOf(marker) + marker.length);
        const contentHeaderEnd = text.indexOf("\r\n\r\n", secondBoundaryIndex) + 4;
        const closingBoundaryIndex = text.lastIndexOf(`\r\n--${boundary}--`);
        payloadSize = closingBoundaryIndex - contentHeaderEnd;
      } catch {
        // best-effort parse for the test mock only
      }
      // A small artificial delay widens the window during which concurrent
      // calls actually overlap, so maxConcurrentDriveUploadRequests reflects
      // real overlap instead of near-instant mock responses hiding it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const id = nextDriveId("file");
      driveUploads.push({ id, name, parentId, size: payloadSize });
      return new Response(JSON.stringify({ id }), { status: 200 });
    } finally {
      activeDriveUploadRequests--;
    }
  }
  if (u.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")) {
    if (simulateInsufficientCalendarScope) return new Response("forbidden", { status: 403 });
    if (simulateCalendarApiDisabled) {
      return new Response(
        JSON.stringify({
          error: {
            code: 403,
            message:
              "Google Calendar API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview",
            errors: [{ reason: "accessNotConfigured" }],
          },
        }),
        { status: 403 }
      );
    }
    const parsed = new URL(u);
    if (parsed.pathname === "/calendar/v3/calendars/primary/events") {
      if (!init.method || init.method === "GET") {
        const timeMin = new Date(parsed.searchParams.get("timeMin")).getTime();
        const timeMax = new Date(parsed.searchParams.get("timeMax")).getTime();
        const keyword = parsed.searchParams.get("q");
        let items = calendarEvents.filter((e) => {
          const t = new Date(e.start.dateTime).getTime();
          return t >= timeMin && t < timeMax;
        });
        if (keyword) items = items.filter((e) => e.summary.includes(keyword));
        return new Response(JSON.stringify({ items }), { status: 200 });
      }
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        calendarIdSeq += 1;
        const id = `evt-${calendarIdSeq}`;
        calendarEvents.push({ id, summary: body.summary, start: body.start, end: body.end });
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
    } else {
      const id = parsed.pathname.split("/").pop();
      if (init.method === "PATCH") {
        const body = JSON.parse(init.body);
        const ev = calendarEvents.find((e) => e.id === id);
        if (ev) Object.assign(ev, { summary: body.summary, start: body.start, end: body.end });
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      if (init.method === "DELETE") {
        const idx = calendarEvents.findIndex((e) => e.id === id);
        if (idx >= 0) calendarEvents.splice(idx, 1);
        return new Response(null, { status: 204 });
      }
    }
  }
  if (u.includes("?fields=sheets.properties.title")) {
    diaryTabMetaCalls += 1;
    return new Response(JSON.stringify({ sheets: diaryTabExists ? [{ properties: { title: "Diary" } }] : [] }), {
      status: 200,
    });
  }
  if (u.includes("Diary!A1?valueInputOption=RAW")) {
    diaryTabExists = true;
    return new Response(JSON.stringify({}), { status: 200 });
  }
  if (u.includes("Diary!A1:append")) {
    const body = JSON.parse(init.body);
    diaryRows.push(...body.values);
    return new Response(JSON.stringify({}), { status: 200 });
  }
  if (u.includes("Diary!A2:E100000")) {
    return new Response(JSON.stringify({ values: diaryRows }), { status: 200 });
  }
  if (u.includes("generativelanguage.googleapis.com")) {
    if (simulateGeminiFailure) {
      simulateGeminiFailure = false;
      return new Response(JSON.stringify({ error: { message: "simulated Gemini failure" } }), { status: 500 });
    }
    const body = JSON.parse(init.body);
    const systemInstruction = body.systemInstruction?.parts?.[0]?.text ?? "";
    const question = body.contents?.[0]?.parts?.[0]?.text ?? "";
    geminiRequests.push({ systemInstruction, question, apiKey: init.headers?.["x-goog-api-key"] });
    // A canned (not truly AI-generated) answer that echoes the question back,
    // so tests can assert the real question made it all the way through.
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: `[mock AI answer] คำถาม: ${question}` }] } }] }),
      { status: 200 }
    );
  }

  if (u.includes("geocoding-api.open-meteo.com/v1/search")) {
    const parsed = new URL(u);
    const found = GEOCODE_RESULTS[parsed.searchParams.get("name")];
    return new Response(JSON.stringify({ results: found ? [found] : [] }), { status: 200 });
  }
  if (u.includes("api.open-meteo.com/v1/forecast")) {
    if (simulateWeatherFetchFailure) {
      simulateWeatherFetchFailure = false;
      return new Response("simulated weather service failure", { status: 500 });
    }
    return new Response(
      JSON.stringify({
        current: { temperature_2m: 32.5, weather_code: 1 },
        daily: { temperature_2m_max: [35.2], temperature_2m_min: [26.1] },
      }),
      { status: 200 }
    );
  }
  if (u.includes("bangkokpost.com/rss/data/topstories.xml")) {
    if (simulateNewsFetchFailure) {
      simulateNewsFetchFailure = false;
      return new Response("simulated RSS fetch failure", { status: 500 });
    }
    const rss = [
      "<?xml version=\"1.0\"?><rss><channel>",
      "<item><title><![CDATA[Test headline one]]></title></item>",
      "<item><title>Test headline two</title></item>",
      "</channel></rss>",
    ].join("");
    return new Response(rss, { status: 200 });
  }
  if (u.includes("cnbc.com/id/10000664/device/rss/rss.html")) {
    if (simulateFinanceNewsFetchFailure) {
      simulateFinanceNewsFetchFailure = false;
      return new Response("simulated finance RSS fetch failure", { status: 500 });
    }
    const rss = [
      "<?xml version=\"1.0\"?><rss><channel>",
      "<item><title>Stocks rally as tech earnings beat expectations</title></item>",
      "<item><title>Bitcoin holds steady above key support level</title></item>",
      "</channel></rss>",
    ].join("");
    return new Response(rss, { status: 200 });
  }

  if (u.includes("api.coingecko.com/api/v3/simple/price")) {
    if (simulateMarketDataFetchFailure) {
      simulateMarketDataFetchFailure = false;
      return new Response("simulated market data fetch failure", { status: 500 });
    }
    return new Response(JSON.stringify({ bitcoin: { usd: 65000 } }), { status: 200 });
  }
  if (u.includes("api.gold-api.com/price/XAU")) {
    if (simulateMarketDataFetchFailure) {
      simulateMarketDataFetchFailure = false;
      return new Response("simulated market data fetch failure", { status: 500 });
    }
    return new Response(JSON.stringify({ price: 2345.6 }), { status: 200 });
  }
  if (u.includes("query1.finance.yahoo.com/v8/finance/chart")) {
    if (simulateMarketDataFetchFailure) {
      simulateMarketDataFetchFailure = false;
      return new Response("simulated market data fetch failure", { status: 500 });
    }
    return new Response(
      JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 5555.55 } }] } }),
      { status: 200 }
    );
  }
  if (u.includes("query1.finance.yahoo.com/v1/finance/screener/predefined/saved")) {
    if (simulateMarketDataFetchFailure) {
      simulateMarketDataFetchFailure = false;
      return new Response("simulated market data fetch failure", { status: 500 });
    }
    const isGainers = u.includes("scrIds=day_gainers");
    const quotes = isGainers
      ? [
          { symbol: "AAAA", regularMarketChangePercent: 18.2 },
          { symbol: "BBBB", regularMarketChangePercent: 14.7 },
        ]
      : [
          { symbol: "CCCC", regularMarketChangePercent: -16.5 },
          { symbol: "DDDD", regularMarketChangePercent: -12.1 },
        ];
    return new Response(JSON.stringify({ finance: { result: [{ quotes }] } }), { status: 200 });
  }

  throw new Error(`unexpected fetch to ${u}`);
};

const {
  handleTextMessage,
  handleImageMessage,
  handleVideoMessage,
  handleWebhook,
  drainUploadQueue,
  default: worker,
} = await import("../src/index.ts");
const { setAccountLink } = await import("../src/state.ts");
const { verifyState, signState, signViewToken, verifyViewToken } = await import("../src/signedState.ts");
const { bangkokDateKey, addDaysToDateKey, formatThaiDateLabel } = await import("../src/thaiDate.ts");
const { countQueuedForUser } = await import("../src/uploadQueue.ts");
const { buildReturnGreeting } = await import("../src/greetingCommands.ts");

async function signLineBody(rawBody, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const arr = new Uint8Array(signature);
  let binary = "";
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toSlashDate(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return `${d}/${m}/${y + 543}`;
}

const kv = new FakeKV();
const env = {
  ACCOUNTS: kv,
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  STATE_SIGNING_SECRET: "test-state-secret",
  LINE_CHANNEL_SECRET: "test-channel-secret",
  LINE_CHANNEL_ACCESS_TOKEN: "test-channel-access-token",
  GEMINI_API_KEY: "test-gemini-key",
};
const lineUserId = "Utestuser1";
const origin = "http://localhost:8787";

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) {
    pass++;
    console.log(`ok - ${label}`);
  } else {
    fail++;
    console.log(`FAIL - ${label}`);
  }
}

// 1. Unlinked user gets prompted to link, with a Google OAuth URL whose
// signed `state` decodes back to the exact same lineUserId that this
// webhook event carried — this is the regression test for the bug where
// the linked id came from a different LINE channel (LIFF) than the one
// webhook events use, so lookups never matched.
const unlinkedReply = await handleTextMessage(env, lineUserId, "ซื้อกาแฟ 60", origin);
check("unlinked user is told to link", unlinkedReply.includes("accounts.google.com/o/oauth2/v2/auth"));
const authorizeUrl = unlinkedReply.split("\n").pop();
const state = new URL(authorizeUrl).searchParams.get("state");
const decodedUserId = await verifyState(state, env.STATE_SIGNING_SECRET);
check("state param round-trips to the webhook's own lineUserId", decodedUserId === lineUserId);

// 2. Link the account (simulating a completed OAuth flow).
await setAccountLink(kv, lineUserId, {
  spreadsheetId: "fake-sheet-id",
  refreshToken: "fake-refresh-token",
  displayName: "สมุดส่วนตัว",
});

// 3. A clean message logs a transaction directly.
const okReply = await handleTextMessage(env, lineUserId, "ซื้อกาแฟ 60", origin);
check("logs a clear expense", okReply.includes("60"));
check("wrote a row to the sheet", sheetRows.length === 1 && sheetRows[0][3] === 60);

// 4. An ambiguous message triggers a clarification question, then resolves.
const askReply = await handleTextMessage(env, lineUserId, "ซื้อของ", origin);
check("asks for the missing amount", askReply.includes("จำนวนเงิน"));
const resolveReply = await handleTextMessage(env, lineUserId, "120", origin);
check("category still needed after amount", resolveReply.includes("หมวด"));
const categoryReply = await handleTextMessage(env, lineUserId, "ช้อปปิ้ง", origin);
check("clarification resolves into a saved transaction", categoryReply.includes("120"));
check("second row written to the sheet", sheetRows.length === 2 && sheetRows[1][3] === 120);

// 5. Monthly summary command reads back what was written.
const summaryReply = await handleTextMessage(env, lineUserId, "สรุปเดือนนี้", origin);
check("summary mentions total expense", summaryReply.includes("180"));

// 6. More transactions to exercise the report commands with real spread:
// food (100 total, 2 entries), shopping (120, 1 entry), income (5000).
await handleTextMessage(env, lineUserId, "ข้าว 40", origin);
await handleTextMessage(env, lineUserId, "เงินเดือนเข้า 5000", origin);

const todayReply = await handleTextMessage(env, lineUserId, "วันนี้ใช้ไปเท่าไหร่", origin);
check("today's summary totals all three expenses (220)", todayReply.includes("220"));

const incomeReply = await handleTextMessage(env, lineUserId, "รายรับเดือนนี้เท่าไหร่", origin);
check("income-this-month reports 5000", incomeReply.includes("5,000"));

const balanceReply = await handleTextMessage(env, lineUserId, "เหลือเงินเท่าไหร่", origin);
check("balance is income minus expense (4,780)", balanceReply.includes("4,780"));

const topCategoryReply = await handleTextMessage(env, lineUserId, "หมวดไหนใช้เงินเยอะที่สุด", origin);
check("top category by spend is shopping (120 > 100)", topCategoryReply.includes("ช้อปปิ้ง"));

const frequentReply = await handleTextMessage(env, lineUserId, "ซื้ออะไรบ่อยที่สุด", origin);
check("most frequent category is food (2 entries)", frequentReply.includes("อาหาร"));

const avgReply = await handleTextMessage(env, lineUserId, "เฉลี่ยวันละเท่าไหร่", origin);
check("daily average mentions the 220 total", avgReply.includes("220"));

const currentMonth = new Date().toISOString().slice(0, 7);
budgetRows.push(["b1", "food", currentMonth, "50"]);
const budgetReply = await handleTextMessage(env, lineUserId, "งบเหลือเท่าไหร่", origin);
check("over-budget category is flagged", budgetReply.includes("เกินงบแล้ว"));

const searchReply = await handleTextMessage(env, lineUserId, "ค้นหาข้าว", origin);
check("search finds the matching transaction", searchReply.includes("40"));

const recentReply = await handleTextMessage(env, lineUserId, "รายการล่าสุด", origin);
check("recent transactions list is returned", recentReply.includes("5 รายการล่าสุด"));

// Regression test for a real report: "ยกเลิกรายการล่าสุด" contains
// "รายการล่าสุด" as a substring, which commands.ts's includesAny-based
// report matcher used to catch first, just showing the list again instead
// of deleting anything (there was no delete command at all). Must actually
// delete now, with a confirm step first.
const rowCountBeforeDelete = sheetRows.length;
const deleteLastPromptReply = await handleTextMessage(env, lineUserId, "ยกเลิกรายการล่าสุด", origin);
check(
  "asks to confirm before deleting, doesn't just show the list again",
  deleteLastPromptReply.includes("จะลบรายการล่าสุด") && sheetRows.length === rowCountBeforeDelete
);
const deleteLastConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "confirming actually removes the row from the sheet",
  deleteLastConfirmReply.includes("ลบรายการล่าสุดแล้ว") && sheetRows.length === rowCountBeforeDelete - 1
);

// Regression test for a real report: several items sent as one message, one
// per line, used to be logged as a single transaction — extractAmount only
// ever finds the first number in the whole text, so everything after the
// first line's amount was silently dropped. Exercises the real
// handleTextMessage entry point end to end, confirming every line becomes
// its own row in the sheet, not just the first. Placed after every
// exact-total report assertion above (today's summary, balance, top
// category, etc.) so its own rows don't perturb numbers those already
// checked against a known, fixed set of prior transactions.
const rowCountBeforeMultiline = sheetRows.length;
const multilineReply = await handleTextMessage(env, lineUserId, "อเมริกาโน่ 50\nลาเต้ 40\nเค้ก 80", origin);
check("a 3-line batch writes 3 separate rows, not one", sheetRows.length === rowCountBeforeMultiline + 3);
check(
  "every amount made it into the sheet, not just the first line's",
  sheetRows
    .slice(rowCountBeforeMultiline)
    .map((r) => r[3])
    .join(",") === "50,40,80"
);
check(
  "the combined reply mentions the item count and total instead of one line's worth",
  multilineReply.includes("3 รายการ") && multilineReply.includes("170")
);

const helpReply = await handleTextMessage(env, lineUserId, "วิธีใช้", origin);
check(
  "help lists commands grouped by feature area",
  helpReply.includes("💰 จดเงิน") &&
    helpReply.includes("📸 อัลบั้มรูปทริป") &&
    helpReply.includes("📅 ปฏิทิน") &&
    helpReply.includes("📔 ไดอารี่") &&
    helpReply.includes("🤖 ถามคำถาม/วิเคราะห์")
);

const weekReply = await handleTextMessage(env, lineUserId, "สรุปสัปดาห์นี้", origin);
check("week summary doesn't error", weekReply.includes("รายรับ"));

const lastMonthReply = await handleTextMessage(env, lineUserId, "สรุปเดือนที่แล้ว", origin);
check("last month summary doesn't error", lastMonthReply.length > 0);

const greetingReply = await handleTextMessage(env, lineUserId, "สวัสดีค่ะ", origin);
check(
  "a plain greeting gets the 4-area welcome message, not the detailed help",
  greetingReply.includes("7 เรื่องหลักๆ") && !greetingReply.includes("💰 จดเงิน")
);

// A greeting sent mid-clarification must still cancel the pending question
// (chatEngine's own behavior) instead of leaving it stuck in KV — regression
// test for a bug caught while wiring up the welcome message.
await handleTextMessage(env, lineUserId, "ซื้อของ", origin); // triggers "จำนวนเงินเท่าไหร่คะ"
const greetingWhilePendingReply = await handleTextMessage(env, lineUserId, "หวัดดีครับ", origin);
check(
  "a greeting mid-clarification cancels it via chatEngine, not the rich welcome",
  !greetingWhilePendingReply.includes("7 เรื่องหลักๆ")
);
const afterGreetingReply = await handleTextMessage(env, lineUserId, "ข้าว 30", origin);
check(
  "the next real message after that isn't misread as answering the stale question",
  afterGreetingReply.includes("30")
);

// Morning briefing (PLAN.md 15.11): the first greeting of a Bangkok calendar
// day (that isn't the account's very first-ever greeting, already covered
// above) gets a full briefing instead of the welcome message or the short
// return-greeting. Forces this by writing an old date directly into the
// same KV key classifyGreeting itself reads/writes, since the test can't
// actually change what day it is.
await env.ACCOUNTS.put(`last-greeting:${lineUserId}`, "2000-01-01");
const briefingNoProvinceReply = await handleTextMessage(env, lineUserId, "มอนิ่ง", origin);
check(
  "a first-greeting-of-the-day (not first-ever) gets the morning briefing, not the welcome message",
  !briefingNoProvinceReply.includes("7 เรื่องหลักๆ") && briefingNoProvinceReply.includes(formatThaiDateLabel(bangkokDateKey()))
);
check(
  "with no province set, the briefing suggests setting one instead of showing weather",
  briefingNoProvinceReply.includes("ตั้งจังหวัด")
);
check(
  "the briefing includes an AI-summarized news section",
  briefingNoProvinceReply.includes("ข่าวเช้านี้") && briefingNoProvinceReply.includes("headline")
);
const returnGreetingReply = await handleTextMessage(env, lineUserId, "หวัดดี", origin);
check(
  "a second greeting the same day gets the short return-greeting instead of another briefing",
  returnGreetingReply === buildReturnGreeting()
);

const provinceNotFoundReply = await handleTextMessage(env, lineUserId, "ตั้งจังหวัด Atlantis", origin);
check("setting an unrecognized province says so instead of silently accepting it", provinceNotFoundReply.includes("ไม่เจอ"));

const provinceSetReply = await handleTextMessage(env, lineUserId, "ตั้งจังหวัด เชียงใหม่", origin);
check("setting a real province confirms it", provinceSetReply.includes("เชียงใหม่"));

await env.ACCOUNTS.put(`last-greeting:${lineUserId}`, "2000-01-02");
const briefingWithProvinceReply = await handleTextMessage(env, lineUserId, "กู๊ดมอร์นิ่ง", origin);
check(
  "once a province is set, the next briefing includes real weather instead of the setup hint",
  briefingWithProvinceReply.includes("เชียงใหม่") &&
    briefingWithProvinceReply.includes("°C") &&
    briefingWithProvinceReply.includes("35") && // daily max from the mocked forecast
    !briefingWithProvinceReply.includes('พิมพ์ "ตั้งจังหวัด')
);

// Weather and news are independent best-effort additions — either failing
// must never take the other down, or block the greeting itself from going
// out at all.
await env.ACCOUNTS.put(`last-greeting:${lineUserId}`, "2000-01-03");
simulateWeatherFetchFailure = true;
simulateNewsFetchFailure = true;
const briefingBothFailReply = await handleTextMessage(env, lineUserId, "อรุณสวัสดิ์", origin);
check(
  "if both weather and news fail, the briefing still goes out with at least the date",
  briefingBothFailReply.includes(formatThaiDateLabel(bangkokDateKey()))
);

// 7. Trip photo album (PLAN.md 15.2): image with no active trip is rejected,
// starting a trip creates the album-root + trip folders, images then upload
// into a date subfolder, switching trips needs confirmation, and ending works.
const uploadsBeforeTrip = driveUploads.length;
const noTripImageReply = await handleImageMessage(env, lineUserId, "msg-1", Date.now(), origin);
check("image with no active trip asks to start one first", noTripImageReply.includes("เริ่มทริป"));
check("no upload happened without an active trip", driveUploads.length === uploadsBeforeTrip);

const startTripReply = await handleTextMessage(env, lineUserId, "เริ่มทริป ทะเล", origin);
check("starting a trip confirms the name", startTripReply.includes('ทริป "ทะเล"'));
check("album root folder was created", driveFolders.some((f) => f.name === "จดบัญชี - อัลบั้มทริป"));
check("trip folder was created under the album root", driveFolders.some((f) => f.name === "ทะเล"));

const statusReply1 = await handleTextMessage(env, lineUserId, "ทริปตอนนี้", origin);
check("status reports the open trip", statusReply1.includes("ทะเล"));

const tripFolderId = driveFolders.find((f) => f.name === "ทะเล").id;
const foldersBeforePhoto = driveFolders.length;
const photoReply = await handleImageMessage(env, lineUserId, "msg-2", Date.now(), origin);
check("photo upload confirms the trip name", photoReply.includes('ทริป "ทะเล"'));
check("an upload was recorded", driveUploads.length === uploadsBeforeTrip + 1);
check(
  "the photo uploads straight into the trip folder, not a per-day subfolder",
  driveUploads.at(-1).parentId === tripFolderId && driveFolders.length === foldersBeforePhoto
);
check(
  "the filename is date-prefixed with a zero-padded, sortable date",
  /^\d{4}-\d{2}-\d{2}_msg-2\.\w+$/.test(driveUploads.at(-1).name)
);

// A second photo the same day must land in the very same trip folder too —
// regression test for the duplicate-day-folder race this replaced: Drive's
// find-then-create wasn't atomic, so two uploads landing at nearly the same
// instant (e.g. sent together as a LINE multi-select) could each miss the
// day-folder search and create their own, splitting the trip across two
// folders. A flat trip folder has nothing to race on.
const photoReply2 = await handleImageMessage(env, lineUserId, "msg-2b", Date.now(), origin);
check("second same-day photo also confirms the trip name", photoReply2.includes('ทริป "ทะเล"'));
check("a second upload was recorded", driveUploads.length === uploadsBeforeTrip + 2);
check(
  "the second photo lands in the same trip folder, no new folder created",
  driveUploads.at(-1).parentId === tripFolderId && driveFolders.length === foldersBeforePhoto
);

// Video clips (LINE "video" message type) must upload just like photos —
// regression test for a real report: a user sent both photos and video
// clips to a trip, but only photos ever showed up in the Drive folder,
// because the webhook only ever recognized image message events.
const uploadsBeforeVideo = driveUploads.length;
const videoReply = await handleVideoMessage(env, lineUserId, "vid-1", Date.now(), origin);
check("video upload confirms the trip name", videoReply.includes('ทริป "ทะเล"'));
check("a video upload was recorded", driveUploads.length === uploadsBeforeVideo + 1);
check("the video also lands directly in the trip folder", driveUploads.at(-1).parentId === tripFolderId);

// Regression test for a real report: a short (19s) clip uploaded fine, but a
// longer (~1min) clip that had already finished sending in LINE never got a
// bot reply at all — traced to the old buffer-then-upload path risking the
// Worker's memory limit and doubling total latency for bigger files. Now
// streamed straight through; this confirms a larger payload (2MB here,
// standing in for "much bigger than 4 bytes") still uploads intact.
const bigVideoReply = await handleVideoMessage(env, lineUserId, "vid-big-1", Date.now(), origin);
check("a larger (streamed) clip also confirms the trip name", bigVideoReply.includes('ทริป "ทะเล"'));
check(
  "the large clip's full byte size made it through the streaming upload intact",
  driveUploads.at(-1).size === 2 * 1024 * 1024
);

// Regression test for a review finding on the streaming-upload work: the
// multipart request carries metadata (name + parent folder) and content
// together in one atomic request, so a failure never leaves an orphaned,
// unnamed file sitting in Drive's root — nothing is created at all unless
// the whole request succeeds. Failing every attempt (MAX_UPLOAD_ATTEMPTS) so
// the retry below doesn't mask this into a false pass.
const uploadsBeforeFailedPut = driveUploads.length;
simulateDriveUploadFailureCount = 2;
let failedUploadThrew = false;
try {
  await handleVideoMessage(env, lineUserId, "vid-willfail", Date.now(), origin);
} catch {
  failedUploadThrew = true;
}
check("a failed Drive content upload (all attempts exhausted) surfaces as an error", failedUploadThrew);
check("a failed content upload leaves no orphaned file behind in Drive", driveUploads.length === uploadsBeforeFailedPut);

// Regression test for a real report: Cloudflare's own metrics showed a real,
// if small, background failure rate for the Drive upload request over a day
// of production use — ordinary transient flakiness. uploadTripMedia now
// retries once (MAX_UPLOAD_ATTEMPTS) before giving up, re-fetching from LINE
// fresh each attempt (a ReadableStream can only be read once, so the first
// attempt's stream can't just be reused). This fails only the first attempt,
// so the upload should still succeed on the retry.
const uploadsBeforeRetrySuccess = driveUploads.length;
simulateDriveUploadFailureCount = 1;
const retrySuccessReply = await handleVideoMessage(env, lineUserId, "vid-retry-ok", Date.now(), origin);
check(
  "a Drive upload that fails once still succeeds after one retry",
  retrySuccessReply.includes('ทริป "ทะเล"') && driveUploads.length === uploadsBeforeRetrySuccess + 1
);

// A batch of many photos+videos sent together (bundled into one webhook
// call, as LINE can do for a multi-select send) must not blow through
// Cloudflare's per-request subrequest budget. Sharing one refreshed access
// token across the whole batch (instead of re-fetching one per file) plus
// dropping the per-day folder lookup cuts each file down to a handful of
// subrequests — cheap enough that even a large batch stays well under the
// limit. This doesn't call the real webhook handler (no real LINE signature
// here), so it drives handleImageMessage/handleVideoMessage directly with a
// shared token cache the same way handleWebhook does.
const tokenCacheForBatch = new Map();
const uploadsBeforeBatch = driveUploads.length;
for (let i = 0; i < 12; i++) {
  const handler = i % 2 === 0 ? handleImageMessage : handleVideoMessage;
  await handler(env, lineUserId, `batch-${i}`, Date.now(), origin, tokenCacheForBatch);
}
check("all 12 batched uploads succeeded", driveUploads.length === uploadsBeforeBatch + 12);
check(
  "the whole batch reused one cached access token instead of refreshing per file",
  tokenCacheForBatch.size === 1
);

// Regression test for a real report: even a small batch (well under the old
// immediate-upload threshold) still produced a flood of separate one-file
// confirmations, because LINE often splits one multi-select send into
// several separate webhook calls (e.g. one per file, when some take longer
// to finish uploading from the sender's phone than others) — "one combined
// reply per webhook call" didn't mean "one combined reply per send". Every
// media file now goes through the same queue+drain path regardless of batch
// size, and the enqueue step itself sends no reply at all (a follow-up fix
// after this: an intermediate "received, uploading" reply per webhook call
// was itself still one flood source, since LINE's fragmented calls each
// triggered their own) — so this send (8 photos) queues silently and the
// first the user hears about it is the drain's own summary once uploaded
// (accepted tradeoff: even a small send now takes up to about a minute, the
// cron interval, before any confirmation arrives, instead of being instant).
const smallBatchSize = 8;
const smallBatchEvents = Array.from({ length: smallBatchSize }, (_, i) => ({
  type: "message",
  message: { type: "image", id: `smallbatch-${i}` },
  source: { type: "user", userId: lineUserId },
  replyToken: `reply-smallbatch-${i}`,
  timestamp: Date.now(),
}));
const smallBatchRawBody = JSON.stringify({ events: smallBatchEvents });
const smallBatchSignature = await signLineBody(smallBatchRawBody, env.LINE_CHANNEL_SECRET);
const smallBatchRequest = new Request("http://localhost:8787/webhook", {
  method: "POST",
  headers: { "x-line-signature": smallBatchSignature },
  body: smallBatchRawBody,
});
const uploadsBeforeSmallBatch = driveUploads.length;
const repliesBeforeSmallBatch = replies.length;
await handleWebhook(smallBatchRequest, env);
check(
  `a small batch (${smallBatchSize} photos) does not upload anything immediately — it queues instead`,
  driveUploads.length === uploadsBeforeSmallBatch
);
check(
  "queueing a batch sends no reply at all — only the drain's own summary counts as the confirmation",
  replies.length === repliesBeforeSmallBatch
);
check(
  `all ${smallBatchSize} photos were queued`,
  (await countQueuedForUser(env.ACCOUNTS, lineUserId)) === smallBatchSize
);

// Draining (DRAIN_BATCH_SIZE is 10, so this clears the whole 8-photo batch
// in one pass) actually performs the uploads, one Drive subrequest per file,
// and is the only place a confirmation message gets sent for this batch.
const driveUploadRequestsBeforeSmallBatchDrain = driveUploadRequestCount;
const pushesBeforeSmallBatchDrain = pushes.length;
await drainUploadQueue(env);
check(
  `draining uploads all ${smallBatchSize} photos from the small batch`,
  driveUploads.length === uploadsBeforeSmallBatch + smallBatchSize
);
check(
  "each file cost exactly one Drive upload subrequest, not two",
  driveUploadRequestCount === driveUploadRequestsBeforeSmallBatchDrain + smallBatchSize
);
check(
  "the drain sends exactly one push confirming the batch finished, once it's actually done",
  pushes.length === pushesBeforeSmallBatchDrain + 1 &&
    pushes.at(-1).text.includes(`${smallBatchSize}`) &&
    pushes.at(-1).text.includes('ทริป "ทะเล"') &&
    pushes.at(-1).text.includes("ครบทุกไฟล์แล้ว")
);
check(
  "the small batch's queue is empty after draining",
  (await countQueuedForUser(env.ACCOUNTS, lineUserId)) === 0
);

// Regression test for a bug found while investigating a real report: a
// failure while handling a media batch (enqueueUploads throwing, in this
// case) could escape uncaught through handleWebhook's Promise.all, crashing
// the *entire* invocation — silencing not just the one failed batch but
// every other event in the same webhook call too, matching a real report
// where one photo batch got zero message while an unrelated one succeeded.
// This forces the queue write to fail (via simulateQueuePutFailureOnce) for
// one image event, with its reply token also "expired" and a one-shot
// simulated push failure so the catch block's own apology reply fails both
// ways too — in the SAME webhook call as an unrelated text message — and
// confirms the text message still gets its normal reply regardless.
simulateQueuePutFailureOnce = true;
const totalFailureImageEvent = {
  type: "message",
  message: { type: "image", id: "totalfail-img-1" },
  source: { type: "user", userId: lineUserId },
  replyToken: "reply-totalfail-expired",
  timestamp: Date.now(),
};
const totalFailureTextEvent = {
  type: "message",
  message: { type: "text", text: "สวัสดีค่ะ" },
  source: { type: "user", userId: lineUserId },
  replyToken: "reply-totalfail-text-ok",
  timestamp: Date.now(),
};
const totalFailureRawBody = JSON.stringify({ events: [totalFailureImageEvent, totalFailureTextEvent] });
const totalFailureSignature = await signLineBody(totalFailureRawBody, env.LINE_CHANNEL_SECRET);
const totalFailureRequest = new Request("http://localhost:8787/webhook", {
  method: "POST",
  headers: { "x-line-signature": totalFailureSignature },
  body: totalFailureRawBody,
});
simulatePushFailureToo = true;
const repliesBeforeTotalFailure = replies.length;
const totalFailureResponse = await handleWebhook(totalFailureRequest, env);
check(
  "handleWebhook still returns ok even when a batch's reply AND push both fail",
  totalFailureResponse.status === 200
);
check(
  // A plain "return" greeting by this point in the test — this account
  // already greeted once earlier (the "a plain greeting gets the..."
  // check above), consuming the once-per-day welcome/briefing state — so
  // the expected reply here is the short return-greeting, not the rich
  // welcome message.
  "an unrelated text event in the same webhook call still gets its normal reply",
  replies.length > repliesBeforeTotalFailure &&
    replies.slice(repliesBeforeTotalFailure).some((r) => r.includes(buildReturnGreeting()))
);

// Regression test for a real report backed by Cloudflare's own request logs:
// a webhook invocation was cut short with outcome "canceled" only ~2 seconds
// in — LINE gave up waiting for a response and disconnected while the
// Worker was still uploading/replying, well under any CPU or subrequest
// limit. The fix moves the actual event processing into ctx.waitUntil() so
// the real `fetch` handler (not handleWebhook, which stays fully
// synchronous for tests) responds to LINE immediately. This exercises the
// real default-exported fetch handler with a FakeExecutionContext and
// checks the response comes back before any upload has happened, then
// drains the backgrounded work and confirms it actually completes.
const fastAckImageEvent = {
  type: "message",
  message: { type: "image", id: "fastack-img-1" },
  source: { type: "user", userId: lineUserId },
  replyToken: "reply-fastack-1",
  timestamp: Date.now(),
};
const fastAckRawBody = JSON.stringify({ events: [fastAckImageEvent] });
const fastAckSignature = await signLineBody(fastAckRawBody, env.LINE_CHANNEL_SECRET);
const fastAckRequest = new Request("http://localhost:8787/webhook", {
  method: "POST",
  headers: { "x-line-signature": fastAckSignature },
  body: fastAckRawBody,
});
const fastAckCtx = new FakeExecutionContext();
const uploadsBeforeFastAck = driveUploads.length;
const repliesBeforeFastAck = replies.length;
const queuedBeforeFastAck = await countQueuedForUser(env.ACCOUNTS, lineUserId);
const fastAckResponse = await worker.fetch(fastAckRequest, env, fastAckCtx);
check("the fetch handler responds ok right away", fastAckResponse.status === 200);
check(
  "the response comes back before anything (queueing or any reply) has actually happened",
  driveUploads.length === uploadsBeforeFastAck && replies.length === repliesBeforeFastAck
);
await fastAckCtx.drain();
check(
  "draining the backgrounded work queues the file silently — no reply until the drain actually uploads it",
  driveUploads.length === uploadsBeforeFastAck && // not uploaded yet — queued, not immediate
    replies.length === repliesBeforeFastAck &&
    (await countQueuedForUser(env.ACCOUNTS, lineUserId)) === queuedBeforeFastAck + 1
);
// Fully drain everything queued so far (this test's file, plus any leftovers
// a prior test may have queued without draining) before moving on, keeping
// later tests' queue-count assertions from having to account for cross-test
// leftovers.
const totalQueuedBeforeFinalDrain = queuedBeforeFastAck + 1;
while ((await countQueuedForUser(env.ACCOUNTS, lineUserId)) > 0) {
  await drainUploadQueue(env);
}
check(
  "a subsequent drain actually uploads the file that the fast-ack path queued (plus any earlier leftovers)",
  driveUploads.length === uploadsBeforeFastAck + totalQueuedBeforeFinalDrain
);

// Regression test for a real report: even after cutting Drive requests back
// to one per file and bounding webhook concurrency, sending 50 photos in one
// batch still left up to 4 silently missing with no error reply. A single
// webhook invocation only has so much subrequest/CPU budget no matter how
// it's spent — each photo/video needs 2 outbound requests (fetch from LINE,
// upload to Drive), and even the fallback error reply is itself a
// subrequest, so an event landing at the platform's ceiling can lose its
// upload *and* its error message together. Fixed by queueing every batch
// (regardless of size, see the always-queue comment on DRAIN_BATCH_SIZE in
// src/index.ts) instead of processing it in one invocation: this sends 40
// photos through the real handleWebhook entry point and confirms none
// upload immediately and no reply is sent at all, then drives the queue via
// drainUploadQueue (the same function the cron trigger in wrangler.toml
// calls) the way it actually runs in production — a bounded batch at a
// time, each drain a fresh invocation with its own budget — until every
// file is confirmed uploaded, with only the drain's own push messages ever
// notifying the user.
// Kept in sync manually with DRAIN_BATCH_SIZE in src/index.ts (not exported,
// since it's an internal tuning constant, not part of that module's API).
const DRAIN_BATCH_SIZE_FOR_TEST = 10;
const largeBatchSize = 40;
const largeBatchEvents = Array.from({ length: largeBatchSize }, (_, i) => ({
  type: "message",
  message: { type: "image", id: `bigbatch-${i}` },
  source: { type: "user", userId: lineUserId },
  replyToken: `reply-bigbatch-${i}`,
  timestamp: Date.now(),
}));
const largeBatchRawBody = JSON.stringify({ events: largeBatchEvents });
const largeBatchSignature = await signLineBody(largeBatchRawBody, env.LINE_CHANNEL_SECRET);
const largeBatchRequest = new Request("http://localhost:8787/webhook", {
  method: "POST",
  headers: { "x-line-signature": largeBatchSignature },
  body: largeBatchRawBody,
});
const uploadsBeforeLargeBatch = driveUploads.length;
const repliesBeforeLargeBatch = replies.length;
await handleWebhook(largeBatchRequest, env);
check(
  `a ${largeBatchSize}-photo batch does not upload anything immediately`,
  driveUploads.length === uploadsBeforeLargeBatch
);
check("queueing the large batch sends no reply either", replies.length === repliesBeforeLargeBatch);
const queuedAfterLargeBatch = await countQueuedForUser(env.ACCOUNTS, lineUserId);
check(`all ${largeBatchSize} photos were queued for background upload`, queuedAfterLargeBatch === largeBatchSize);

// Drains DRAIN_BATCH_SIZE (10) of the 40 queued photos at a time — 4 drains
// exactly — checking the running upload count, remaining-queued count, and
// push summary wording after each one, the way the once-a-minute cron
// trigger in wrangler.toml actually works through a big backlog in
// production.
const drainRounds = largeBatchSize / DRAIN_BATCH_SIZE_FOR_TEST;
for (let round = 1; round <= drainRounds; round++) {
  const pushesBefore = pushes.length;
  await drainUploadQueue(env);
  const expectedUploaded = round * DRAIN_BATCH_SIZE_FOR_TEST;
  const expectedRemaining = largeBatchSize - expectedUploaded;
  check(
    `drain round ${round} uploads a total of ${expectedUploaded} of ${largeBatchSize} photos`,
    driveUploads.length === uploadsBeforeLargeBatch + expectedUploaded
  );
  check(
    `drain round ${round} leaves exactly ${expectedRemaining} photos queued`,
    (await countQueuedForUser(env.ACCOUNTS, lineUserId)) === expectedRemaining
  );
  const summaryText = pushes.length === pushesBefore + 1 ? pushes.at(-1).text : "";
  check(
    `drain round ${round}'s push summary says the right thing`,
    expectedRemaining > 0
      ? summaryText.includes(`เหลืออีก ${expectedRemaining} ไฟล์`)
      : summaryText.includes("อัปโหลดครบทุกไฟล์แล้ว")
  );
}

// Draining with nothing queued must be a safe no-op (this is what most of
// the cron's once-a-minute firings will actually do, since large batches are
// rare).
const pushesBeforeEmptyDrain = pushes.length;
const driveUploadsBeforeEmptyDrain = driveUploads.length;
await drainUploadQueue(env);
check("draining an empty queue sends no push and uploads nothing", pushes.length === pushesBeforeEmptyDrain && driveUploads.length === driveUploadsBeforeEmptyDrain);

const switchPromptReply = await handleTextMessage(env, lineUserId, "เริ่มทริป ภูเขา", origin);
check(
  "starting a new trip while one is open asks to confirm first",
  switchPromptReply.includes("ทะเล") && switchPromptReply.includes("ภูเขา")
);

const declineReply = await handleTextMessage(env, lineUserId, "ซื้อกาแฟ 60", origin);
check("declining the switch still logs the unrelated message as an expense", declineReply.includes("60"));
const statusAfterDecline = await handleTextMessage(env, lineUserId, "ทริปตอนนี้", origin);
check("declined switch leaves the original trip open", statusAfterDecline.includes("ทะเล"));

const switchPromptReply2 = await handleTextMessage(env, lineUserId, "เริ่มทริป ภูเขา", origin);
check("re-prompts to switch trips", switchPromptReply2.includes("ยืนยัน"));
const confirmSwitchReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "confirming the switch closes the old trip and opens the new one",
  confirmSwitchReply.includes("ทะเล") && confirmSwitchReply.includes("ภูเขา")
);
const statusAfterSwitch = await handleTextMessage(env, lineUserId, "ทริปตอนนี้", origin);
check("status now reports the new trip", statusAfterSwitch.includes("ภูเขา"));

const endTripReply = await handleTextMessage(env, lineUserId, "จบทริป", origin);
check("ending the trip confirms the name", endTripReply.includes("ภูเขา"));
const statusAfterEnd = await handleTextMessage(env, lineUserId, "ทริปตอนนี้", origin);
check("status reports no open trip after ending", statusAfterEnd.includes("ไม่มีทริป"));

const imageAfterEndReply = await handleImageMessage(env, lineUserId, "msg-3", Date.now(), origin);
check("image after ending the trip asks to start one again", imageAfterEndReply.includes("เริ่มทริป"));

// Regression test for a real report: sending several photos/clips together
// used to arrive as fewer confirmations than files sent, with total silence
// (no reply, no error) for the missing ones. Root cause: handleWebhook
// processed events one at a time, so a later event's reply could miss its
// LINE reply token's short window after waiting through every earlier
// event's full round trip — and a failed reply retried the same expired
// token in the catch block, swallowing that failure too. This exercises the
// real handleWebhook entry point (signature verification included) with a
// batch that mixes two image events (combined into one reply, using the
// first event's token — which "expires" here, to prove the combined reply
// itself still falls back to push) and one of an unsupported message type
// (LINE can send "file" for some clips), which gets its own direct reply.
const webhookEvents = [
  {
    type: "message",
    message: { type: "image", id: "batch2-ok" },
    source: { type: "user", userId: lineUserId },
    replyToken: "reply-expired-1",
    timestamp: Date.now(),
  },
  {
    type: "message",
    message: { type: "image", id: "batch2-expired" },
    source: { type: "user", userId: lineUserId },
    replyToken: "reply-ok-2",
    timestamp: Date.now(),
  },
  {
    type: "message",
    message: { type: "file", id: "batch2-file" },
    source: { type: "user", userId: lineUserId },
    replyToken: "reply-ok-3",
    timestamp: Date.now(),
  },
];
const rawWebhookBody = JSON.stringify({ events: webhookEvents });
const webhookSignature = await signLineBody(rawWebhookBody, env.LINE_CHANNEL_SECRET);
const webhookRequest = new Request("http://localhost:8787/webhook", {
  method: "POST",
  headers: { "x-line-signature": webhookSignature },
  body: rawWebhookBody,
});
const repliesBefore = replies.length;
const pushesBefore = pushes.length;
const webhookResponse = await handleWebhook(webhookRequest, env);
check("webhook call returns ok even with a mixed/failing batch", webhookResponse.status === 200);
check(
  "the unsupported-type event still gets a direct reply, not silence",
  replies.length === repliesBefore + 1 && replies.slice(repliesBefore).every((r) => r.includes("ยังไม่รองรับ"))
);
check(
  "the media batch's expired reply token falls back to a push message instead of staying silent",
  pushes.length === pushesBefore + 1 &&
    pushes[pushesBefore].to === lineUserId &&
    pushes[pushesBefore].text.includes("ยังไม่ได้เริ่มทริปอยู่เลย")
);

const wrongSignatureRequest = new Request("http://localhost:8787/webhook", {
  method: "POST",
  headers: { "x-line-signature": "not-a-real-signature" },
  body: rawWebhookBody,
});
const wrongSignatureResponse = await handleWebhook(wrongSignatureRequest, env);
check("an invalid LINE signature is still rejected", wrongSignatureResponse.status === 401);

// Regression test for a review finding on the fast-ack PR: the invalid-
// signature check above only exercised handleWebhook directly, not the
// production fetch handler real LINE traffic actually hits — a future edit
// to the fetch handler's /webhook branch (e.g. reordering the signature
// check relative to ctx.waitUntil) could silently break 401-on-bad-signature
// for real requests without any test catching it.
const wrongSignatureRequestForFetch = new Request("http://localhost:8787/webhook", {
  method: "POST",
  headers: { "x-line-signature": "not-a-real-signature" },
  body: rawWebhookBody,
});
const fetchCtxForBadSignature = new FakeExecutionContext();
const wrongSignatureFetchResponse = await worker.fetch(wrongSignatureRequestForFetch, env, fetchCtxForBadSignature);
check(
  "the real fetch handler also rejects an invalid signature with 401, not just handleWebhook",
  wrongSignatureFetchResponse.status === 401
);
check(
  "no background work gets scheduled for a request that fails signature verification",
  fetchCtxForBadSignature.waitUntilPromises.length === 0
);

// 8. Calendar (PLAN.md 15.3): format hint, confirm-before-create, decline,
// list by day, search-based edit/delete, and the insufficient-scope re-link.
const todayKey = bangkokDateKey();
const tomorrowKey = addDaysToDateKey(todayKey, 1);
const tomorrowSlash = toSlashDate(tomorrowKey);

const noDateTimeReply = await handleTextMessage(env, lineUserId, "นัด ประชุมทีม", origin);
check("calendar create without a date/time asks for the right format", noDateTimeReply.includes("นัด ประชุมทีม"));

const createPromptReply = await handleTextMessage(env, lineUserId, `นัด ประชุมทีม ${tomorrowSlash} 13:00`, origin);
check(
  "calendar create asks to confirm before touching the calendar",
  createPromptReply.includes("ประชุมทีม") && createPromptReply.includes("13:00") && calendarEvents.length === 0
);

const declineCreateReply = await handleTextMessage(env, lineUserId, "ไม่เอาดีกว่า", origin);
check("declining calendar create falls through without creating anything", calendarEvents.length === 0);
check("declined text still gets an ordinary reply", declineCreateReply.length > 0);

await handleTextMessage(env, lineUserId, `นัด ประชุมทีม ${tomorrowSlash} 13:00`, origin);
const confirmCreateReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check("confirming creates the event", confirmCreateReply.includes("จดนัดแล้ว") && calendarEvents.length === 1);

const listTodayReply = await handleTextMessage(env, lineUserId, "มีนัดอะไรวันนี้", origin);
check("today's list doesn't include tomorrow's event", !listTodayReply.includes("ประชุมทีม"));

const listTomorrowReply = await handleTextMessage(env, lineUserId, "มีนัดอะไรพรุ่งนี้", origin);
check("tomorrow's list includes the created event", listTomorrowReply.includes("ประชุมทีม") && listTomorrowReply.includes("13:00"));

const listWeekReply = await handleTextMessage(env, lineUserId, "มีนัดอะไรสัปดาห์นี้", origin);
check("week list doesn't error", listWeekReply.length > 0);

const editPromptReply = await handleTextMessage(env, lineUserId, "แก้นัด ประชุมทีม เป็น 15:00", origin);
check("edit asks to confirm the new time", editPromptReply.includes("15:00"));
const editConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "confirming the edit updates the event time",
  editConfirmReply.includes("15:00") && calendarEvents[0].start.dateTime.includes("15:00")
);

const deletePromptReply = await handleTextMessage(env, lineUserId, "ลบนัด ประชุมทีม", origin);
check("delete asks to confirm first", deletePromptReply.includes("ประชุมทีม") && calendarEvents.length === 1);
const deleteConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "confirming the delete removes the event",
  deleteConfirmReply.includes("ลบนัด") && calendarEvents.length === 0
);

const deleteMissingReply = await handleTextMessage(env, lineUserId, "ลบนัด ไม่มีจริง", origin);
check("deleting a non-existent event says so instead of erroring", deleteMissingReply.includes("ไม่พบนัด"));

// A decimal number in the title (before the date) must not be misread as
// the time — regression test for a bug found in review where extractTime
// scanned the whole message and grabbed the first digit:digit-looking match.
const decimalTitlePromptReply = await handleTextMessage(
  env,
  lineUserId,
  `นัด ประชุมงบ 12.5 ล้าน ${tomorrowSlash} 15:30`,
  origin
);
check(
  "a decimal number in the title doesn't get mistaken for the time",
  decimalTitlePromptReply.includes("15:30") && !decimalTitlePromptReply.includes("12:50")
);
const decimalTitleConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "the event is actually created at the real time, not the decimal in the title",
  decimalTitleConfirmReply.includes("15:30") && calendarEvents[0].start.dateTime.includes("15:30")
);

// Regression test for a real report: "4 กันยายน 2569 นัดฉีดวัคซีน" (date
// first, "นัด" not at the start, no explicit time) used to match nothing in
// calendarCommands and fall all the way through to the money parser, which
// happily recorded a nonsense "4 บาท" health expense instead of telling the
// user their appointment attempt was missing a time.
const sheetRowsBeforeNadMisfire = sheetRows.length;
const calendarEventsBeforeNadMisfire = calendarEvents.length;
const nadMisfireReply = await handleTextMessage(env, lineUserId, "4 กันยายน 2569 นัดฉีดวัคซีน", origin);
check(
  "a date-first appointment attempt with no time gets the format hint, not a bogus expense",
  nadMisfireReply.includes("นัด ประชุมทีม") && sheetRows.length === sheetRowsBeforeNadMisfire
);
check("no stray calendar event was created either", calendarEvents.length === calendarEventsBeforeNadMisfire);

// A real expense that happens to contain "นัด" glued onto a preceding word
// (no space before it, e.g. "ค่านัดหมอ") must NOT be hijacked into a
// calendar-command attempt — the heuristic above only fires when "นัด" is a
// standalone, whitespace-separated word.
const doctorFeeReply = await handleTextMessage(env, lineUserId, "ค่านัดหมอ 500", origin);
check(
  "an expense with 'นัด' glued onto another word is still logged as money",
  doctorFeeReply.includes("500") && sheetRows.length === sheetRowsBeforeNadMisfire + 1
);

// "นัดวันนี้" is a fixed alias for "list today's events" and must still work
// now that the looser "นัด ... " create-match was added — it must not be
// swallowed as an attempt to create an event titled "วันนี้".
const nadTodayAliasReply = await handleTextMessage(env, lineUserId, "นัดวันนี้", origin);
check(
  "'นัดวันนี้' still lists today's events instead of being treated as a create attempt",
  nadTodayAliasReply.includes("นัดช่วงวันนี้") || nadTodayAliasReply.includes("ไม่มีนัดช่วงวันนี้")
);

simulateInsufficientCalendarScope = true;
const relinkReply = await handleTextMessage(env, lineUserId, "มีนัดอะไรวันนี้", origin);
check(
  "a scope-less refresh token gets a re-link prompt, not a crash",
  relinkReply.includes("สิทธิ์ปฏิทินเพิ่ม") && relinkReply.includes("accounts.google.com")
);
simulateInsufficientCalendarScope = false;

// Regression test for a real bug hit in production: a disabled Calendar API
// also returns 403, but re-linking (the message above) can't fix that — the
// bot must tell the difference and point at the actual fix instead of
// sending the user through a re-link loop that will never succeed.
simulateCalendarApiDisabled = true;
const apiDisabledReply = await handleTextMessage(env, lineUserId, "มีนัดอะไรวันนี้", origin);
check(
  "a disabled Calendar API gets an 'enable it in Cloud Console' message, not a re-link loop",
  apiDisabledReply.includes("Google Cloud Console") && !apiDisabledReply.includes("เชื่อมบัญชี Google ใหม่อีกครั้ง")
);
simulateCalendarApiDisabled = false;

// 9. Diary (PLAN.md 15.4): confirm-before-save with a default and an explicit
// category, monthly listing, and search.
const diaryPromptReply = await handleTextMessage(env, lineUserId, "ไดอารี่ วันนี้อากาศดีมาก", origin);
check(
  "diary create defaults to the uncategorized bucket and asks to confirm",
  diaryPromptReply.includes("อื่นๆ") && diaryPromptReply.includes("อากาศดีมาก") && diaryRows.length === 0
);
const diaryConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check("confirming saves the diary entry", diaryConfirmReply.includes("บันทึกไดอารี่แล้ว") && diaryRows.length === 1);

await handleTextMessage(env, lineUserId, "บันทึก #งาน ประชุมเสร็จเร็ว", origin);
const diaryCatConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "explicit #category is picked up and saved",
  diaryCatConfirmReply.includes('"งาน"') && diaryRows.length === 2 && diaryRows[1][2] === "งาน"
);

// Monthly view is a category+date summary now, not a full text dump — a
// user asked for this after realizing a long month of diary entries could
// exceed LINE's 5,000-character reply limit and get silently cut off. The
// full text for a given day comes from "ไดอารี่วันที่ <วันที่>" instead.
const diaryMonthReply = await handleTextMessage(env, lineUserId, "ไดอารี่เดือนนี้มีอะไรบ้าง", origin);
check(
  "monthly diary summary shows a total, category breakdown, and a hint — not the raw text",
  diaryMonthReply.includes("2 รายการ") &&
    diaryMonthReply.includes("อื่นๆ: 1 รายการ") &&
    diaryMonthReply.includes("งาน: 1 รายการ") &&
    diaryMonthReply.includes("ไดอารี่วันที่") &&
    !diaryMonthReply.includes("อากาศดีมาก") &&
    !diaryMonthReply.includes("ประชุมเสร็จเร็ว")
);

const todaySlashForDiary = toSlashDate(bangkokDateKey());
const diaryByDateReply = await handleTextMessage(env, lineUserId, `ไดอารี่วันที่ ${todaySlashForDiary}`, origin);
check(
  "viewing a specific date shows the full text for that day's entries",
  diaryByDateReply.includes("อากาศดีมาก") && diaryByDateReply.includes("ประชุมเสร็จเร็ว") && diaryByDateReply.includes("2 รายการ")
);

const diaryByDateEmptyReply = await handleTextMessage(env, lineUserId, "ไดอารี่วันที่ 1/1/2500", origin);
check(
  "viewing a date with no entries says so instead of erroring",
  diaryByDateEmptyReply.includes("ยังไม่มีบันทึกไดอารี่")
);

const diarySearchReply = await handleTextMessage(env, lineUserId, "ค้นหาไดอารี่ ประชุม", origin);
check(
  "diary search only matches the relevant entry",
  diarySearchReply.includes("ประชุมเสร็จเร็ว") && !diarySearchReply.includes("อากาศดีมาก")
);

check(
  "the Diary tab's existence is only checked once, then cached in KV",
  diaryTabMetaCalls === 1
);

// Proves the actual scaling concern is fixed: writing a lot in a month used
// to produce one giant reply that could exceed LINE's 5,000-character limit
// and get silently truncated. Add a bunch more entries with long text and
// confirm the monthly summary reply stays small regardless.
for (let i = 0; i < 15; i++) {
  await handleTextMessage(env, lineUserId, `ไดอารี่ วันนี้เป็นวันที่เหนื่อยมากเพราะทำงานหนักเรื่องที่ ${i} จนดึกดื่น`, origin);
  await handleTextMessage(env, lineUserId, "ใช่", origin);
}
const diaryMonthReplyAfterMany = await handleTextMessage(env, lineUserId, "ไดอารี่เดือนนี้มีอะไรบ้าง", origin);
check(
  "the monthly summary stays short no matter how many entries exist",
  diaryMonthReplyAfterMany.length < 1000 && diaryMonthReplyAfterMany.includes("17 รายการ")
);

// A message with an embedded newline (very normal to type in LINE) must
// still be recognized as a command — regression test for a bug found in
// review where the trip/calendar/diary regexes used `.+` without the
// dotAll flag, so anything past a line break silently failed to match and
// fell through to the money parser instead.
const multilineDiaryPromptReply = await handleTextMessage(
  env,
  lineUserId,
  "ไดอารี่ วันนี้อากาศดีมาก\nไปทะเลด้วย",
  origin
);
check(
  "a multi-line diary message is still recognized as a diary command",
  multilineDiaryPromptReply.includes("ไปทะเลด้วย")
);
const multilineDiaryConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "the multi-line entry is saved with the line break intact",
  multilineDiaryConfirmReply.includes("บันทึกไดอารี่แล้ว") &&
    diaryRows.some((r) => r[3] === "วันนี้อากาศดีมาก\nไปทะเลด้วย")
);

// AI Q&A / analysis (PLAN.md 15.6): "ถาม <คำถาม>" and "วิเคราะห์" route to
// Gemini instead of the money parser or any hardcoded report — exercises the
// full path (matchAiCommand -> aggregate Sheets/Diary data -> askGemini) and
// its guardrails: an empty question gets a usage hint without ever calling
// Gemini, a Gemini failure surfaces a friendly fallback instead of crashing,
// and the prompt sent to Gemini only ever contains precomputed totals for
// money questions, never raw arithmetic left for the model to do itself.
const geminiRequestsBeforeNoQuestion = geminiRequests.length;
const aiNoQuestionReply = await handleTextMessage(env, lineUserId, "ถาม", origin);
check(
  "asking with no question text gets a usage hint instead of calling Gemini",
  aiNoQuestionReply.includes("ถาม เดือนนี้") && geminiRequests.length === geminiRequestsBeforeNoQuestion
);

const geminiRequestsBeforeAsk = geminiRequests.length;
const aiAskReply = await handleTextMessage(env, lineUserId, "ถาม เดือนนี้ใช้เงินหมวดไหนเยอะสุด", origin);
check(
  "a real question is forwarded to Gemini and its answer is returned as-is",
  aiAskReply.includes("[mock AI answer]") && aiAskReply.includes("เดือนนี้ใช้เงินหมวดไหนเยอะสุด")
);
check("exactly one Gemini request was made for the question", geminiRequests.length === geminiRequestsBeforeAsk + 1);
const lastGeminiRequest = geminiRequests.at(-1);
check("the Gemini request authenticates with the configured API key", lastGeminiRequest.apiKey === "test-gemini-key");
check(
  "the prompt hands Gemini precomputed totals instead of letting it do arithmetic itself",
  lastGeminiRequest.systemInstruction.includes("รายรับรวม") &&
    lastGeminiRequest.systemInstruction.includes("รายจ่ายรวม") &&
    lastGeminiRequest.systemInstruction.includes("ห้ามคำนวณหรือเดาตัวเลขเอง")
);
// Regression test for a real report: asked "วันนี้วันที่" (what's today's
// date), Gemini answered a day off — it was never actually told today's
// date, only handed a calendar range that started from it, so it had to
// infer "today" itself instead of being given the fact outright, same
// mistake the money guardrail above already exists to prevent.
check(
  "the prompt states today's actual date explicitly, not left for Gemini to infer",
  lastGeminiRequest.systemInstruction.includes(`วันนี้คือวันที่ ${formatThaiDateLabel(bangkokDateKey())}`) &&
    lastGeminiRequest.systemInstruction.includes("ห้ามเดาหรือคำนวณเอง")
);
// Regression test for a real report: "ถาม สภาพอากาศวันนี้เป็นไง" got told
// there was no weather data at all, even though a province had already
// been set via "ตั้งจังหวัด" (see the morning-briefing tests earlier in
// this file) — buildSystemInstruction never fetched weather at all before
// this fix, only the separate morning-briefing code path did.
check(
  "once a province is set, the AI prompt includes real weather too, not just money/calendar/diary",
  lastGeminiRequest.systemInstruction.includes("เชียงใหม่") &&
    lastGeminiRequest.systemInstruction.includes("สภาพอากาศตอนนี้")
);

// New capability requested directly: "ถาม ข่าวหุ้น" (or similar finance
// keywords) routes to a dedicated finance-news summary instead of the
// personal-data Q&A pipeline — verified by confirming it does NOT touch
// Sheets/Calendar (no new geminiRequests entry has money/calendar/diary
// framing) and does use the CNBC-mocked headlines.
const geminiRequestsBeforeFinance = geminiRequests.length;
const financeNewsReply = await handleTextMessage(env, lineUserId, "ถาม ข่าวหุ้น", origin);
check(
  "\"ถาม ข่าวหุ้น\" routes to the finance-news summary, using the CNBC-mocked headlines",
  financeNewsReply.includes("[mock AI answer]") && financeNewsReply.includes("tech earnings")
);
check("finance news doesn't touch the money/calendar/diary Q&A pipeline", geminiRequests.length === geminiRequestsBeforeFinance + 1);
const lastFinanceGeminiRequest = geminiRequests.at(-1);
check(
  "the finance-news prompt has its own guardrail against stating stale prices as current",
  lastFinanceGeminiRequest.systemInstruction.includes("ห้ามระบุตัวเลขราคา") &&
    !lastFinanceGeminiRequest.systemInstruction.includes("รายรับรวม")
);
// New capability requested directly: gold/BTC/S&P 500/top-mover numbers from
// marketData.ts (free no-key APIs) get folded into the finance-news prompt
// as labeled ground truth, alongside the RSS headlines.
check(
  "the finance-news prompt includes real market numbers fetched fresh (BTC/gold/S&P 500/top movers)",
  lastFinanceGeminiRequest.question.includes("ข้อมูลราคาล่าสุด") &&
    lastFinanceGeminiRequest.question.includes("65,000") &&
    lastFinanceGeminiRequest.question.includes("2,345.6") &&
    lastFinanceGeminiRequest.question.includes("AAAA") &&
    lastFinanceGeminiRequest.question.includes("CCCC")
);

simulateFinanceNewsFetchFailure = true;
const financeNewsFailureReply = await handleTextMessage(env, lineUserId, "ถาม ราคาบิตคอยน์วันนี้", origin);
check(
  "a finance-news RSS failure degrades to the friendly fallback, not a crash",
  financeNewsFailureReply.includes("ระบบ AI ขัดข้อง")
);

// Market-data fetches are independent of the RSS fetch and of each other —
// one endpoint failing (here, only the first of the five concurrent calls,
// BTC) must not block the headline summary or the other numbers.
simulateMarketDataFetchFailure = true;
const financePartialFailureReply = await handleTextMessage(env, lineUserId, "ถาม ข่าวหุ้นวันนี้เป็นไง", origin);
const partialFailureRequest = geminiRequests.at(-1);
check(
  "a partial market-data fetch failure still produces a finance-news answer, just missing that one number",
  financePartialFailureReply.includes("[mock AI answer]") &&
    !partialFailureRequest.question.includes("บิตคอยน์") &&
    partialFailureRequest.question.includes("ทองคำ")
);

// New capability requested directly: "ถาม ข่าววันนี้" (or similar general
// news phrasing) routes to the daily domestic-news summary — same pattern
// as the finance-news routing above, reusing fetchNewsSummary (Bangkok
// Post RSS), which until now was only wired into the morning briefing.
const geminiRequestsBeforeDomesticNews = geminiRequests.length;
const domesticNewsReply = await handleTextMessage(env, lineUserId, "ถาม ข่าววันนี้", origin);
check(
  '"ถาม ข่าววันนี้" routes to the domestic daily-news summary, using the Bangkok Post-mocked headlines',
  domesticNewsReply.includes("[mock AI answer]") && domesticNewsReply.includes("Test headline")
);
check(
  "domestic news doesn't touch the money/calendar/diary Q&A pipeline",
  geminiRequests.length === geminiRequestsBeforeDomesticNews + 1
);
const lastDomesticNewsRequest = geminiRequests.at(-1);
check(
  "the domestic-news prompt uses the daily-news framing, not money/calendar totals",
  lastDomesticNewsRequest.systemInstruction.includes("ข่าวประจำวัน") &&
    !lastDomesticNewsRequest.systemInstruction.includes("รายรับรวม")
);

simulateNewsFetchFailure = true;
const domesticNewsFailureReply = await handleTextMessage(env, lineUserId, "ถาม ข่าวเช้านี้มีอะไรบ้าง", origin);
check(
  "a domestic-news RSS failure degrades to the friendly fallback, not a crash",
  domesticNewsFailureReply.includes("ระบบ AI ขัดข้อง")
);

const aiAnalyzeReply = await handleTextMessage(env, lineUserId, "วิเคราะห์", origin);
check(
  '"วิเคราะห์" alone still asks something useful instead of showing a usage hint',
  aiAnalyzeReply.includes("[mock AI answer]") && aiAnalyzeReply.includes("วิเคราะห์พฤติกรรมการใช้จ่าย")
);

simulateGeminiFailure = true;
const aiFailureReply = await handleTextMessage(env, lineUserId, "ถาม เดือนนี้ใช้เงินไปเท่าไหร่", origin);
check(
  "a Gemini failure (quota/error) surfaces as a friendly fallback message, not a crash",
  aiFailureReply.includes("ระบบ AI ขัดข้อง")
);

const aiPhraseOverlapReply = await handleTextMessage(env, lineUserId, "ถาม หมวดไหนใช้เงินเยอะที่สุด", origin);
check(
  '"ถาม <คำถาม>" always goes to the AI, even when the question text also happens to match a hardcoded report phrase',
  aiPhraseOverlapReply.includes("[mock AI answer]")
);

// Regression test for a real report: "ถาม นัดพรุ่งนี้มีไหม" got swallowed by
// matchCalendarCommand's appointment-creation matcher (which matches "นัด"
// as a standalone word anywhere in the text, not just at the very start —
// see its own comment for why) before ever reaching the AI, producing the
// calendar create-parser's "ไม่พบวันที่/เวลาในข้อความนะ..." error instead of
// an AI answer. Fixed by checking matchAiCommand first, ahead of every other
// matcher. Also exercises the fix for a second bug found in the same report:
// the AI used to have zero access to real Calendar data, so it answered a
// calendar question purely by pattern-matching a similarly-worded Diary
// entry — this creates a real (mocked) Calendar event for tomorrow and
// checks it actually reaches the prompt, not just Diary/money data.
const aiCalendarEventDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // tomorrow
calendarEvents.push({
  id: "evt-ai-test-1",
  summary: "หาหมอฟัน",
  start: { dateTime: aiCalendarEventDate.toISOString() },
  end: { dateTime: aiCalendarEventDate.toISOString() },
});
const aiCalendarReply = await handleTextMessage(env, lineUserId, "ถาม นัดพรุ่งนี้มีไหม", origin);
check(
  '"ถาม นัดพรุ่งนี้มีไหม" reaches the AI instead of being swallowed by the calendar create-parser',
  aiCalendarReply.includes("[mock AI answer]") && !aiCalendarReply.includes("ไม่พบวันที่/เวลาในข้อความนะ")
);
const lastCalendarGeminiRequest = geminiRequests.at(-1);
check(
  "the AI prompt includes the real calendar event, not just diary/money data",
  lastCalendarGeminiRequest.systemInstruction.includes("หาหมอฟัน") &&
    lastCalendarGeminiRequest.systemInstruction.includes("นัดหมายในปฏิทิน")
);
calendarEvents.length = 0; // clean up — nothing after this reads calendarEvents, but keep it tidy

// If fetching Calendar data for the AI's context fails, it should degrade to
// answering without it (and say so, per buildSystemInstruction) rather than
// surfacing the calendar-disabled message that isn't relevant to an AI
// question that may not even be about calendar at all.
simulateCalendarApiDisabled = true;
const aiCalendarFailReply = await handleTextMessage(env, lineUserId, "ถาม นัดพรุ่งนี้มีไหม", origin);
check(
  "a Calendar fetch failure while building AI context degrades gracefully instead of showing the calendar-disabled message",
  aiCalendarFailReply.includes("[mock AI answer]") && !aiCalendarFailReply.includes("Google Cloud Console")
);
simulateCalendarApiDisabled = false;

// Web viewer (PLAN.md 16): "เปิดเว็บดูข้อมูล" mints a signed link to a
// read-only /view page instead of requiring a fresh Google sign-in in the
// browser — exercises the whole path: chat command -> signed token ->
// real fetch handler -> HTML response, plus the guardrails a leaked/
// tampered/wrong-purpose token needs.
const viewLinkReply = await handleTextMessage(env, lineUserId, "เปิดเว็บดูข้อมูล", origin);
const viewLinkMatch = viewLinkReply.match(/https?:\/\/\S+\/view\?token=\S+/);
check("\"เปิดเว็บดูข้อมูล\" replies with a /view link", viewLinkMatch !== null);
const viewLinkUrl = viewLinkMatch[0];
const viewToken = new URL(viewLinkUrl).searchParams.get("token");

// Injects a transaction with an HTML-special-characters note directly
// into the mocked sheet (bypassing the chat parser, which isn't what's
// under test here) so the escaping test below is unambiguous about what
// it's checking, dated today so it lands inside the current month filter
// /view uses.
sheetRows.push([
  "xss-test-id",
  bangkokDateKey(),
  "expense",
  111,
  "other",
  "<script>alert(1)</script>",
  "<script>alert(1)</script> 111",
  lineUserId,
  "tester",
  new Date().toISOString(),
]);

const viewPageResponse = await worker.fetch(new Request(viewLinkUrl), env, new FakeExecutionContext());
const viewPageHtml = await viewPageResponse.text();
check("a valid view token renders the accounts summary page", viewPageResponse.status === 200 && viewPageHtml.includes("สรุปบัญชี"));
check(
  "the summary page shows totals labels",
  viewPageHtml.includes("รายรับ") && viewPageHtml.includes("รายจ่าย") && viewPageHtml.includes("คงเหลือ")
);
check(
  "a transaction note containing HTML is escaped, not rendered as live markup — the one place in this codebase user text lands in actual HTML",
  viewPageHtml.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !viewPageHtml.includes("<script>alert(1)</script>")
);

const viewNoTokenResponse = await worker.fetch(new Request(`${origin}/view`), env, new FakeExecutionContext());
check("/view with no token shows a friendly message, not a raw error", viewNoTokenResponse.status === 400 && (await viewNoTokenResponse.text()).includes("เปิดเว็บดูข้อมูล"));

const tamperedToken = viewToken.slice(0, -2) + "xx";
const viewTamperedResponse = await worker.fetch(new Request(`${origin}/view?token=${tamperedToken}`), env, new FakeExecutionContext());
check("a tampered view token is rejected", viewTamperedResponse.status === 400);

const unlinkedViewToken = await signViewToken("Uneverlinkeduser", env.STATE_SIGNING_SECRET);
const viewUnlinkedResponse = await worker.fetch(new Request(`${origin}/view?token=${unlinkedViewToken}`), env, new FakeExecutionContext());
check(
  "a view token for an account that never linked shows a friendly prompt to link first",
  viewUnlinkedResponse.status === 400 && (await viewUnlinkedResponse.text()).includes("ยังไม่ได้เชื่อมบัญชี")
);

// Regression test for the exact hijack scenario signedState.ts's top
// comment describes: OAuth `state` and the view token share the same
// {u, t} shape and secret, so without a purpose tag either one would
// verify as the other.
const forgedOauthStateFromViewToken = await signViewToken(lineUserId, env.STATE_SIGNING_SECRET);
check(
  "a view token can't be replayed as an OAuth state",
  (await verifyState(forgedOauthStateFromViewToken, env.STATE_SIGNING_SECRET)) === null
);
const forgedViewTokenFromOauthState = await signState(lineUserId, env.STATE_SIGNING_SECRET);
check(
  "an OAuth state can't be replayed as a view token",
  (await verifyViewToken(forgedViewTokenFromOauthState, env.STATE_SIGNING_SECRET)) === null
);

// Calendar/diary/trip-photo views (PLAN.md 16.3) — same token, three more
// pages sharing the resolveViewSession plumbing.

calendarEvents.push({
  id: "evt-view-test-1",
  summary: "นัดหาหมอ",
  start: { dateTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
  end: { dateTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
});
const calendarViewResponse = await worker.fetch(new Request(`${origin}/view/calendar?token=${viewToken}`), env, new FakeExecutionContext());
const calendarViewHtml = await calendarViewResponse.text();
check(
  "/view/calendar shows upcoming events grouped by date",
  calendarViewResponse.status === 200 && calendarViewHtml.includes("นัดหาหมอ")
);
calendarEvents.length = 0; // clean up — nothing after this reads calendarEvents

diaryRows.push(["diary-view-test-1", bangkokDateKey(), "ทั่วไป", "<b>ทดสอบ</b> วันนี้อากาศดี", new Date().toISOString()]);
const diaryViewResponse = await worker.fetch(new Request(`${origin}/view/diary?token=${viewToken}`), env, new FakeExecutionContext());
const diaryViewHtml = await diaryViewResponse.text();
check(
  "/view/diary shows this month's entries grouped by day, with HTML-escaped text",
  diaryViewResponse.status === 200 &&
    diaryViewHtml.includes("&lt;b&gt;ทดสอบ&lt;/b&gt;") &&
    !diaryViewHtml.includes("<b>ทดสอบ</b>")
);
const diaryEmptyMonthResponse = await worker.fetch(new Request(`${origin}/view/diary?token=${viewToken}&month=2999-01`), env, new FakeExecutionContext());
check(
  "/view/diary for a month with no entries shows an empty state instead of erroring",
  diaryEmptyMonthResponse.status === 200 && (await diaryEmptyMonthResponse.text()).includes("ไม่มีบันทึกเดือนนี้")
);

// Trip photos view reuses the "ทะเล" trip folder and its already-uploaded
// files from the trip-photo tests earlier in this run (see tripFolderId
// above) instead of manufacturing fresh Drive mock data — the view layer
// just reads back what the upload path already wrote.
const tripsListResponse = await worker.fetch(new Request(`${origin}/view/trips?token=${viewToken}`), env, new FakeExecutionContext());
const tripsListHtml = await tripsListResponse.text();
check("/view/trips lists the trip folders that exist", tripsListResponse.status === 200 && tripsListHtml.includes("ทะเล"));

const tripPhotosResponse = await worker.fetch(new Request(`${origin}/view/trips/${tripFolderId}?token=${viewToken}`), env, new FakeExecutionContext());
const tripPhotosHtml = await tripPhotosResponse.text();
check(
  "/view/trips/:folderId shows a photo grid linking to the photo-proxy endpoint",
  tripPhotosResponse.status === 200 && tripPhotosHtml.includes("ทะเล") && tripPhotosHtml.includes("/view/photo/")
);

const tripPhotoFileId = driveUploads.find((f) => f.parentId === tripFolderId)?.id;
const photoResponse = await worker.fetch(new Request(`${origin}/view/photo/${tripPhotoFileId}?token=${viewToken}`), env, new FakeExecutionContext());
check(
  "/view/photo/:fileId proxies the actual image bytes with an image content-type, not a Google token",
  photoResponse.status === 200 && (photoResponse.headers.get("content-type") ?? "").startsWith("image/")
);

simulatePhotoFetchFailure = true;
const photoFailureResponse = await worker.fetch(new Request(`${origin}/view/photo/${tripPhotoFileId}?token=${viewToken}`), env, new FakeExecutionContext());
check("a Drive failure while proxying a photo degrades to a friendly error page, not a crash", photoFailureResponse.status === 502);

const missingFolderResponse = await worker.fetch(new Request(`${origin}/view/trips/does-not-exist?token=${viewToken}`), env, new FakeExecutionContext());
check(
  "a trip folder id that doesn't exist (or isn't this account's) shows a friendly not-found page",
  missingFolderResponse.status === 404
);

const missingPhotoResponse = await worker.fetch(new Request(`${origin}/view/photo/does-not-exist?token=${viewToken}`), env, new FakeExecutionContext());
check("a photo id that doesn't exist shows a friendly not-found page, not a crash", missingPhotoResponse.status === 404);

console.log(`\n${pass} passed, ${fail} failed`);
globalThis.fetch = realFetch;
process.exit(fail > 0 ? 1 : 0);
