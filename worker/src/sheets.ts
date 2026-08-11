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
