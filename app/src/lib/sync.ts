// Syncs a book's local IndexedDB data with its Google Sheet. First sync
// creates the spreadsheet; later syncs pull remote rows, merge them with
// local ones by id (union — a record present on either side survives),
// then write the merged set back. This keeps things simple for
// personal/household scale data; it does not propagate deletes across
// devices yet (see PLAN.md section 9 for the tracked limitation).

import type { Book, Budget, Category, Transaction } from "../types";
import {
  appendTransactions,
  createBookSpreadsheet,
  overwriteBudgets,
  overwriteCategories,
  overwriteTransactions,
  readTransactions,
} from "./sheetsService";

export interface SyncResult {
  sheetId: string;
  mergedTransactions: Transaction[];
}

export async function syncBookWithSheets(
  book: Book,
  localTransactions: Transaction[],
  localCategories: Category[],
  localBudgets: Budget[]
): Promise<SyncResult> {
  if (!book.sheetId) {
    const sheetId = await createBookSpreadsheet(book.name);
    await overwriteCategories(sheetId, localCategories);
    await overwriteBudgets(sheetId, localBudgets);
    if (localTransactions.length > 0) {
      await appendTransactions(sheetId, localTransactions);
    }
    return { sheetId, mergedTransactions: localTransactions };
  }

  const remote = await readTransactions(book.sheetId, book.id);
  const byId = new Map(localTransactions.map((t) => [t.id, t]));
  for (const r of remote) {
    if (!byId.has(r.id)) byId.set(r.id, r);
  }
  const merged = Array.from(byId.values());
  await overwriteTransactions(book.sheetId, merged);
  await overwriteCategories(book.sheetId, localCategories);
  await overwriteBudgets(book.sheetId, localBudgets);
  return { sheetId: book.sheetId, mergedTransactions: merged };
}
