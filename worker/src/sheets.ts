// The column layout below was originally shared with the React PWA's
// sheetsService.ts, so a book could be written to from either side. The PWA
// is gone (PLAN.md 17.46) and this is now the only writer — but the layout
// stays exactly as it was, because books created by the old app are still
// real spreadsheets holding real money, and the bot has to keep reading them.

import { fetchWithTimeout, NETWORK_TIMEOUTS } from "./timeouts.ts";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const TRANSACTION_HEADERS = [
  "id", "date", "type", "amount", "categoryId", "note", "rawText", "addedBy", "addedByName", "createdAt",
];

async function sheetsFetch(accessToken: string, path: string, init: RequestInit = {}): Promise<any> {
  // Bounded since PLAN.md 17.52 — every read and write in this file goes
  // through here, and a hung one used to be able to hold a reply open past
  // the LINE token that was meant to answer it.
  const res = await fetchWithTimeout("Google Sheets", NETWORK_TIMEOUTS.sheets, `${SHEETS_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Google Sheets API error (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// ---- Reading several ranges at once (PLAN.md 17.45) -----------------------
// Every read in this file asks Google for a whole tab, because the Sheets
// values API has no "where date >= this month" — you get a rectangle or you
// get nothing. So the lever that actually exists isn't fetching fewer rows,
// it's fetching them fewer *times*, and several handlers here were doing the
// opposite: one HTTP request per tab, fired together and all waited on.
// "งบเหลือเท่าไหร่" made two, /view/budgets two, and the AI Q&A four.
//
// values:batchGet returns any number of ranges from the same spreadsheet in
// a single request, which collapses all of those to one. Rows still grow
// without bound — that part is inherent to the sheet being the database, and
// is a separate problem for the day a book gets big enough to feel it — but
// nothing pays for the same tab twice in one message anymore.

const TRANSACTIONS_RANGE = "Transactions!A2:J";
const BUDGETS_RANGE = "Budgets!A2:D";
const DIARY_RANGE = "Diary!A2:E";

/** Fetches several ranges in one HTTP request. Results come back positionally
 * — `valueRanges[i]` is `ranges[i]` — which is the documented correspondence
 * and the only usable one: the `range` string Google echoes back is
 * normalised (tab names get quoted, open-ended bounds get expanded to the
 * grid size), so it never matches what was asked for. A range with no data
 * comes back as an entry with no `values`, not as a missing entry. */
async function sheetsBatchGet(
  accessToken: string,
  spreadsheetId: string,
  ranges: string[]
): Promise<string[][][]> {
  const query = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
  const data = await sheetsFetch(accessToken, `/${spreadsheetId}/values:batchGet?${query}`);
  const valueRanges = (data.valueRanges ?? []) as Array<{ values?: string[][] }>;
  return ranges.map((_, i) => valueRanges[i]?.values ?? []);
}

export async function createBookSpreadsheet(accessToken: string, bookName: string): Promise<string> {
  const created = await sheetsFetch(accessToken, "", {
    method: "POST",
    body: JSON.stringify({
      properties: { title: `${bookName} — จดบัญชี` },
      sheets: [
        { properties: { title: "Transactions" } },
        { properties: { title: "Categories" } },
        { properties: { title: "Budgets" } },
      ],
    }),
  });
  const spreadsheetId = created.spreadsheetId as string;
  await sheetsFetch(accessToken, `/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: [{ range: "Transactions!A1", values: [TRANSACTION_HEADERS] }],
    }),
  });
  return spreadsheetId;
}

/** Lightweight check for whether an access token can read a given
 * spreadsheet — used by group mode's OAuth relink flow (PLAN.md 17) to
 * tell "the same Google account re-consenting with broader scope" (can
 * still access the group's existing spreadsheet) apart from "a different
 * group member completing the link with their own separate account"
 * (can't), since there's no LINE API to verify who actually clicked the
 * link. */
export async function canAccessSpreadsheet(accessToken: string, spreadsheetId: string): Promise<boolean> {
  // Not sheetsFetch, because a non-2xx here is the answer rather than an
  // error — but it gets the same deadline (PLAN.md 17.52). A timeout is not
  // "no access", so it throws rather than quietly returning false and
  // sending someone down the re-link flow over a slow request.
  const res = await fetchWithTimeout(
    "Google Sheets access check",
    NETWORK_TIMEOUTS.sheets,
    `${SHEETS_BASE}/${spreadsheetId}?fields=spreadsheetId`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return res.ok;
}

export interface TransactionRow {
  id: string;
  date: string;
  type: "income" | "expense";
  amount: number;
  categoryId: string;
  note: string;
  rawText: string;
  addedBy: string;
  addedByName: string;
  createdAt: string;
}

export async function appendTransaction(
  accessToken: string,
  spreadsheetId: string,
  tx: TransactionRow
): Promise<void> {
  const values = [[
    tx.id, tx.date, tx.type, tx.amount, tx.categoryId, tx.note, tx.rawText, tx.addedBy, tx.addedByName, tx.createdAt,
  ]];
  await sheetsFetch(accessToken, `/${spreadsheetId}/values/Transactions!A1:append?valueInputOption=RAW`, {
    method: "POST",
    body: JSON.stringify({ values }),
  });
}

function toTransactionRow(r: string[]): TransactionRow {
  return {
    id: r[0],
    date: r[1],
    type: r[2] as "income" | "expense",
    amount: Number(r[3]),
    categoryId: r[4],
    note: r[5] ?? "",
    rawText: r[6] ?? "",
    addedBy: r[7] ?? "",
    addedByName: r[8] ?? "",
    createdAt: r[9] ?? "",
  };
}

/** Drops rows whose id cell is blank — a row someone cleared by hand in
 * Google Sheets still comes back from the values API, as an empty entry. */
function parseTransactionRows(raw: string[][]): TransactionRow[] {
  return raw.filter((r) => r[0]).map(toTransactionRow);
}

export async function readAllTransactions(
  accessToken: string,
  spreadsheetId: string
): Promise<TransactionRow[]> {
  const data = await sheetsFetch(accessToken, `/${spreadsheetId}/values/${TRANSACTIONS_RANGE}`);
  return parseTransactionRows(data.values ?? []);
}

// ---- Reading from a month onward, not from the beginning (PLAN.md 17.47) --
// 17.45 stopped the same tab being fetched twice in one message, but every
// one of those fetches still pulled the entire history, and that grows
// forever. Almost everything the bot answers is about the current month.
//
// The plan considered first was splitting Transactions into one tab per
// month with a precomputed summary tab. That was turned down: the summary
// would be a cache living inside the user's own spreadsheet, and this is a
// spreadsheet its owner edits by hand — delete a row and the summary keeps
// reporting the old total, confidently and silently. A wrong money figure is
// worse than a slow one. It would also need every live book migrated with an
// API that has no transactions, and it would break the five commands that
// genuinely span months ("เหลือเงินเท่าไหร่", "ค้นหา", "รายการล่าสุด",
// "ลบรายการล่าสุด", and "สรุปสัปดาห์นี้" for the ~4 days a week straddles
// two months).
//
// What's here instead: remember which sheet row a month starts on. Rows are
// appended in chronological order, so a month is a contiguous run, and
// `Transactions!A<start>:J` is one request whose size is bounded by how much
// has happened since that month began rather than by the whole history. The
// tab layout, the columns and every existing book are untouched, and nothing
// is derived and stored that could disagree with the rows themselves.
//
// The remembered row is a hint, never trusted blindly — see checkMonthWindow.

/** Remembered per book and per month. TTL only so keys for long-past months
 * don't accumulate; expiry costs one full read and is otherwise invisible. */
const MONTH_START_TTL_SECONDS = 90 * 24 * 60 * 60;

function monthStartKey(spreadsheetId: string, month: string): string {
  return `tx-month-start:${spreadsheetId}:${month}`;
}

/** The 1-based sheet row where `month` begins. When the month has no rows
 * yet this is the row its first one will land on, which is what makes the
 * hint usable from the very start of a month rather than only after the
 * first save. Indices come from the raw response, blanks included, for the
 * same reason deleteSheetRow's do. */
function findMonthStartRow(rawRows: string[][], month: string): number {
  const index = rawRows.findIndex((r) => r[0] && String(r[1] ?? "").startsWith(month));
  return index === -1 ? rawRows.length + 2 : index + 2;
}

/**
 * Is the remembered start row still a real month boundary? Answered from the
 * single row directly above the window, fetched in the same batchGet, so the
 * check costs nothing extra.
 *
 * It must exist and belong to an earlier month. Blank means rows above were
 * cleared or deleted; a date in `month` or later means the index has drifted
 * down and rows of this month are now sitting above the window — the one
 * failure that would silently under-report money. Either way the hint is
 * discarded and rebuilt from a full read.
 *
 * Drift the other way (the row points too far *up*, into an earlier month)
 * needs no detection: the window simply starts early, and callers filter by
 * date regardless, so the answer stays correct and only the request is
 * bigger than it had to be.
 *
 * Row 2 has nothing above it but the header, so there is nothing to check
 * and nothing that can have drifted.
 */
function checkMonthWindow(startRow: number, boundaryRaw: string[][], month: string): boolean {
  if (startRow <= 2) return true;
  const boundary = boundaryRaw[0];
  if (!boundary || !boundary[0]) return false;
  const boundaryMonth = String(boundary[1] ?? "").slice(0, 7);
  return boundaryMonth !== "" && boundaryMonth < month;
}

/**
 * Every transaction from the start of `month` to the end of the sheet, plus
 * whatever other ranges the caller wants, in one HTTP request.
 *
 * Open-ended on purpose: a window that runs to the end of the sheet is what
 * lets "สรุปสัปดาห์นี้" cross a month boundary and "สรุปเดือนที่แล้ว" work,
 * both from a single read. Callers filter down to the dates they want.
 */
async function readTransactionsFromMonth(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  month: string,
  extraRanges: string[] = []
): Promise<{ transactions: TransactionRow[]; extras: string[][][] }> {
  // Applied to both paths, not just the full read. A window can legitimately
  // open earlier than the month it was asked for — a hint that drifted *up*
  // is deliberately not detected, since starting early costs a bigger request
  // but never a wrong answer — and without this the two paths would return
  // different row sets for the same call. Every caller filters by date on top
  // of this anyway, which is exactly why the difference could sit here
  // unnoticed; the function's own promise is what's being kept.
  const fromFirstOfMonth = (rows: TransactionRow[]) => rows.filter((r) => r.date >= `${month}-01`);

  const cached = Number(await kv.get(monthStartKey(spreadsheetId, month)));
  if (Number.isInteger(cached) && cached >= 2) {
    // The boundary row needs only its id and date, so it asks for A:B.
    const boundaryRanges = cached > 2 ? [`Transactions!A${cached - 1}:B${cached - 1}`] : [];
    const raw = await sheetsBatchGet(accessToken, spreadsheetId, [
      ...boundaryRanges,
      `Transactions!A${cached}:J`,
      ...extraRanges,
    ]);
    const boundaryRaw = boundaryRanges.length > 0 ? raw[0] : [];
    if (checkMonthWindow(cached, boundaryRaw, month)) {
      return {
        transactions: fromFirstOfMonth(parseTransactionRows(raw[boundaryRanges.length])),
        extras: raw.slice(boundaryRanges.length + 1),
      };
    }
    // Hint no good — fall through and rebuild it from the whole tab.
  }

  const raw = await sheetsBatchGet(accessToken, spreadsheetId, [TRANSACTIONS_RANGE, ...extraRanges]);
  const allRaw = raw[0];
  await kv.put(monthStartKey(spreadsheetId, month), String(findMonthStartRow(allRaw, month)), {
    expirationTtl: MONTH_START_TTL_SECONDS,
  });
  return { transactions: fromFirstOfMonth(parseTransactionRows(allRaw)), extras: raw.slice(1) };
}

/** Rows dated on or after the first of `month`. */
/**
 * Empties the Transactions tab, keeping the header row (PLAN.md 17.48).
 *
 * `values:clear` rather than deleting rows: it is one request whatever the
 * size of the book, and it cannot half-succeed the way a batch of
 * deleteDimension requests could. It leaves the rows physically present but
 * blank, which every reader here already copes with — parseTransactionRows
 * drops rows with no id, and deleteMostRecentTransaction indexes off the raw
 * response precisely so blanks don't shift anything.
 *
 * Also forgets the remembered month-start rows for this book: they would
 * point past the end of an emptied sheet, and while the boundary check would
 * catch that on the next read, a wipe is exactly the moment not to rely on
 * self-healing for money.
 */
export async function clearAllTransactions(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace
): Promise<void> {
  await sheetsFetch(accessToken, `/${spreadsheetId}/values/${TRANSACTIONS_RANGE}:clear`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  const stale = await kv.list({ prefix: `tx-month-start:${spreadsheetId}:` });
  await Promise.all(stale.keys.map((k) => kv.delete(k.name)));
}

export async function readTransactionsFrom(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  month: string
): Promise<TransactionRow[]> {
  const { transactions } = await readTransactionsFromMonth(accessToken, spreadsheetId, kv, month);
  return transactions;
}

/** Just the one month. */
export async function readTransactionsForMonth(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  month: string
): Promise<TransactionRow[]> {
  const rows = await readTransactionsFrom(accessToken, spreadsheetId, kv, month);
  return rows.filter((r) => r.date?.startsWith(month));
}

/** One month's spending and this month's limits, in one HTTP request — for
 * "งบเหลือเท่าไหร่", /view/budgets, and the after-a-save budget line. */
export async function readMonthTransactionsAndBudgets(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  month: string
): Promise<{ transactions: TransactionRow[]; budgets: BudgetRow[] }> {
  const { transactions, extras } = await readTransactionsFromMonth(
    accessToken,
    spreadsheetId,
    kv,
    month,
    [BUDGETS_RANGE]
  );
  return {
    transactions: transactions.filter((r) => r.date?.startsWith(month)),
    budgets: parseBudgetRows(extras[0]),
  };
}

// Nothing invalidates these hints, and nothing needs to. An append lands
// below every window, so a row that was a boundary stays one. A delete can
// shift rows out from under a hint, but only ever in the direction
// checkMonthWindow detects: removing a row above the window pulls this
// month's first row up into the boundary slot, which fails the check and
// triggers a rebuild. Removing one at or below the start row leaves the rows
// above it — and therefore the boundary — exactly where they were. The same
// check is what covers edits made by hand in Google Sheets, which no
// invalidation hook could ever see.

/** Shared by deleteMostRecentTransaction and deleteDiaryEntry — resolves
 * the tab's sheetId and deletes one data row. `dataRowIndex` is 0-based
 * within the raw A2:... values range (row 2 = index 0), so blank rows
 * count — see updateDiaryEntry's comment on why indices must come from
 * the raw response, never a filtered list. */
async function deleteSheetRow(
  accessToken: string,
  spreadsheetId: string,
  sheetTitle: string,
  dataRowIndex: number
): Promise<void> {
  const meta = await sheetsFetch(accessToken, `/${spreadsheetId}?fields=sheets.properties`);
  const sheet = (meta.sheets ?? []).find((s: any) => s.properties.title === sheetTitle);
  const sheetId = sheet?.properties?.sheetId;
  if (sheetId === undefined) throw new Error(`${sheetTitle} sheet not found`);

  // +1 because data starts at row index 1 (0-based) — row 0 is the header.
  const startIndex = dataRowIndex + 1;
  await sheetsFetch(accessToken, `/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: [
        {
          deleteDimension: {
            range: { sheetId, dimension: "ROWS", startIndex, endIndex: startIndex + 1 },
          },
        },
      ],
    }),
  });
}

/**
 * Deletes the most recently *created* transaction (by createdAt, matching
 * "รายการล่าสุด"'s own sort order) and returns the row that was removed, or
 * null if there's nothing to delete. Used by the "ลบรายการล่าสุด" /
 * "ยกเลิกรายการล่าสุด" undo command.
 *
 * Scans the *raw* values response to find the physical row, not the
 * filtered list readAllTransactions returns — a blank (cells-cleared) row
 * anywhere above the target would otherwise skew the index and delete a
 * neighboring row. Same fix as updateDiaryEntry/deleteDiaryEntry (see the
 * Diary section's comment), applied here because this function had the
 * identical latent flaw.
 */
export async function deleteMostRecentTransaction(
  accessToken: string,
  spreadsheetId: string
): Promise<TransactionRow | null> {
  const data = await sheetsFetch(accessToken, `/${spreadsheetId}/values/${TRANSACTIONS_RANGE}`);
  const rawRows: string[][] = data.values ?? [];

  // Most recent by createdAt (column index 9); ties keep the earliest row,
  // matching the previous sort-based implementation's stable-sort behavior.
  let rawIndex = -1;
  for (let i = 0; i < rawRows.length; i++) {
    const r = rawRows[i];
    if (!r[0]) continue;
    if (rawIndex === -1 || (r[9] ?? "") > (rawRows[rawIndex][9] ?? "")) rawIndex = i;
  }
  if (rawIndex === -1) return null;

  const mostRecent = toTransactionRow(rawRows[rawIndex]);

  await deleteSheetRow(accessToken, spreadsheetId, "Transactions", rawIndex);
  return mostRecent;
}

export interface BudgetRow {
  id: string;
  categoryId: string;
  month: string;
  limitAmount: number;
}

function parseBudgetRows(raw: string[][]): BudgetRow[] {
  return raw
    .filter((r) => r[0])
    .map((r) => ({
      id: r[0],
      categoryId: r[1],
      month: r[2],
      limitAmount: Number(r[3]),
    }));
}

export async function readBudgets(accessToken: string, spreadsheetId: string): Promise<BudgetRow[]> {
  const data = await sheetsFetch(accessToken, `/${spreadsheetId}/values/${BUDGETS_RANGE}`);
  return parseBudgetRows(data.values ?? []);
}

// ---- Budget writes (PLAN.md 17.43) ---------------------------------------
// readBudgets above has been here since the beginning; nothing could ever
// write one. Budgets were set in the separate React PWA, which signs into
// Google on its own and creates its *own* spreadsheet — so in practice a
// LINE user's budgets often lived in a different book from the one the bot
// reads, and "งบเหลือเท่าไหร่" answered "ยังไม่ได้ตั้งงบไว้เลย" forever.
//
// The layout matched the React PWA's sheetsService.ts exactly (same header,
// same column order) so a book written by either side stayed readable by
// both. The PWA is gone now (PLAN.md 17.46); the layout stays for the books
// it left behind.

const BUDGET_HEADERS = ["id", "categoryId", "month", "limitAmount"];

// createBookSpreadsheet makes the Budgets *tab* but only ever wrote headers
// for Transactions, so a bot-created book has an empty, header-less Budgets
// sheet — while readBudgets starts at A2, assuming row 1 is a header. That
// mismatch was invisible while nothing wrote budgets; the moment something
// does, the first one would land in row 1 and be skipped on read. Writing
// the header before the first write is what keeps the two ends agreeing.
// Same lazy, KV-cached shape as ensureDiaryTab above, and it also covers a
// book whose tab was deleted by hand.
async function ensureBudgetsTab(accessToken: string, spreadsheetId: string, kv: KVNamespace): Promise<void> {
  const cacheKey = `budgets-tab:${spreadsheetId}`;
  if (await kv.get(cacheKey)) return;

  const meta = await sheetsFetch(accessToken, `/${spreadsheetId}?fields=sheets.properties.title`);
  const titles: string[] = (meta.sheets ?? []).map((s: any) => s.properties.title);
  if (!titles.includes("Budgets")) {
    await sheetsFetch(accessToken, `/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: "Budgets" } } }] }),
    });
  }
  // Written unconditionally rather than only for a new tab: the tab usually
  // already exists (createBookSpreadsheet made it) but without its header.
  // A1:D1 is the header row either way, so setting it is idempotent.
  await sheetsFetch(accessToken, `/${spreadsheetId}/values/Budgets!A1:D1?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: [BUDGET_HEADERS] }),
  });
  await kv.put(cacheKey, "1");
}

async function readBudgetRawRows(accessToken: string, spreadsheetId: string): Promise<string[][]> {
  const data = await sheetsFetch(accessToken, `/${spreadsheetId}/values/${BUDGETS_RANGE}`);
  return data.values ?? [];
}

/** One budget per (category, month): setting the same pair again replaces
 * the existing figure rather than stacking a second row that readBudgets
 * would then report twice. Row indices come from the raw values response,
 * never a filtered list — same reasoning as updateDiaryEntry above. */
export async function upsertBudget(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  budget: { categoryId: string; month: string; limitAmount: number }
): Promise<void> {
  await ensureBudgetsTab(accessToken, spreadsheetId, kv);
  const rawRows = await readBudgetRawRows(accessToken, spreadsheetId);
  const rawIndex = rawRows.findIndex((r) => r[1] === budget.categoryId && r[2] === budget.month);

  if (rawIndex === -1) {
    await sheetsFetch(accessToken, `/${spreadsheetId}/values/Budgets!A1:append?valueInputOption=RAW`, {
      method: "POST",
      body: JSON.stringify({
        values: [[crypto.randomUUID(), budget.categoryId, budget.month, budget.limitAmount]],
      }),
    });
    return;
  }

  const rowNumber = rawIndex + 2; // +1 for the header, +1 for 1-based rows
  await sheetsFetch(accessToken, `/${spreadsheetId}/values/Budgets!A${rowNumber}:D${rowNumber}?valueInputOption=RAW`, {
    method: "PUT",
    // Keeps the existing id — the row is the same budget with a new figure,
    // not a new one.
    body: JSON.stringify({ values: [[rawRows[rawIndex][0], budget.categoryId, budget.month, budget.limitAmount]] }),
  });
}

/** Returns false (not an error) when there was no budget for that pair —
 * the caller reports "there wasn't one" rather than treating it as failure. */
export async function deleteBudget(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  categoryId: string,
  month: string
): Promise<boolean> {
  await ensureBudgetsTab(accessToken, spreadsheetId, kv);
  const rawRows = await readBudgetRawRows(accessToken, spreadsheetId);
  const rawIndex = rawRows.findIndex((r) => r[1] === categoryId && r[2] === month);
  if (rawIndex === -1) return false;

  await deleteSheetRow(accessToken, spreadsheetId, "Budgets", rawIndex);
  return true;
}

// ---- Diary (PLAN.md 15.4) -----------------------------------------------
// Personal-only tab: never used for shared group-book spreadsheets (PLAN.md
// 15.5). Older spreadsheets (created before this feature existed) don't have
// a Diary tab yet, so every write/read lazily creates it on first use.

const DIARY_HEADERS = ["id", "date", "category", "text", "createdAt"];

export interface DiaryRow {
  id: string;
  date: string;
  category: string;
  text: string;
  createdAt: string;
}

// Cached per spreadsheetId in KV once confirmed, so normal reads/writes skip
// the metadata check entirely instead of paying for a spreadsheets.get on
// every single diary interaction (a tab, once created, doesn't go away).
async function ensureDiaryTab(accessToken: string, spreadsheetId: string, kv: KVNamespace): Promise<void> {
  const cacheKey = `diary-tab:${spreadsheetId}`;
  if (await kv.get(cacheKey)) return;

  const meta = await sheetsFetch(accessToken, `/${spreadsheetId}?fields=sheets.properties.title`);
  const titles: string[] = (meta.sheets ?? []).map((s: any) => s.properties.title);
  if (!titles.includes("Diary")) {
    await sheetsFetch(accessToken, `/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: "Diary" } } }] }),
    });
    await sheetsFetch(accessToken, `/${spreadsheetId}/values/Diary!A1?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [DIARY_HEADERS] }),
    });
  }
  await kv.put(cacheKey, "1");
}

export async function appendDiaryEntry(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  entry: DiaryRow
): Promise<void> {
  await ensureDiaryTab(accessToken, spreadsheetId, kv);
  const values = [[entry.id, entry.date, entry.category, entry.text, entry.createdAt]];
  await sheetsFetch(accessToken, `/${spreadsheetId}/values/Diary!A1:append?valueInputOption=RAW`, {
    method: "POST",
    body: JSON.stringify({ values }),
  });
}

function parseDiaryRows(raw: string[][]): DiaryRow[] {
  return raw
    .filter((r) => r[0])
    .map((r) => ({
      id: r[0],
      date: r[1],
      category: r[2] ?? "อื่นๆ",
      text: r[3] ?? "",
      createdAt: r[4] ?? "",
    }));
}

export async function readAllDiaryEntries(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace
): Promise<DiaryRow[]> {
  await ensureDiaryTab(accessToken, spreadsheetId, kv);
  const data = await sheetsFetch(accessToken, `/${spreadsheetId}/values/${DIARY_RANGE}`);
  return parseDiaryRows(data.values ?? []);
}

// PLAN.md 17.36: edit/delete now live on /view/diary (viewDiaryPage.ts)
// instead of chat commands — a diary entry is a single row identified by
// `id`, the same row-per-entry shape as Transactions. `createdAt` is
// deliberately preserved on edit (never part of the caller's `updates`) —
// it's when the entry was originally written, not when it was last edited.
//
// Both helpers locate the row by scanning the *raw* values response, NOT
// the filtered list readAllDiaryEntries returns — the values API returns
// a blank row (one whose cells were cleared by hand in Google Sheets, as
// opposed to the row itself being deleted) as an empty [] entry, which
// the filtered list drops. An index into the filtered list would then be
// off by one physical row for everything below the blank, silently
// editing/deleting a *neighboring* entry. Caught in code review before
// this ever shipped, along with the same latent flaw in
// deleteMostRecentTransaction (fixed there too, further up).
//
// Known, accepted race (no fix available): the Sheets API has no
// transactions, so between the raw read here and the PUT/batchUpdate that
// follows, a concurrent delete from another tab can shift rows and land
// this write on the wrong one. The window is milliseconds wide on a
// single-user personal tool — noted honestly rather than pretended away.

async function readDiaryRawRows(accessToken: string, spreadsheetId: string): Promise<string[][]> {
  const data = await sheetsFetch(accessToken, `/${spreadsheetId}/values/${DIARY_RANGE}`);
  return data.values ?? [];
}

/** Returns false (not an error) if no row with this id exists — the entry
 * may already have been deleted by a concurrent edit from the same user in
 * another tab; the caller treats this the same as "nothing to update". */
export async function updateDiaryEntry(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  id: string,
  updates: { date: string; category: string; text: string }
): Promise<boolean> {
  await ensureDiaryTab(accessToken, spreadsheetId, kv);
  const rawRows = await readDiaryRawRows(accessToken, spreadsheetId);
  const rawIndex = rawRows.findIndex((r) => r[0] === id);
  if (rawIndex === -1) return false;

  const rowNumber = rawIndex + 2; // +1 for the header row, +1 to go from 0-based to 1-based
  const values = [[id, updates.date, updates.category, updates.text, rawRows[rawIndex][4] ?? ""]];
  await sheetsFetch(accessToken, `/${spreadsheetId}/values/Diary!A${rowNumber}:E${rowNumber}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values }),
  });
  return true;
}

/** Returns false (not an error) if no row with this id exists — same
 * already-gone reasoning as updateDiaryEntry above. */
export async function deleteDiaryEntry(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  id: string
): Promise<boolean> {
  await ensureDiaryTab(accessToken, spreadsheetId, kv);
  const rawRows = await readDiaryRawRows(accessToken, spreadsheetId);
  const rawIndex = rawRows.findIndex((r) => r[0] === id);
  if (rawIndex === -1) return false;

  await deleteSheetRow(accessToken, spreadsheetId, "Diary", rawIndex);
  return true;
}

// ---- Shifts (PLAN.md 17.18) ----------------------------------------------
// Personal-only grid ("ตารางเวรของฉัน"): a tab per month, shaped exactly like
// the web page shows it — a header row of day-of-month numbers, then one
// fixed row per shift type with a checkmark in whichever day columns that
// shift is worked. Unlike Transactions/Diary's append-only row-per-entry
// log, the web form submits the *entire* month's grid state on every save,
// so overwriting the whole data range with one PUT is simpler and safer
// than diffing individual cell changes against whatever rows already exist.

export const SHIFT_TYPES = ["เวร 7.00", "เวรเช้า", "เวรบ่าย", "เวรดึก"] as const;
export type ShiftType = (typeof SHIFT_TYPES)[number];

export interface ShiftGrid {
  monthKey: string; // YYYY-MM
  days: number; // days in that month
  // checked[shiftType] holds the day-of-month numbers (1-based) checked for that shift.
  checked: Record<ShiftType, number[]>;
}

function isShiftType(value: string): value is ShiftType {
  return (SHIFT_TYPES as readonly string[]).includes(value);
}

function daysInMonth(monthKey: string): number {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day of this one
}

/** 1 -> "A", 26 -> "Z", 27 -> "AA", ... — A1-notation column letters for a
 * 1-based column index. Needed because a month's grid is up to 32 columns
 * wide (31 days + the shift-type label column), past "Z". */
function columnLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function shiftsTabName(monthKey: string): string {
  return `Shifts-${monthKey}`;
}

function shiftsDataRange(monthKey: string): string {
  const lastCol = columnLetter(daysInMonth(monthKey) + 1);
  const lastRow = 1 + SHIFT_TYPES.length;
  return `'${shiftsTabName(monthKey)}'!A2:${lastCol}${lastRow}`;
}

// Cached per (spreadsheetId, monthKey) once confirmed, same reasoning as
// ensureDiaryTab — a tab, once created, doesn't go away, so normal reads/
// writes should skip the metadata check entirely.
async function ensureShiftsTab(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  monthKey: string
): Promise<void> {
  const cacheKey = `shifts-tab:${spreadsheetId}:${monthKey}`;
  if (await kv.get(cacheKey)) return;

  const tabName = shiftsTabName(monthKey);
  const meta = await sheetsFetch(accessToken, `/${spreadsheetId}?fields=sheets.properties.title`);
  const titles: string[] = (meta.sheets ?? []).map((s: any) => s.properties.title);
  if (!titles.includes(tabName)) {
    await sheetsFetch(accessToken, `/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }),
    });
    const header = ["ประเภทเวร", ...Array.from({ length: daysInMonth(monthKey) }, (_, i) => String(i + 1))];
    const typeRows = SHIFT_TYPES.map((t) => [t]);
    await sheetsFetch(accessToken, `/${spreadsheetId}/values/'${tabName}'!A1?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [header, ...typeRows] }),
    });
  }
  await kv.put(cacheKey, "1");
}

function parseShiftGrid(monthKey: string, rows: string[][]): ShiftGrid {
  const days = daysInMonth(monthKey);
  const checked = Object.fromEntries(SHIFT_TYPES.map((t) => [t, [] as number[]])) as Record<ShiftType, number[]>;
  for (const row of rows) {
    const type = row[0];
    if (!isShiftType(type)) continue;
    for (let day = 1; day <= days; day++) {
      const cell = row[day]; // row[0] is the type label, row[1] is day 1, etc.
      if (cell && cell.trim() !== "") checked[type].push(day);
    }
  }
  return { monthKey, days, checked };
}

export async function readShiftGrid(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  monthKey: string
): Promise<ShiftGrid> {
  await ensureShiftsTab(accessToken, spreadsheetId, kv, monthKey);
  const data = await sheetsFetch(accessToken, `/${spreadsheetId}/values/${shiftsDataRange(monthKey)}`);
  return parseShiftGrid(monthKey, data.values ?? []);
}

// ---- Everything the AI Q&A needs, in one request (PLAN.md 17.45) ---------
// answerQuestion builds the model's prompt out of four tabs at once, and was
// fetching each with its own HTTP request — a Promise.all of four, so four
// round trips deep into the 15-second budget of a question the user is
// sitting and waiting on. They're all ranges of the same spreadsheet, which
// is exactly what values:batchGet is for.
//
// The two ensure* calls stay separate and go first: a batchGet naming a tab
// that doesn't exist yet fails the whole request, not just that range. Both
// are KV-cached after the first time (see ensureDiaryTab), so on the normal
// path they cost nothing and this really is one request.

export interface AccountSnapshot {
  transactions: TransactionRow[];
  diary: DiaryRow[];
  budgets: BudgetRow[];
  shifts: ShiftGrid;
}

export async function readAccountSnapshot(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  monthKey: string
): Promise<AccountSnapshot> {
  await Promise.all([
    ensureDiaryTab(accessToken, spreadsheetId, kv),
    ensureShiftsTab(accessToken, spreadsheetId, kv, monthKey),
  ]);
  // Transactions come windowed to the month (PLAN.md 17.47) — answerQuestion
  // filtered them to `monthKey` immediately anyway, so nothing downstream
  // changes. Diary is still read whole; it's a handful of rows a day of text
  // and has never been the expensive one.
  const { transactions, extras } = await readTransactionsFromMonth(accessToken, spreadsheetId, kv, monthKey, [
    DIARY_RANGE,
    BUDGETS_RANGE,
    shiftsDataRange(monthKey),
  ]);
  const [diaryRaw, budgetRaw, shiftRaw] = extras;
  return {
    transactions,
    diary: parseDiaryRows(diaryRaw),
    budgets: parseBudgetRows(budgetRaw),
    shifts: parseShiftGrid(monthKey, shiftRaw),
  };
}

/** Overwrites a whole month's grid with exactly the given checked cells —
 * anything not in `checkedCells` is cleared, matching a plain HTML
 * checkbox form's semantics (only checked boxes are submitted at all). */
export async function saveShiftGrid(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  monthKey: string,
  checkedCells: Array<{ shiftType: ShiftType; day: number }>
): Promise<void> {
  await ensureShiftsTab(accessToken, spreadsheetId, kv, monthKey);
  const days = daysInMonth(monthKey);
  const checkedSet = new Set(checkedCells.filter((c) => c.day >= 1 && c.day <= days).map((c) => `${c.shiftType}|${c.day}`));
  const rows = SHIFT_TYPES.map((t) => [
    t,
    ...Array.from({ length: days }, (_, i) => (checkedSet.has(`${t}|${i + 1}`) ? "✓" : "")),
  ]);
  await sheetsFetch(accessToken, `/${spreadsheetId}/values/${shiftsDataRange(monthKey)}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: rows }),
  });
}
