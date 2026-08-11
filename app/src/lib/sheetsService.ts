// Thin wrapper around the Google Sheets REST API. Each "book" (personal or
// group) maps to one spreadsheet with three tabs: Transactions, Categories,
// Budgets — matching the layout documented in PLAN.md section 4.

import { getAccessToken } from "./googleAuth";
import type { Budget, Category, Transaction } from "../types";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

const TRANSACTION_HEADERS = [
  "id", "date", "type", "amount", "categoryId", "note", "rawText", "addedBy", "addedByName", "createdAt",
];
const CATEGORY_HEADERS = ["id", "name", "icon", "type", "keywords", "isCustom"];
const BUDGET_HEADERS = ["id", "categoryId", "month", "limitAmount"];

async function sheetsFetch(path: string, init: RequestInit = {}): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${SHEETS_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Sheets API error (${res.status}): ${body}`);
  }
  return res.json();
}

export async function createBookSpreadsheet(bookName: string): Promise<string> {
  const created = await sheetsFetch("", {
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

  await sheetsFetch(`/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: [
        { range: "Transactions!A1", values: [TRANSACTION_HEADERS] },
        { range: "Categories!A1", values: [CATEGORY_HEADERS] },
        { range: "Budgets!A1", values: [BUDGET_HEADERS] },
      ],
    }),
  });

  return spreadsheetId;
}

export async function appendTransactions(
  spreadsheetId: string,
  transactions: Transaction[]
): Promise<void> {
  if (transactions.length === 0) return;
  const values = transactions.map((t) => [
    t.id, t.date, t.type, t.amount, t.categoryId, t.note, t.rawText, t.addedBy, t.addedByName, t.createdAt,
  ]);
  await sheetsFetch(`/${spreadsheetId}/values/Transactions!A1:append?valueInputOption=RAW`, {
    method: "POST",
    body: JSON.stringify({ values }),
  });
}

export async function overwriteTransactions(
  spreadsheetId: string,
  transactions: Transaction[]
): Promise<void> {
  const values = [
    TRANSACTION_HEADERS,
    ...transactions.map((t) => [
      t.id, t.date, t.type, t.amount, t.categoryId, t.note, t.rawText, t.addedBy, t.addedByName, t.createdAt,
    ]),
  ];
  await sheetsFetch(`/${spreadsheetId}/values/Transactions!A1:clear`, { method: "POST" });
  await sheetsFetch(`/${spreadsheetId}/values/Transactions!A1?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values }),
  });
}

export async function readTransactions(spreadsheetId: string, bookId: string): Promise<Transaction[]> {
  const data = await sheetsFetch(`/${spreadsheetId}/values/Transactions!A2:J100000`);
  const rows: string[][] = data.values ?? [];
  return rows
    .filter((r) => r[0])
    .map((r) => ({
      id: r[0],
      bookId,
      date: r[1],
      type: r[2] as Transaction["type"],
      amount: Number(r[3]),
      categoryId: r[4],
      note: r[5] ?? "",
      rawText: r[6] ?? "",
      addedBy: r[7] ?? "",
      addedByName: r[8] ?? "",
      createdAt: r[9] ?? "",
    }));
}

export async function overwriteCategories(spreadsheetId: string, categories: Category[]): Promise<void> {
  const values = [
    CATEGORY_HEADERS,
    ...categories.map((c) => [c.id, c.name, c.icon, c.type, c.keywords.join("|"), String(c.isCustom)]),
  ];
  await sheetsFetch(`/${spreadsheetId}/values/Categories!A1:clear`, { method: "POST" });
  await sheetsFetch(`/${spreadsheetId}/values/Categories!A1?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values }),
  });
}

export async function overwriteBudgets(spreadsheetId: string, budgets: Budget[]): Promise<void> {
  const values = [
    BUDGET_HEADERS,
    ...budgets.map((b) => [b.id, b.categoryId, b.month, b.limitAmount]),
  ];
  await sheetsFetch(`/${spreadsheetId}/values/Budgets!A1:clear`, { method: "POST" });
  await sheetsFetch(`/${spreadsheetId}/values/Budgets!A1?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values }),
  });
}
