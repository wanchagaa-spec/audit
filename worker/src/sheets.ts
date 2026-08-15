// Mirrors app/src/lib/sheetsService.ts column layout so a spreadsheet can
// be written to from both the web app and the LINE bot interchangeably.

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const TRANSACTION_HEADERS = [
  "id", "date", "type", "amount", "categoryId", "note", "rawText", "addedBy", "addedByName", "createdAt",
];

async function sheetsFetch(accessToken: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${SHEETS_BASE}${path}`, {
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
  const res = await fetch(`${SHEETS_BASE}/${spreadsheetId}?fields=spreadsheetId`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
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

export async function readAllTransactions(
  accessToken: string,
  spreadsheetId: string
): Promise<TransactionRow[]> {
  const data = await sheetsFetch(accessToken, `/${spreadsheetId}/values/Transactions!A2:J100000`);
  const rows: string[][] = data.values ?? [];
  return rows
    .filter((r) => r[0])
    .map((r) => ({
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
    }));
}

export async function readTransactionsForMonth(
  accessToken: string,
  spreadsheetId: string,
  month: string
): Promise<TransactionRow[]> {
  const all = await readAllTransactions(accessToken, spreadsheetId);
  return all.filter((r) => r.date?.startsWith(month));
}

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
  const data = await sheetsFetch(accessToken, `/${spreadsheetId}/values/Transactions!A2:J100000`);
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

  const r = rawRows[rawIndex];
  const mostRecent: TransactionRow = {
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

  await deleteSheetRow(accessToken, spreadsheetId, "Transactions", rawIndex);
  return mostRecent;
}

export interface BudgetRow {
  id: string;
  categoryId: string;
  month: string;
  limitAmount: number;
}

export async function readBudgets(accessToken: string, spreadsheetId: string): Promise<BudgetRow[]> {
  const data = await sheetsFetch(accessToken, `/${spreadsheetId}/values/Budgets!A2:D10000`);
  const rows: string[][] = data.values ?? [];
  return rows
    .filter((r) => r[0])
    .map((r) => ({
      id: r[0],
      categoryId: r[1],
      month: r[2],
      limitAmount: Number(r[3]),
    }));
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

export async function readAllDiaryEntries(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace
): Promise<DiaryRow[]> {
  await ensureDiaryTab(accessToken, spreadsheetId, kv);
  const data = await sheetsFetch(accessToken, `/${spreadsheetId}/values/Diary!A2:E100000`);
  const rows: string[][] = data.values ?? [];
  return rows
    .filter((r) => r[0])
    .map((r) => ({
      id: r[0],
      date: r[1],
      category: r[2] ?? "อื่นๆ",
      text: r[3] ?? "",
      createdAt: r[4] ?? "",
    }));
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
  const data = await sheetsFetch(accessToken, `/${spreadsheetId}/values/Diary!A2:E100000`);
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

export async function readShiftGrid(
  accessToken: string,
  spreadsheetId: string,
  kv: KVNamespace,
  monthKey: string
): Promise<ShiftGrid> {
  await ensureShiftsTab(accessToken, spreadsheetId, kv, monthKey);
  const days = daysInMonth(monthKey);
  const data = await sheetsFetch(accessToken, `/${spreadsheetId}/values/${shiftsDataRange(monthKey)}`);
  const rows: string[][] = data.values ?? [];

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
