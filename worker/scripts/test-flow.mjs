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

const calendarEvents = []; // simulates Google Calendar: {id, summary, start:{dateTime}, end:{dateTime}}
let calendarIdSeq = 0;
let simulateInsufficientCalendarScope = false;
let simulateCalendarApiDisabled = false;

let diaryTabExists = false;
let diaryTabMetaCalls = 0; // counts spreadsheets.get calls, to verify the KV cache actually skips them
const diaryRows = []; // simulates the Diary tab

let simulateDriveUploadFailure = false; // one-shot: fails the next Drive media upload request
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
    if (!init.method || init.method === "GET") {
      const q = parsed.searchParams.get("q") ?? "";
      const nameMatch = q.match(/name='((?:[^'\\]|\\.)*)'/);
      const parentMatch = q.match(/'([^']+)' in parents/);
      const name = nameMatch ? nameMatch[1].replace(/\\'/g, "'") : null;
      const parentId = parentMatch ? parentMatch[1] : null;
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
      if (simulateDriveUploadFailure) {
        simulateDriveUploadFailure = false;
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

  throw new Error(`unexpected fetch to ${u}`);
};

const { handleTextMessage, handleImageMessage, handleVideoMessage, handleWebhook, drainUploadQueue } = await import(
  "../src/index.ts"
);
const { setAccountLink } = await import("../src/state.ts");
const { verifyState } = await import("../src/signedState.ts");
const { bangkokDateKey, addDaysToDateKey } = await import("../src/thaiDate.ts");
const { countQueuedForUser } = await import("../src/uploadQueue.ts");

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

const helpReply = await handleTextMessage(env, lineUserId, "วิธีใช้", origin);
check(
  "help lists commands grouped by feature area",
  helpReply.includes("💰 จดเงิน") &&
    helpReply.includes("📸 อัลบั้มรูปทริป") &&
    helpReply.includes("📅 ปฏิทิน") &&
    helpReply.includes("📔 ไดอารี่")
);

const weekReply = await handleTextMessage(env, lineUserId, "สรุปสัปดาห์นี้", origin);
check("week summary doesn't error", weekReply.includes("รายรับ"));

const lastMonthReply = await handleTextMessage(env, lineUserId, "สรุปเดือนที่แล้ว", origin);
check("last month summary doesn't error", lastMonthReply.length > 0);

const greetingReply = await handleTextMessage(env, lineUserId, "สวัสดีค่ะ", origin);
check(
  "a plain greeting gets the 4-area welcome message, not the detailed help",
  greetingReply.includes("4 เรื่องหลักๆ") && !greetingReply.includes("💰 จดเงิน")
);

// A greeting sent mid-clarification must still cancel the pending question
// (chatEngine's own behavior) instead of leaving it stuck in KV — regression
// test for a bug caught while wiring up the welcome message.
await handleTextMessage(env, lineUserId, "ซื้อของ", origin); // triggers "จำนวนเงินเท่าไหร่คะ"
const greetingWhilePendingReply = await handleTextMessage(env, lineUserId, "หวัดดีครับ", origin);
check(
  "a greeting mid-clarification cancels it via chatEngine, not the rich welcome",
  !greetingWhilePendingReply.includes("4 เรื่องหลักๆ")
);
const afterGreetingReply = await handleTextMessage(env, lineUserId, "ข้าว 30", origin);
check(
  "the next real message after that isn't misread as answering the stale question",
  afterGreetingReply.includes("30")
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
// the whole request succeeds.
const uploadsBeforeFailedPut = driveUploads.length;
simulateDriveUploadFailure = true;
let failedUploadThrew = false;
try {
  await handleVideoMessage(env, lineUserId, "vid-willfail", Date.now(), origin);
} catch {
  failedUploadThrew = true;
}
check("a failed Drive content upload surfaces as an error, not a false success", failedUploadThrew);
check("a failed content upload leaves no orphaned file behind in Drive", driveUploads.length === uploadsBeforeFailedPut);

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

// Regression test for a real report: sending 37 photos in one LINE
// multi-select left 2 of them silently missing from Drive, with total
// silence (no reply, no error) for those two — traced to an earlier version
// of the streaming-upload fix using Drive's resumable protocol, which needs
// 2 Drive requests per file (init + content). Reverted to a single streamed
// multipart request per file, so a batch costs exactly 1 Drive subrequest
// per file again. This batch (15 photos) stays under
// IMMEDIATE_MEDIA_BATCH_LIMIT (20), so it still uploads immediately through
// the real handleWebhook entry point (concurrent processing, real signature
// verification) — the queued/drained path for bigger batches is exercised
// separately below. Also covers a later fix: immediate batches get one
// combined reply for the whole batch, not one per file — a real user asked
// for this (instead of a stream of separate confirmations), and it also
// turned out to matter for the subrequest math: a reply per file was itself
// a per-file subrequest that IMMEDIATE_MEDIA_BATCH_LIMIT's original
// calibration had missed, letting even a "moderate" immediate batch quietly
// exceed the same budget the queueing threshold exists to protect.
const moderateBatchSize = 15;
const moderateBatchEvents = Array.from({ length: moderateBatchSize }, (_, i) => ({
  type: "message",
  message: { type: "image", id: `modbatch-${i}` },
  source: { type: "user", userId: lineUserId },
  replyToken: `reply-modbatch-${i}`,
  timestamp: Date.now(),
}));
const moderateBatchRawBody = JSON.stringify({ events: moderateBatchEvents });
const moderateBatchSignature = await signLineBody(moderateBatchRawBody, env.LINE_CHANNEL_SECRET);
const moderateBatchRequest = new Request("http://localhost:8787/webhook", {
  method: "POST",
  headers: { "x-line-signature": moderateBatchSignature },
  body: moderateBatchRawBody,
});
const uploadsBeforeModerateBatch = driveUploads.length;
const repliesBeforeModerateBatch = replies.length;
const driveUploadRequestsBeforeModerateBatch = driveUploadRequestCount;
await handleWebhook(moderateBatchRequest, env);
check(
  `all ${moderateBatchSize} photos in one moderate batch (under the queueing threshold) made it into Drive immediately`,
  driveUploads.length === uploadsBeforeModerateBatch + moderateBatchSize
);
check(
  `all ${moderateBatchSize} photos get exactly one combined confirmation reply, not one per file`,
  replies.length === repliesBeforeModerateBatch + 1 &&
    replies.at(-1).includes(`${moderateBatchSize} ไฟล์`) &&
    replies.at(-1).includes('ทริป "ทะเล"')
);
check(
  "each file cost exactly one Drive upload subrequest, not two",
  driveUploadRequestCount === driveUploadRequestsBeforeModerateBatch + moderateBatchSize
);
check(
  `Drive uploads stayed bounded (never more than 5 in flight at once) across all ${moderateBatchSize} photos`,
  maxConcurrentDriveUploadRequests <= 5
);

// Regression test for a real report: even after cutting Drive requests back
// to one per file and bounding webhook concurrency, sending 50 photos in one
// batch still left up to 4 silently missing with no error reply. A single
// webhook invocation only has so much subrequest/CPU budget no matter how
// it's spent — each photo/video needs 2 outbound requests (fetch from LINE,
// upload to Drive), and even the fallback error reply is itself a
// subrequest, so an event landing at the platform's ceiling can lose its
// upload *and* its error message together. Fixed by queueing whole batches
// at/above IMMEDIATE_MEDIA_BATCH_LIMIT instead of processing them in one
// invocation: this sends 45 photos (over the limit) through the real
// handleWebhook entry point and confirms none upload immediately, then
// drives the queue via drainUploadQueue (the same function the cron trigger
// in wrangler.toml calls) the way it actually runs in production — a bounded
// batch at a time, each drain a fresh invocation with its own budget — until
// every file is confirmed uploaded.
const largeBatchSize = 45;
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
  `a ${largeBatchSize}-photo batch (over the threshold) does not upload anything immediately`,
  driveUploads.length === uploadsBeforeLargeBatch
);
check(
  "the whole large batch gets exactly one combined reply, not one per file",
  replies.length === repliesBeforeLargeBatch + 1 && replies.at(-1).includes(`${largeBatchSize} ไฟล์`)
);
const queuedAfterLargeBatch = await countQueuedForUser(env.ACCOUNTS, lineUserId);
check(`all ${largeBatchSize} photos were queued for background upload`, queuedAfterLargeBatch === largeBatchSize);

// First drain: DRAIN_BATCH_SIZE (20) of the 45 queued photos should upload,
// leaving 25 still queued, with a push summary mentioning both counts.
const pushesBeforeFirstDrain = pushes.length;
await drainUploadQueue(env);
check("the first drain uploads exactly one batch's worth (20) of photos", driveUploads.length === uploadsBeforeLargeBatch + 20);
check(
  "the first drain sends a push summary mentioning what's left",
  pushes.length === pushesBeforeFirstDrain + 1 &&
    pushes.at(-1).text.includes("20 ไฟล์") &&
    pushes.at(-1).text.includes("เหลืออีก 25 ไฟล์")
);
check("25 photos remain queued after the first drain", (await countQueuedForUser(env.ACCOUNTS, lineUserId)) === 25);

// Second drain: another 20 of the remaining 25.
await drainUploadQueue(env);
check("the second drain uploads another 20 photos", driveUploads.length === uploadsBeforeLargeBatch + 40);
check("5 photos remain queued after the second drain", (await countQueuedForUser(env.ACCOUNTS, lineUserId)) === 5);

// Third drain: the last 5 — queue empties, and the summary says so instead
// of mentioning a remaining count.
await drainUploadQueue(env);
check(
  `all ${largeBatchSize} photos are uploaded after enough drains`,
  driveUploads.length === uploadsBeforeLargeBatch + largeBatchSize
);
check("the queue is empty once every photo has been drained", (await countQueuedForUser(env.ACCOUNTS, lineUserId)) === 0);
check("the final drain's summary says the queue is fully caught up", pushes.at(-1).text.includes("อัปโหลดครบทุกไฟล์แล้ว"));

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

console.log(`\n${pass} passed, ${fail} failed`);
globalThis.fetch = realFetch;
process.exit(fail > 0 ? 1 : 0);
