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
const budgetRows = []; // simulates the Budgets tab
const replies = []; // captures what would have been sent back to LINE

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

let diaryTabExists = false;
const diaryRows = []; // simulates the Diary tab

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
  if (u.includes("Budgets!A2:D10000")) {
    return new Response(JSON.stringify({ values: budgetRows }), { status: 200 });
  }
  if (u.includes("api.line.me/v2/bot/message/reply")) {
    const body = JSON.parse(init.body);
    replies.push(body.messages[0].text);
    return new Response("{}", { status: 200 });
  }
  if (u.startsWith("https://api-data.line.me/v2/bot/message/") && u.endsWith("/content")) {
    return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
      status: 200,
      headers: { "content-type": "image/jpeg" },
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
    const id = nextDriveId("file");
    driveUploads.push({ id });
    return new Response(JSON.stringify({ id }), { status: 200 });
  }
  if (u.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")) {
    if (simulateInsufficientCalendarScope) return new Response("forbidden", { status: 403 });
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

const { handleTextMessage, handleImageMessage } = await import("../src/index.ts");
const { setAccountLink } = await import("../src/state.ts");
const { verifyState } = await import("../src/signedState.ts");
const { bangkokDateKey, addDaysToDateKey } = await import("../src/thaiDate.ts");

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

const photoReply = await handleImageMessage(env, lineUserId, "msg-2", Date.now(), origin);
check("photo upload confirms the trip name", photoReply.includes('ทริป "ทะเล"'));
check("an upload was recorded", driveUploads.length === uploadsBeforeTrip + 1);
check(
  "a date subfolder was created under the trip folder",
  driveFolders.some((f) => f.parentId === driveFolders.find((t) => t.name === "ทะเล").id)
);

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

simulateInsufficientCalendarScope = true;
const relinkReply = await handleTextMessage(env, lineUserId, "มีนัดอะไรวันนี้", origin);
check(
  "a scope-less refresh token gets a re-link prompt, not a crash",
  relinkReply.includes("สิทธิ์ปฏิทินเพิ่ม") && relinkReply.includes("accounts.google.com")
);
simulateInsufficientCalendarScope = false;

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

const diaryMonthReply = await handleTextMessage(env, lineUserId, "ไดอารี่เดือนนี้มีอะไรบ้าง", origin);
check(
  "monthly diary list shows both entries",
  diaryMonthReply.includes("อากาศดีมาก") && diaryMonthReply.includes("ประชุมเสร็จเร็ว")
);

const diarySearchReply = await handleTextMessage(env, lineUserId, "ค้นหาไดอารี่ ประชุม", origin);
check(
  "diary search only matches the relevant entry",
  diarySearchReply.includes("ประชุมเสร็จเร็ว") && !diarySearchReply.includes("อากาศดีมาก")
);

console.log(`\n${pass} passed, ${fail} failed`);
globalThis.fetch = realFetch;
process.exit(fail > 0 ? 1 : 0);
