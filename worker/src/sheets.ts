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

/**
 * Deletes the most recently *created* transaction (by createdAt, matching
 * "รายการล่าสุด"'s own sort order) and returns the row that was removed, or
 * null if there's nothing to delete. Used by the "ลบรายการล่าสุด" /
 * "ยกเลิกรายการล่าสุด" undo command.
 */
export async function deleteMostRecentTransaction(
  accessToken: string,
  spreadsheetId: string
): Promise<TransactionRow | null> {
  const all = await readAllTransactions(accessToken, spreadsheetId);
  if (all.length === 0) return null;

  const mostRecent = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const rowIndex = all.findIndex((r) => r.id === mostRecent.id); // index within the A2:... data range

  const meta = await sheetsFetch(accessToken, `/${spreadsheetId}?fields=sheets.properties`);
  const sheet = (meta.sheets ?? []).find((s: any) => s.properties.title === "Transactions");
  const sheetId = sheet?.properties?.sheetId;
  if (sheetId === undefined) throw new Error("Transactions sheet not found");

  // +1 because data starts at row index 1 (0-based) — row 0 is the header.
  const startIndex = rowIndex + 1;
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
