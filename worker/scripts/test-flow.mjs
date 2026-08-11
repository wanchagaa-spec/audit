// Exercises the core LINE message-handling flow against real code
// (state.ts, chatEngine.ts, sheets.ts, googleAuth.ts) with a fake KV store
// and a mocked `fetch` standing in for Google/LINE, since we don't have
// real credentials in this environment. Run with:
//   node --experimental-strip-types scripts/test-flow.mjs

class FakeKV {
  constructor() {
    this.store = new Map();
  }
  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  async put(key, value) {
    this.store.set(key, value);
  }
  async delete(key) {
    this.store.delete(key);
  }
}

const sheetRows = []; // simulates the Transactions tab
const replies = []; // captures what would have been sent back to LINE

const realFetch = fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);

  if (u.includes("oauth2.googleapis.com/token")) {
    return new Response(JSON.stringify({ access_token: "fake-access-token", expires_in: 3600 }), {
      status: 200,
    });
  }
  if (u.endsWith("/v4/spreadsheets")) {
    return new Response(JSON.stringify({ spreadsheetId: "fake-sheet-id" }), { status: 200 });
  }
  if (u.includes(":batchUpdate")) {
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
  if (u.includes("api.line.me/v2/bot/message/reply")) {
    const body = JSON.parse(init.body);
    replies.push(body.messages[0].text);
    return new Response("{}", { status: 200 });
  }

  throw new Error(`unexpected fetch to ${u}`);
};

const { handleTextMessage } = await import("../src/index.ts");
const { setAccountLink } = await import("../src/state.ts");
const { verifyState } = await import("../src/signedState.ts");

const kv = new FakeKV();
const env = {
  ACCOUNTS: kv,
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  STATE_SIGNING_SECRET: "test-state-secret",
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

console.log(`\n${pass} passed, ${fail} failed`);
globalThis.fetch = realFetch;
process.exit(fail > 0 ? 1 : 0);
