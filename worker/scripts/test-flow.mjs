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
    if (simulateSearchResultPutFailureOnce && key.startsWith("search-result:")) {
      simulateSearchResultPutFailureOnce = false;
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
let simulateFolderNameFetchFailure = false; // makes the next Drive folder-name (fields=name) lookup fail, to exercise the not-found-vs-transient-failure distinction

const calendarEvents = []; // simulates Google Calendar: {id, summary, start:{dateTime}, end:{dateTime}}
let calendarIdSeq = 0;
let simulateInsufficientCalendarScope = false;
let simulateCalendarApiDisabled = false;

const googleTasks = []; // simulates the Google Tasks @default list: {id, title, status}
let taskIdSeq = 0;
let simulateInsufficientTasksScope = false;
let simulateTasksApiDisabled = false;

const gmailInbox = []; // simulates the Gmail inbox: {id, from, subject, unread}
const gmailSent = []; // simulates sent messages: {to, subject, body} (decoded from the base64url raw payload)
let gmailIdSeq = 0;
let simulateInsufficientGmailScope = false;
let simulateGmailApiDisabled = false;

const placesSearchCalls = []; // records {location, keyword, key} for every Nearby Search call made
let nearbyPlacesResults = []; // simulates Places API (New)'s `places` array for the next search
let simulatePlacesApiError = false;
let simulateGmailScopeErrorAs400 = false; // regression: Gmail can answer a scope problem with a non-401/403 status, unlike Calendar/Tasks

let googleContacts = []; // simulates the account's People API connections: {name, email}
let simulateInsufficientContactsScope = false;
let simulateContactsApiDisabled = false;

// Travelpayouts travel-search mocks (PLAN.md 17.37)
let travelpayoutsFlightOffers = []; // raw prices_for_dates `data` entries for the next call
let travelpayoutsHotelOffers = []; // raw Hotellook cache entries (bare array) for the next call
const travelpayoutsFlightSearchCalls = []; // records the query params + token of each flight search
const travelpayoutsHotelSearchCalls = []; // records the query params of each hotel search
let simulateTravelpayoutsFailure = false; // makes the next Travelpayouts API call fail, to exercise the links-still-sent degradation

let diaryTabExists = false;
let diaryTabMetaCalls = 0; // counts spreadsheets.get calls, to verify the KV cache actually skips them
const diaryRows = []; // simulates the Diary tab

// simulates the extra per-month Shifts-YYYY-MM tabs (PLAN.md 17.18): which
// tab names exist yet, and the current A2:.. data range for each (the
// header/type-label rows written by ensureShiftsTab's creation PUT, then
// fully overwritten on every saveShiftGrid call).
const shiftTabsCreated = new Set();
const shiftGridStore = {}; // tabName -> string[][] (rows 2..end, as the real sheet would return them)

let simulateDriveUploadFailureCount = 0; // decremented each time; while > 0, fails the next Drive media upload request(s)
let simulatePushFailureToo = false; // one-shot: fails the next push too (pair with an "expired" replyToken to simulate total messaging failure)
const groupMemberDisplayNames = {}; // simulates LINE group member profiles: { [userId]: displayName }
let simulateGroupMemberProfileFailure = false; // makes the next group-member-profile lookup fail, to exercise graceful attribution fallback
let simulateGroupSummaryFailure = false; // makes the next group-summary lookup fail, to exercise the generic spreadsheet-name fallback
let mockGroupName = "ทริปเพื่อน"; // the group name returned by the mocked group-summary endpoint
let simulateQueuePutFailureOnce = false; // one-shot: fails the next KV put to the upload queue, to exercise handleQueuedMediaBatch's outer catch
let simulateGeminiFailure = false; // one-shot: fails the next Gemini request, to exercise the AI command's fallback message
let simulatePersonaRewrite = false; // one-shot: makes the next persona-styling call (PLAN.md 17.9) return a recognizably different string instead of echoing, to verify styling actually happened
let simulatePersonaDropQuote = false; // one-shot: makes the next persona-styling call return the input with all quoted spans stripped, to verify applyPersona's fallback when a quoted instruction (e.g. "ใช่") doesn't survive
let simulatePersonaDropLink = false; // one-shot: same idea for a URL — the travel/places replies carry no quoted spans at all, so links need their own coverage
let simulateGeminiTruncation = false; // one-shot: makes the next non-interpreter Gemini call return a *successful* 200 whose text was cut off at the token ceiling (finishReason MAX_TOKENS), the failure that used to be indistinguishable from a complete answer
let simulateGroundedAnswer = false; // one-shot: next AI Q&A call comes back grounded (the model searched the web, PLAN.md 17.38) with a LONG answer — long enough that it belongs on /view/search rather than in the chat
let simulateShortGroundedAnswer = false; // one-shot: same, but with a short answer — the common case, which goes straight into the chat with no page and nothing stored
let simulateSearchResultPutFailureOnce = false; // one-shot: fails the KV write that stores a grounded answer, leaving a real answer with nowhere permitted to display it
let simulateGroundingRejected = false; // one-shot: Gemini refuses any request carrying the google_search tool with a 400 — the real production failure, where a model that doesn't serve the tool took the whole Q&A feature down with it
let simulateTransactionAppendFailureOnce = false; // one-shot: fails the next Transactions!A1:append call, to exercise resolveConfirmation keeping the pending draft alive for a retry instead of losing it on a transient save failure
const geminiRequests = []; // captures {systemInstruction, question, apiKey} per call, so tests can assert the right data context was sent
// Must match aiInterpreter.ts's INTERPRETER_MARKER exactly — identifies an
// AI-interpreter call (PLAN.md 17.11) the same way persona.ts's calls are
// identified by "ห้ามเปลี่ยนตัวเลข" below.
const INTERPRETER_MARKER = "ระบบตีความข้อความแชท";
// one-shot: the structured intent object the *next* AI interpreter call
// returns (JSON-stringified for the mocked Gemini response). Left null by
// default, which makes the mock return non-JSON text instead — interpretMessage
// then fails to parse it and gracefully falls back to the deterministic
// matcher chain, so every test written before this feature existed keeps
// exercising that same deterministic path unless it explicitly opts in here.
let simulateInterpreterResult = null;
let simulateInterpreterFailure = false; // one-shot: fails the next AI-interpreter call specifically (a real network/API error, not just an unusable response), to exercise interpretMessage's own catch-and-fall-back path distinctly from a malformed-JSON response
let simulateInterpreterTruncation = false; // one-shot: same as simulateGeminiTruncation but for the interpreter call, which is answered before that flag is ever consulted
let simulateWeatherFetchFailure = false; // makes the next Open-Meteo forecast request fail, to exercise graceful degradation
let simulateNewsFetchFailure = false; // makes the next Bangkok Post RSS request fail, to exercise graceful degradation
let simulateFinanceNewsFetchFailure = false; // makes the next CNBC RSS request fail, to exercise graceful degradation
let simulateMarketDataFetchFailure = false; // makes the next batch of market-data requests (BTC/gold/movers) fail, to exercise graceful degradation
let simulateEconomicCalendarFetchFailure = false; // makes the next Forex Factory calendar request fail, to exercise "couldn't check" vs "confirmed empty" degradation
const GEOCODE_RESULTS = {
  เชียงใหม่: { name: "เชียงใหม่", latitude: 18.7883, longitude: 98.9853 },
};
let driveUploadRequestCount = 0; // counts requests to the media-upload mock, to verify it's 1-per-file
let activeDriveUploadRequests = 0; // in-flight count, to verify webhook concurrency stays bounded
let maxConcurrentDriveUploadRequests = 0;
let simulateSpreadsheetAccessDeniedOnce = false; // makes the next canAccessSpreadsheet check (group OAuth relink) fail, to simulate a different Google account than the one that owns the group's spreadsheet

const realFetch = fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);

  if (u.includes("oauth2.googleapis.com/token")) {
    const params = new URLSearchParams(init.body);
    const body = { access_token: "fake-access-token", expires_in: 3600 };
    // Only the initial code exchange (exchangeCodeForTokens) returns a
    // refresh_token, same as the real endpoint — refreshAccessToken's own
    // requests (grant_type=refresh_token) don't need or check for one, so
    // this stays a no-op for the many tests that only ever refresh.
    // Deriving it from `code` (not a fixed string) lets a test simulate
    // two different people completing the same still-valid OAuth link with
    // two different Google accounts, by using two different `code`s.
    if (params.get("grant_type") === "authorization_code") {
      body.refresh_token = `fake-refresh-token-for-${params.get("code")}`;
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }
  if (u.endsWith("/v4/spreadsheets")) {
    return new Response(JSON.stringify({ spreadsheetId: "fake-sheet-id" }), { status: 200 });
  }
  if (u.includes("?fields=spreadsheetId")) {
    if (simulateSpreadsheetAccessDeniedOnce) {
      simulateSpreadsheetAccessDeniedOnce = false;
      return new Response(JSON.stringify({ error: { message: "The caller does not have permission" } }), { status: 403 });
    }
    return new Response(JSON.stringify({ spreadsheetId: "fake-sheet-id" }), { status: 200 });
  }
  if (u.includes("?fields=sheets.properties") && !u.includes(".title")) {
    return new Response(
      JSON.stringify({
        sheets: [
          { properties: { sheetId: 0, title: "Transactions" } },
          { properties: { sheetId: 1, title: "Categories" } },
          { properties: { sheetId: 2, title: "Budgets" } },
          // PLAN.md 17.36's deleteDiaryEntry looks this up the same way
          // deleteMostRecentTransaction does — only present once the tab
          // has actually been created, same gating as the .title variant
          // of this same endpoint above.
          ...(diaryTabExists ? [{ properties: { sheetId: 100, title: "Diary" } }] : []),
        ],
      }),
      { status: 200 }
    );
  }
  if (u.includes(":batchUpdate")) {
    const body = init.body ? JSON.parse(init.body) : {};
    const deleteReq = (body.requests ?? []).find((r) => r.deleteDimension);
    if (deleteReq) {
      const { sheetId, startIndex, endIndex } = deleteReq.deleteDimension.range;
      // Both sheetRows and diaryRows hold only data rows (no header),
      // matching the real sheet's row 2 = index 0 offset already applied
      // by the real code under test — sheetId tells the two sheets' delete
      // requests apart, same as a real spreadsheet would.
      const target = sheetId === 100 ? diaryRows : sheetId === 2 ? budgetRows : sheetRows;
      target.splice(startIndex - 1, endIndex - startIndex);
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }
  // updateDiaryEntry (PLAN.md 17.36): overwrites one specific row in place,
  // unlike the append-only Diary!A1:append path below.
  const diaryRowUpdateMatch = u.match(/Diary!A(\d+):E\1\?valueInputOption=RAW/);
  if (diaryRowUpdateMatch) {
    const rowNumber = Number(diaryRowUpdateMatch[1]);
    const body = JSON.parse(init.body);
    diaryRows[rowNumber - 2] = body.values[0]; // -2: 1-based row number, minus the header row
    return new Response(JSON.stringify({}), { status: 200 });
  }
  // Budget writes (PLAN.md 17.43) — the header PUT that ensureBudgetsTab
  // makes, an append for a brand-new budget, and an in-place row update when
  // one already exists for that category+month.
  if (u.includes("Budgets!A1:D1?valueInputOption=RAW")) {
    return new Response(JSON.stringify({}), { status: 200 });
  }
  if (u.includes("Budgets!A1:append")) {
    const body = JSON.parse(init.body);
    budgetRows.push(...body.values);
    return new Response(JSON.stringify({}), { status: 200 });
  }
  const budgetRowUpdateMatch = u.match(/Budgets!A(\d+):D\1\?valueInputOption=RAW/);
  if (budgetRowUpdateMatch) {
    const rowNumber = Number(budgetRowUpdateMatch[1]);
    const body = JSON.parse(init.body);
    budgetRows[rowNumber - 2] = body.values[0]; // -2: 1-based row, minus the header
    return new Response(JSON.stringify({}), { status: 200 });
  }
  if (u.includes("Transactions!A1:append")) {
    if (simulateTransactionAppendFailureOnce) {
      simulateTransactionAppendFailureOnce = false;
      return new Response(JSON.stringify({ error: { message: "simulated transient Sheets append failure" } }), { status: 500 });
    }
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
  if (u.match(/https:\/\/api\.line\.me\/v2\/bot\/group\/([^/]+)\/member\/([^/]+)$/)) {
    if (simulateGroupMemberProfileFailure) {
      simulateGroupMemberProfileFailure = false;
      return new Response("simulated member-profile fetch failure", { status: 500 });
    }
    const [, , userId] = u.match(/https:\/\/api\.line\.me\/v2\/bot\/group\/([^/]+)\/member\/([^/]+)$/);
    const displayName = groupMemberDisplayNames[userId];
    if (!displayName) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ displayName, userId }), { status: 200 });
  }
  if (u.match(/https:\/\/api\.line\.me\/v2\/bot\/group\/([^/]+)\/summary$/)) {
    if (simulateGroupSummaryFailure) {
      simulateGroupSummaryFailure = false;
      return new Response("simulated group-summary fetch failure", { status: 500 });
    }
    return new Response(JSON.stringify({ groupName: mockGroupName }), { status: 200 });
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
      if (simulateFolderNameFetchFailure) {
        simulateFolderNameFetchFailure = false;
        return new Response("simulated folder-name fetch failure", { status: 500 });
      }
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
          JSON.stringify({
            files: files.map((f) => ({ id: f.id, name: f.name, mimeType: "image/jpeg", createdTime: f.createdTime })),
          }),
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
      driveUploads.push({ id, name, parentId, size: payloadSize, createdTime: new Date().toISOString() });
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
  if (u.startsWith("https://tasks.googleapis.com/tasks/v1/lists/@default/tasks")) {
    if (simulateInsufficientTasksScope) return new Response("forbidden", { status: 403 });
    if (simulateTasksApiDisabled) {
      return new Response(
        JSON.stringify({
          error: {
            code: 403,
            message:
              "Google Tasks API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/tasks.googleapis.com/overview",
            errors: [{ reason: "accessNotConfigured" }],
          },
        }),
        { status: 403 }
      );
    }
    const parsed = new URL(u);
    if (parsed.pathname === "/tasks/v1/lists/@default/tasks") {
      if (!init.method || init.method === "GET") {
        const items = googleTasks.filter((t) => t.status !== "completed");
        return new Response(JSON.stringify({ items }), { status: 200 });
      }
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        taskIdSeq += 1;
        const id = `task-${taskIdSeq}`;
        // Real Google Tasks normalizes `due` to UTC ("...Z") on the way
        // back out, regardless of what offset was sent — echoing the
        // Bangkok-offset string back unchanged (as this mock used to) would
        // silently mask any bug in converting it back to Bangkok time on
        // read, which is exactly what happened in production (PLAN.md
        // 17.28 follow-up).
        const dueUtc = body.due ? new Date(body.due).toISOString() : undefined;
        googleTasks.push({ id, title: body.title, status: "needsAction", due: dueUtc });
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
    } else {
      const id = parsed.pathname.split("/").pop();
      if (init.method === "PATCH") {
        const body = JSON.parse(init.body);
        const t = googleTasks.find((t) => t.id === id);
        if (t) Object.assign(t, body);
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      if (init.method === "DELETE") {
        const idx = googleTasks.findIndex((t) => t.id === id);
        if (idx >= 0) googleTasks.splice(idx, 1);
        return new Response(null, { status: 204 });
      }
    }
  }
  if (u.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages")) {
    if (simulateInsufficientGmailScope) return new Response("forbidden", { status: 403 });
    if (simulateGmailScopeErrorAs400) return new Response("insufficient scope, weird status", { status: 400 });
    if (simulateGmailApiDisabled) {
      return new Response(
        JSON.stringify({
          error: {
            code: 403,
            message:
              "Gmail API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview",
            errors: [{ reason: "accessNotConfigured" }],
          },
        }),
        { status: 403 }
      );
    }
    const parsed = new URL(u);
    if (parsed.pathname === "/gmail/v1/users/me/messages/send" && init.method === "POST") {
      const body = JSON.parse(init.body);
      const raw = Buffer.from(body.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      const to = raw.match(/^To: (.*)$/m)?.[1] ?? "";
      const subjectHeader = raw.match(/^Subject: (.*)$/m)?.[1] ?? "";
      const encodedMatch = subjectHeader.match(/^=\?UTF-8\?B\?(.*)\?=$/);
      const subject = encodedMatch ? Buffer.from(encodedMatch[1], "base64").toString("utf8") : subjectHeader;
      const bodyText = raw.split("\r\n\r\n").slice(1).join("\r\n\r\n");
      gmailIdSeq += 1;
      const id = `msg-${gmailIdSeq}`;
      gmailSent.push({ to, subject, body: bodyText, raw });
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
    if (parsed.pathname === "/gmail/v1/users/me/messages" && (!init.method || init.method === "GET")) {
      const unreadOnly = parsed.searchParams.get("q")?.includes("is:unread") ?? false;
      const matched = gmailInbox.filter((m) => !unreadOnly || m.unread);
      return new Response(JSON.stringify({ messages: matched.map((m) => ({ id: m.id })) }), { status: 200 });
    }
    const idMatch = parsed.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/(.+)$/);
    if (idMatch) {
      const message = gmailInbox.find((m) => m.id === idMatch[1]);
      return new Response(
        JSON.stringify({
          id: message.id,
          snippet: message.snippet ?? "",
          payload: { headers: [{ name: "From", value: message.from }, { name: "Subject", value: message.subject }] },
        }),
        { status: 200 }
      );
    }
  }
  if (u.startsWith("https://people.googleapis.com/v1/people/me/connections")) {
    if (simulateInsufficientContactsScope) return new Response("forbidden", { status: 403 });
    if (simulateContactsApiDisabled) {
      return new Response(
        JSON.stringify({
          error: {
            code: 403,
            message:
              "People API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/people.googleapis.com/overview",
            errors: [{ reason: "accessNotConfigured" }],
          },
        }),
        { status: 403 }
      );
    }
    const connections = googleContacts.map((c) => ({
      names: [{ displayName: c.name }],
      ...(c.email ? { emailAddresses: [{ value: c.email }] } : {}),
    }));
    return new Response(JSON.stringify({ connections }), { status: 200 });
  }
  if (u.startsWith("https://api.travelpayouts.com/") || u.startsWith("https://engine.hotellook.com/")) {
    if (simulateTravelpayoutsFailure) {
      simulateTravelpayoutsFailure = false;
      return new Response(JSON.stringify({ success: false, error: "simulated failure" }), { status: 500 });
    }
    const parsed = new URL(u);
    if (parsed.pathname === "/aviasales/v3/prices_for_dates") {
      travelpayoutsFlightSearchCalls.push({
        origin: parsed.searchParams.get("origin"),
        destination: parsed.searchParams.get("destination"),
        date: parsed.searchParams.get("departure_at"),
        currency: parsed.searchParams.get("currency"),
        oneWay: parsed.searchParams.get("one_way"),
        token: init.headers?.["X-Access-Token"],
      });
      return new Response(JSON.stringify({ success: true, data: travelpayoutsFlightOffers, currency: "thb" }), { status: 200 });
    }
    if (parsed.pathname === "/api/v2/cache.json") {
      travelpayoutsHotelSearchCalls.push({
        location: parsed.searchParams.get("location"),
        checkIn: parsed.searchParams.get("checkIn"),
        checkOut: parsed.searchParams.get("checkOut"),
        currency: parsed.searchParams.get("currency"),
      });
      // Hotellook's cache endpoint returns a bare array, no {data} envelope.
      return new Response(JSON.stringify(travelpayoutsHotelOffers), { status: 200 });
    }
  }
  if (u === "https://places.googleapis.com/v1/places:searchText") {
    const body = JSON.parse(init.body);
    const circle = body.locationBias?.circle;
    placesSearchCalls.push({
      location: circle ? `${circle.center.latitude},${circle.center.longitude}` : null,
      keyword: body.textQuery,
      key: init.headers?.["X-Goog-Api-Key"],
      fieldMask: init.headers?.["X-Goog-FieldMask"],
    });
    if (simulatePlacesApiError) {
      return new Response(JSON.stringify({ error: { code: 403, message: "simulated API failure", status: "PERMISSION_DENIED" } }), {
        status: 403,
      });
    }
    return new Response(JSON.stringify({ places: nearbyPlacesResults }), { status: 200 });
  }
  if (u.includes("?fields=sheets.properties.title")) {
    diaryTabMetaCalls += 1;
    const titles = [
      ...(diaryTabExists ? ["Diary"] : []),
      ...Array.from(shiftTabsCreated),
    ];
    return new Response(JSON.stringify({ sheets: titles.map((title) => ({ properties: { title } })) }), {
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
  if (u.includes("Shifts-") && u.includes("!A1?valueInputOption=RAW")) {
    const tabName = u.match(/'(Shifts-\d{4}-\d{2})'/)?.[1];
    const body = JSON.parse(init.body);
    shiftTabsCreated.add(tabName);
    // The creation PUT writes [header, ...typeRows] starting at A1 — the
    // data range (A2:..) callers actually read/write is everything after
    // the header row, so seed the store with just the type-label rows.
    shiftGridStore[tabName] = body.values.slice(1).map((row) => [...row]);
    return new Response(JSON.stringify({}), { status: 200 });
  }
  if (u.includes("Shifts-") && u.includes("!A2:")) {
    const tabName = u.match(/'(Shifts-\d{4}-\d{2})'/)?.[1];
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      shiftGridStore[tabName] = body.values;
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response(JSON.stringify({ values: shiftGridStore[tabName] ?? [] }), { status: 200 });
  }
  if (u.includes("generativelanguage.googleapis.com")) {
    const body = JSON.parse(init.body);
    const systemInstruction = body.systemInstruction?.parts?.[0]?.text ?? "";
    const question = body.contents?.[0]?.parts?.[0]?.text ?? "";

    // AI-interpreter calls (PLAN.md 17.11, aiInterpreter.ts) are identified
    // by their own marker phrase and handled before simulateGeminiFailure is
    // even consulted — every fresh message now makes this call *first*,
    // ahead of persona styling or the real Q&A pipeline, and tests that set
    // simulateGeminiFailure to exercise one of those *specific* downstream
    // calls need it to still be armed by the time that later call happens,
    // not eaten by this earlier, unrelated one. See simulateInterpreterResult's
    // own comment above for why the no-mock-configured default is
    // deliberately non-JSON.
    if (systemInstruction.includes(INTERPRETER_MARKER)) {
      geminiRequests.push({
        systemInstruction,
        question,
        apiKey: init.headers?.["x-goog-api-key"],
        maxOutputTokens: body.generationConfig?.maxOutputTokens,
        hasGoogleSearchTool: Boolean(body.tools?.some((t) => "google_search" in t)),
        model: u.match(/models\/([^:]+):/)?.[1],
      });
      if (simulateInterpreterTruncation) {
        simulateInterpreterTruncation = false;
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"intent":"chitch' }] }, finishReason: "MAX_TOKENS" }],
          }),
          { status: 200 }
        );
      }
      if (simulateInterpreterFailure) {
        simulateInterpreterFailure = false;
        return new Response(JSON.stringify({ error: { message: "simulated interpreter failure" } }), { status: 500 });
      }
      if (simulateInterpreterResult) {
        const result = simulateInterpreterResult;
        simulateInterpreterResult = null;
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: `[no interpreter mock configured] ${question}` }] } }] }),
        { status: 200 }
      );
    }

    if (simulateGeminiFailure) {
      simulateGeminiFailure = false;
      return new Response(JSON.stringify({ error: { message: "simulated Gemini failure" } }), { status: 500 });
    }
    geminiRequests.push({
      systemInstruction,
      question,
      apiKey: init.headers?.["x-goog-api-key"],
      maxOutputTokens: body.generationConfig?.maxOutputTokens,
      hasGoogleSearchTool: Boolean(body.tools?.some((t) => "google_search" in t)),
      model: u.match(/models\/([^:]+):/)?.[1],
    });

    // A 200 carrying real-looking but incomplete text — exactly what the
    // API returns when it hits maxOutputTokens. The first half of the input
    // is echoed back so the truncation is visible in an assertion.
    if (simulateGeminiTruncation) {
      simulateGeminiTruncation = false;
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: question.slice(0, Math.floor(question.length / 2)) }] }, finishReason: "MAX_TOKENS" },
          ],
        }),
        { status: 200 }
      );
    }

    // Persona-styling calls (PLAN.md 17.9, persona.ts) are identified by a
    // marker phrase unique to that system instruction. By default they echo
    // the input straight back — every other test in this file asserts on
    // the bot's exact deterministic reply text, and would break if persona
    // styling silently rewrote it under the hood. A test that specifically
    // wants to verify persona styling actually happened sets
    // simulatePersonaRewrite first, which returns a recognizably different
    // string instead (one-shot, same pattern as simulateGeminiFailure).
    if (systemInstruction.includes("ห้ามเปลี่ยนตัวเลข")) {
      if (simulatePersonaDropQuote) {
        simulatePersonaDropQuote = false;
        // Simulates the exact failure mode found in review: the model
        // "styles" a quoted instruction like '"ใช่"' into something that no
        // longer contains it verbatim, e.g. dropping the quotes entirely.
        const mangled = question.replace(/"([^"]+)"/g, "$1");
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: mangled }] } }] }), { status: 200 });
      }
      if (simulatePersonaDropLink) {
        simulatePersonaDropLink = false;
        // The travel/places failure mode: the reply keeps its shape and
        // reads fine, but a booking link came back cut short — which, for a
        // feature whose links are the entire product, is worse than not
        // restyling at all.
        const mangled = question.replace(/(https?:\/\/\S{12})\S+/g, "$1…");
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: mangled }] } }] }), { status: 200 });
      }
      if (simulatePersonaRewrite) {
        simulatePersonaRewrite = false;
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: `[persona] ${question}` }] } }] }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: question }] } }] }), { status: 200 });
    }

    // Cleared as soon as it fires, so the retry that follows — which sends
    // no tools — goes through the normal path below and succeeds.
    if (simulateGroundingRejected && body.tools?.some((t) => "google_search" in t)) {
      simulateGroundingRejected = false;
      return new Response(
        JSON.stringify({ error: { code: 400, message: "Search Grounding is not supported for this model." } }),
        { status: 400 }
      );
    }

    // A grounded answer (PLAN.md 17.38) — the model chose to run a search,
    // so the response carries groundingMetadata: the sources it used and
    // Google's Search Suggestions widget, which is HTML that has to be
    // rendered rather than escaped. Deliberately long and multi-paragraph so
    // tests can tell the chat preview apart from the full page text.
    if (simulateGroundedAnswer || simulateShortGroundedAnswer) {
      const short = simulateShortGroundedAnswer;
      simulateGroundedAnswer = false;
      simulateShortGroundedAnswer = false;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: short
                      ? "นายกรัฐมนตรีคนปัจจุบันคืออนุทินค่ะ"
                      : `นายกรัฐมนตรีคนปัจจุบันตอบจากผลค้นหาจริงนะคะ\n\nรายละเอียดเพิ่มเติมย่อหน้าที่สอง ${"ก".repeat(900)}`,
                  },
                ],
              },
              finishReason: "STOP",
              groundingMetadata: {
                searchEntryPoint: { renderedContent: '<style>.gsc{color:red}</style><div class="gsc">ค้นหาต่อ</div>' },
                groundingChunks: [
                  { web: { uri: "https://example.com/a", title: "แหล่งข่าว ก" } },
                  { web: { uri: "https://example.com/b", title: "แหล่งข่าว <ข>" } },
                ],
                webSearchQueries: ["นายกรัฐมนตรีไทยคนปัจจุบัน"],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }

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

  if (u.includes("query1.finance.yahoo.com/v8/finance/chart/")) {
    if (simulateMarketDataFetchFailure) {
      simulateMarketDataFetchFailure = false;
      return new Response("simulated market data fetch failure", { status: 500 });
    }
    // Gold and BTC both go through this same chart endpoint now (PLAN.md
    // 17.16/17.17) — regularMarketPrice/previousClose, same shape movers'
    // sibling endpoint already used successfully before this. Checking for
    // BTC-USD specifically (not "GC=F", which encodeURIComponent turns into
    // "GC%3DF" in the real request URL) since it's the one symbol that
    // stays literal.
    const isBtc = u.includes("BTC-USD");
    const meta = isBtc
      ? { regularMarketPrice: 60000, previousClose: 63000 }
      : { regularMarketPrice: 4413.6, previousClose: 4360.0 };
    return new Response(JSON.stringify({ chart: { result: [{ meta }] } }), { status: 200 });
  }
  if (u.includes("nfs.faireconomy.media/ff_calendar_thisweek.json")) {
    if (simulateEconomicCalendarFetchFailure) {
      simulateEconomicCalendarFetchFailure = false;
      return new Response("simulated economic calendar fetch failure", { status: 500 });
    }
    // A fixed "today" (Bangkok) event plus deliberate noise the code/prompt
    // is expected to filter out: a non-USD event, a Low-impact USD event,
    // and a High-impact USD event on a different day.
    const todayBangkok = bangkokDateKey();
    const [y, m, d] = todayBangkok.split("-").map(Number);
    const todayIso = (hour, minute) =>
      new Date(Date.UTC(y, m - 1, d, hour - 7, minute)).toISOString();
    const otherDayIso = new Date(Date.UTC(y, m - 1, d - 3, 5, 0)).toISOString();
    return new Response(
      JSON.stringify([
        { title: "Unemployment Claims", country: "USD", impact: "Medium", date: todayIso(19, 30) },
        { title: "German Factory Orders", country: "EUR", impact: "High", date: todayIso(14, 0) },
        { title: "Retail Sales m/m", country: "USD", impact: "Low", date: todayIso(20, 0) },
        { title: "Fed Chair Speaks", country: "USD", impact: "High", date: otherDayIso },
      ]),
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
  handleGroupTextMessage,
  handleImageMessage,
  handleVideoMessage,
  handleWebhook,
  drainUploadQueue,
  default: worker,
} = await import("../src/index.ts");
const { setAccountLink, getAccountLink, getPending } = await import("../src/state.ts");
const { verifyState, signState, signViewToken, verifyViewToken } = await import("../src/signedState.ts");
const { bangkokDateKey, bangkokMonthKey, addDaysToDateKey, formatThaiDateLabel, formatThaiDateLabelFull, bangkokStartOfDayIso } = await import("../src/thaiDate.ts");
const { countQueuedForUser } = await import("../src/uploadQueue.ts");
const { getGroupMemberProfile, getGroupSummary } = await import("../src/line.ts");
const { buildReturnGreeting, broadcastMorningBriefings } = await import("../src/greetingCommands.ts");
const { buildHelpText } = await import("../src/commands.ts");
const { validateIntent } = await import("../src/aiInterpreter.ts");
const { getConversationHistory } = await import("../src/conversationHistory.ts");

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
  // On for the suite, so the whole web-search path stays covered even though
  // production runs with it off (PLAN.md 17.42 — grounding needs a
  // billing-enabled Gemini project). The off state gets its own test, which
  // flips this and puts it back.
  ENABLE_WEB_SEARCH: "true",
  GOOGLE_MAPS_API_KEY: "test-maps-key",
  TRAVELPAYOUTS_TOKEN: "test-travelpayouts-token",
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

// Every transaction save now asks to confirm first (PLAN.md 17.9 —
// requested explicitly: numbers/anything that gets saved must always be
// confirmed, not just when the amount/category was ambiguous). This helper
// sends the log message, checks it prompted for confirmation instead of
// saving immediately, then confirms — for tests that don't need to inspect
// the prompt text itself.
async function logAndConfirm(userId, text, tokenCache) {
  const promptReply = await handleTextMessage(env, userId, text, origin, tokenCache);
  check(`"${text}" asks to confirm before saving, doesn't save immediately`, promptReply.includes("ใช่ไหม"));
  return handleTextMessage(env, userId, "ใช่", origin, tokenCache);
}

// 3. A clean message asks to confirm, then logs the transaction once confirmed.
const okReply = await logAndConfirm(lineUserId, "ซื้อกาแฟ 60");
check("logs a clear expense once confirmed", okReply.includes("60"));
check("wrote a row to the sheet", sheetRows.length === 1 && sheetRows[0][3] === 60);

// 4. An ambiguous message triggers a clarification question, then resolves
// into a confirmation prompt (not an immediate save).
const askReply = await handleTextMessage(env, lineUserId, "ซื้อของ", origin);
check("asks for the missing amount", askReply.includes("จำนวนเงิน"));
const resolveReply = await handleTextMessage(env, lineUserId, "120", origin);
check("category still needed after amount", resolveReply.includes("หมวด"));
const categoryPromptReply = await handleTextMessage(env, lineUserId, "ช้อปปิ้ง", origin);
check(
  "clarification resolves into a confirmation prompt, not an immediate save",
  categoryPromptReply.includes("120") && categoryPromptReply.includes("ใช่ไหม")
);
const categoryReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check("confirming saves the transaction", categoryReply.includes("120"));
check("second row written to the sheet", sheetRows.length === 2 && sheetRows[1][3] === 120);

// 5. Monthly summary command reads back what was written.
const summaryReply = await handleTextMessage(env, lineUserId, "สรุปเดือนนี้", origin);
check("summary mentions total expense", summaryReply.includes("180"));

// 6. More transactions to exercise the report commands with real spread:
// food (100 total, 2 entries), shopping (120, 1 entry), income (5000).
await logAndConfirm(lineUserId, "ข้าว 40");
await logAndConfirm(lineUserId, "เงินเดือนเข้า 5000");

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

// Regression test for a real bug found in review: isAffirmative only
// matched a bare exact word, so a natural reply like "ใช่ครับ"/"ใช่ค่ะ" to
// the bot's own "...ใช่ไหม?" confirmation prompt failed the check and
// silently discarded the pending draft — money the user believed they'd
// just confirmed never got saved. Now matters far more than before PLAN.md
// 17.9 (previously only calendar/diary/delete needed a confirm word at
// all; now every transaction does too).
const politeConfirmPromptReply = await handleTextMessage(env, lineUserId, "ค่าไฟ 45", origin);
check("asks to confirm before saving (setup for the polite-confirmation check below)", politeConfirmPromptReply.includes("ใช่ไหม"));
const rowCountBeforePoliteConfirm = sheetRows.length;
const politeConfirmReply = await handleTextMessage(env, lineUserId, "ใช่ค่ะ", origin);
check(
  "a natural polite confirmation (\"ใช่ค่ะ\", not the bare \"ใช่\") still saves the transaction",
  politeConfirmReply.includes("45") && sheetRows.length === rowCountBeforePoliteConfirm + 1
);

// Regression test for a real bug found in review: resolveConfirmation used
// to clear the pendingConfirmation *before* attempting the save, so a
// transient failure while actually appending to the sheet (a Sheets API
// hiccup, here simulated) threw the draft away along with the error —
// "ลองใหม่อีกครั้งนะ" actually meant retyping the whole entry from scratch.
// Now the pending draft survives a failed attempt, so retrying "ใช่" alone
// is enough. Goes through the real webhook path (handleWebhook), not a
// direct handleTextMessage call, since the graceful "เกิดข้อผิดพลาด..."
// fallback for an uncaught throw lives in processWebhookEvents, not inside
// handleTextMessage itself.
const transientFailurePromptBody = JSON.stringify({ events: [personalTextEvent("ค่าเน็ต 89", "reply-transient-1")] });
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": await signLineBody(transientFailurePromptBody, env.LINE_CHANNEL_SECRET) }, body: transientFailurePromptBody }),
  env
);
check("asks to confirm before saving (setup for the transient-failure retry check below)", replies.at(-1).includes("ใช่ไหม"));

const rowCountBeforeTransientFailure = sheetRows.length;
simulateTransactionAppendFailureOnce = true;
const transientFailureBody = JSON.stringify({ events: [personalTextEvent("ใช่", "reply-transient-2")] });
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": await signLineBody(transientFailureBody, env.LINE_CHANNEL_SECRET) }, body: transientFailureBody }),
  env
);
check(
  "a transient save failure surfaces an error instead of a false success, without saving anything",
  replies.at(-1).includes("เกิดข้อผิดพลาด") && sheetRows.length === rowCountBeforeTransientFailure
);

const transientRetryBody = JSON.stringify({ events: [personalTextEvent("ใช่", "reply-transient-3")] });
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": await signLineBody(transientRetryBody, env.LINE_CHANNEL_SECRET) }, body: transientRetryBody }),
  env
);
check(
  "retrying \"ใช่\" alone (no retyping) succeeds, since the draft survived the earlier failed attempt",
  replies.at(-1).includes("89") && sheetRows.length === rowCountBeforeTransientFailure + 1
);

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

// Code-review fix (found while reviewing PLAN.md 17.36's diary helpers,
// which copied this function's shape): a blank (cells-cleared) sheet row
// comes back from the values API as [], which readAllTransactions filters
// out — deleteMostRecentTransaction used to compute the physical row from
// the *filtered* index, so a blank row above the target deleted the
// neighboring row instead. Must scan the raw response now.
const blankRowInsertAt = sheetRows.length; // insert the blank right above where the new row will land
sheetRows.push([]);
const blankRowDeletePromptReply = await handleTextMessage(env, lineUserId, "น้ำเปล่า 10", origin);
await handleTextMessage(env, lineUserId, "ใช่", origin); // confirm-save it
const rowCountBeforeBlankRowDelete = sheetRows.length;
await handleTextMessage(env, lineUserId, "ลบรายการล่าสุด", origin);
const blankRowDeleteConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "deleting the last transaction below a hand-cleared blank sheet row removes the right physical row, not a neighbor",
  blankRowDeletePromptReply.includes("10") &&
    blankRowDeleteConfirmReply.includes("ลบรายการล่าสุดแล้ว") &&
    sheetRows.length === rowCountBeforeBlankRowDelete - 1 &&
    sheetRows[blankRowInsertAt].length === 0 && // the blank row itself is untouched
    !sheetRows.some((r) => r[5] === "น้ำเปล่า" || r[6] === "น้ำเปล่า 10")
);
sheetRows.splice(blankRowInsertAt, 1); // remove the blank so later exact-count assertions aren't perturbed

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
const multilinePromptReply = await handleTextMessage(env, lineUserId, "อเมริกาโน่ 50\nลาเต้ 40\nเค้ก 80", origin);
check(
  "a 3-line batch asks to confirm all 3 items before saving any of them",
  multilinePromptReply.includes("ใช่ไหม") && sheetRows.length === rowCountBeforeMultiline
);
const multilineReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check("confirming a 3-line batch writes 3 separate rows, not one", sheetRows.length === rowCountBeforeMultiline + 3);
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

// "วิธีใช้" answers with a link now, not the guide itself (PLAN.md 17.39).
// LINE silently truncates a text message past 5,000 characters, and the
// guide is the one reply that grows with every feature — it hit the cap for
// real twice (17.35 trimmed a 5,998-character draft; 17.38 tripped the guard
// that replaced it). A page has no such ceiling, so the transport stops
// dictating what the guide is allowed to say.
const helpReply = await handleTextMessage(env, lineUserId, "วิธีใช้", origin);
check(
  "\"วิธีใช้\" replies with a link to the guide rather than the guide itself",
  helpReply.includes(`${origin}/view/help`) && !helpReply.includes("💰 จดเงิน") && helpReply.length < 300
);

const helpPageResponse = await worker.fetch(new Request(`${origin}/view/help`), env, new FakeExecutionContext());
const helpPageHtml = await helpPageResponse.text();
check(
  "the guide page lists commands grouped by feature area",
  helpPageResponse.status === 200 &&
    helpPageHtml.includes("💰 จดเงิน") &&
    helpPageHtml.includes("📸 อัลบั้มรูปทริป") &&
    helpPageHtml.includes("📅 ปฏิทิน") &&
    helpPageHtml.includes("📔 ไดอารี่") &&
    helpPageHtml.includes("🤖 ถามคำถาม/วิเคราะห์")
);
check(
  "every bullet in the guide survives onto the page",
  helpPageHtml.match(/<li>/g)?.length === buildHelpText(true).split("\n").filter((l) => l.startsWith("• ")).length
);
// No token in the URL, unlike every other /view page: the guide is the same
// for everyone and holds no account data, so it opens for anyone — including
// someone who hasn't linked an account yet.
check("the guide page needs no token at all", !helpPageHtml.includes("ลิงก์หมดอายุ"));

const weekReply = await handleTextMessage(env, lineUserId, "สรุปสัปดาห์นี้", origin);
check("week summary doesn't error", weekReply.includes("รายรับ"));

const lastMonthReply = await handleTextMessage(env, lineUserId, "สรุปเดือนที่แล้ว", origin);
check("last month summary doesn't error", lastMonthReply.length > 0);

const greetingReply = await handleTextMessage(env, lineUserId, "สวัสดีค่ะ", origin);
check(
  "a plain greeting gets the 4-area welcome message, not the detailed help",
  greetingReply.includes("12 เรื่องหลักๆ") && !greetingReply.includes("💰 จดเงิน")
);

// A greeting sent mid-clarification must still cancel the pending question
// (chatEngine's own behavior) instead of leaving it stuck in KV — regression
// test for a bug caught while wiring up the welcome message.
await handleTextMessage(env, lineUserId, "ซื้อของ", origin); // triggers "จำนวนเงินเท่าไหร่คะ"
const greetingWhilePendingReply = await handleTextMessage(env, lineUserId, "หวัดดีครับ", origin);
check(
  "a greeting mid-clarification cancels it via chatEngine, not the rich welcome",
  !greetingWhilePendingReply.includes("9 เรื่องหลักๆ")
);
const afterGreetingReply = await handleTextMessage(env, lineUserId, "ข้าว 30", origin);
check(
  "the next real message after that isn't misread as answering the stale question",
  afterGreetingReply.includes("30")
);

// Regression test for a real report: a non-greeting, non-amount reply sent
// mid-clarification (e.g. an unrelated natural-language question) used to
// get stuck answering "จำนวนเงินเท่าไหร่คะ" forever instead of ever reaching
// the AI interpreter, since a pending clarification skipped it entirely and
// chatEngine's own "treat as a brand new message" fallback still re-asked
// the same question (parseMessage treats any text with no digits as another
// incomplete expense). Fixed by dropping a stale "amount" clarification
// before deciding whether to run the AI interpreter.
await handleTextMessage(env, lineUserId, "ซื้อของ", origin); // triggers "จำนวนเงินเท่าไหร่คะ" again
simulateInterpreterResult = { intent: "chitchat", reply: "ใครอยู่เวรพรุ่งนี้เหรอคะ เดี๋ยวดูให้นะ" };
const unrelatedQuestionWhilePendingReply = await handleTextMessage(env, lineUserId, "ใครอยู่เวรพรุ่งนี้", origin);
check(
  "an unrelated question sent mid-clarification reaches the AI interpreter instead of re-asking for an amount forever",
  unrelatedQuestionWhilePendingReply.includes("เดี๋ยวดูให้นะ") &&
    !unrelatedQuestionWhilePendingReply.includes("จำนวนเงินเท่าไหร่คะ")
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
  !briefingNoProvinceReply.includes("9 เรื่องหลักๆ") && briefingNoProvinceReply.includes(formatThaiDateLabel(bangkokDateKey()))
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

// Daily 7:00 broadcast (PLAN.md 17.21): the same morning briefing every
// personal account otherwise only gets reactively (on their own first
// "สวัสดี" of the day) now also goes out proactively at 07:00 Bangkok time,
// to every *personal* linked account only — not groups. lineUserId already
// has a province set (เชียงใหม่, from the briefing tests above), so its
// broadcast should include real weather, same as its reactive briefing did.
await setAccountLink(env.ACCOUNTS, "group:test-broadcast-group", {
  spreadsheetId: "fake-sheet-id",
  refreshToken: "fake-refresh-token-for-broadcast-group-test",
  displayName: "กลุ่มทดสอบ",
});
const pushesBeforeBroadcast = pushes.length;
const bangkok0700TodayUtc = new Date(`${bangkokDateKey()}T00:00:00.000Z`); // 00:00 UTC = 07:00 Bangkok
const notSevenOClockUtc = new Date(bangkok0700TodayUtc.getTime() + 3 * 60 * 60 * 1000); // 10:00 Bangkok

// Extras (PLAN.md 17.22): a real event today (exercises the "has an
// appointment" branch of the Calendar line) and a real diary entry dated
// yesterday (exercises the AI-analysis branch of the diary line, echoed
// back verbatim by the mocked Gemini call so the assertion below can check
// the actual diary text made it into the prompt). Both arrays are cleaned
// back up right after, since later sections (Calendar, Diary) assume they
// start from empty.
const broadcastTestEventId = "evt-broadcast-test-1";
calendarEvents.push({
  id: broadcastTestEventId,
  summary: "ประชุมทีมเช้านี้",
  start: { dateTime: `${bangkokDateKey()}T09:00:00+07:00` },
  end: { dateTime: `${bangkokDateKey()}T10:00:00+07:00` },
});
const yesterdayKeyForBroadcast = addDaysToDateKey(bangkokDateKey(), -1);
diaryRows.push(["diary-broadcast-test-1", yesterdayKeyForBroadcast, "ทั่วไป", "เมื่อวานไปวิ่งออกกำลังกายมา", new Date().toISOString()]);

await broadcastMorningBriefings(env, env.ACCOUNTS, notSevenOClockUtc);
check("the broadcast is a no-op outside the 07:00 Bangkok minute", pushes.length === pushesBeforeBroadcast);

await broadcastMorningBriefings(env, env.ACCOUNTS, bangkok0700TodayUtc);
const broadcastPushes = pushes.slice(pushesBeforeBroadcast);
check("at 07:00 Bangkok, exactly one broadcast push goes out (the personal account only)", broadcastPushes.length === 1);
check("the broadcast push targets the personal lineUserId, not the group", broadcastPushes[0]?.to === lineUserId);
check(
  "the broadcast includes today's date and real weather, same content as the reactive briefing",
  broadcastPushes[0]?.text.includes(formatThaiDateLabel(bangkokDateKey())) &&
    broadcastPushes[0]?.text.includes("เชียงใหม่") &&
    broadcastPushes[0]?.text.includes("°C")
);
check(
  "the broadcast includes today's real gold and bitcoin prices",
  broadcastPushes[0]?.text.includes("ทองคำ") && broadcastPushes[0]?.text.includes("บิตคอยน์")
);
check(
  "the broadcast includes today's real calendar appointment",
  broadcastPushes[0]?.text.includes("ประชุมทีมเช้านี้")
);
check(
  "the broadcast says there's no shift today, since none is ticked yet",
  broadcastPushes[0]?.text.includes("ไม่มีเวรนะ")
);
check(
  "the broadcast's diary line is an AI reflection built from yesterday's real diary text",
  broadcastPushes[0]?.text.includes("เมื่อวานไปวิ่งออกกำลังกายมา")
);
calendarEvents.length = 0; // clean up — the Calendar test section below assumes it starts empty
diaryRows.length = 0; // clean up — the Diary test section below assumes it starts empty

await broadcastMorningBriefings(env, env.ACCOUNTS, bangkok0700TodayUtc);
check("a second 07:00 firing the same day doesn't send a duplicate broadcast", pushes.length === pushesBeforeBroadcast + 1);

const returnGreetingAfterBroadcastReply = await handleTextMessage(env, lineUserId, "สวัสดี", origin);
check(
  "a greeting later the same day as the broadcast gets the short return-greeting, not another briefing",
  returnGreetingAfterBroadcastReply === buildReturnGreeting()
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
check("declining the switch still treats the unrelated message as a normal expense attempt", declineReply.includes("60"));
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

// AI persona layer (PLAN.md 17.9): restyles every reply the bot actually
// sends to LINE, but only at that real outgoing boundary — never inside
// handleTextMessage/handleGroupTextMessage's own return value, which every
// other test in this file relies on staying byte-exact deterministic text.
// Proves both halves of that design: a real webhook-driven reply passes
// through persona styling, and a direct call to handleTextMessage for the
// exact same text does not.
function personalTextEvent(text, replyToken = "reply-persona-1") {
  return {
    type: "message",
    message: { type: "text", text },
    source: { type: "user", userId: lineUserId },
    replyToken,
    timestamp: Date.now(),
  };
}

const directPersonaReply = await handleTextMessage(env, lineUserId, "สรุปเดือนนี้", origin);
check(
  "a direct handleTextMessage call is never persona-styled — stays exact deterministic text",
  !directPersonaReply.startsWith("[persona]")
);

simulatePersonaRewrite = true;
const personaWebhookBody = JSON.stringify({ events: [personalTextEvent("สรุปเดือนนี้")] });
const personaWebhookSignature = await signLineBody(personaWebhookBody, env.LINE_CHANNEL_SECRET);
const repliesBeforePersona = replies.length;
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": personaWebhookSignature }, body: personaWebhookBody }),
  env
);
check(
  "the same text sent through a real webhook call comes back persona-styled",
  replies.length === repliesBeforePersona + 1 && replies.at(-1).startsWith("[persona]")
);

// A persona call that fails (quota, network, timeout — all surface as a
// thrown error from askGemini) must fall back to the original deterministic
// text, never break or silence the reply.
simulateGeminiFailure = true;
const personaFailureWebhookBody = JSON.stringify({ events: [personalTextEvent("สรุปเดือนนี้", "reply-persona-2")] });
const personaFailureWebhookSignature = await signLineBody(personaFailureWebhookBody, env.LINE_CHANNEL_SECRET);
const repliesBeforePersonaFailure = replies.length;
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": personaFailureWebhookSignature }, body: personaFailureWebhookBody }),
  env
);
check(
  "a failed persona call falls back to the original unstyled reply instead of breaking it",
  replies.length === repliesBeforePersonaFailure + 1 &&
    !replies.at(-1).startsWith("[persona]") &&
    replies.at(-1) === directPersonaReply
);

// Regression test for a real bug found in review: applyPersona used to
// trust the styled output unconditionally — if Gemini dropped or reworded
// a quoted instruction like '"ใช่"' despite being told not to (an
// instruction, not a guarantee), the styled reply would go out with a
// confirmation instruction the exact-match isAffirmative check could never
// recognize, silently breaking the user's ability to confirm at all. Now
// verifies every quoted span from the original survived, falling back to
// the unstyled text otherwise.
simulatePersonaDropQuote = true;
const quoteDropWebhookBody = JSON.stringify({ events: [personalTextEvent("ชานมไข่มุก 25", "reply-persona-3")] });
const quoteDropWebhookSignature = await signLineBody(quoteDropWebhookBody, env.LINE_CHANNEL_SECRET);
const repliesBeforeQuoteDrop = replies.length;
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": quoteDropWebhookSignature }, body: quoteDropWebhookBody }),
  env
);
check(
  "a persona call that drops a quoted confirmation instruction falls back to the original reply, keeping the exact \"ใช่\" instruction intact",
  replies.length === repliesBeforeQuoteDrop + 1 && replies.at(-1).includes('"ใช่"')
);

// Same guard, the case the quoted-span check could never see: travel and
// nearby-place replies contain no quoted spans at all, but their whole
// point is the booking/maps links. A restyling that shortens a URL leaves a
// reply that still reads perfectly and is completely useless.
simulatePersonaDropLink = true;
const flightWebhookBody = JSON.stringify({
  events: [personalTextEvent("หาตั๋วเครื่องบิน กรุงเทพ ไป เชียงใหม่ 20/12/2569", "reply-persona-4")],
});
const flightWebhookSignature = await signLineBody(flightWebhookBody, env.LINE_CHANNEL_SECRET);
const repliesBeforeLinkDrop = replies.length;
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": flightWebhookSignature }, body: flightWebhookBody }),
  env
);
check(
  "a persona call that shortens a booking link falls back to the original reply, with every link intact",
  replies.length === repliesBeforeLinkDrop + 1 &&
    replies.at(-1).includes("https://www.skyscanner.co.th/transport/flights/bkk/cnx/261220/") &&
    replies.at(-1).includes("https://www.google.com/travel/flights?q=") &&
    !replies.at(-1).includes("…")
);

// Regression tests for a real bug found in review: a response cut off at
// the token ceiling comes back as an ordinary 200 with text in it, and
// askGemini used to read only `parts` — so a half-finished answer was
// indistinguishable from a complete one and went straight out to the user.
// finishReason is now checked, which turns each of these into the ordinary
// failed-call path every caller already handles.
// The interpreter was already covered by accident — truncated JSON fails
// JSON.parse, which interpretMessage catches into the same fallback — so
// this one passes with or without the finishReason check and proves
// nothing about it. Kept as a behaviour lock (the fallback must stay
// deterministic no matter which error shape gets it there); the check
// itself is what the AI-answer case below actually exercises.
simulateInterpreterTruncation = true;
const interpreterTruncatedReply = await handleTextMessage(env, lineUserId, "สรุปเดือนนี้", origin);
check(
  "a truncated interpreter response falls back to the deterministic matcher chain, not a half-parsed intent",
  interpreterTruncatedReply === directPersonaReply
);

simulateGeminiTruncation = true;
const answerTruncatedReply = await handleTextMessage(env, lineUserId, "ถาม เดือนนี้ใช้เงินหมวดไหนเยอะสุด", origin);
check(
  "a truncated AI answer shows the honest fallback message instead of a sentence that stops mid-thought",
  answerTruncatedReply.includes("ตอบคำถามนี้ไม่สำเร็จ")
);

// The ceilings differ per caller now (gemini.ts) — one shared number had to
// suit a small JSON intent and a full reply restyling at once.
const lastRequestWhere = (predicate) => [...geminiRequests].reverse().find(predicate);
const lastInterpreterRequest = lastRequestWhere((r) => r.systemInstruction.includes(INTERPRETER_MARKER));
const lastPersonaRequest = lastRequestWhere((r) => r.systemInstruction.includes("ห้ามเปลี่ยนตัวเลข"));
// The AI Q&A call carries the Google Search tool (PLAN.md 17.38) and so
// gets its own, larger ceiling than the plain prose callers (news, the diary
// reflection) that share ANSWER_MAX_OUTPUT_TOKENS.
const lastQuestionRequest = lastRequestWhere((r) => r.systemInstruction.includes("ช่วยตอบคำถามเกี่ยวกับการเงิน"));
const lastNewsRequest = lastRequestWhere((r) => r.systemInstruction.includes("ช่วยสรุปข่าว"));
check(
  "each Gemini caller sends its own output ceiling rather than one shared value",
  lastInterpreterRequest?.maxOutputTokens === 800 &&
    lastPersonaRequest?.maxOutputTokens === 2000 &&
    lastQuestionRequest?.maxOutputTokens === 2000 &&
    lastNewsRequest?.maxOutputTokens === 1200
);
check(
  "only the AI Q&A call offers the Google Search tool — the interpreter and persona never do",
  lastQuestionRequest?.hasGoogleSearchTool === true &&
    lastInterpreterRequest?.hasGoogleSearchTool === false &&
    lastPersonaRequest?.hasGoogleSearchTool === false
);
// PLAN.md 17.41: the grounded call runs on the full Flash model because Lite
// doesn't appear to serve the search tool. Nothing else moves off Lite —
// that model was never the problem and is cheaper and faster.
check(
  "the grounded call runs on full Flash while every other caller stays on Lite",
  lastQuestionRequest?.model === "gemini-3.5-flash" &&
    lastInterpreterRequest?.model === "gemini-3.5-flash-lite" &&
    lastPersonaRequest?.model === "gemini-3.5-flash-lite"
);
// Clean up the dangling pendingConfirmation this created directly (rather
// than through a chat message, which would have side effects of its own),
// so it doesn't interfere with anything later in the file sharing lineUserId.
await kv.delete(`confirm:${lineUserId}`);

// Regression test for the fix to a real race found in review: every event
// for the same subject in one webhook call used to run concurrently
// (Promise.allSettled), so two events for the same subject could race on
// the single shared pendingConfirmation KV slot (state.ts) — e.g. one
// event's "ใช่" confirming a fresh draft the other event only just created,
// or clobbering it entirely. Events for the same subject are now grouped
// and processed strictly one at a time (still concurrent across different
// subjects), so a batch containing both "confirm the old draft" and
// "start a brand new draft" for the same person must resolve deterministically
// in array order, not race.
const subjectRaceSetupPromptReply = await handleTextMessage(env, lineUserId, "ซื้อกาแฟ 200", origin);
check(
  "setup: an older pending draft exists before the same-batch race test below",
  subjectRaceSetupPromptReply.includes("ใช่ไหม")
);
const rowCountBeforeSubjectRace = sheetRows.length;
const subjectRaceBody = JSON.stringify({
  events: [personalTextEvent("ใช่", "reply-race-1"), personalTextEvent("ค่ากาแฟ 15", "reply-race-2")],
});
const repliesBeforeSubjectRace = replies.length;
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": await signLineBody(subjectRaceBody, env.LINE_CHANNEL_SECRET) }, body: subjectRaceBody }),
  env
);
check(
  "the older draft (200) is confirmed and saved by the batch's first event, not lost or crossed with the second",
  sheetRows.length === rowCountBeforeSubjectRace + 1 && sheetRows.at(-1)[3] === 200
);
check(
  "the batch's second event starts its own fresh draft (15) afterward, in order, not concurrently",
  replies.length === repliesBeforeSubjectRace + 2 &&
    replies.at(-2).includes("200") &&
    replies.at(-1).includes("15") &&
    replies.at(-1).includes("ใช่ไหม")
);
// Clean up the dangling pendingConfirmation this test's second event left behind.
await kv.delete(`confirm:${lineUserId}`);

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
check(
  "each line in a listing includes the date, not just the time",
  listTomorrowReply.includes(formatThaiDateLabel(tomorrowKey))
);

const listWeekReply = await handleTextMessage(env, lineUserId, "มีนัดอะไรสัปดาห์นี้", origin);
check("week list doesn't error", listWeekReply.length > 0);

// Regression test for a real report: a multi-day listing ("นัดช่วงนี้",
// routed through the AI interpreter's calendar_query intent since it's not
// one of the fixed today/tomorrow/week phrases) showed only the time per
// line with no date at all — two real events on different days at 18:00 and
// 14:00 read as "out of order" with nothing to show they weren't the same
// day. Second event here is a few days out but at an *earlier* clock time
// than the first, matching that shape. The order check below confirms
// formatEventLines preserves whatever order listCalendarEvents returns
// (real Google API sorts by actual start time via orderBy: startTime, not
// re-verified by this mock) rather than re-sorting or reversing it; the
// date-inclusion checks are this test's actual regression coverage. Uses an
// explicit interpreter-provided range instead of the "week" phrase above,
// so this doesn't depend on which day of the week the test happens to run
// on.
const laterKey = addDaysToDateKey(todayKey, 4);
const laterSlash = toSlashDate(laterKey);
await handleTextMessage(env, lineUserId, `นัด จัดห้องใหม่ ${laterSlash} 09:00`, origin);
await handleTextMessage(env, lineUserId, "ใช่", origin);

simulateInterpreterResult = {
  intent: "calendar_query",
  calendarRangeFromKey: todayKey,
  calendarRangeToKeyExclusive: addDaysToDateKey(todayKey, 5),
  calendarRangeLabel: "นี้",
};
const listRangeReply = await handleTextMessage(env, lineUserId, "นัดช่วงนี้", origin);
check(
  "a multi-day listing includes both events with their own dates",
  listRangeReply.includes(formatThaiDateLabel(tomorrowKey)) &&
    listRangeReply.includes("ประชุมทีม") &&
    listRangeReply.includes(formatThaiDateLabel(laterKey)) &&
    listRangeReply.includes("จัดห้องใหม่")
);
check(
  "the earlier-day event (later clock time) is listed before the later-day event (earlier clock time)",
  listRangeReply.indexOf("ประชุมทีม") < listRangeReply.indexOf("จัดห้องใหม่")
);
// Clean up — the edit/delete tests right below assume "ประชุมทีม" is the
// only event in calendarEvents (calendarEvents.length/calendarEvents[0]
// checks), same as before this multi-day listing test existed.
const janghongIdx = calendarEvents.findIndex((e) => e.summary === "จัดห้องใหม่");
if (janghongIdx >= 0) calendarEvents.splice(janghongIdx, 1);

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
const doctorFeeReply = await logAndConfirm(lineUserId, "ค่านัดหมอ 500");
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

// Regression test for a real, systemic bug found via a live Gmail report but
// affecting every AI-interpreted intent, not just Gmail: runInterpretedIntent
// (index.ts) used to `return withToken(...)` — a promise — from inside its
// own try block *without* awaiting it. A `try { return somePromise(); }
// catch {...}` does NOT let that catch see a *later* rejection of the
// returned promise (verified directly: only a synchronous throw, or an
// awaited rejection, triggers the catch) — so every scope-error/API-disabled
// classification in that function was silently unreachable in production
// whenever the AI interpreter (the primary path for most real messages)
// successfully classified the intent, which is the common case. Every prior
// relink/API-disabled test above this one only ever exercised the *other*,
// correctly-awaited path (dispatchLegacyCommands) — this test-flow.mjs mock
// happens to reject the interpreter call by default (deliberately invalid
// JSON, see simulateInterpreterResult's own comment) unless
// simulateInterpreterResult is explicitly set first, which none of those
// tests did, so this exact bug passed 352 prior tests undetected.
simulateInterpreterResult = { intent: "calendar_query", calendarRangeFromKey: "2026-01-01", calendarRangeToKeyExclusive: "2026-01-02", calendarRangeLabel: "วันนี้" };
simulateInsufficientCalendarScope = true;
const aiInterpretedRelinkReply = await handleTextMessage(env, lineUserId, "มีนัดอะไรบ้างวันนี้นะ", origin);
check(
  "an AI-interpreted intent that hits a scope error still gets the re-link prompt, not the generic crash message",
  aiInterpretedRelinkReply.includes("สิทธิ์ปฏิทินเพิ่ม") &&
    aiInterpretedRelinkReply.includes("accounts.google.com") &&
    !aiInterpretedRelinkReply.includes("เกิดข้อผิดพลาดตอนบันทึก")
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

// 8.5. Tasks (PLAN.md 17.26): "สิ่งที่ต้องทำ" — a plain title-only to-do list
// backed by Google Tasks. Confirm-before-you-do-it for create/complete/
// delete, same discipline as calendar/diary/transactions.
const listEmptyReply = await handleTextMessage(env, lineUserId, "สิ่งที่ต้องทำ", origin);
check("an empty task list says so instead of an empty list", listEmptyReply.includes("ไม่มีสิ่งที่ต้องทำค้างอยู่เลยนะ"));

// Regression test for a real, confirmed collision: matchCalendarCommand's
// "นัด" trigger (extractNadPayload) matches that word anywhere in a message,
// not just at the start — a task whose free text happens to contain it (a
// common Thai word) used to get swallowed into a failed calendar-create
// attempt ("ไม่พบวันที่/เวลาในข้อความนะ...") before ever reaching
// matchTaskCommand, since calendarHandler used to be checked first in
// dispatchLegacyCommands (index.ts). Fixed by checking Task/Gmail's own
// fixed, unambiguous prefixes before Calendar's looser trigger. Fully
// created and deleted again here (rather than left lingering) so it doesn't
// disturb the length-based assertions the rest of this section relies on.
const calendarEventsBeforeNadWordTask = calendarEvents.length;
const taskWithNadWordPromptReply = await handleTextMessage(env, lineUserId, "เพิ่มสิ่งที่ต้องทำ นัดหมอฟันสัปดาห์หน้า", origin);
check(
  "a task whose text contains the word 'นัด' still reaches the task handler, not calendar's create-parser",
  taskWithNadWordPromptReply.includes("นัดหมอฟันสัปดาห์หน้า") && !taskWithNadWordPromptReply.includes("ไม่พบวันที่/เวลา")
);
await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "confirming actually created the task, not a calendar event",
  googleTasks.some((t) => t.title === "นัดหมอฟันสัปดาห์หน้า") && calendarEvents.length === calendarEventsBeforeNadWordTask
);
await handleTextMessage(env, lineUserId, "ลบสิ่งที่ต้องทำ นัดหมอฟันสัปดาห์หน้า", origin);
await handleTextMessage(env, lineUserId, "ใช่", origin);
check("cleaned back up so it doesn't affect the counts below", !googleTasks.some((t) => t.title === "นัดหมอฟันสัปดาห์หน้า"));

const taskCreatePromptReply = await handleTextMessage(env, lineUserId, "เพิ่มสิ่งที่ต้องทำ ซื้อของเข้าบ้าน", origin);
check(
  "task create asks to confirm before touching Google Tasks",
  taskCreatePromptReply.includes("ซื้อของเข้าบ้าน") && googleTasks.length === 0
);
const taskCreateConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "confirming creates the task",
  taskCreateConfirmReply.includes("เพิ่มสิ่งที่ต้องทำแล้ว") && googleTasks.length === 1
);

await handleTextMessage(env, lineUserId, "เพิ่มสิ่งที่ต้องทำ จ่ายบิลค่าน้ำ", origin);
await handleTextMessage(env, lineUserId, "ใช่", origin);
check("a second task can be added too", googleTasks.length === 2);

const listWithTasksReply = await handleTextMessage(env, lineUserId, "สิ่งที่ต้องทำ", origin);
check(
  "the task list shows every incomplete task",
  listWithTasksReply.includes("ซื้อของเข้าบ้าน") && listWithTasksReply.includes("จ่ายบิลค่าน้ำ")
);

const completePromptReply = await handleTextMessage(env, lineUserId, "ทำเสร็จแล้ว ซื้อของเข้าบ้าน", origin);
check(
  "marking a task complete asks to confirm first",
  completePromptReply.includes("ซื้อของเข้าบ้าน") && googleTasks.find((t) => t.title === "ซื้อของเข้าบ้าน").status !== "completed"
);
const completeConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "confirming marks the task complete and it drops off the incomplete list",
  completeConfirmReply.includes("เสร็จแล้ว") &&
    googleTasks.find((t) => t.title === "ซื้อของเข้าบ้าน").status === "completed"
);
const listAfterCompleteReply = await handleTextMessage(env, lineUserId, "สิ่งที่ต้องทำ", origin);
check(
  "a completed task no longer shows up in the list",
  !listAfterCompleteReply.includes("ซื้อของเข้าบ้าน") && listAfterCompleteReply.includes("จ่ายบิลค่าน้ำ")
);

const deleteTaskPromptReply = await handleTextMessage(env, lineUserId, "ลบสิ่งที่ต้องทำ จ่ายบิลค่าน้ำ", origin);
check("delete asks to confirm first", deleteTaskPromptReply.includes("จ่ายบิลค่าน้ำ") && googleTasks.length === 2);
const deleteTaskConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "confirming removes the task entirely",
  deleteTaskConfirmReply.includes("ลบสิ่งที่ต้องทำ") && googleTasks.length === 1
);

const deleteTaskMissingReply = await handleTextMessage(env, lineUserId, "ลบสิ่งที่ต้องทำ ไม่มีจริง", origin);
check("deleting a non-existent task says so instead of erroring", deleteTaskMissingReply.includes("ไม่พบสิ่งที่ต้องทำ"));

// AI interpreter routing (PLAN.md 17.11/17.26): a natural-language task
// request without the exact "เพิ่มสิ่งที่ต้องทำ"/"สิ่งที่ต้องทำ" phrasing still
// reaches the same confirm-before-save flow via task_create/task_list.
simulateInterpreterResult = { intent: "task_create", taskTitle: "โทรหาหมอ" };
const interpTaskCreateReply = await handleTextMessage(env, lineUserId, "อย่าลืมโทรหาหมอด้วยนะ", origin);
check("an AI-interpreted task create still asks to confirm first", interpTaskCreateReply.includes("โทรหาหมอ"));
await handleTextMessage(env, lineUserId, "ใช่", origin);
simulateInterpreterResult = { intent: "task_list" };
const interpTaskListReply = await handleTextMessage(env, lineUserId, "มีอะไรต้องทำอีกไหม", origin);
check("an AI-interpreted task list reaches the same answerTaskList function", interpTaskListReply.includes("โทรหาหมอ"));

simulateInsufficientTasksScope = true;
const taskRelinkReply = await handleTextMessage(env, lineUserId, "สิ่งที่ต้องทำ", origin);
check(
  "a scope-less refresh token gets a re-link prompt for Tasks, not a crash",
  taskRelinkReply.includes("สิทธิ์สิ่งที่ต้องทำเพิ่ม") && taskRelinkReply.includes("accounts.google.com")
);
simulateInsufficientTasksScope = false;

simulateTasksApiDisabled = true;
const taskApiDisabledReply = await handleTextMessage(env, lineUserId, "สิ่งที่ต้องทำ", origin);
check(
  "a disabled Tasks API gets an 'enable it in Cloud Console' message, not a re-link loop",
  taskApiDisabledReply.includes("Google Cloud Console") && !taskApiDisabledReply.includes("เชื่อมบัญชี Google ใหม่อีกครั้ง")
);
simulateTasksApiDisabled = false;

// PLAN.md 17.27: "เพิ่มสิ่งที่ต้องทำ" now understands an optional trailing
// date and/or time, the same "strip a matched date/time out of the free
// text" trick calendarCommands.ts's parseEventDraft uses — except a task's
// date/time stay optional (parseTaskDraft never rejects a message just for
// missing one), unlike an appointment's, which are both mandatory.
const taskWithDateTimePromptReply = await handleTextMessage(
  env,
  lineUserId,
  "เพิ่มสิ่งที่ต้องทำ จ่ายค่าไฟ 20/1/2569 14:00",
  origin
);
check(
  "a task with a date and time shows both in the confirm prompt, with a clean title",
  taskWithDateTimePromptReply.includes('"จ่ายค่าไฟ"') &&
    taskWithDateTimePromptReply.includes("20 ม.ค. 2569") &&
    taskWithDateTimePromptReply.includes("14:00")
);
const taskWithDateTimeConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
const savedDateTimeTask = googleTasks.find((t) => t.title === "จ่ายค่าไฟ");
check(
  "confirming sends a due timestamp built from the parsed date+time",
  taskWithDateTimeConfirmReply.includes("20 ม.ค. 2569") &&
    taskWithDateTimeConfirmReply.includes("14:00") &&
    // The mock normalizes to UTC on write, same as the real Google Tasks
    // API (see the mock's own comment) — 14:00 Bangkok (+07:00) is 07:00Z.
    savedDateTimeTask?.due === "2026-01-20T07:00:00.000Z"
);

const taskDateOnlyPromptReply = await handleTextMessage(env, lineUserId, "เพิ่มสิ่งที่ต้องทำ ต่อทะเบียนรถ 25/1/2569", origin);
check(
  "a task with only a date shows the date but not a time in the confirm prompt",
  taskDateOnlyPromptReply.includes("25 ม.ค. 2569") && !taskDateOnlyPromptReply.includes("เวลา")
);
await handleTextMessage(env, lineUserId, "ใช่", origin);
const savedDateOnlyTask = googleTasks.find((t) => t.title === "ต่อทะเบียนรถ");
check(
  // 00:00 Bangkok (+07:00) on the 25th is 17:00Z the day *before* — this is
  // exactly the date-rollback trap parseDueField's fix comment describes.
  "a date-only task is still sent with a due timestamp, at midnight Bangkok time",
  savedDateOnlyTask?.due === "2026-01-24T17:00:00.000Z"
);

// Regression test for a real production report ("วันที่/เวลาที่โชว์ผิด" — the
// shown date/time is wrong): listIncompleteTasks/parseDueField (tasks.ts)
// used to slice the raw `due` string directly assuming it was already
// Bangkok-local text, but Google's API actually returns it as a genuine UTC
// timestamp — reading it back without converting through bangkokDateKey/
// bangkokHourMinute showed the *UTC* date/time (off by the file's whole
// +07:00 offset, and for early-morning times, off by a whole day too). This
// specifically only fails if the mock simulates Google's real UTC
// normalization (see the mock's own comment) rather than just echoing back
// whatever was sent, which is what let this bug ship undetected originally.
const listWithDueDatesReply = await handleTextMessage(env, lineUserId, "สิ่งที่ต้องทำ", origin);
check(
  "the task list shows the correct Bangkok-local due date/time, not the raw UTC one Google actually stores",
  listWithDueDatesReply.includes("จ่ายค่าไฟ วันที่ 20 ม.ค. 2569 เวลา 14:00") &&
    listWithDueDatesReply.includes("ต่อทะเบียนรถ วันที่ 25 ม.ค. 2569") &&
    !listWithDueDatesReply.includes("ต่อทะเบียนรถ วันที่ 25 ม.ค. 2569 เวลา") &&
    !listWithDueDatesReply.includes("24 ม.ค. 2569") // the UTC-rolled-back date, if the bug were still present
);

// A task created with no date/time at all still works exactly as before
// (backward compatibility) — "โทรหาหมอ" was created earlier in this section
// via the AI-interpreter path with no due date supplied at all.
check("a task created with no date/time has no due field at all", googleTasks.find((t) => t.title === "โทรหาหมอ")?.due === undefined);

// The AI interpreter (aiInterpreter.ts) can supply an optional due date/time too.
simulateInterpreterResult = {
  intent: "task_create",
  taskTitle: "ต่อประกันรถ",
  taskDueDateKey: "2026-02-01",
  taskDueTime: "09:30",
};
const interpTaskWithDueReply = await handleTextMessage(env, lineUserId, "อย่าลืมต่อประกันรถ 1 ก.พ. 9:30 ด้วยนะ", origin);
check(
  "an AI-interpreted task_create with a due date/time shows it in the confirm prompt",
  interpTaskWithDueReply.includes("1 ก.พ. 2569") && interpTaskWithDueReply.includes("09:30")
);
await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "the AI-supplied due date/time reaches Google Tasks as a real due timestamp",
  // 09:30 Bangkok (+07:00) is 02:30Z.
  googleTasks.find((t) => t.title === "ต่อประกันรถ")?.due === "2026-02-01T02:30:00.000Z"
);

// 8.6. Gmail (PLAN.md 17.28): "เช็คอีเมล" / "ส่งอีเมล ถึง ... เรื่อง ... ข้อความ
// ...". Read (inbox summaries only) + send only — the narrowest v1 scope
// that still does what was asked for. Sending confirms first, same as every
// other write action.
const emailCheckEmptyReply = await handleTextMessage(env, lineUserId, "เช็คอีเมล", origin);
check("no unread email says so instead of an empty list", emailCheckEmptyReply.includes("ไม่มีอีเมลใหม่ที่ยังไม่ได้อ่านเลยนะ"));

gmailInbox.push(
  { id: "m-1", from: "boss@company.com", subject: "งานด่วน", snippet: "ช่วยส่งรายงานก่อนเที่ยงด้วยนะ", unread: true },
  { id: "m-2", from: "newsletter@shop.com", subject: "โปรโมชั่นพิเศษ", snippet: "ลดสูงสุด 50%", unread: false }
);
const emailCheckWithMailReply = await handleTextMessage(env, lineUserId, "เช็คอีเมล", origin);
check(
  "checking email lists only the unread one, with sender/subject/snippet, not the already-read one",
  emailCheckWithMailReply.includes("boss@company.com") &&
    emailCheckWithMailReply.includes("งานด่วน") &&
    emailCheckWithMailReply.includes("ช่วยส่งรายงานก่อนเที่ยงด้วยนะ") &&
    !emailCheckWithMailReply.includes("newsletter@shop.com")
);

const emailSendBadFormatReply = await handleTextMessage(env, lineUserId, "ส่งอีเมล หาใครสักคน", origin);
check(
  "a malformed send command asks for the right format instead of erroring",
  emailSendBadFormatReply.includes("รูปแบบไม่ถูกต้อง") && gmailSent.length === 0
);

// "not-an-email" isn't a valid address, so it's treated as a contact name
// (PLAN.md 17.34) — with no matching contact, this degrades to a friendly
// "didn't find that contact" message rather than a confirm prompt, same
// end result (rejected before ever confirming) as the old plain
// invalid-format check this replaced.
const emailSendBadAddressReply = await handleTextMessage(
  env,
  lineUserId,
  "ส่งอีเมล ถึง not-an-email เรื่อง ทดสอบ ข้อความ สวัสดี",
  origin
);
check(
  "an unresolvable recipient (not an email, no matching contact) is rejected before ever prompting to confirm",
  emailSendBadAddressReply.includes("ไม่พบผู้ติดต่อ") && gmailSent.length === 0
);

const emailSendPromptReply = await handleTextMessage(
  env,
  lineUserId,
  "ส่งอีเมล ถึง friend@example.com เรื่อง ประชุมพรุ่งนี้ ข้อความ พรุ่งนี้เจอกันตอนบ่ายสองนะ",
  origin
);
check(
  "sending an email asks to confirm first, and warns it can't be recalled",
  emailSendPromptReply.includes("friend@example.com") &&
    emailSendPromptReply.includes("ประชุมพรุ่งนี้") &&
    emailSendPromptReply.includes("เรียกคืนไม่ได้") &&
    gmailSent.length === 0
);
const emailSendConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "confirming actually sends it, with the exact recipient/subject/body",
  emailSendConfirmReply.includes("friend@example.com") &&
    gmailSent.length === 1 &&
    gmailSent[0].to === "friend@example.com" &&
    gmailSent[0].subject === "ประชุมพรุ่งนี้" &&
    gmailSent[0].body === "พรุ่งนี้เจอกันตอนบ่ายสองนะ"
);

// Regression test for a header-injection bug caught in code review before
// merge: gmailCommands.ts's send-command regex uses the /s (dotAll) flag so
// a multi-line body can be typed, but that also lets the *subject* capture
// span a real newline if one is embedded in the message. Without stripping
// it (gmail.ts's stripHeaderBreaks), that embedded \n would become a real
// line break in the raw MIME message, letting whatever follows be read as
// an extra header (e.g. a live Bcc:) instead of literal subject text.
const injectedSubjectText = "Hi\nBcc: attacker@evil.com";
await handleTextMessage(
  env,
  lineUserId,
  `ส่งอีเมล ถึง friend@example.com เรื่อง ${injectedSubjectText} ข้อความ Hello`,
  origin
);
await handleTextMessage(env, lineUserId, "ใช่", origin);
const injectedSend = gmailSent.at(-1);
const rawHeaderLines = injectedSend.raw.split("\r\n\r\n")[0].split("\r\n");
check(
  "an embedded newline in the subject can't inject a real extra header (e.g. Bcc) into the sent MIME message",
  !rawHeaderLines.some((line) => line.startsWith("Bcc:")) && injectedSend.subject.includes("Bcc: attacker@evil.com")
);

// AI interpreter routing (PLAN.md 17.11/17.28): natural-language email
// requests still reach the same confirm-before-send flow.
simulateInterpreterResult = { intent: "email_check" };
const interpEmailCheckReply = await handleTextMessage(env, lineUserId, "มีเมลใหม่บ้างไหม", origin);
check("an AI-interpreted email_check reaches the same answerEmailCheck function", interpEmailCheckReply.includes("boss@company.com"));

simulateInterpreterResult = {
  intent: "email_send",
  emailTo: "colleague@example.com",
  emailSubject: "แจ้งลาป่วย",
  emailBody: "วันนี้ขอลาป่วยนะครับ",
};
const gmailSentCountBeforeInterp = gmailSent.length;
const interpEmailSendReply = await handleTextMessage(env, lineUserId, "ช่วยส่งเมลลาป่วยให้เพื่อนร่วมงานหน่อย", origin);
check(
  "an AI-interpreted email_send still asks to confirm first, never sends directly",
  interpEmailSendReply.includes("colleague@example.com") && gmailSent.length === gmailSentCountBeforeInterp
);
await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "confirming the AI-interpreted send actually sends it",
  gmailSent.length === gmailSentCountBeforeInterp + 1 && gmailSent.at(-1).to === "colleague@example.com"
);

// Explicitly routes through the AI-interpreted path (simulateInterpreterResult
// set), not just the deterministic dispatchLegacyCommands fallback this mock
// would otherwise silently take — this is what actually reproduces the real
// production report (index.ts's runInterpretedIntent missing an `await` on
// its `return withToken(...)` calls, see the regression test/comment further
// up for the full explanation), since Gemini classifies a message like
// "เช็คอีเมล" successfully in real production traffic far more often than not.
simulateInterpreterResult = { intent: "email_check" };
simulateInsufficientGmailScope = true;
const gmailRelinkReply = await handleTextMessage(env, lineUserId, "เช็คอีเมล", origin);
check(
  "a scope-less refresh token gets a re-link prompt for Gmail, not a crash, even via the AI-interpreted path",
  gmailRelinkReply.includes("สิทธิ์อีเมลเพิ่ม") &&
    gmailRelinkReply.includes("accounts.google.com") &&
    !gmailRelinkReply.includes("เกิดข้อผิดพลาดตอนบันทึก")
);
simulateInsufficientGmailScope = false;

// Regression test for a real report: a user with the Gmail API already
// enabled but not yet re-linked got a generic crash reply instead of the
// re-link prompt — gmailFetch used to only classify a scope problem when
// the status was exactly 401/403, so a real Gmail response using some other
// 4xx status fell through as a raw, unclassified Error. Any 4xx that isn't
// the API-disabled case is now treated as "needs to re-link" instead.
simulateGmailScopeErrorAs400 = true;
const gmailRelink400Reply = await handleTextMessage(env, lineUserId, "เช็คอีเมล", origin);
check(
  "a non-401/403 4xx from Gmail still gets a re-link prompt, not a generic crash",
  gmailRelink400Reply.includes("สิทธิ์อีเมลเพิ่ม") && gmailRelink400Reply.includes("accounts.google.com")
);
simulateGmailScopeErrorAs400 = false;

simulateGmailApiDisabled = true;
const gmailApiDisabledReply = await handleTextMessage(env, lineUserId, "เช็คอีเมล", origin);
check(
  "a disabled Gmail API gets an 'enable it in Cloud Console' message, not a re-link loop",
  gmailApiDisabledReply.includes("Google Cloud Console") && !gmailApiDisabledReply.includes("เชื่อมบัญชี Google ใหม่อีกครั้ง")
);
simulateGmailApiDisabled = false;

// 8.7. Contacts (PLAN.md 17.34): "อีเมลของ<ชื่อ>" lookup, plus letting
// "ส่งอีเมล ถึง <ชื่อ>" accept a contact's name instead of a full email
// address. Read-only, no confirm-before-save of its own — the actual write
// this feeds into (sending) still confirms via the usual flow, always
// showing the *resolved* address before anything goes out.
googleContacts = [
  { name: "สมชาย ใจดี", email: "somchai@example.com" },
  { name: "สมหญิง", email: "somying@example.com" },
  { name: "สมศักดิ์ ไม่มีอีเมล" }, // a real contact with no email on file
];

const contactLookupReply = await handleTextMessage(env, lineUserId, "อีเมลของสมชาย", origin);
check("looking up a contact's email finds the exact match", contactLookupReply.includes("somchai@example.com"));

const contactLookupMissingReply = await handleTextMessage(env, lineUserId, "อีเมลของไม่มีตัวตน", origin);
check("looking up a nonexistent contact says so instead of erroring", contactLookupMissingReply.includes("ไม่พบผู้ติดต่อ"));

const contactLookupNoEmailReply = await handleTextMessage(env, lineUserId, "อีเมลของสมศักดิ์", origin);
check(
  "looking up a real contact with no email on file says so, not a crash",
  contactLookupNoEmailReply.includes("ไม่มีอีเมลบันทึกไว้")
);

// Sending by name: resolves through the exact same lookup, then the normal
// confirm-before-send prompt shows the *resolved* address — so a wrong
// match is still caught before anything is sent, not after.
const sendByNamePromptReply = await handleTextMessage(
  env,
  lineUserId,
  "ส่งอีเมล ถึง สมชาย เรื่อง นัดพรุ่งนี้ ข้อความ เจอกันบ่ายโมงนะ",
  origin
);
check(
  "sending to a contact's name resolves it and shows the real address in the confirm prompt",
  sendByNamePromptReply.includes("somchai@example.com")
);
const sendByNameConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "confirming sends to the resolved address, not the typed name",
  sendByNameConfirmReply.includes("somchai@example.com") && gmailSent.at(-1).to === "somchai@example.com"
);

// A multi-word name ("สมชาย ใจดี") must survive the "ถึง <token> เรื่อง"
// regex capture, which used to be \S+ (single token only, would have cut
// this off at the space) before PLAN.md 17.34 widened it.
const sendByFullNamePromptReply = await handleTextMessage(
  env,
  lineUserId,
  "ส่งอีเมล ถึง สมชาย ใจดี เรื่อง ทดสอบชื่อเต็ม ข้อความ สวัสดี",
  origin
);
check(
  "a multi-word contact name (with a space) still resolves correctly",
  sendByFullNamePromptReply.includes("somchai@example.com")
);
await handleTextMessage(env, lineUserId, "ใช่", origin);

const ambiguousNameReply = await handleTextMessage(env, lineUserId, "อีเมลของสม", origin);
check(
  "an ambiguous name (matches multiple contacts) asks to be more specific instead of guessing",
  ambiguousNameReply.includes("พบหลายคน") &&
    ambiguousNameReply.includes("สมชาย ใจดี") &&
    ambiguousNameReply.includes("สมหญิง") &&
    ambiguousNameReply.includes("สมศักดิ์")
);

// A real email address bypasses contact lookup entirely — the two paths
// (literal address vs. name) must both still work side by side.
const sendByRealAddressReply = await handleTextMessage(
  env,
  lineUserId,
  "ส่งอีเมล ถึง friend2@example.com เรื่อง ทดสอบ ข้อความ สวัสดี",
  origin
);
check("a literal email address still bypasses contact lookup entirely", sendByRealAddressReply.includes("friend2@example.com"));
await handleTextMessage(env, lineUserId, "ใช่", origin);

// AI interpreter routing (PLAN.md 17.11/17.34): both a standalone lookup
// and a send-by-name go through the exact same resolution/lookup functions.
simulateInterpreterResult = { intent: "contact_lookup", contactName: "สมหญิง" };
const interpContactLookupReply = await handleTextMessage(env, lineUserId, "ขออีเมลสมหญิงหน่อย", origin);
check("an AI-interpreted contact_lookup reaches the same answerContactEmail function", interpContactLookupReply.includes("somying@example.com"));

simulateInterpreterResult = {
  intent: "email_send",
  emailTo: "สมหญิง",
  emailSubject: "นัดพรุ่งนี้",
  emailBody: "เจอกันบ่ายสองนะ",
};
const interpSendByNameReply = await handleTextMessage(env, lineUserId, "ส่งเมลหาสมหญิงว่าเจอกันบ่ายสองพรุ่งนี้นะ", origin);
check(
  "an AI-interpreted email_send with a contact name also resolves through the same lookup",
  interpSendByNameReply.includes("somying@example.com")
);
await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "confirming the AI-interpreted send-by-name actually sends to the resolved address",
  gmailSent.at(-1).to === "somying@example.com"
);

simulateInsufficientContactsScope = true;
const contactsRelinkReply = await handleTextMessage(env, lineUserId, "อีเมลของสมชาย", origin);
check(
  "a scope-less refresh token gets a re-link prompt for Contacts, not a crash",
  contactsRelinkReply.includes("สิทธิ์ผู้ติดต่อเพิ่ม") && contactsRelinkReply.includes("accounts.google.com")
);
simulateInsufficientContactsScope = false;

simulateContactsApiDisabled = true;
const contactsApiDisabledReply = await handleTextMessage(env, lineUserId, "อีเมลของสมชาย", origin);
check(
  "a disabled People API gets an 'enable it in Cloud Console' message, not a re-link loop",
  contactsApiDisabledReply.includes("Google Cloud Console") && !contactsApiDisabledReply.includes("เชื่อมบัญชี Google ใหม่อีกครั้ง")
);
simulateContactsApiDisabled = false;

googleContacts = []; // clean up — the sections below don't expect any contacts to exist

// 8.8. Nearby places (PLAN.md 17.30): "หา<คำ>ใกล้ฉัน" + LINE's native
// location-sharing message. No OAuth, no confirm-before-save — the only
// feature in this bot backed by a flat API key instead of a linked Google
// account, and the only one that reads back public data without ever
// writing/sending anything. Goes through the real webhook path (not
// handleTextMessage directly) since a location message is a distinct LINE
// event type handleTextMessage never sees.
function personalLocationEvent(lat, lng, replyToken = "reply-location-1") {
  return {
    type: "message",
    message: { type: "location", latitude: lat, longitude: lng },
    source: { type: "user", userId: lineUserId },
    replyToken,
    timestamp: Date.now(),
  };
}

async function sendWebhookEvents(events) {
  const rawBody = JSON.stringify({ events });
  const signature = await signLineBody(rawBody, env.LINE_CHANNEL_SECRET);
  await handleWebhook(
    new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": signature }, body: rawBody }),
    env
  );
}

nearbyPlacesResults = [
  { displayName: { text: "ร้านกาแฟดีใจ" }, formattedAddress: "ถนนสุขุมวิท", rating: 4.5, googleMapsUri: "https://maps.google.com/?cid=1" },
];

const repliesBeforeNearbyPrompt = replies.length;
await sendWebhookEvents([personalTextEvent("หาร้านกาแฟใกล้ฉัน", "reply-nearby-1")]);
check(
  "asking to find something nearby prompts to share a location",
  replies.length === repliesBeforeNearbyPrompt + 1 && replies.at(-1).includes("ตำแหน่ง")
);

const repliesBeforeNearbyResult = replies.length;
await sendWebhookEvents([personalLocationEvent(13.75, 100.5, "reply-nearby-2")]);
check(
  "sharing the location afterward searches nearby and replies with results",
  replies.length === repliesBeforeNearbyResult + 1 &&
    replies.at(-1).includes("ร้านกาแฟดีใจ") &&
    replies.at(-1).includes("ถนนสุขุมวิท")
);
check(
  "the search actually used the shared coordinates, the right keyword, and the configured API key",
  placesSearchCalls.at(-1).location === "13.75,100.5" &&
    placesSearchCalls.at(-1).keyword === "ร้านกาแฟ" &&
    placesSearchCalls.at(-1).key === "test-maps-key"
);

const repliesBeforeUnpromptedLocation = replies.length;
await sendWebhookEvents([personalLocationEvent(13.75, 100.5, "reply-nearby-3")]);
check("sharing a location with nothing pending gets no reply at all", replies.length === repliesBeforeUnpromptedLocation);

// Regression test for a real report: typing "ร้านกาแฟใกล้ฉัน" (no "หา" at the
// start) got hallucinated into an unrelated weather/no-data reply instead of
// prompting for a location — matchPlacesCommand's regex only recognizes the
// exact "หา...ใกล้ฉัน" phrasing, and since the AI interpreter runs *before*
// the deterministic matcher for every fresh message but never knew this
// feature existed at all (no find_nearby_places intent), it never had a way
// to route a differently-phrased request here. Fixed by teaching the
// interpreter the intent and sharing the same promptPlaceSearch the regex
// matcher already used.
simulateInterpreterResult = { intent: "find_nearby_places", placeKeyword: "ร้านกาแฟ" };
const repliesBeforeAiNearbyPrompt = replies.length;
await sendWebhookEvents([personalTextEvent("ร้านกาแฟใกล้ฉัน", "reply-nearby-ai-1")]);
check(
  "an AI-interpreted nearby-place request (no 'หา' prefix) still prompts to share a location",
  replies.length === repliesBeforeAiNearbyPrompt + 1 && replies.at(-1).includes("ตำแหน่ง")
);

const repliesBeforeAiNearbyResult = replies.length;
await sendWebhookEvents([personalLocationEvent(13.75, 100.5, "reply-nearby-ai-2")]);
check(
  "sharing the location afterward resolves the AI-interpreted search too",
  replies.length === repliesBeforeAiNearbyResult + 1 && replies.at(-1).includes("ร้านกาแฟดีใจ")
);

// A search with no nearby results degrades gracefully, not silently.
nearbyPlacesResults = [];
await sendWebhookEvents([personalTextEvent("หาปั๊มน้ำมันใกล้ฉัน", "reply-nearby-4")]);
const repliesBeforeZeroResults = replies.length;
await sendWebhookEvents([personalLocationEvent(13.75, 100.5, "reply-nearby-5")]);
check(
  "no nearby results says so instead of an empty list",
  replies.length === repliesBeforeZeroResults + 1 && replies.at(-1).includes("ไม่พบ")
);

// A real Places API failure (bad key/quota/etc.) degrades to one generic
// message — there's no per-user remediation to offer here, unlike Calendar/
// Tasks/Gmail's re-link vs. enable-API split (an admin-only key/config
// problem either way), so this doesn't need a dedicated error class.
simulatePlacesApiError = true;
await sendWebhookEvents([personalTextEvent("หาร้านอาหารใกล้ฉัน", "reply-nearby-6")]);
const repliesBeforeApiError = replies.length;
await sendWebhookEvents([personalLocationEvent(13.75, 100.5, "reply-nearby-7")]);
check(
  "a real Places API failure degrades to a friendly message, not a crash",
  replies.length === repliesBeforeApiError + 1 && replies.at(-1).includes("ไม่สำเร็จ")
);
simulatePlacesApiError = false;

// Missing GOOGLE_MAPS_API_KEY (optional, same degrade-gracefully treatment
// as GEMINI_API_KEY) tells the user the feature isn't set up instead of
// crashing or silently doing nothing.
const realMapsKey = env.GOOGLE_MAPS_API_KEY;
env.GOOGLE_MAPS_API_KEY = "";
await sendWebhookEvents([personalTextEvent("หาที่จอดรถใกล้ฉัน", "reply-nearby-8")]);
const repliesBeforeMissingKey = replies.length;
await sendWebhookEvents([personalLocationEvent(13.75, 100.5, "reply-nearby-9")]);
check(
  "a missing Maps API key tells the user the feature isn't set up, not a crash",
  replies.length === repliesBeforeMissingKey + 1 && replies.at(-1).includes("ยังไม่พร้อมใช้งาน")
);
env.GOOGLE_MAPS_API_KEY = realMapsKey;

// LINE can bundle the "หา...ใกล้ฉัน" text command and the location share
// into the same webhook call (e.g. a fast double-tap) — same real bundling
// race as trip-start + photo (see processWebhookEvents's own comment); text
// events are grouped and processed before location events for the same
// subject, so the pending state the text just set is what the bundled
// location event resolves, not left stranded for a message that never comes.
nearbyPlacesResults = [{ displayName: { text: "ร้านสะดวกซื้อ" }, formattedAddress: "ซอยหลังบ้าน", googleMapsUri: "https://maps.google.com/?cid=3" }];
const repliesBeforeBundled = replies.length;
await sendWebhookEvents([
  personalTextEvent("หาร้านสะดวกซื้อใกล้ฉัน", "reply-nearby-10"),
  personalLocationEvent(13.8, 100.6, "reply-nearby-11"),
]);
check(
  "a text command and its location share bundled into the same webhook call still resolve correctly",
  replies.length === repliesBeforeBundled + 2 && replies.at(-1).includes("ร้านสะดวกซื้อ")
);

// 8.9. Travel search (PLAN.md 17.37): real flight/hotel prices via
// Amadeus when configured, links always, 12Go links-only for bus/train,
// and graceful degradation on every price-lookup failure mode.

// Flight search via the deterministic "หาตั๋วเครื่องบิน" command.
travelpayoutsFlightOffers = [
  { price: 1540, airline: "FD", departure_at: "2026-12-20T08:00:00+07:00", transfers: 0 },
  { price: 2100, airline: "WE", departure_at: "2026-12-20T10:00:00+07:00", transfers: 1 },
];
const flightSearchReply = await handleTextMessage(env, lineUserId, "หาตั๋วเครื่องบิน กรุงเทพ ไป เชียงใหม่ 20/12/2569", origin);
check(
  "flight search shows real cached prices: airline (LCCs included), departure time, direct/stops, baht price",
  flightSearchReply.includes("FD ออก 08:00 บินตรง") &&
    flightSearchReply.includes("1,540 บาท") &&
    flightSearchReply.includes("ต่อเครื่อง 1 ครั้ง") &&
    flightSearchReply.includes("2,100 บาท")
);
check(
  "the flight search hit the API with the parsed route/date, one-way, THB, and the configured token",
  travelpayoutsFlightSearchCalls.at(-1)?.origin === "BKK" &&
    travelpayoutsFlightSearchCalls.at(-1)?.destination === "CNX" &&
    travelpayoutsFlightSearchCalls.at(-1)?.date === "2026-12-20" &&
    travelpayoutsFlightSearchCalls.at(-1)?.currency === "thb" &&
    travelpayoutsFlightSearchCalls.at(-1)?.oneWay === "true" &&
    travelpayoutsFlightSearchCalls.at(-1)?.token === "test-travelpayouts-token"
);
check(
  "the flight reply always includes Google Flights + Skyscanner booking links with the route prefilled",
  flightSearchReply.includes("google.com/travel/flights") &&
    flightSearchReply.includes("skyscanner.co.th/transport/flights/bkk/cnx/261220/")
);
check(
  "the flight reply says prices come from a search cache, not a live quote",
  flightSearchReply.includes("แคช")
);

// Hotel search via the deterministic "หาที่พัก" command — cheapest-first.
travelpayoutsHotelOffers = [
  { hotelName: "โรงแรมแพง", stars: 5, priceFrom: 4500 },
  { hotelName: "โรงแรมถูก", stars: 3, priceFrom: 1200 },
];
const hotelSearchReply = await handleTextMessage(env, lineUserId, "หาที่พัก เชียงใหม่ 20/12/2569 ถึง 22/12/2569", origin);
check(
  "hotel search shows real cached prices cheapest-first, with star ratings",
  hotelSearchReply.indexOf("โรงแรมถูก") !== -1 &&
    hotelSearchReply.indexOf("โรงแรมถูก") < hotelSearchReply.indexOf("โรงแรมแพง") &&
    hotelSearchReply.includes("เริ่ม 1,200 บาท") &&
    hotelSearchReply.includes("⭐3")
);
check(
  "the hotel lookup sent the free-text city name and stay dates to Hotellook",
  travelpayoutsHotelSearchCalls.at(-1)?.location === "เชียงใหม่" &&
    travelpayoutsHotelSearchCalls.at(-1)?.checkIn === "2026-12-20" &&
    travelpayoutsHotelSearchCalls.at(-1)?.checkOut === "2026-12-22"
);
check(
  "the hotel reply always includes Agoda + Booking links with city and dates prefilled",
  hotelSearchReply.includes("agoda.com/search") &&
    hotelSearchReply.includes("booking.com/searchresults.html") &&
    hotelSearchReply.includes("checkin=2026-12-20") &&
    hotelSearchReply.includes("checkout=2026-12-22")
);

// One date and no checkout = a 1-night stay.
const hotelOneNightReply = await handleTextMessage(env, lineUserId, "หาที่พัก ภูเก็ต 20/12/2569", origin);
check(
  "a hotel search with only a check-in date defaults to one night",
  hotelOneNightReply.includes("checkin=2026-12-20") && hotelOneNightReply.includes("checkout=2026-12-21")
);

// Bus/train: links-only by design (no free price API exists), said openly.
const groundSearchReply = await handleTextMessage(env, lineUserId, "หาตั๋วรถทัวร์ กรุงเทพ ไป ขอนแก่น 20/12/2569", origin);
check(
  "ground-transport search sends a 12Go link with the route and date prefilled, and says prices live there",
  groundSearchReply.includes("12go.asia/th/travel/bangkok/khon-kaen?date=2026-12-20") &&
    groundSearchReply.includes("ยังไม่มีระบบราคา")
);

// Degradation tier 1: Amadeus API fails — links still go out with a note.
simulateTravelpayoutsFailure = true;
const flightApiFailReply = await handleTextMessage(env, lineUserId, "หาตั๋วเครื่องบิน กรุงเทพ ไป ภูเก็ต 21/12/2569", origin);
check(
  "a Travelpayouts API failure degrades to links-plus-note, never an empty or error reply",
  flightApiFailReply.includes("ดึงราคามาโชว์ตรงนี้ไม่สำเร็จ") &&
    flightApiFailReply.includes("google.com/travel/flights") &&
    flightApiFailReply.includes("skyscanner.co.th")
);

// Degradation tier 2: no Amadeus key configured at all — links-only with a
// different, honest note (same optional-secret treatment as GOOGLE_MAPS_API_KEY).
const realTravelpayoutsToken = env.TRAVELPAYOUTS_TOKEN;
env.TRAVELPAYOUTS_TOKEN = "";
const flightNoKeyReply = await handleTextMessage(env, lineUserId, "หาตั๋วเครื่องบิน กรุงเทพ ไป เชียงใหม่ 20/12/2569", origin);
check(
  "with no Travelpayouts token configured, the reply says so and still sends the booking links",
  flightNoKeyReply.includes("ยังไม่ได้ตั้งค่า Travelpayouts token") && flightNoKeyReply.includes("google.com/travel/flights")
);
env.TRAVELPAYOUTS_TOKEN = realTravelpayoutsToken;

// An unknown city in the deterministic command points at the AI phrasing
// instead of failing silently.
const unknownCityReply = await handleTextMessage(env, lineUserId, "หาตั๋วเครื่องบิน กรุงเทพ ไป เบตง 20/12/2569", origin);
check("an unknown city in the fixed command suggests the natural-language phrasing", unknownCityReply.includes("ยังไม่รู้จักเมือง"));

// Regression guard: "หาตั๋ว..."/"หาที่พัก..." must reach the travel handler,
// not commands.ts's transaction-search regex ("^(?:ค้นหา|หา)...") which
// would otherwise swallow them as a money-note search — and "หาที่พักใกล้ฉัน"
// must still be a GPS nearby-search (Places), not a travel search.
check(
  "travel commands aren't swallowed by the transaction-search matcher",
  !flightSearchReply.includes("ไม่พบรายการ") && !hotelSearchReply.includes("ไม่พบรายการ")
);
const nearbyHotelReply = await handleTextMessage(env, lineUserId, "หาที่พักใกล้ฉัน", origin);
check(
  '"หาที่พักใกล้ฉัน" still routes to the GPS nearby-search prompt, not travel search',
  nearbyHotelReply.includes("แชร์ตำแหน่งปัจจุบัน")
);
// Clear the pending place search directly in KV — sending a chat message
// to cancel it would itself get parsed as a new (incomplete) money entry
// by the deterministic fallback chain and leave a dangling clarification.
await env.ACCOUNTS.delete(`place-search:${lineUserId}`);

// AI-interpreted paths route to the exact same answer functions.
simulateInterpreterResult = {
  intent: "flight_search",
  flightOriginCode: "BKK",
  flightDestinationCode: "CNX",
  flightOriginName: "กรุงเทพ",
  flightDestinationName: "เชียงใหม่",
  flightDateKey: "2026-12-20",
};
const interpFlightReply = await handleTextMessage(env, lineUserId, "อยากบินไปเชียงใหม่วันที่ 20 ธันวา", origin);
check(
  "an AI-interpreted flight search reaches the same price+links pipeline",
  interpFlightReply.includes("FD ออก 08:00") && interpFlightReply.includes("skyscanner.co.th")
);

simulateInterpreterResult = {
  intent: "hotel_search",
  hotelCityName: "เชียงใหม่",
  hotelCheckInDateKey: "2026-12-20",
  hotelCheckOutDateKey: "2026-12-22",
};
const interpHotelReply = await handleTextMessage(env, lineUserId, "หาที่นอนเชียงใหม่ 20-22 ธันวาหน่อย", origin);
check(
  "an AI-interpreted hotel search reaches the same price+links pipeline",
  interpHotelReply.includes("โรงแรมถูก") && interpHotelReply.includes("agoda.com")
);

simulateInterpreterResult = {
  intent: "ground_ticket_search",
  groundOriginName: "กรุงเทพ",
  groundDestinationName: "เชียงใหม่",
  groundOriginSlug: "bangkok",
  groundDestinationSlug: "chiang-mai",
};
const interpGroundReply = await handleTextMessage(env, lineUserId, "นั่งรถไฟไปเชียงใหม่มีไหม", origin);
check(
  "an AI-interpreted ground-ticket search sends the 12Go link (no date = no date param)",
  interpGroundReply.includes("12go.asia/th/travel/bangkok/chiang-mai") && !interpGroundReply.includes("date=")
);

// validateIntent must reject malformed codes/slugs outright — they feed
// straight into API queries and URL paths.
simulateInterpreterResult = {
  intent: "flight_search",
  flightOriginCode: "BKKX", // not a 3-letter IATA code
  flightDestinationCode: "CNX",
  flightOriginName: "กรุงเทพ",
  flightDestinationName: "เชียงใหม่",
  flightDateKey: "2026-12-20",
};
const interpBadCodeReply = await handleTextMessage(env, lineUserId, "อยากบินไปเชียงใหม่", origin);
check(
  "a malformed IATA code from the model is rejected by validateIntent (falls through to the deterministic chain)",
  !interpBadCodeReply.includes("skyscanner.co.th")
);

check(
  "the interpreter prompt actually teaches all three travel intents",
  (() => {
    const lastInterpreterCall = geminiRequests.findLast((r) => r.systemInstruction.includes(INTERPRETER_MARKER));
    return (
      lastInterpreterCall.systemInstruction.includes('"intent":"flight_search"') &&
      lastInterpreterCall.systemInstruction.includes('"intent":"hotel_search"') &&
      lastInterpreterCall.systemInstruction.includes('"intent":"ground_ticket_search"')
    );
  })()
);

travelpayoutsFlightOffers = [];
travelpayoutsHotelOffers = [];

// 9. Diary (PLAN.md 15.4): confirm-before-save with a default and an explicit
// category, monthly listing, and search.
// Snapshotted here rather than assuming diaryTabMetaCalls starts at 0 — the
// 7:00 broadcast test above (PLAN.md 17.22) also reads the Diary tab once
// (for yesterday's entries), so this section's own "checked once" check
// below asserts against the delta since this point, not an absolute count.
const diaryTabMetaCallsBeforeThisSection = diaryTabMetaCalls;
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
  "the Diary tab's existence is checked at most once across this whole section, then cached in KV",
  // <= 1, not === 1: the broadcast test above (PLAN.md 17.22) may have
  // already warmed the same spreadsheetId's diary-tab cache key by reading
  // yesterday's entries, in which case this section's own reads pay for
  // zero further metadata checks rather than exactly one — either way, the
  // cache means this section itself never pays for more than one.
  diaryTabMetaCalls - diaryTabMetaCallsBeforeThisSection <= 1
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

// AI message interpretation + conversation memory (PLAN.md 17.11): every
// fresh message goes through interpretMessage first, and its structured
// intent routes to the exact same deterministic apply/prompt/answer
// functions the regex matchers use — confirm-before-save (17.9) still
// applies to anything that saves data. The default Gemini mock returns
// non-JSON text for an interpreter call (see simulateInterpreterResult's own
// comment), so unless a test explicitly sets it, interpretMessage returns
// null and the message falls back to the pre-existing deterministic path —
// this is what let all 264 pre-17.11 tests above pass completely unchanged.

const sheetRowsBeforeInterp = sheetRows.length;
simulateInterpreterResult = {
  intent: "transaction",
  transactions: [{ amount: 350, type: "expense", categoryId: "shopping", note: "เสื้อยืดตัวใหม่" }],
};
const interpTxPromptReply = await handleTextMessage(env, lineUserId, "ไปเดินห้างมาซื้อเสื้อยืดตัวนึง", origin);
check(
  "an AI-interpreted transaction still asks to confirm before saving, doesn't save immediately",
  interpTxPromptReply.includes("ใช่ไหม") && sheetRows.length === sheetRowsBeforeInterp
);
const interpTxConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "confirming the AI-interpreted draft actually saves it, using the AI-picked category",
  interpTxConfirmReply.includes("350") &&
    sheetRows.length === sheetRowsBeforeInterp + 1 &&
    sheetRows.at(-1)[4] === "shopping" &&
    sheetRows.at(-1)[5] === "เสื้อยืดตัวใหม่"
);

// validateIntent (aiInterpreter.ts) rejects a well-formed-JSON-but-invalid
// intent outright — here, a categoryId that doesn't exist for the declared
// type — rather than trusting it and writing a bogus category to the sheet.
// A rejected intent is treated exactly like a failed call: gracefully falls
// back to the deterministic parser, which still recognizes the plain
// "ซื้อกาแฟ 45" phrasing on its own.
const sheetRowsBeforeInvalid = sheetRows.length;
simulateInterpreterResult = {
  intent: "transaction",
  transactions: [{ amount: 45, type: "expense", categoryId: "not-a-real-category", note: "กาแฟ" }],
};
const invalidIntentReply = await handleTextMessage(env, lineUserId, "ซื้อกาแฟ 45", origin);
check(
  "an invalid AI intent (bogus categoryId) is rejected and falls back to the deterministic parser",
  invalidIntentReply.includes("ใช่ไหม")
);
const invalidIntentConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "the deterministic fallback saved a real category, not the AI's invalid one",
  sheetRows.length === sheetRowsBeforeInvalid + 1 && sheetRows.at(-1)[4] === "food"
);

// An outright interpreter call failure (network/API error, not just an
// unusable response) degrades the exact same way a malformed response does
// — the deterministic parser still resolves an unambiguous message on its
// own, so a Gemini outage never blocks logging an expense.
const sheetRowsBeforeCallFailure = sheetRows.length;
simulateInterpreterFailure = true;
await logAndConfirm(lineUserId, "ซื้อขนม 20");
check(
  "an outright interpreter call failure still falls back to the deterministic parser",
  sheetRows.length === sheetRowsBeforeCallFailure + 1 && sheetRows.at(-1)[4] === "food"
);

// "chitchat"/"unclear" intents: the AI answers directly (a reply it composed
// itself, not routed through any save/confirm step) rather than being forced
// through chatEngine's fixed clarification phrasing.
simulateInterpreterResult = { intent: "chitchat", reply: "สวัสดีค่ะ วันนี้เป็นอย่างไรบ้างคะ" };
const chitchatReply = await handleTextMessage(env, lineUserId, "ช่วงนี้เป็นไงบ้าง", origin);
check("a chitchat intent returns the AI's own reply directly", chitchatReply === "สวัสดีค่ะ วันนี้เป็นอย่างไรบ้างคะ");

const pendingBeforeUnclear = await getPending(env.ACCOUNTS, lineUserId);
simulateInterpreterResult = { intent: "unclear", reply: "ซื้ออะไรคะ ราคาเท่าไหร่คะ" };
const unclearReply = await handleTextMessage(env, lineUserId, "ซื้อของมา", origin);
check("an unclear intent asks the AI's own clarifying question", unclearReply === "ซื้ออะไรคะ ราคาเท่าไหร่คะ");
const pendingAfterUnclear = await getPending(env.ACCOUNTS, lineUserId);
check(
  // Regression guard: an "unclear" reply must never leave a chatEngine
  // PendingClarification behind — if it did, the *next* message (however
  // unrelated) would get silently swallowed as an answer to a question the
  // AI asked, not chatEngine. Follow-ups instead rely purely on
  // conversation history feeding back into the next interpreter call.
  "an unclear intent does not leave a chatEngine pendingClarification behind",
  pendingBeforeUnclear === null && pendingAfterUnclear === null
);

// calendar_create / diary_create intents route through the exact same
// prompt*FromDraft functions the regex matchers use, so confirm-before-save
// and the confirmation wording are identical either way.
simulateInterpreterResult = {
  intent: "calendar_create",
  calendarTitle: "นัดหาหมอฟัน",
  calendarDateKey: addDaysToDateKey(bangkokDateKey(), 3),
  calendarTime: "10:30",
};
const interpCalendarPromptReply = await handleTextMessage(env, lineUserId, "อีก 3 วันนัดหาหมอฟัน 10 โมงครึ่ง", origin);
check(
  "an AI-interpreted calendar event asks to confirm before creating it",
  interpCalendarPromptReply.includes("นัดหาหมอฟัน") && interpCalendarPromptReply.includes("ใช่ไหม")
);
const interpCalendarConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "confirming the AI-interpreted calendar draft actually creates the event",
  interpCalendarConfirmReply.includes("จดนัดแล้ว") && calendarEvents.some((e) => e.summary === "นัดหาหมอฟัน")
);

const diaryRowsBeforeInterp = diaryRows.length;
simulateInterpreterResult = { intent: "diary_create", diaryText: "วันนี้อารมณ์ดีมาก", diaryCategory: "อารมณ์" };
const interpDiaryPromptReply = await handleTextMessage(env, lineUserId, "วันนี้รู้สึกดีมากเลย", origin);
check("an AI-interpreted diary entry asks to confirm before saving", interpDiaryPromptReply.includes("ใช่ไหม"));
const interpDiaryConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "confirming the AI-interpreted diary draft actually saves it",
  interpDiaryConfirmReply.includes("บันทึกไดอารี่แล้ว") && diaryRows.length === diaryRowsBeforeInterp + 1
);

// "question"/"help" intents route directly to the exact same guarded
// pipelines matchAiCommand/matchCommand already use (answerQuestion,
// buildHelpText) — no separate implementation to keep in sync.
simulateInterpreterResult = { intent: "question", question: "เดือนนี้ใช้เงินไปเท่าไหร่แล้ว" };
const interpQuestionReply = await handleTextMessage(env, lineUserId, "เดือนนี้ใช้เงินไปเยอะไหมนะ", origin);
check(
  "a question intent routes straight to the guarded AI Q&A pipeline",
  interpQuestionReply.includes("[mock AI answer]") && interpQuestionReply.includes("เดือนนี้ใช้เงินไปเท่าไหร่แล้ว")
);

simulateInterpreterResult = { intent: "help" };
const interpHelpReply = await handleTextMessage(env, lineUserId, "ทำอะไรได้บ้างอะ", origin);
check("a help intent returns the same guide link the deterministic path does", interpHelpReply.includes(`${origin}/view/help`));

// Regression test for a real report: "พรุ่งนี้เค้ามีเวรมั้ย"/"พรุ่งนี้ได้ขึ้นเวรมั้ย"
// got misclassified as calendar_query and answered from Google Calendar
// ("ไม่มีนัดพรุ่งนี้เลยนะคะ") instead of the shift-schedule data (PLAN.md
// 17.18) — "เวร" and "นัด" are different data sources, but nothing told the
// interpreter that. Can't make the mocked Gemini call actually classify a
// message correctly, but this confirms the disambiguation instruction that
// fixes it is actually present in every interpreter prompt, and that a
// shift question routed as "question" (the correct outcome) reaches the
// same guarded AI Q&A pipeline as any other question, not the calendar one.
simulateInterpreterResult = { intent: "question", question: "พรุ่งนี้มีเวรมั้ย" };
const interpShiftQuestionReply = await handleTextMessage(env, lineUserId, "พรุ่งนี้เค้ามีเวรมั้ย", origin);
check(
  "a shift question classified as 'question' (not calendar_query) reaches the AI Q&A pipeline",
  interpShiftQuestionReply.includes("[mock AI answer]")
);
// Two Gemini calls happen for this message: the interpreter's own
// classification call, then answerQuestion's separate Q&A call (captured as
// the last one, above) — the disambiguation instruction lives in the
// interpreter's prompt specifically, i.e. the second-to-last capture.
const lastShiftInterpreterRequest = geminiRequests.at(-2);
check(
  "the interpreter prompt explicitly tells the model เวร (shifts) and นัด (Calendar) are different data sources",
  lastShiftInterpreterRequest.systemInstruction.includes("เวร") &&
    lastShiftInterpreterRequest.systemInstruction.includes("ห้ามใช้ calendar_query")
);

// Regression test for a real report: "เปิดเว็บไซต์ให้หน่อย" (natural phrasing,
// not the exact "เปิดเว็บดูข้อมูล" trigger) had no interpreter intent to route
// to at all, so it fell through to chitchat/unclear and the bot wrongly
// claimed it couldn't open a website — a feature that already exists.
simulateInterpreterResult = { intent: "view_link" };
const interpViewLinkReply = await handleTextMessage(env, lineUserId, "เปิดเว็บไซต์ให้หน่อย", origin);
check("a view_link intent replies with the same /view link buildViewLinkReply produces", interpViewLinkReply.includes("/view"));

// Conversation memory: both sides of an exchange are recorded, and the next
// interpreter call actually receives that history in its prompt — this is
// the "จำ context ที่คุยกันทั้งหมด" half of PLAN.md 17.11, not just intent
// classification in isolation.
const historyUserId = "history-test-user";
await setAccountLink(env.ACCOUNTS, historyUserId, {
  spreadsheetId: "sheet-history-test",
  refreshToken: "refresh-history-test",
  displayName: "ประวัติทดสอบ",
});
simulateInterpreterResult = { intent: "chitchat", reply: "จำได้ค่ะ ถามอะไรมาเมื่อกี้นะ" };
await handleTextMessage(env, historyUserId, "ฉันชื่อฟ้า", origin);
const historyAfterFirstTurn = await getConversationHistory(env.ACCOUNTS, historyUserId);
check(
  "both the user's message and the bot's reply are recorded after one exchange",
  historyAfterFirstTurn.length === 2 &&
    historyAfterFirstTurn[0].role === "user" &&
    historyAfterFirstTurn[0].text === "ฉันชื่อฟ้า" &&
    historyAfterFirstTurn[1].role === "bot" &&
    historyAfterFirstTurn[1].text === "จำได้ค่ะ ถามอะไรมาเมื่อกี้นะ"
);
simulateInterpreterResult = { intent: "chitchat", reply: "ค่ะ" };
await handleTextMessage(env, historyUserId, "จำชื่อฉันได้ไหม", origin);
const lastInterpreterRequestForHistory = geminiRequests
  .filter((r) => r.systemInstruction.includes("ระบบตีความข้อความแชท"))
  .at(-1);
check(
  "the next interpreter call's prompt actually includes the prior turn's text",
  lastInterpreterRequestForHistory.systemInstruction.includes("ฉันชื่อฟ้า") &&
    lastInterpreterRequestForHistory.systemInstruction.includes("จำได้ค่ะ ถามอะไรมาเมื่อกี้นะ")
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
  // +1, not +0: the AI interpreter (PLAN.md 17.11) still makes its own call
  // first on every fresh message before any matcher runs; it just doesn't
  // recognize this as an actionable intent (the mock's default response
  // isn't valid JSON), so it falls back to the exact same deterministic
  // matchAiCommand path this test originally exercised, which itself still
  // never calls Gemini for an empty question.
  "asking with no question text gets a usage hint instead of calling Gemini",
  aiNoQuestionReply.includes("ถาม เดือนนี้") && geminiRequests.length === geminiRequestsBeforeNoQuestion + 1
);

const geminiRequestsBeforeAsk = geminiRequests.length;
const aiAskReply = await handleTextMessage(env, lineUserId, "ถาม เดือนนี้ใช้เงินหมวดไหนเยอะสุด", origin);
check(
  "a real question is forwarded to Gemini and its answer is returned as-is",
  aiAskReply.includes("[mock AI answer]") && aiAskReply.includes("เดือนนี้ใช้เงินหมวดไหนเยอะสุด")
);
check(
  // +2: the AI interpreter's own attempt (falls back, non-JSON mock), then
  // the real Q&A call from the legacy matchAiCommand fallback path.
  "exactly two Gemini requests were made for the question (interpreter attempt + the real answer)",
  geminiRequests.length === geminiRequestsBeforeAsk + 2
);
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
check(
  // +2: interpreter attempt, then the real finance-news call — same
  // accounting as the general-question test above.
  "finance news doesn't touch the money/calendar/diary Q&A pipeline",
  geminiRequests.length === geminiRequestsBeforeFinance + 2
);
const lastFinanceGeminiRequest = geminiRequests.at(-1);
check(
  "the finance-news prompt has its own guardrail against stating stale prices as current",
  lastFinanceGeminiRequest.systemInstruction.includes("ห้ามระบุตัวเลขราคา") &&
    !lastFinanceGeminiRequest.systemInstruction.includes("รายรับรวม")
);

// PLAN.md 15.13: the requested format — gold/BTC/top-mover numbers are no
// longer handed to Gemini to restate at all. They're deterministic text
// (marketData.ts's buildMarketHeaderBlock) prepended to the reply, so the
// exact "* ทองคำ : $4,413.6 (+1.23%)"-style lines can never drift under
// paraphrasing — checked directly on the final reply, not the Gemini prompt.
// The % figures are computed from the mocked Yahoo chart meta
// (regularMarketPrice vs. previousClose — PLAN.md 17.16), not asserted as
// magic numbers: gold (4413.6 vs 4360.0) -> +1.23%, BTC (60000 vs 63000)
// -> -4.76%.
check(
  "the finance-news reply leads with a deterministic date + gold/BTC/movers header, never touched by Gemini",
  financeNewsReply.startsWith(`ข้อมูล ณ วันที่ ${formatThaiDateLabelFull(bangkokDateKey())}`) &&
    financeNewsReply.includes("* ทองคำ : $4,413.6 (+1.23%)") &&
    financeNewsReply.includes("* บิตคอยน์ : $60,000 (-4.76%)") &&
    financeNewsReply.includes("* หุ้นสหรัฐฯ เคลื่อนไหวมากที่สุด") &&
    financeNewsReply.includes("AAAA (+18.20%)") &&
    financeNewsReply.includes("CCCC (-16.50%)")
);

// PLAN.md 15.13: today's US economic calendar (Forex Factory) is folded
// into the prompt as labeled ground truth for Gemini to select from — only
// USD, medium/high-impact, and dated today should survive the filter in
// forexCalendar.ts; the mock deliberately includes a non-USD event, a
// low-impact USD event, and a high-impact USD event on a different day, none
// of which should appear.
check(
  "the finance-news prompt includes today's real USD economic-calendar events, filtered correctly",
  lastFinanceGeminiRequest.question.includes("เวลาไทย 19:30 น. Unemployment Claims (ผลกระทบ: Medium)") &&
    !lastFinanceGeminiRequest.question.includes("German Factory Orders") &&
    !lastFinanceGeminiRequest.question.includes("Retail Sales") &&
    !lastFinanceGeminiRequest.question.includes("Fed Chair Speaks")
);

simulateEconomicCalendarFetchFailure = true;
const financeNoCalendarReply = await handleTextMessage(env, lineUserId, "ถาม ข่าวหุ้นวันนี้มีอะไรบ้าง", origin);
const noCalendarRequest = geminiRequests.at(-1);
check(
  "an economic-calendar fetch failure still produces a finance-news answer, labeled as 'couldn't check' not 'no news'",
  financeNoCalendarReply.includes("[mock AI answer]") && noCalendarRequest.question.includes("[CALENDAR_STATUS: UNAVAILABLE]")
);

simulateFinanceNewsFetchFailure = true;
const financeNewsFailureReply = await handleTextMessage(env, lineUserId, "ถาม ราคาบิตคอยน์วันนี้", origin);
check(
  "a finance-news RSS failure degrades to the friendly fallback, not a crash",
  financeNewsFailureReply.includes("ตอบคำถามนี้ไม่สำเร็จ")
);

// Market-data fetches are independent of the RSS fetch and of each other —
// one endpoint failing (here, gold — the first of the four concurrent
// calls in fetchMarketSnapshot, so the first to consume the one-shot flag)
// must not block the headline summary, the other price, or the movers list.
simulateMarketDataFetchFailure = true;
const financePartialFailureReply = await handleTextMessage(env, lineUserId, "ถาม ข่าวหุ้นวันนี้เป็นไง", origin);
check(
  "a partial market-data fetch failure still produces a finance-news answer, just missing that one number",
  financePartialFailureReply.includes("[mock AI answer]") &&
    !financePartialFailureReply.includes("ทองคำ") &&
    financePartialFailureReply.includes("บิตคอยน์")
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
  // +2: interpreter attempt, then the real domestic-news call.
  "domestic news doesn't touch the money/calendar/diary Q&A pipeline",
  geminiRequests.length === geminiRequestsBeforeDomesticNews + 2
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
  domesticNewsFailureReply.includes("ตอบคำถามนี้ไม่สำเร็จ")
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
  aiFailureReply.includes("ตอบคำถามนี้ไม่สำเร็จ")
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

// Regression test for a real bug caught in code review: a *tampered* token
// (above) still decodes as base64 and so failed the signature check
// cleanly, but a token that isn't valid base64 at all — a hand-edited or
// truncated link, an easy thing for a user to produce — made `atob` throw
// inside verifyPayload. Nothing caught it, so instead of the friendly
// "ลิงก์หมดอายุหรือไม่ถูกต้อง" page this exact path already renders for every
// other bad token, the whole request died as a bare 500. Every one of these
// must come back as an ordinary rejection.
for (const malformed of ["abc.!!!!", "abc.AAAAA", "%25%25.%25%25", "a.b", "."]) {
  const malformedResponse = await worker.fetch(
    new Request(`${origin}/view?token=${malformed}`),
    env,
    new FakeExecutionContext()
  );
  check(
    `a malformed view token (${malformed}) is rejected with the friendly page, not a 500`,
    malformedResponse.status === 400 && (await malformedResponse.text()).includes("ลิงก์หมดอายุหรือไม่ถูกต้อง")
  );
}

// Same fix, the other caller of the same helper: /oauth/callback verifies
// its `state` through verifyState, which shared verifyPayload's crash.
const malformedStateResponse = await worker.fetch(
  new Request(`${origin}/oauth/callback?code=abc&state=abc.!!!!`),
  env,
  new FakeExecutionContext()
);
check(
  "a malformed OAuth state is rejected with the friendly page, not a 500",
  malformedStateResponse.status === 400 && (await malformedStateResponse.text()).includes("ลิงก์หมดอายุหรือไม่ถูกต้อง")
);

// The token these pages authenticate with lives in the URL itself, so the
// rendered page must not be cacheable and must not leak that URL onward as
// a Referer.
check(
  "/view pages are served no-store with no referrer, so the tokenised URL doesn't travel",
  viewPageResponse.headers.get("cache-control") === "no-store" &&
    viewPageResponse.headers.get("referrer-policy") === "no-referrer"
);

const unlinkedViewToken = await signViewToken("Uneverlinkeduser", env.STATE_SIGNING_SECRET);
const viewUnlinkedResponse = await worker.fetch(new Request(`${origin}/view?token=${unlinkedViewToken}`), env, new FakeExecutionContext());
check(
  "a view token for an account that never linked shows a friendly prompt to link first",
  viewUnlinkedResponse.status === 400 && (await viewUnlinkedResponse.text()).includes("ยังไม่ได้เชื่อมบัญชี")
);

// ---- Web search (PLAN.md 17.38) -------------------------------------------
// A question the model answers by searching can't be delivered as one chat
// message: Google requires the Search Suggestions that come back with a
// grounded answer be displayed alongside it, and they're HTML. So the chat
// gets a short preview plus a link, and /view/search carries the rest.

simulateGroundedAnswer = true;
const groundedReply = await handleTextMessage(env, lineUserId, "ถาม นายกรัฐมนตรีไทยคนปัจจุบันคือใคร", origin);
const searchPageMatch = groundedReply.match(/https?:\/\/\S+\/view\/search\?token=\S+/);
check("a long grounded answer replies with a link to /view/search", searchPageMatch !== null);
check(
  "the chat gets a lead paragraph, not the whole long answer",
  groundedReply.includes("ตอบจากผลค้นหาจริง") &&
    !groundedReply.includes("รายละเอียดเพิ่มเติมย่อหน้าที่สอง") &&
    groundedReply.length < 700
);

// The common case, and the reason length decides rather than the mere fact
// of a search: most questions want a fact, and making someone tap a link to
// read one line would be a worse product than simply answering.
simulateShortGroundedAnswer = true;
const shortGroundedReply = await handleTextMessage(env, lineUserId, "ถาม นายกรัฐมนตรีคนปัจจุบันคือใคร", origin);
check(
  "a short grounded answer is just the answer, in the chat, with no link at all",
  shortGroundedReply.includes("อนุทิน") && !shortGroundedReply.includes("/view/search")
);
check(
  "nothing was stored for it either — there is no page for anyone to open",
  [...kv.store.keys()].filter((k) => k.startsWith("search-result:")).length === 1
);

const searchPageResponse = await worker.fetch(new Request(searchPageMatch[0]), env, new FakeExecutionContext());
const searchPageHtml = await searchPageResponse.text();
check("the /view/search page opens", searchPageResponse.status === 200);
check(
  "it shows the question and the full answer, both paragraphs",
  searchPageHtml.includes("นายกรัฐมนตรีไทยคนปัจจุบันคือใคร") &&
    searchPageHtml.includes("ตอบจากผลค้นหาจริง") &&
    searchPageHtml.includes("รายละเอียดเพิ่มเติมย่อหน้าที่สอง")
);
check(
  "it lists every source the answer drew on, as real links",
  searchPageHtml.includes('href="https://example.com/a"') && searchPageHtml.includes('href="https://example.com/b"')
);
// The compliance requirement this whole two-surface design exists for:
// Google's Search Suggestions widget arrives as HTML+CSS and has to be
// rendered as markup, not printed as text.
check(
  "Google's Search Suggestions widget is rendered as live markup, not escaped into text",
  searchPageHtml.includes('<div class="gsc">ค้นหาต่อ</div>') && !searchPageHtml.includes("&lt;div class=&quot;gsc&quot;")
);
// ...while everything the model produced is still escaped, including a
// source title containing angle brackets.
check(
  "a source title containing markup is still escaped",
  searchPageHtml.includes("แหล่งข่าว &lt;ข&gt;") && !searchPageHtml.includes("แหล่งข่าว <ข>")
);

// A stored result belongs to the account that produced it: the id is only
// meaningful when paired with that account's own token.
const otherSubjectToken = await signViewToken("Usomeoneelse", env.STATE_SIGNING_SECRET);
const storedId = new URL(searchPageMatch[0]).searchParams.get("id");
const foreignSearchResponse = await worker.fetch(
  new Request(`${origin}/view/search?token=${otherSubjectToken}&id=${storedId}`),
  env,
  new FakeExecutionContext()
);
check(
  "another account's token cannot read this search result, even with the exact id",
  foreignSearchResponse.status === 404
);

const missingSearchResponse = await worker.fetch(
  new Request(`${origin}/view/search?token=${viewToken}&id=does-not-exist`),
  env,
  new FakeExecutionContext()
);
check(
  "an expired or unknown result id shows a friendly page explaining it, not a crash",
  missingSearchResponse.status === 404 && (await missingSearchResponse.text()).includes("หมดอายุ")
);

// When a long answer can't be stored there is no page to link to, so it
// goes to the chat in full — the same place a short answer would have gone
// anyway. Losing an answer over a KV hiccup would be the worse outcome.
simulateGroundedAnswer = true;
simulateSearchResultPutFailureOnce = true;
const unstorableReply = await handleTextMessage(env, lineUserId, "ถาม นายกรัฐมนตรีไทยคนปัจจุบันคือใคร", origin);
check(
  "if a long answer can't be stored, it is sent inline rather than lost",
  unstorableReply.includes("ตอบจากผลค้นหาจริง") &&
    unstorableReply.includes("รายละเอียดเพิ่มเติมย่อหน้าที่สอง") &&
    !unstorableReply.includes("/view/search")
);

// The ordinary case must be untouched: a question the model answers from the
// account's own rows never searched, so there is nothing Google requires be
// displayed and no reason to make the user tap through to a page.
const ungroundedReply = await handleTextMessage(env, lineUserId, "ถาม เดือนนี้ใช้เงินหมวดไหนเยอะสุด", origin);
check(
  "a question answered from the user's own data still replies in full in the chat, with no link",
  ungroundedReply.includes("[mock AI answer]") && !ungroundedReply.includes("/view/search")
);

// Regression test for a real production failure. Offering the search tool
// put it on *every* question, so when Gemini refused the tool-bearing
// request the entire Q&A feature went dark — questions about the account's
// own rows, which had worked for months and never needed a search, started
// failing alongside the web ones. A rejected tool must cost the search, not
// the answer.
simulateGroundingRejected = true;
const toolRejectedReply = await handleTextMessage(env, lineUserId, "ถาม เดือนนี้ใช้เงินหมวดไหนเยอะสุด", origin);
check(
  "if Gemini refuses the search tool, the question is still answered without it",
  toolRejectedReply.includes("[mock AI answer]") && !toolRejectedReply.includes("ตอบคำถามนี้ไม่สำเร็จ")
);
const retryRequest = lastRequestWhere((r) => r.systemInstruction.includes("ช่วยตอบคำถามเกี่ยวกับการเงิน"));
check(
  "the retry sends no tool, and drops the search rules from the prompt with it",
  retryRequest?.hasGoogleSearchTool === false && !retryRequest.systemInstruction.includes("ให้ใช้ Google Search")
);
check(
  "the retry also drops back to Lite — the full model was only for the search tool",
  retryRequest?.model === "gemini-3.5-flash-lite"
);
// The diagnostic that lived here did its job — the real error turned out to
// be a 429 with no quota attached, meaning grounding isn't on this tier at
// all (PLAN.md 17.42) — and came back out with it. What has to keep holding
// is that a rejected tool never leaks an API error into a user's chat.
check(
  "a refused search tool leaves no API error in the reply",
  !toolRejectedReply.includes("[debug]") && !toolRejectedReply.includes("Gemini API error")
);

// The switch itself (PLAN.md 17.42). Off is the production state, and off
// has to mean "never even attempt it" — before the flag, every question paid
// for a grounded call that was certain to fail before falling back.
const geminiRequestsBeforeSwitchOff = geminiRequests.length;
env.ENABLE_WEB_SEARCH = undefined;
const switchedOffReply = await handleTextMessage(env, lineUserId, "ถาม เดือนนี้ใช้เงินหมวดไหนเยอะสุด", origin);
const requestsWhileOff = geminiRequests.slice(geminiRequestsBeforeSwitchOff);
env.ENABLE_WEB_SEARCH = "true";
check(
  "with the switch off the question is still answered, from the account's own data",
  switchedOffReply.includes("[mock AI answer]") && !switchedOffReply.includes("/view/search")
);
check(
  "and no request offers the search tool at all — not even one that gets rejected",
  requestsWhileOff.length > 0 && requestsWhileOff.every((r) => r.hasGoogleSearchTool === false)
);
check(
  "the guide drops the web-search line when the switch is off, so it can't promise what's disabled",
  buildHelpText(false).includes("ถาม <คำถาม>") && !buildHelpText(false).includes("บอทไปค้น Google")
);
check(
  "the retry still carries the account's own data, and the pre-search rule about missing data",
  retryRequest.systemInstruction.includes("ตัวเลขที่คำนวณไว้แล้วสำหรับเดือน") &&
    retryRequest.systemInstruction.includes("ให้บอกตรงๆ ว่าไม่มีข้อมูลพอจะตอบ")
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

// Regression test for a real off-by-one: listCalendarEvents' timeMax is
// exclusive, so an event landing exactly on the page's stated boundary
// (60 days ahead) used to fall just outside the fetched window despite
// the page claiming to cover it.
const sixtyDaysOutIso = bangkokStartOfDayIso(addDaysToDateKey(bangkokDateKey(), 60));
calendarEvents.push({
  id: "evt-view-boundary-test",
  summary: "นัดขอบเขตหกสิบวัน",
  start: { dateTime: sixtyDaysOutIso },
  end: { dateTime: sixtyDaysOutIso },
});
const calendarBoundaryResponse = await worker.fetch(new Request(`${origin}/view/calendar?token=${viewToken}`), env, new FakeExecutionContext());
check(
  "an event exactly 60 days out is included, matching the page's stated range",
  calendarBoundaryResponse.status === 200 && (await calendarBoundaryResponse.text()).includes("นัดขอบเขตหกสิบวัน")
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

// Regression test: a malformed ?month= (not YYYY-MM) used to flow straight
// into shiftMonthKey's Number() parsing and produce permanently-broken
// "NaN-NaN" prev/next links instead of falling back to the current month.
const diaryMalformedMonthResponse = await worker.fetch(new Request(`${origin}/view/diary?token=${viewToken}&month=not-a-month`), env, new FakeExecutionContext());
const diaryMalformedMonthHtml = await diaryMalformedMonthResponse.text();
check(
  "a malformed ?month= falls back to the current month instead of producing NaN-NaN navigation links",
  diaryMalformedMonthResponse.status === 200 && !diaryMalformedMonthHtml.includes("NaN")
);

// Search box (?q=) on /view/diary: searches every month at once, same
// substring match as the "ค้นหาไดอารี่ <คำ>" chat command, not just whatever
// month happens to be showing.
diaryRows.push(["diary-view-search-1", "2020-03-15", "ทั่วไป", "หาโน้ตเรื่องแมวส้มตัวนี้", new Date().toISOString()]);
const diarySearchResponse = await worker.fetch(new Request(`${origin}/view/diary?token=${viewToken}&q=${encodeURIComponent("แมวส้ม")}`), env, new FakeExecutionContext());
const diarySearchHtml = await diarySearchResponse.text();
check(
  "/view/diary?q= finds an entry from a month far outside the currently-viewed one",
  diarySearchResponse.status === 200 && diarySearchHtml.includes("แมวส้ม") && diarySearchHtml.includes("2020-03-15")
);
const diarySearchNoMatchResponse = await worker.fetch(new Request(`${origin}/view/diary?token=${viewToken}&q=${encodeURIComponent("ไม่มีทางเจอคำนี้แน่นอน")}`), env, new FakeExecutionContext());
check(
  "/view/diary?q= with no matches shows an empty-results state, not an error",
  diarySearchNoMatchResponse.status === 200 && (await diarySearchNoMatchResponse.text()).includes("ไม่พบบันทึก")
);
const diarySearchXssResponse = await worker.fetch(new Request(`${origin}/view/diary?token=${viewToken}&q=${encodeURIComponent('<script>alert(1)</script>')}`), env, new FakeExecutionContext());
const diarySearchXssHtml = await diarySearchXssResponse.text();
check(
  "the search query itself is HTML-escaped when echoed back into the page (reflected in both the input value and the results heading)",
  diarySearchXssResponse.status === 200 &&
    !diarySearchXssHtml.includes("<script>alert(1)</script>") &&
    diarySearchXssHtml.includes("&lt;script&gt;alert(1)&lt;/script&gt;")
);

// /view/diary is write-capable now (PLAN.md 17.36) — edit/delete moved
// here from being a documented chat gap, reusing "diary-view-test-1" (this
// month) and "diary-view-search-1" (2020-03-15) already pushed above.
check(
  "each entry in the month view is rendered as its own editable form, with the escaped text inside a textarea (not just a static div)",
  diaryViewHtml.includes('name="id" value="diary-view-test-1"') &&
    diaryViewHtml.includes(">&lt;b&gt;ทดสอบ&lt;/b&gt; วันนี้อากาศดี</textarea>") &&
    diaryViewHtml.includes(`confirmDelete=diary-view-test-1`)
);

const diaryRowsBeforeEdit = diaryRows.length;
// Snapshot of every OTHER row — an off-by-one in updateDiaryEntry's row
// arithmetic wouldn't show up in the row-count or find()-based checks
// below (it corrupts a *neighboring* row with a duplicate id, and find()
// happily returns the corrupted clone first), so this is the assertion
// that actually pins the write to the right row. Proven necessary: the
// first version of these tests passed with rowIndex+1 instead of +2.
const diaryOtherRowsSnapshot = JSON.stringify(diaryRows.filter((r) => r[0] !== "diary-view-test-1"));
const diaryUpdateResponse = await worker.fetch(
  new Request(`${origin}/view/diary?token=${viewToken}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      op: "update",
      id: "diary-view-test-1",
      date: bangkokDateKey(),
      category: "สุขภาพ",
      text: "แก้ไขข้อความแล้วนะ",
    }).toString(),
  }),
  env,
  new FakeExecutionContext()
);
const diaryUpdateHtml = await diaryUpdateResponse.text();
check(
  "editing an entry saves in place (same row count) and shows a save notice with the new text",
  diaryUpdateResponse.status === 200 &&
    diaryUpdateHtml.includes("บันทึกการแก้ไขแล้ว") &&
    diaryUpdateHtml.includes("แก้ไขข้อความแล้วนะ") &&
    diaryRows.length === diaryRowsBeforeEdit
);
check(
  "the underlying row was actually overwritten, not appended as a new one",
  diaryRows.filter((r) => r[0] === "diary-view-test-1").length === 1 &&
    diaryRows.find((r) => r[0] === "diary-view-test-1")[2] === "สุขภาพ" &&
    diaryRows.find((r) => r[0] === "diary-view-test-1")[3] === "แก้ไขข้อความแล้วนะ"
);
check(
  "every other diary row is untouched by the edit (no neighboring-row corruption from a row-offset bug)",
  JSON.stringify(diaryRows.filter((r) => r[0] !== "diary-view-test-1")) === diaryOtherRowsSnapshot
);

const confirmDeleteResponse = await worker.fetch(
  new Request(`${origin}/view/diary?token=${viewToken}&confirmDelete=diary-view-search-1`),
  env,
  new FakeExecutionContext()
);
const confirmDeleteHtml = await confirmDeleteResponse.text();
check(
  "visiting the delete-confirm link shows the entry's own text and asks to confirm, without deleting it yet",
  confirmDeleteResponse.status === 200 &&
    confirmDeleteHtml.includes("หาโน้ตเรื่องแมวส้มตัวนี้") &&
    confirmDeleteHtml.includes("ยืนยันลบ") &&
    diaryRows.some((r) => r[0] === "diary-view-search-1")
);

const diaryDeleteResponse = await worker.fetch(
  new Request(`${origin}/view/diary?token=${viewToken}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ op: "delete", id: "diary-view-search-1" }).toString(),
  }),
  env,
  new FakeExecutionContext()
);
const diaryDeleteHtml = await diaryDeleteResponse.text();
check(
  "confirming the delete actually removes the row and shows a deleted notice",
  diaryDeleteResponse.status === 200 &&
    diaryDeleteHtml.includes("ลบบันทึกแล้ว") &&
    !diaryRows.some((r) => r[0] === "diary-view-search-1")
);

const diaryEditMissingIdResponse = await worker.fetch(
  new Request(`${origin}/view/diary?token=${viewToken}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ op: "update", id: "does-not-exist", date: bangkokDateKey(), category: "x", text: "y" }).toString(),
  }),
  env,
  new FakeExecutionContext()
);
const diaryEditMissingIdHtml = await diaryEditMissingIdResponse.text();
check(
  "editing an id that no longer exists says so honestly instead of showing a false success notice (code-review fix)",
  diaryEditMissingIdResponse.status === 200 &&
    diaryEditMissingIdHtml.includes("ไม่พบบันทึกนี้แล้ว") &&
    !diaryEditMissingIdHtml.includes("บันทึกการแก้ไขแล้ว")
);

// Code-review fixes (post-17.36 review pass), each with its own regression
// test: (1) an empty-textarea save must not silently wipe an entry's text,
// (2) an invalid date must be rejected, never silently rewritten or
// written verbatim, (3) a blank (cells-cleared) sheet row above the target
// must not skew the edit/delete onto a neighboring row.

diaryRows.push(["diary-review-fix-1", bangkokDateKey(), "ทั่วไป", "ข้อความเดิมห้ามหาย", new Date().toISOString()]);

const diaryEmptyTextResponse = await worker.fetch(
  new Request(`${origin}/view/diary?token=${viewToken}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ op: "update", id: "diary-review-fix-1", date: bangkokDateKey(), category: "ทั่วไป", text: "   " }).toString(),
  }),
  env,
  new FakeExecutionContext()
);
const diaryEmptyTextHtml = await diaryEmptyTextResponse.text();
check(
  "an empty-textarea save is rejected with a pointer to the delete button, and the stored text is untouched",
  diaryEmptyTextResponse.status === 200 &&
    diaryEmptyTextHtml.includes("ข้อความว่างเปล่า") &&
    !diaryEmptyTextHtml.includes("บันทึกการแก้ไขแล้ว") &&
    diaryRows.find((r) => r[0] === "diary-review-fix-1")[3] === "ข้อความเดิมห้ามหาย"
);

const diaryBadDateResponse = await worker.fetch(
  new Request(`${origin}/view/diary?token=${viewToken}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ op: "update", id: "diary-review-fix-1", date: "15/08/2026", category: "ทั่วไป", text: "ใหม่" }).toString(),
  }),
  env,
  new FakeExecutionContext()
);
check(
  "a wrong-format date (e.g. a browser without <input type=date>) is rejected, not silently rewritten to the 1st of the month",
  diaryBadDateResponse.status === 200 &&
    (await diaryBadDateResponse.text()).includes("วันที่ไม่ถูกต้อง") &&
    diaryRows.find((r) => r[0] === "diary-review-fix-1")[3] === "ข้อความเดิมห้ามหาย"
);

const diaryFakeDateResponse = await worker.fetch(
  new Request(`${origin}/view/diary?token=${viewToken}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ op: "update", id: "diary-review-fix-1", date: "2026-99-99", category: "ทั่วไป", text: "ใหม่" }).toString(),
  }),
  env,
  new FakeExecutionContext()
);
check(
  "a pattern-shaped but non-calendar date (2026-99-99) is rejected too, so no entry can be orphaned from every month view",
  diaryFakeDateResponse.status === 200 &&
    (await diaryFakeDateResponse.text()).includes("วันที่ไม่ถูกต้อง") &&
    diaryRows.find((r) => r[0] === "diary-review-fix-1")[1] === bangkokDateKey()
);

// Blank-row skew: a row whose cells were cleared by hand in Google Sheets
// comes back from the values API as [], which readAllDiaryEntries filters
// out — the edit/delete row arithmetic must come from the RAW response, or
// everything below the blank is off by one physical row.
diaryRows.length = 0;
diaryRows.push(["diary-blank-above-1", bangkokDateKey(), "ทั่วไป", "แถวบน", new Date().toISOString()]);
diaryRows.push([]); // the hand-cleared blank row
diaryRows.push(["diary-blank-below-1", bangkokDateKey(), "ทั่วไป", "แถวล่างที่จะแก้", new Date().toISOString()]);

const diaryBlankRowEditResponse = await worker.fetch(
  new Request(`${origin}/view/diary?token=${viewToken}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      op: "update",
      id: "diary-blank-below-1",
      date: bangkokDateKey(),
      category: "ทั่วไป",
      text: "แก้แล้วถูกแถว",
    }).toString(),
  }),
  env,
  new FakeExecutionContext()
);
check(
  "editing an entry below a hand-cleared blank sheet row lands on the right physical row (code-review fix)",
  diaryBlankRowEditResponse.status === 200 &&
    diaryRows[2][0] === "diary-blank-below-1" &&
    diaryRows[2][3] === "แก้แล้วถูกแถว" &&
    diaryRows[0][3] === "แถวบน" && // the neighbor above the blank is untouched
    diaryRows[1].length === 0 // the blank row itself is untouched
);

const diaryBlankRowDeleteResponse = await worker.fetch(
  new Request(`${origin}/view/diary?token=${viewToken}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ op: "delete", id: "diary-blank-below-1" }).toString(),
  }),
  env,
  new FakeExecutionContext()
);
check(
  "deleting an entry below a blank sheet row removes the right physical row, not a neighbor",
  diaryBlankRowDeleteResponse.status === 200 &&
    diaryRows.length === 2 &&
    diaryRows[0][0] === "diary-blank-above-1" &&
    diaryRows[1].length === 0
);
diaryRows.length = 0; // clean up — nothing after this reads diaryRows

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
check(
  "each photo in the grid is captioned with its upload date",
  tripPhotosHtml.includes("grid-caption") && tripPhotosHtml.includes(formatThaiDateLabel(bangkokDateKey()))
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

// Regression test: decodeURIComponent throws on malformed percent-encoding
// instead of returning anything — it used to be called outside the
// surrounding try/catch, so a mangled link crashed the whole request
// instead of showing the usual friendly 404 page.
const malformedFolderIdResponse = await worker.fetch(new Request(`${origin}/view/trips/%?token=${viewToken}`), env, new FakeExecutionContext());
check(
  "a malformed percent-encoded trip folder id shows a friendly not-found page instead of crashing",
  malformedFolderIdResponse.status === 404
);
const malformedPhotoIdResponse = await worker.fetch(new Request(`${origin}/view/photo/%?token=${viewToken}`), env, new FakeExecutionContext());
check(
  "a malformed percent-encoded photo id shows a friendly not-found page instead of crashing",
  malformedPhotoIdResponse.status === 404
);

// Regression test: folderId used to be interpolated straight into the
// Drive search query without escaping, unlike every folder *name* lookup
// elsewhere in drive.ts — a folder id containing a quote could break out
// of the `'...' in parents` clause. Doesn't exist as a real folder either
// way, so this just confirms the request degrades to a normal 404
// instead of a raw Drive API error surfacing the broken query.
const quoteFolderIdResponse = await worker.fetch(
  new Request(`${origin}/view/trips/${encodeURIComponent("o' or '1'='1")}?token=${viewToken}`),
  env,
  new FakeExecutionContext()
);
check("a trip folder id containing a quote is handled safely, not as a broken query", quoteFolderIdResponse.status === 404);

// Regression test: getFileName used to swallow every failure (401/403/5xx,
// not just "doesn't exist") into null, so a transient Drive error on a
// real, valid trip folder was reported as "trip not found" instead of
// "try again" — same distinction fetchDriveFileContent already made.
simulateFolderNameFetchFailure = true;
const folderNameFailureResponse = await worker.fetch(new Request(`${origin}/view/trips/${tripFolderId}?token=${viewToken}`), env, new FakeExecutionContext());
check(
  "a transient failure looking up a real trip folder's name degrades to 'try again', not 'not found'",
  folderNameFailureResponse.status === 502
);

// Shift schedule (PLAN.md 17.18) — the one /view/* page that writes, plus
// its wiring into the "ถาม" AI Q&A pipeline. Personal-mode only, using the
// same viewToken as every other page above.
const shiftsMonthKey = bangkokMonthKey();
const shiftsPageResponse = await worker.fetch(new Request(`${origin}/view/shifts?token=${viewToken}`), env, new FakeExecutionContext());
const shiftsPageHtml = await shiftsPageResponse.text();
check(
  "/view/shifts renders an empty grid for a month with no shifts ticked yet",
  shiftsPageResponse.status === 200 && shiftsPageHtml.includes("ตารางเวรของฉัน") && shiftsPageHtml.includes("เวรเช้า")
);

const shiftsSaveResponse = await worker.fetch(
  new Request(`${origin}/view/shifts?token=${viewToken}&month=${shiftsMonthKey}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `cell=${encodeURIComponent("3|เวรเช้า")}`,
  }),
  env,
  new FakeExecutionContext()
);
const shiftsSaveHtml = await shiftsSaveResponse.text();
check(
  "POSTing a checked cell saves it and shows a save confirmation",
  shiftsSaveResponse.status === 200 && shiftsSaveHtml.includes("บันทึกตารางเวรแล้ว")
);

const shiftsAfterSaveResponse = await worker.fetch(new Request(`${origin}/view/shifts?token=${viewToken}&month=${shiftsMonthKey}`), env, new FakeExecutionContext());
const shiftsAfterSaveHtml = await shiftsAfterSaveResponse.text();
check(
  "the checked cell from the POST persists on the next GET",
  shiftsAfterSaveResponse.status === 200 && /name="cell" value="3\|[^"]*"\s+checked/.test(shiftsAfterSaveHtml)
);

const shiftsMalformedMonthResponse = await worker.fetch(new Request(`${origin}/view/shifts?token=${viewToken}&month=not-a-month`), env, new FakeExecutionContext());
check(
  "a malformed ?month= on /view/shifts falls back to the current month instead of producing NaN-NaN navigation links",
  shiftsMalformedMonthResponse.status === 200 && !(await shiftsMalformedMonthResponse.text()).includes("NaN")
);

const shiftsAiReply = await handleTextMessage(env, lineUserId, "ถาม ใครอยู่เวรเช้าวันไหนบ้างเดือนนี้", origin);
check("\"ถาม\" about shifts reaches Gemini, not a canned reply", shiftsAiReply.includes("[mock AI answer]"));
const lastShiftsGeminiRequest = geminiRequests.at(-1);
check(
  "the AI prompt includes the ticked shift-schedule data the web page just saved",
  lastShiftsGeminiRequest.systemInstruction.includes("ตารางเวร") &&
    lastShiftsGeminiRequest.systemInstruction.includes("3: เวรเช้า")
);

// /view/tasks (PLAN.md 17.36) — read-only, reuses listIncompleteTasks the
// same way /view/calendar reuses listCalendarEvents. googleTasks may
// already hold leftover incomplete tasks from earlier chat-command tests
// in this same run (never reset between sections, unlike diaryRows/
// calendarEvents) — these assertions only check for the two tasks pushed
// here, not an exact total count, so that's fine.
const tasksViewDueTaskId = "task-view-test-1";
googleTasks.push({
  id: tasksViewDueTaskId,
  title: "ส่งรายงานทีม",
  status: "needsAction",
  due: new Date(`${bangkokDateKey()}T15:30:00+07:00`).toISOString(),
});
const tasksViewUndatedTaskId = "task-view-test-2";
googleTasks.push({ id: tasksViewUndatedTaskId, title: "จัดตู้เย็น", status: "needsAction" });
// Created AFTER the 15:30 task but due EARLIER the same day — the Tasks
// API returns manual position order, so without an explicit within-day
// sort this would render 15:30 before 09:00 (code-review fix).
const tasksViewEarlierTaskId = "task-view-test-3";
googleTasks.push({
  id: tasksViewEarlierTaskId,
  title: "ประชุมเช้า",
  status: "needsAction",
  due: new Date(`${bangkokDateKey()}T09:00:00+07:00`).toISOString(),
});

const tasksViewResponse = await worker.fetch(new Request(`${origin}/view/tasks?token=${viewToken}`), env, new FakeExecutionContext());
const tasksViewHtml = await tasksViewResponse.text();
check(
  "/view/tasks shows a task with a due date/time under that date's heading",
  tasksViewResponse.status === 200 && tasksViewHtml.includes("ส่งรายงานทีม") && tasksViewHtml.includes("15:30")
);
check(
  "a task with no due date at all shows up under its own \"ไม่มีกำหนด\" section, not dropped",
  tasksViewHtml.includes("จัดตู้เย็น") && tasksViewHtml.includes("ไม่มีกำหนด")
);
check(
  "within one day, tasks render earliest due time first regardless of creation order",
  tasksViewHtml.indexOf("ประชุมเช้า") !== -1 && tasksViewHtml.indexOf("ประชุมเช้า") < tasksViewHtml.indexOf("ส่งรายงานทีม")
);

simulateInsufficientTasksScope = true;
const tasksViewScopeResponse = await worker.fetch(new Request(`${origin}/view/tasks?token=${viewToken}`), env, new FakeExecutionContext());
check(
  "/view/tasks degrades to a friendly re-link message on insufficient scope instead of a raw error",
  tasksViewScopeResponse.status === 400 && (await tasksViewScopeResponse.text()).includes("เชื่อมใหม่")
);
simulateInsufficientTasksScope = false;

simulateTasksApiDisabled = true;
const tasksViewApiDisabledResponse = await worker.fetch(new Request(`${origin}/view/tasks?token=${viewToken}`), env, new FakeExecutionContext());
check(
  "/view/tasks degrades gracefully when the Tasks API itself is disabled too",
  tasksViewApiDisabledResponse.status === 400 && (await tasksViewApiDisabledResponse.text()).includes("Google Tasks API")
);
simulateTasksApiDisabled = false;

for (const cleanupId of [tasksViewDueTaskId, tasksViewUndatedTaskId, tasksViewEarlierTaskId]) {
  const idx = googleTasks.findIndex((t) => t.id === cleanupId);
  if (idx >= 0) googleTasks.splice(idx, 1);
}

// Group mode (PLAN.md 17) — a shared account bound to a LINE groupId
// instead of an individual's userId, gated on the bot being @-mentioned.
const groupId = "Cgrouptest1";
const groupSenderA = "Ugroupsender-a";
const groupSenderB = "Ugroupsender-b";

// 1. An unlinked group gets a link whose signed state decodes to
// "group:<groupId>", not any individual's LINE userId — same round-trip
// regression check as the personal-linking test near the top of this file.
const groupUnlinkedReply = await handleGroupTextMessage(env, groupId, groupSenderA, "ซื้อกาแฟ 60", origin);
check("an unlinked group is told to link, with a Google OAuth URL", groupUnlinkedReply.includes("accounts.google.com/o/oauth2/v2/auth"));
const groupAuthorizeUrl = groupUnlinkedReply.split("\n").pop();
const groupState = new URL(groupAuthorizeUrl).searchParams.get("state");
check(
  "the group's state param round-trips to \"group:<groupId>\", not a personal LINE userId",
  (await verifyState(groupState, env.STATE_SIGNING_SECRET)) === `group:${groupId}`
);

// 2. Link the group (simulating a completed OAuth flow, same pattern used
// for the personal account near the top of this file).
await setAccountLink(kv, `group:${groupId}`, {
  spreadsheetId: "fake-group-sheet-id",
  refreshToken: "fake-group-refresh-token",
  displayName: "สมุดกลุ่ม",
});

// 3. Money logging, attributed to whoever actually sent it (unlike
// personal mode, where attribution is always just "LINE" — meaningless in
// a 1:1 chat, but genuinely informative once several people share one
// account).
groupMemberDisplayNames[groupSenderA] = "สมชาย";
const groupSheetRowsBeforeLog = sheetRows.length;
const groupLogPromptReply = await handleGroupTextMessage(env, groupId, groupSenderA, "ซื้อกาแฟ 60", origin);
check(
  "a clear expense asks to confirm in group mode too, same as personal mode, doesn't save immediately",
  groupLogPromptReply.includes("ใช่ไหม") && sheetRows.length === groupSheetRowsBeforeLog
);
const groupLogReply = await handleGroupTextMessage(env, groupId, groupSenderA, "ใช่", origin);
check("confirming logs the expense in group mode", groupLogReply.includes("60"));
check("exactly one row was appended to the group's own spreadsheet", sheetRows.length === groupSheetRowsBeforeLog + 1);
const loggedGroupRow = sheetRows.at(-1);
check(
  "the logged row is attributed to the actual sender, not a generic group label",
  loggedGroupRow[7] === groupSenderA && loggedGroupRow[8] === "สมชาย"
);

// 4. A pending clarification is shared by the whole group — sender A asks
// the question, sender B (a different person) answers it, and it still
// resolves, matching how a question posed to a group chat naturally works
// (unlike personal mode, where only one person could ever be replying).
// Attribution is fixed to whoever actually completed the draft (sender B,
// who answered the amount) at the moment the confirmation prompt is built —
// not whoever happens to confirm it afterward, which anyone in the group
// can do (checked below via groupSenderA confirming sender B's draft).
const groupSheetRowsBeforeShared = sheetRows.length;
// "ซื้อกาแฟ" (no amount) rather than something like "ซื้อของ" — "กาแฟ" alone
// already resolves to a specific category (same convention used throughout
// this file), so answering just the amount below completes the entry in
// one round instead of also needing a category clarification round.
const groupAskReply = await handleGroupTextMessage(env, groupId, groupSenderA, "ซื้อกาแฟ", origin);
check("an ambiguous message still asks a clarifying question in group mode", groupAskReply.includes("จำนวนเงินเท่าไหร่"));
groupMemberDisplayNames[groupSenderB] = "สมหญิง";
const groupAnswerPromptReply = await handleGroupTextMessage(env, groupId, groupSenderB, "80", origin);
check(
  "a different group member answering the pending question resolves it into a confirmation prompt, not an immediate save",
  groupAnswerPromptReply.includes("80") && groupAnswerPromptReply.includes("ใช่ไหม") && sheetRows.length === groupSheetRowsBeforeShared
);
const groupAnswerReply = await handleGroupTextMessage(env, groupId, groupSenderA, "ใช่", origin);
check(
  "any group member (not just whoever completed the draft) can confirm it, saving the entry",
  groupAnswerReply.includes("80") && sheetRows.length === groupSheetRowsBeforeShared + 1
);
check("the resolved entry is attributed to whoever actually answered the clarification, not whoever confirmed it", sheetRows.at(-1)[7] === groupSenderB);

// 5. Attribution degrades gracefully when LINE didn't include a sender
// userId at all (see LineEventSource's comment in line.ts for when that
// happens) — never blocks the save over what's a cosmetic detail.
const groupNoSenderPromptReply = await handleGroupTextMessage(env, groupId, undefined, "ข้าว 30", origin);
check(
  "a message with no sender userId still prompts to confirm",
  groupNoSenderPromptReply.includes("30") && groupNoSenderPromptReply.includes("ใช่ไหม")
);
const groupNoSenderReply = await handleGroupTextMessage(env, groupId, undefined, "ใช่", origin);
check(
  "a message with no sender userId still logs, with a generic attribution label",
  groupNoSenderReply.includes("30") && sheetRows.at(-1)[7] === "unknown" && sheetRows.at(-1)[8] === "สมาชิกกลุ่ม"
);

// simulateGroupMemberProfileFailure must fail the lookup that happens while
// building the confirmation *prompt* (attribution is resolved and baked in
// then, not at confirm time) — set right before the prompt call, not the
// confirm call.
simulateGroupMemberProfileFailure = true;
const groupProfileFailurePromptReply = await handleGroupTextMessage(env, groupId, groupSenderA, "น้ำ 20", origin);
check("still asks to confirm even when the profile lookup for attribution fails", groupProfileFailurePromptReply.includes("ใช่ไหม"));
const groupProfileFailureReply = await handleGroupTextMessage(env, groupId, groupSenderA, "ใช่", origin);
check(
  "a failed member-profile lookup still logs the transaction, with the generic label",
  groupProfileFailureReply.includes("20") && sheetRows.at(-1)[8] === "สมาชิกกลุ่ม"
);

// 6. The read-only report shortcuts and "ลบรายการล่าสุด" both work in
// group mode too (pure reads / a single well-tested command, unlike the
// AI/calendar/diary/trip commands this first pass deliberately holds back).
const groupSummaryReply = await handleGroupTextMessage(env, groupId, groupSenderA, "สรุปเดือนนี้", origin);
check("\"สรุปเดือนนี้\" works in group mode", groupSummaryReply.includes("รายรับ"));
const groupSheetRowsBeforeDelete = sheetRows.length;
const groupDeletePromptReply = await handleGroupTextMessage(env, groupId, groupSenderA, "ลบรายการล่าสุด", origin);
check("\"ลบรายการล่าสุด\" asks to confirm in group mode", groupDeletePromptReply.includes("ใช่"));
const groupDeleteConfirmReply = await handleGroupTextMessage(env, groupId, groupSenderB, "ใช่", origin);
check(
  "any group member can confirm the shared pending deletion, same as the money-amount clarification above",
  groupDeleteConfirmReply.includes("ลบ") && sheetRows.length === groupSheetRowsBeforeDelete - 1
);

// The shared help text ("วิธีใช้") advertises the web viewer in both modes
// now that it actually works in both (PLAN.md 17.7 second pass) — a fix
// to a real bug an earlier version of this help text had (see the group
// view-link regression test block further below for the full story).
// The guide itself moved to /view/help (PLAN.md 17.39), so what both modes
// must now produce is that link — and the guide behind it still advertises
// the web viewer, which is the thing this pair was written to protect.
const personalHelpReply = await handleTextMessage(env, lineUserId, "วิธีใช้", origin);
check("personal mode's help command hands over the guide link", personalHelpReply.includes(`${origin}/view/help`));
const groupHelpReply = await handleGroupTextMessage(env, groupId, groupSenderA, "วิธีใช้", origin);
check("group mode's help command hands over the same guide link", groupHelpReply.includes(`${origin}/view/help`));
check("the guide it links to still advertises the web viewer, which works in both modes", buildHelpText(true).includes("เปิดเว็บดูข้อมูล"));

// ---- Budgets (PLAN.md 17.43) ----------------------------------------------
// readBudgets and the over-budget warning have been here since the start;
// nothing could ever write one, so "งบเหลือเท่าไหร่" answered "ยังไม่ได้ตั้งงบ"
// forever unless the separate React PWA happened to be pointed at the very
// same spreadsheet. These cover the write side, from both surfaces.

budgetRows.length = 0;
const budgetMonth = bangkokMonthKey();

const noBudgetReply = await handleTextMessage(env, lineUserId, "ดูงบ", origin);
check("with nothing set, ดูงบ explains how to set one instead of showing an empty list",
  noBudgetReply.includes("ยังไม่ได้ตั้งงบ") && noBudgetReply.includes("ตั้งงบ"));

const budgetPromptReply = await handleTextMessage(env, lineUserId, "ตั้งงบ อาหาร 5000", origin);
check(
  "ตั้งงบ asks to confirm before writing, like every other chat write",
  budgetPromptReply.includes("5,000") && budgetPromptReply.includes('"ใช่"') && budgetRows.length === 0
);
const budgetConfirmReply = await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "confirming writes the budget to the account's own book",
  budgetConfirmReply.includes("ตั้งงบ") &&
    budgetRows.length === 1 &&
    budgetRows[0][2] === budgetMonth &&
    Number(budgetRows[0][3]) === 5000
);

// One row per category+month. Setting the same one again has to replace the
// figure, not stack a second row that readBudgets would then report twice.
const budgetChangeReply = await handleTextMessage(env, lineUserId, "ตั้งงบ อาหาร 3000", origin);
check("setting the same category again warns that it replaces the old figure", budgetChangeReply.includes("เดิมตั้งไว้ 5,000"));
await handleTextMessage(env, lineUserId, "ใช่", origin);
check(
  "and it overwrites in place rather than adding a second row",
  budgetRows.length === 1 && Number(budgetRows[0][3]) === 3000
);
const keptBudgetId = budgetRows[0][0];

const budgetListReply = await handleTextMessage(env, lineUserId, "ดูงบ", origin);
check("ดูงบ lists what's set", budgetListReply.includes("3,000") && budgetListReply.includes("อาหาร"));

// The report that has always existed should now actually find something.
const budgetRemainingReply = await handleTextMessage(env, lineUserId, "งบเหลือเท่าไหร่", origin);
check(
  "งบเหลือเท่าไหร่ finally reports against a real budget instead of 'ยังไม่ได้ตั้งงบ'",
  !budgetRemainingReply.includes("ยังไม่ได้ตั้งงบ") && budgetRemainingReply.includes("เหลือ")
);

const unknownCategoryReply = await handleTextMessage(env, lineUserId, "ตั้งงบ ยานอวกาศ 900", origin);
check(
  "an unknown category lists the real ones instead of failing silently",
  unknownCategoryReply.includes("ไม่รู้จักหมวด") && budgetRows.length === 1
);

// A budget caps spending, so an income category must not be settable.
const incomeCategoryBudget = validateIntent({ intent: "budget_set", budgetCategoryId: "salary", budgetLimitAmount: 100 });
check("validateIntent refuses a budget on an income category", incomeCategoryBudget === null);
check(
  "and refuses a zero or negative limit",
  validateIntent({ intent: "budget_set", budgetCategoryId: "food", budgetLimitAmount: 0 }) === null
);

simulateInterpreterResult = { intent: "budget_set", budgetCategoryId: "food", budgetLimitAmount: 7000 };
const interpBudgetReply = await handleTextMessage(env, lineUserId, "ขอตั้งงบค่ากินเดือนนี้เจ็ดพันนะ", origin);
check("an AI-interpreted budget_set reaches the same confirm prompt", interpBudgetReply.includes("7,000") && interpBudgetReply.includes('"ใช่"'));
await handleTextMessage(env, lineUserId, "ใช่", origin);
check("and still keeps one row, with the id preserved across the overwrite",
  budgetRows.length === 1 && budgetRows[0][0] === keptBudgetId && Number(budgetRows[0][3]) === 7000);

// The web page — the second write-capable /view page after ตารางเวร.
const budgetsPageResponse = await worker.fetch(new Request(`${origin}/view/budgets?token=${viewToken}`), env, new FakeExecutionContext());
const budgetsPageHtml = await budgetsPageResponse.text();
check(
  "/view/budgets shows every expense category, prefilled with what's set",
  budgetsPageResponse.status === 200 && budgetsPageHtml.includes('name="budget-food"') && budgetsPageHtml.includes('value="7000"')
);
check("it shows spending next to each limit, so the number isn't picked blind", budgetsPageHtml.includes("ใช้ไปแล้ว"));

const budgetSaveBody = new URLSearchParams({ "budget-food": "4500", "budget-transport": "1200" });
const budgetSaveResponse = await worker.fetch(
  new Request(`${origin}/view/budgets?token=${viewToken}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: budgetSaveBody.toString(),
  }),
  env,
  new FakeExecutionContext()
);
check("saving the form writes every submitted category at once", budgetSaveResponse.status === 200 && budgetRows.length === 2);
check(
  "a blank field clears that category's budget rather than storing NaN",
  budgetRows.every((r) => Number.isFinite(Number(r[3])) && Number(r[3]) > 0) &&
    budgetRows.some((r) => r[1] === "food" && Number(r[3]) === 4500)
);

// Regression test for what a real user hit within minutes of budgets
// shipping: they set a 5,000 shopping budget, logged 4,500 and then 800
// against it, and the bot said nothing either time. A limit that only speaks
// when asked isn't doing the job a limit exists for (PLAN.md 17.44).
budgetRows.length = 0;
budgetRows.push([crypto.randomUUID(), "shopping", budgetMonth, 5000]);
const sheetRowsBeforeBudgetWarn = sheetRows.length;

// Expected figures are derived from the sheet, not hardcoded — this section
// runs after plenty of other transactions, so the shopping category already
// carries a balance and a literal "เหลือ 500" would only be testing the test.
const shoppingSpent = () =>
  sheetRows
    .filter((r) => r[2] === "expense" && r[4] === "shopping" && String(r[1]).startsWith(budgetMonth))
    .reduce((sum, r) => sum + Number(r[3]), 0);
const baht = (n) => n.toLocaleString("th-TH", { maximumFractionDigits: 2 });

await handleTextMessage(env, lineUserId, "ซื้อกระเป๋า 4500", origin);
const underBudgetSave = await handleTextMessage(env, lineUserId, "ใช่", origin);
const remainingAfterBag = 5000 - shoppingSpent();
check(
  "saving an expense in a budgeted category reports what's left, unprompted",
  underBudgetSave.includes("บันทึกรายจ่าย") &&
    remainingAfterBag > 0 &&
    underBudgetSave.includes(`เหลือ ${baht(remainingAfterBag)} บาท`)
);

await handleTextMessage(env, lineUserId, "รองเท้า 800", origin);
const overBudgetSave = await handleTextMessage(env, lineUserId, "ใช่", origin);
const overspend = shoppingSpent() - 5000;
check(
  "and the one that tips it over says so, with the overspend",
  overBudgetSave.includes("⚠️") && overspend > 0 && overBudgetSave.includes(`เกินแล้ว ${baht(overspend)} บาท`)
);

// Every expense logged here must land in the current Bangkok month, or it
// would silently miss the budget it was meant to count against — the money
// path was the last place still stamping rows with a UTC date.
check(
  "the saved rows carry the Bangkok date, not the UTC one",
  sheetRows.slice(sheetRowsBeforeBudgetWarn).every((r) => r[1] === bangkokDateKey())
);

// An expense in a category with no budget must stay silent — the feature
// shouldn't start narrating budgets at people who never set one.
const noBudgetCategorySave = await (async () => {
  await handleTextMessage(env, lineUserId, "ค่าแท็กซี่ 120", origin);
  return handleTextMessage(env, lineUserId, "ใช่", origin);
})();
check(
  "an expense in an unbudgeted category says nothing about budgets",
  noBudgetCategorySave.includes("บันทึกรายจ่าย") && !noBudgetCategorySave.includes("งบ")
);

// The AI prompt had no idea budgets existed — a user asked about the very
// category they'd just budgeted and the answer never mentioned it.
geminiRequests.length = 0;
await handleTextMessage(env, lineUserId, "ถาม งบช้อปปิ้งเหลือเท่าไหร่", origin);
const budgetAwarePrompt = [...geminiRequests].reverse().find((r) => r.systemInstruction.includes("ช่วยตอบคำถามเกี่ยวกับการเงิน"));
check(
  "the AI Q&A prompt now carries the budgets, with remaining precomputed",
  budgetAwarePrompt?.systemInstruction.includes("งบประมาณเดือนนี้ที่ผู้ใช้ตั้งไว้") &&
    budgetAwarePrompt.systemInstruction.includes("ห้ามคำนวณเอง")
);

budgetRows.length = 0;
budgetRows.push([keptBudgetId, "food", budgetMonth, 4500], [crypto.randomUUID(), "transport", budgetMonth, 1200]);

const budgetDeleteReply = await handleTextMessage(env, lineUserId, "ลบงบ อาหาร", origin);
check("ลบงบ confirms first too", budgetDeleteReply.includes('"ใช่"') && budgetRows.length === 2);
await handleTextMessage(env, lineUserId, "ใช่", origin);
check("confirming removes just that category's row", budgetRows.length === 1 && !budgetRows.some((r) => r[1] === "food"));
budgetRows.length = 0;

// "เปิดเว็บดูข้อมูล" (PLAN.md 17.7 second pass) works in group mode now,
// after a user asked for it once they noticed calendar/diary/trip/province
// worked but the web viewer still didn't — exercises the same chat
// command -> signed token -> real fetch handler -> HTML response path as
// personal mode above, plus the group-specific wording and error message.
const groupViewLinkReply = await handleGroupTextMessage(env, groupId, groupSenderA, "เปิดเว็บดูข้อมูล", origin);
const groupViewLinkMatch = groupViewLinkReply.match(/https?:\/\/\S+\/view\?token=\S+/);
check("\"เปิดเว็บดูข้อมูล\" works in group mode and replies with a /view link", groupViewLinkMatch !== null);
check(
  "the group's view-link reply doesn't falsely claim only the asker can see it, since the reply posts into the shared chat",
  !groupViewLinkReply.includes("เห็นได้เฉพาะคุณคนเดียว")
);
const groupViewLinkUrl = groupViewLinkMatch[0];
const groupViewPageResponse = await worker.fetch(new Request(groupViewLinkUrl), env, new FakeExecutionContext());
check(
  "the group's view token actually renders the shared account's summary page",
  groupViewPageResponse.status === 200 && (await groupViewPageResponse.text()).includes("สรุปบัญชี")
);

const neverLinkedGroupViewToken = await signViewToken("group:Cneverlinkedgroup", env.STATE_SIGNING_SECRET);
const neverLinkedGroupViewResponse = await worker.fetch(
  new Request(`${origin}/view?token=${neverLinkedGroupViewToken}`),
  env,
  new FakeExecutionContext()
);
check(
  "a view token for a group that never linked shows a group-specific prompt, not the personal-mode wording",
  neverLinkedGroupViewResponse.status === 400 && (await neverLinkedGroupViewResponse.text()).includes("กลุ่มนี้ยังไม่ได้เชื่อมบัญชี")
);

// 7. AI Q&A/analysis (PLAN.md 17.6) — opened up to group mode too, reusing
// matchAiCommand exactly as-is (no group-specific code needed, since it
// was already generic over whatever ActionCtx it's handed).
const groupAiRequestsBefore = geminiRequests.length;
const groupAiReply = await handleGroupTextMessage(env, groupId, groupSenderA, "ถาม เดือนนี้ใช้เงินหมวดไหนเยอะสุด", origin);
check(
  // +2: interpreter attempt, then the real Q&A call — same accounting as
  // personal mode above.
  "\"ถาม <คำถาม>\" reaches Gemini in group mode, same as personal mode",
  geminiRequests.length === groupAiRequestsBefore + 2 && groupAiReply.includes("[mock AI answer]")
);
const lastGroupAiRequest = geminiRequests.at(-1);
check(
  "the AI prompt in group mode is built from the group's own shared spreadsheet, not any individual's",
  lastGroupAiRequest.systemInstruction.includes("รายรับรวม")
);
const groupAnalyzeReply = await handleGroupTextMessage(env, groupId, groupSenderA, "วิเคราะห์", origin);
check("\"วิเคราะห์\" (no question text) also works in group mode", groupAnalyzeReply.includes("[mock AI answer]"));

// AI message interpretation in group mode (PLAN.md 17.11) — wired the same
// way as personal mode, and attribution is still resolved lazily (only for
// the "transaction" intent) so an ordinary chitchat message in a group
// doesn't pay for a member-profile lookup it doesn't need.
const groupSheetRowsBeforeInterp = sheetRows.length;
simulateInterpreterResult = {
  intent: "transaction",
  transactions: [{ amount: 120, type: "expense", categoryId: "food", note: "หมูกระทะ" }],
};
const groupInterpPromptReply = await handleGroupTextMessage(env, groupId, groupSenderA, "กินหมูกระทะกันมา 120", origin);
check("an AI-interpreted transaction in group mode also asks to confirm first", groupInterpPromptReply.includes("ใช่ไหม"));
const groupInterpConfirmReply = await handleGroupTextMessage(env, groupId, groupSenderA, "ใช่", origin);
check(
  "confirming saves it to the group's shared sheet, attributed to the actual sender",
  sheetRows.length === groupSheetRowsBeforeInterp + 1 && sheetRows.at(-1)[7] === groupSenderA
);

simulateInterpreterResult = { intent: "chitchat", reply: "อ่ะ เข้าใจแล้ว" };
const groupChitchatReply = await handleGroupTextMessage(env, groupId, groupSenderA, "แค่คุยเล่นเฉยๆนะ", origin);
check("a chitchat intent works in group mode too, without touching the sheet", groupChitchatReply === "อ่ะ เข้าใจแล้ว");

// 8. Full webhook-level mention gating: every message in a group the bot
// belongs to reaches the webhook whether the bot was addressed or not —
// gating on @mention is this bot's own responsibility, not something LINE
// filters server-side (PLAN.md 17).
function groupTextEvent({ text, mention, userId = groupSenderA, replyToken = "reply-group-1" }) {
  return {
    type: "message",
    message: { type: "text", text, ...(mention ? { mention } : {}) },
    source: { type: "group", groupId, userId },
    replyToken,
    timestamp: Date.now(),
  };
}

const repliesBeforeUnmentioned = replies.length;
const unmentionedRawBody = JSON.stringify({ events: [groupTextEvent({ text: "ไปกินข้าวกันไหม" })] });
const unmentionedSignature = await signLineBody(unmentionedRawBody, env.LINE_CHANNEL_SECRET);
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": unmentionedSignature }, body: unmentionedRawBody }),
  env
);
check("ordinary group chatter with no @mention gets no reply at all", replies.length === repliesBeforeUnmentioned);

const mentionedRawBody = JSON.stringify({
  events: [
    groupTextEvent({
      text: "@BotName สรุปเดือนนี้",
      mention: { mentionees: [{ index: 0, length: 8, type: "user", isSelf: true }] },
    }),
  ],
});
const mentionedSignature = await signLineBody(mentionedRawBody, env.LINE_CHANNEL_SECRET);
const repliesBeforeMentioned = replies.length;
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": mentionedSignature }, body: mentionedRawBody }),
  env
);
check(
  "a message that @mentions the bot gets a reply, with the mention text stripped before parsing",
  replies.length === repliesBeforeMentioned + 1 && replies.at(-1).includes("รายรับ")
);

// PLAN.md 17.12: calling the bot by name in plain text (no formal @mention)
// also addresses it in group mode — requested directly so members don't
// have to reach for LINE's @ picker every time.
const namedRawBody = JSON.stringify({ events: [groupTextEvent({ text: "ไพโรจน์ สรุปเดือนนี้" })] });
const namedSignature = await signLineBody(namedRawBody, env.LINE_CHANNEL_SECRET);
const repliesBeforeNamed = replies.length;
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": namedSignature }, body: namedRawBody }),
  env
);
check(
  "calling the bot by name (no @mention) also gets a reply, with the name stripped before parsing",
  replies.length === repliesBeforeNamed + 1 && replies.at(-1).includes("รายรับ")
);

const namedMidRawBody = JSON.stringify({ events: [groupTextEvent({ text: "เดี๋ยวถามไพโรจน์หน่อยว่าเหลือเงินเท่าไหร่", replyToken: "reply-group-named-mid" })] });
const namedMidSignature = await signLineBody(namedMidRawBody, env.LINE_CHANNEL_SECRET);
const repliesBeforeNamedMid = replies.length;
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": namedMidSignature }, body: namedMidRawBody }),
  env
);
check(
  "the name works anywhere in the message, not just as a prefix",
  replies.length === repliesBeforeNamedMid + 1
);

const stillUnmentionedRawBody = JSON.stringify({ events: [groupTextEvent({ text: "วันนี้อากาศดีจัง", replyToken: "reply-group-still-unmentioned" })] });
const stillUnmentionedSignature = await signLineBody(stillUnmentionedRawBody, env.LINE_CHANNEL_SECRET);
const repliesBeforeStillUnmentioned = replies.length;
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": stillUnmentionedSignature }, body: stillUnmentionedRawBody }),
  env
);
check(
  "ordinary chatter that doesn't mention the bot's name still gets no reply",
  replies.length === repliesBeforeStillUnmentioned
);

// 9. The push fallback (used when the reply token has expired) targets the
// group itself, not any individual member — pushTargetId's whole reason
// to exist.
const mentionedExpiredBody = JSON.stringify({
  events: [
    groupTextEvent({
      text: "@BotName สรุปเดือนนี้",
      mention: { mentionees: [{ index: 0, length: 8, type: "user", isSelf: true }] },
      replyToken: "reply-token-expired",
    }),
  ],
});
const mentionedExpiredSignature = await signLineBody(mentionedExpiredBody, env.LINE_CHANNEL_SECRET);
const pushesBeforeGroupFallback = pushes.length;
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": mentionedExpiredSignature }, body: mentionedExpiredBody }),
  env
);
check(
  "an expired reply token in a group falls back to pushing to the groupId, not a member's userId",
  pushes.length === pushesBeforeGroupFallback + 1 && pushes.at(-1).to === groupId
);

// 10. The raw LINE API helpers behind group linking/attribution, tested
// directly rather than just through the flows above.
check(
  "getGroupMemberProfile returns a display name for a known member",
  (await getGroupMemberProfile(groupId, groupSenderA, env.LINE_CHANNEL_ACCESS_TOKEN))?.displayName === "สมชาย"
);
check(
  "getGroupMemberProfile degrades to null (not a throw) for an unknown member",
  (await getGroupMemberProfile(groupId, "Uneverjoined", env.LINE_CHANNEL_ACCESS_TOKEN)) === null
);
check(
  "getGroupSummary returns the group's real name",
  (await getGroupSummary(groupId, env.LINE_CHANNEL_ACCESS_TOKEN))?.groupName === mockGroupName
);
simulateGroupSummaryFailure = true;
check(
  "getGroupSummary degrades to null (not a throw) on failure",
  (await getGroupSummary(groupId, env.LINE_CHANNEL_ACCESS_TOKEN)) === null
);

// 11. Regression test for a real bug caught in review: a group's authorize
// link is posted into the shared chat (not DM'd), so unlike a personal
// re-link (always expected to be the same person, safe to overwrite in
// place), a *second* completion of the same still-valid link could easily
// be a different person entirely, with their own separate Google account.
// Overwriting the group's refreshToken in that case would silently break
// every future read/write against the first person's spreadsheet.
const raceGroupId = "Cgrouprace1";
const raceSubjectId = `group:${raceGroupId}`;
const raceState = await signState(raceSubjectId, env.STATE_SIGNING_SECRET);

const oauthCallbackA = await worker.fetch(
  new Request(`${origin}/oauth/callback?code=code-person-a&state=${encodeURIComponent(raceState)}`),
  env,
  new FakeExecutionContext()
);
check(
  "the first person to complete a group's OAuth link succeeds and links the group",
  oauthCallbackA.status === 200 && (await oauthCallbackA.text()).includes("เชื่อมบัญชีกลุ่มสำเร็จ")
);
const linkAfterA = await getAccountLink(kv, raceSubjectId);
check("the group's refresh token matches person A's completed exchange", linkAfterA?.refreshToken === "fake-refresh-token-for-code-person-a");

// Person B's access token can't reach person A's spreadsheet — a different
// Google account, exactly the race this guard exists for.
simulateSpreadsheetAccessDeniedOnce = true;
const oauthCallbackB = await worker.fetch(
  new Request(`${origin}/oauth/callback?code=code-person-b&state=${encodeURIComponent(raceState)}`),
  env,
  new FakeExecutionContext()
);
check(
  "a second completion of the same still-valid link for an already-linked group is a no-op, not an overwrite",
  oauthCallbackB.status === 200 && (await oauthCallbackB.text()).includes("เชื่อมบัญชีไว้แล้ว")
);
const linkAfterB = await getAccountLink(kv, raceSubjectId);
check(
  "the group's refresh token is still person A's after a second, different person's completion attempt",
  linkAfterB?.refreshToken === "fake-refresh-token-for-code-person-a" && linkAfterB?.spreadsheetId === linkAfterA?.spreadsheetId
);

// Regression test for the fix to the above guard: it must not also block a
// *legitimate* rescope by person A themselves (e.g. re-consenting after
// InsufficientCalendarScopeError). person A's new token can still reach the
// group's existing spreadsheet (canAccessSpreadsheet succeeds, the default
// mock behavior), so this completion should update the refresh token in
// place rather than being treated as a no-op.
const oauthCallbackRescope = await worker.fetch(
  new Request(`${origin}/oauth/callback?code=code-person-a-rescope&state=${encodeURIComponent(raceState)}`),
  env,
  new FakeExecutionContext()
);
check(
  "the same Google account re-consenting with broader scope actually updates the group's refresh token",
  oauthCallbackRescope.status === 200 && (await oauthCallbackRescope.text()).includes("เชื่อมบัญชีกลุ่มสำเร็จ")
);
const linkAfterRescope = await getAccountLink(kv, raceSubjectId);
check(
  "the rescoped refresh token replaced the old one, spreadsheetId unchanged",
  linkAfterRescope?.refreshToken === "fake-refresh-token-for-code-person-a-rescope" &&
    linkAfterRescope?.spreadsheetId === linkAfterA?.spreadsheetId
);

// Group mode, second pass (PLAN.md 17.7): province/calendar/diary/trip
// opened up to near-full parity with personal mode, using the same
// "group:<groupId>" subject id trick as money/AI already did. Reuses the
// group linked earlier in this file (groupId/groupSenderA/groupSenderB).

const groupProvinceReply = await handleGroupTextMessage(env, groupId, groupSenderA, "ตั้งจังหวัด เชียงใหม่", origin);
check("\"ตั้งจังหวัด\" works in group mode", groupProvinceReply.includes("เชียงใหม่"));

const groupCalendarPromptReply = await handleGroupTextMessage(
  env,
  groupId,
  groupSenderA,
  `นัด ประชุมกลุ่ม ${tomorrowSlash} 13:00`,
  origin
);
check(
  "calendar create asks to confirm in group mode, same as personal mode",
  groupCalendarPromptReply.includes("ประชุมกลุ่ม") && groupCalendarPromptReply.includes("13:00")
);
const calendarEventsBeforeGroupConfirm = calendarEvents.length;
const groupCalendarConfirmReply = await handleGroupTextMessage(env, groupId, groupSenderB, "ใช่", origin);
check(
  "any group member can confirm the shared pending calendar create, same as the money/delete confirmations above",
  groupCalendarConfirmReply.includes("จดนัดแล้ว") && calendarEvents.length === calendarEventsBeforeGroupConfirm + 1
);

const groupDiaryPromptReply = await handleGroupTextMessage(env, groupId, groupSenderA, "ไดอารี่ ทริปกลุ่มสนุกมาก", origin);
check("diary create asks to confirm in group mode", groupDiaryPromptReply.includes("ใช่ไหม"));
const groupDiaryConfirmReply = await handleGroupTextMessage(env, groupId, groupSenderB, "ใช่", origin);
check("confirming saves the diary entry in group mode, attributed to the group's own shared diary", groupDiaryConfirmReply.includes("บันทึกไดอารี่แล้ว"));

// Tasks (PLAN.md 17.26) works in group mode too, for free — matchTaskCommand
// runs through the same dispatchLegacyCommands every other feature does,
// with no group-specific wiring needed.
const groupTaskPromptReply = await handleGroupTextMessage(env, groupId, groupSenderA, "เพิ่มสิ่งที่ต้องทำ จองร้านอาหาร", origin);
check("task create asks to confirm in group mode", groupTaskPromptReply.includes("จองร้านอาหาร"));
const groupTaskConfirmReply = await handleGroupTextMessage(env, groupId, groupSenderB, "ใช่", origin);
check(
  "any group member can confirm the shared pending task create, same as calendar/diary above",
  groupTaskConfirmReply.includes("เพิ่มสิ่งที่ต้องทำแล้ว")
);

// Gmail (PLAN.md 17.28) works in group mode too, for the same reason.
const groupEmailSendPromptReply = await handleGroupTextMessage(
  env,
  groupId,
  groupSenderA,
  "ส่งอีเมล ถึง vendor@example.com เรื่อง สั่งของ ข้อความ ขอสั่งของเพิ่มอีก 10 ชิ้นครับ",
  origin
);
check("email send asks to confirm in group mode", groupEmailSendPromptReply.includes("vendor@example.com"));
const groupEmailSentCountBefore = gmailSent.length;
const groupEmailConfirmReply = await handleGroupTextMessage(env, groupId, groupSenderB, "ใช่", origin);
check(
  "any group member can confirm the shared pending email send, same as calendar/diary/task above",
  groupEmailConfirmReply.includes("vendor@example.com") && gmailSent.length === groupEmailSentCountBefore + 1
);

// Contacts (PLAN.md 17.34) works in group mode too, for the same reason —
// resolves against whichever Google account the group itself is linked to.
googleContacts = [{ name: "ผู้ขายวัสดุ", email: "supplier@example.com" }];
const groupContactLookupReply = await handleGroupTextMessage(env, groupId, groupSenderA, "อีเมลของผู้ขายวัสดุ", origin);
check("contact lookup works in group mode", groupContactLookupReply.includes("supplier@example.com"));
googleContacts = [];

// Travel search (PLAN.md 17.37) works in group mode too — dispatch is the
// same shared dispatchLegacyCommands, so one wiring check suffices.
travelpayoutsFlightOffers = [{ price: 1540, airline: "FD", departure_at: "2026-12-20T08:00:00+07:00", transfers: 0 }];
const groupFlightReply = await handleGroupTextMessage(env, groupId, groupSenderA, "หาตั๋วเครื่องบิน กรุงเทพ ไป เชียงใหม่ 20/12/2569", origin);
check(
  "flight search works in group mode: prices plus booking links",
  groupFlightReply.includes("1,540 บาท") && groupFlightReply.includes("google.com/travel/flights")
);
travelpayoutsFlightOffers = [];

// Nearby places (PLAN.md 17.30) works in group mode too — but the location-
// share message itself can't carry a text/@mention at all (LINE's
// location-sharing UI has none), so "is this meant for the bot" is answered
// purely by whether a search is pending, unlike every other group feature
// which is gated by @mention on every single message.
nearbyPlacesResults = [
  { displayName: { text: "ร้านชานม" }, formattedAddress: "ตลาดนัด", rating: 4.0, googleMapsUri: "https://maps.google.com/?cid=4" },
];
const groupNearbyPromptReply = await handleGroupTextMessage(env, groupId, groupSenderA, "หาร้านชานมใกล้ฉัน", origin);
check("asking to find something nearby in a group prompts to share a location", groupNearbyPromptReply.includes("ตำแหน่ง"));

function groupLocationEvent(lat, lng, userId = groupSenderB, replyToken = "reply-group-location-1") {
  return {
    type: "message",
    message: { type: "location", latitude: lat, longitude: lng },
    source: { type: "group", groupId, userId },
    replyToken,
    timestamp: Date.now(),
  };
}
const groupNearbyBody = JSON.stringify({ events: [groupLocationEvent(13.9, 100.7)] });
const groupNearbySignature = await signLineBody(groupNearbyBody, env.LINE_CHANNEL_SECRET);
const repliesBeforeGroupNearbyResult = replies.length;
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": groupNearbySignature }, body: groupNearbyBody }),
  env
);
check(
  "sharing location in the group afterward (no @mention possible on a location message) still resolves the pending search",
  replies.length === repliesBeforeGroupNearbyResult + 1 && replies.at(-1).includes("ร้านชานม")
);

const groupNearbyBody2 = JSON.stringify({ events: [groupLocationEvent(13.9, 100.7, groupSenderA, "reply-group-location-2")] });
const groupNearbySignature2 = await signLineBody(groupNearbyBody2, env.LINE_CHANNEL_SECRET);
const repliesBeforeGroupUnprompted = replies.length;
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": groupNearbySignature2 }, body: groupNearbyBody2 }),
  env
);
check("an unprompted location share in a group gets no reply at all either", replies.length === repliesBeforeGroupUnprompted);

// Trip start/status via the real webhook path (mentioned, since these are
// text commands) — sets up the group's active trip for the photo
// auto-upload tests below, which specifically must NOT require a mention.
const groupTripStartBody = JSON.stringify({
  events: [groupTextEvent({ text: "@BotName เริ่มทริป ทริปกลุ่ม", mention: { mentionees: [{ index: 0, length: 8, type: "user", isSelf: true }] } })],
});
const groupTripStartSignature = await signLineBody(groupTripStartBody, env.LINE_CHANNEL_SECRET);
const repliesBeforeGroupTripStart = replies.length;
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": groupTripStartSignature }, body: groupTripStartBody }),
  env
);
check(
  "starting a trip in a group works the same as personal mode, via a mentioned text command",
  replies.length === repliesBeforeGroupTripStart + 1 && replies.at(-1).includes('ทริป "ทริปกลุ่ม"')
);
check("the group's trip folder was created under the shared album root", driveFolders.some((f) => f.name === "ทริปกลุ่ม"));
const groupTripFolderId = driveFolders.find((f) => f.name === "ทริปกลุ่ม").id;

// Photos in a group can never be @mentioned (LINE's mention feature only
// exists on text), so the whole design here hinges on the active-trip
// check itself being the signal — see resolveMediaBatchContext's comment.
function groupImageEvent({ messageId, userId = groupSenderA, replyToken = "reply-group-img" }) {
  return {
    type: "message",
    message: { type: "image", id: messageId },
    source: { type: "group", groupId, userId },
    replyToken,
    timestamp: Date.now(),
  };
}

// A group that was never linked at all must stay completely silent on a
// random photo — same reasoning as "no active trip" below, just the other
// missing precondition.
const unlinkedGroupId = "Cgroupunlinked1";
const unlinkedGroupImageBody = JSON.stringify({
  events: [
    {
      type: "message",
      message: { type: "image", id: "unlinked-group-img-1" },
      source: { type: "group", groupId: unlinkedGroupId, userId: groupSenderA },
      replyToken: "reply-unlinked-group-img",
      timestamp: Date.now(),
    },
  ],
});
const unlinkedGroupImageSignature = await signLineBody(unlinkedGroupImageBody, env.LINE_CHANNEL_SECRET);
const repliesBeforeUnlinkedGroupImage = replies.length;
const pushesBeforeUnlinkedGroupImage = pushes.length;
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": unlinkedGroupImageSignature }, body: unlinkedGroupImageBody }),
  env
);
check(
  "a photo in a group with no linked account at all gets total silence, not a link prompt",
  replies.length === repliesBeforeUnlinkedGroupImage && pushes.length === pushesBeforeUnlinkedGroupImage
);
check("nothing was queued for the unlinked group either", (await countQueuedForUser(kv, `group:${unlinkedGroupId}`)) === 0);

// The already-linked group (from earlier in this section), but before any
// trip has been started — a photo sent now must be pure ambient
// group chatter, not something to react to.
await handleGroupTextMessage(env, groupId, groupSenderA, "จบทริป", origin); // close the trip opened above, for this check
const noTripGroupImageBody = JSON.stringify({ events: [groupImageEvent({ messageId: "no-trip-group-img-1" })] });
const noTripGroupImageSignature = await signLineBody(noTripGroupImageBody, env.LINE_CHANNEL_SECRET);
const repliesBeforeNoTripGroupImage = replies.length;
const pushesBeforeNoTripGroupImage = pushes.length;
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": noTripGroupImageSignature }, body: noTripGroupImageBody }),
  env
);
check(
  "a photo in a linked group with no active trip also gets total silence, not the personal-mode 'start a trip first' reply",
  replies.length === repliesBeforeNoTripGroupImage && pushes.length === pushesBeforeNoTripGroupImage
);
check("nothing was queued without an active trip", (await countQueuedForUser(kv, `group:${groupId}`)) === 0);

// Re-open the trip, then send a photo with NO mention at all — this is the
// actual point of the feature: once a trip is active, mention-gating
// doesn't apply to photos anymore, the active trip itself is consent.
await handleGroupTextMessage(env, groupId, groupSenderA, "เริ่มทริป ทริปกลุ่ม", origin);
const driveUploadsBeforeGroupPhoto = driveUploads.length;
const groupPhotoBody = JSON.stringify({ events: [groupImageEvent({ messageId: "group-trip-img-1", userId: groupSenderB })] });
const groupPhotoSignature = await signLineBody(groupPhotoBody, env.LINE_CHANNEL_SECRET);
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": groupPhotoSignature }, body: groupPhotoBody }),
  env
);
check(
  "an unmentioned photo from any member queues silently once the group's trip is active",
  driveUploads.length === driveUploadsBeforeGroupPhoto && (await countQueuedForUser(kv, `group:${groupId}`)) === 1
);

const pushesBeforeGroupDrain = pushes.length;
await drainUploadQueue(env);
check("the drain actually uploads the group's queued photo into the trip's own folder", driveUploads.at(-1).parentId === groupTripFolderId);
check(
  "the drain confirmation pushes to the group itself, not to whichever member happened to send the photo",
  pushes.length === pushesBeforeGroupDrain + 1 && pushes.at(-1).to === groupId && pushes.at(-1).text.includes("ทริปกลุ่ม")
);

// Regression test for a real bug caught in code review: media events used
// to be fully processed *before* any text event in the same webhook call —
// so a mentioned "เริ่มทริป" bundled into the same LINE webhook body as a
// multi-selected photo send (a real, not just theoretical, case LINE can
// deliver) would see "no active trip yet" for the photo and, in group
// mode, silently drop it, even though the trip got created moments later
// in that very call. Text now always runs first.
await handleGroupTextMessage(env, groupId, groupSenderA, "จบทริป", origin); // back to a clean "no active trip" state
const sameBatchBody = JSON.stringify({
  events: [
    groupTextEvent({
      text: "@BotName เริ่มทริป ทริปพร้อมกัน",
      mention: { mentionees: [{ index: 0, length: 8, type: "user", isSelf: true }] },
    }),
    groupImageEvent({ messageId: "same-batch-img-1", userId: groupSenderB }),
  ],
});
const sameBatchSignature = await signLineBody(sameBatchBody, env.LINE_CHANNEL_SECRET);
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": sameBatchSignature }, body: sameBatchBody }),
  env
);
check(
  "a photo bundled in the same webhook call as the mentioned trip-start command still queues, not silently dropped",
  (await countQueuedForUser(kv, `group:${groupId}`)) === 1
);
const sameBatchTripFolderId = driveFolders.find((f) => f.name === "ทริปพร้อมกัน")?.id;
await drainUploadQueue(env);
check(
  "the drain uploads that photo into the trip that was started in the very same webhook call",
  driveUploads.at(-1).parentId === sameBatchTripFolderId
);

// Regression test for a real bug caught in code review: drainUploadQueue
// used to key its per-drain summary by subject id alone, so a batch
// spanning two different trips for the same subject collapsed both
// succeeded counts into one summary labeled with whichever job happened to
// be processed last — silently mislabeling which trip some of the
// uploaded files actually went into. Summaries are now keyed by
// (subject, tripFolderId), so this must produce two separate, correctly
// labeled pushes instead of one.
await handleGroupTextMessage(env, groupId, groupSenderA, "จบทริป", origin);
const tripOneStartBody = JSON.stringify({
  events: [groupTextEvent({ text: "@BotName เริ่มทริป ทริปหนึ่ง", mention: { mentionees: [{ index: 0, length: 8, type: "user", isSelf: true }] } })],
});
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": await signLineBody(tripOneStartBody, env.LINE_CHANNEL_SECRET) }, body: tripOneStartBody }),
  env
);
const tripOnePhotoBody = JSON.stringify({ events: [groupImageEvent({ messageId: "two-trip-img-1" })] });
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": await signLineBody(tripOnePhotoBody, env.LINE_CHANNEL_SECRET) }, body: tripOnePhotoBody }),
  env
);
const tripOneFolderId = driveFolders.find((f) => f.name === "ทริปหนึ่ง")?.id;

await handleGroupTextMessage(env, groupId, groupSenderA, "จบทริป", origin);
const tripTwoStartBody = JSON.stringify({
  events: [groupTextEvent({ text: "@BotName เริ่มทริป ทริปสอง", mention: { mentionees: [{ index: 0, length: 8, type: "user", isSelf: true }] } })],
});
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": await signLineBody(tripTwoStartBody, env.LINE_CHANNEL_SECRET) }, body: tripTwoStartBody }),
  env
);
const tripTwoPhotoBody = JSON.stringify({ events: [groupImageEvent({ messageId: "two-trip-img-2" })] });
await handleWebhook(
  new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": await signLineBody(tripTwoPhotoBody, env.LINE_CHANNEL_SECRET) }, body: tripTwoPhotoBody }),
  env
);
const tripTwoFolderId = driveFolders.find((f) => f.name === "ทริปสอง")?.id;

check("both trips' photos are queued going into the shared-summary drain", (await countQueuedForUser(kv, `group:${groupId}`)) === 2);
const pushesBeforeTwoTripDrain = pushes.length;
await drainUploadQueue(env);
const twoTripPushes = pushes.slice(pushesBeforeTwoTripDrain);
check(
  "draining a batch spanning two trips for the same group sends two separate, correctly labeled pushes",
  twoTripPushes.length === 2 &&
    twoTripPushes.some((p) => p.text.includes('"ทริปหนึ่ง"')) &&
    twoTripPushes.some((p) => p.text.includes('"ทริปสอง"'))
);
check(
  "each trip's photo landed in its own trip folder, not mixed up",
  driveUploads.some((u) => u.parentId === tripOneFolderId && u.name.includes("two-trip-img-1")) &&
    driveUploads.some((u) => u.parentId === tripTwoFolderId && u.name.includes("two-trip-img-2"))
);

// Migration safety: a queue entry written before pushTarget existed (the
// field is new, but the KV queue persists across deploys) must still get
// its completion push delivered, falling back to lineUserId — which was
// always the correct push target for every job before group mode split
// the two apart.
const legacyJob = {
  lineUserId,
  kind: "image",
  messageId: "legacy-msg-1",
  timestampMs: Date.now(),
  tripFolderId,
  tripName: "ทะเล",
};
await env.ACCOUNTS.put(`upload-queue:legacy-1`, JSON.stringify(legacyJob), {
  metadata: { lineUserId },
});
const pushesBeforeLegacyDrain = pushes.length;
const driveUploadsBeforeLegacyDrain = driveUploads.length;
await drainUploadQueue(env);
check(
  "a pre-migration queue entry with no pushTarget field still uploads and pushes its confirmation to lineUserId",
  driveUploads.length === driveUploadsBeforeLegacyDrain + 1 &&
    pushes.length === pushesBeforeLegacyDrain + 1 &&
    pushes.at(-1).to === lineUserId
);

// Regression test for a real bug caught in code review: when the account
// link is gone by the time the queue drains (unlinked while the file was
// waiting), drainUploadQueue skipped the upload but still counted the file
// as succeeded — and the `finally` dropped the queue entry regardless. The
// user was told "✅ อัปโหลดเพิ่ม 1 ไฟล์แล้ว" for a photo that was never
// uploaded and no longer existed anywhere to retry from. It has to be
// reported as a failure instead, in the same wording every other failed
// upload uses.
const orphanJob = {
  lineUserId: "Unolongerlinked",
  pushTarget: "Unolongerlinked",
  kind: "image",
  messageId: "orphan-msg-1",
  timestampMs: Date.now(),
  tripFolderId,
  tripName: "ทริปที่บัญชีหลุด",
};
await env.ACCOUNTS.put(`upload-queue:orphan-msg-1`, JSON.stringify(orphanJob), {
  metadata: { lineUserId: orphanJob.lineUserId },
});
const pushesBeforeOrphanDrain = pushes.length;
const driveUploadsBeforeOrphanDrain = driveUploads.length;
await drainUploadQueue(env);
const orphanPush = pushes.at(-1);
check(
  "a queued file whose account is no longer linked is reported as failed, never as uploaded",
  driveUploads.length === driveUploadsBeforeOrphanDrain &&
    pushes.length === pushesBeforeOrphanDrain + 1 &&
    orphanPush.text.includes("อัปโหลดเพิ่ม 0 ไฟล์") &&
    orphanPush.text.includes("อีก 1 ไฟล์อัปโหลดไม่สำเร็จ")
);
check("the unuploadable entry is still cleared from the queue, not left to retry forever",
  (await countQueuedForUser(kv, orphanJob.lineUserId)) === 0);

// Regression test for a real bug caught in code review: LINE redelivers a
// webhook it didn't get a timely "ok" for, and each queue entry used to get
// a random UUID key — so a redelivery enqueued the same photo a second time
// and the drain uploaded a duplicate into the trip folder. Keying by
// messageId makes a redelivery overwrite its own entry instead.
await handleTextMessage(env, lineUserId, "เริ่มทริป ทริปส่งซ้ำ", origin);
const redeliveredBody = JSON.stringify({
  events: [
    {
      type: "message",
      message: { type: "image", id: "redelivered-img-1" },
      source: { type: "user", userId: lineUserId },
      replyToken: "reply-redelivered-1",
      timestamp: Date.now(),
    },
  ],
});
const redeliveredRequest = () =>
  signLineBody(redeliveredBody, env.LINE_CHANNEL_SECRET).then(
    (sig) => new Request("http://localhost:8787/webhook", { method: "POST", headers: { "x-line-signature": sig }, body: redeliveredBody })
  );
await handleWebhook(await redeliveredRequest(), env);
await handleWebhook(await redeliveredRequest(), env); // LINE delivers the very same event again
check("a redelivered webhook queues the same photo only once", (await countQueuedForUser(kv, lineUserId)) === 1);
const driveUploadsBeforeRedeliveryDrain = driveUploads.length;
await drainUploadQueue(env);
check(
  "so the drain uploads it once, with no duplicate copy in the trip folder",
  driveUploads.length === driveUploadsBeforeRedeliveryDrain + 1 &&
    driveUploads.filter((u) => u.name.includes("redelivered-img-1")).length === 1
);

console.log(`\n${pass} passed, ${fail} failed`);
globalThis.fetch = realFetch;
process.exit(fail > 0 ? 1 : 0);
