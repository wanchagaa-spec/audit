export type EntryType = "income" | "expense";

export interface Category {
  id: string;
  name: string;
  icon: string;
  type: EntryType;
  keywords: string[];
  isCustom: boolean;
}

export interface Transaction {
  id: string;
  bookId: string;
  date: string; // YYYY-MM-DD
  type: EntryType;
  amount: number;
  categoryId: string;
  note: string;
  rawText: string;
  addedBy: string; // user id/email, "me" for local-only personal use
  addedByName: string;
  createdAt: string; // ISO datetime
}

export interface Budget {
  id: string;
  bookId: string;
  categoryId: string;
  month: string; // YYYY-MM
  limitAmount: number;
}

export type BookKind = "personal" | "group";

export interface Book {
  id: string;
  name: string;
  kind: BookKind;
  sheetId?: string; // Google Sheets spreadsheetId once synced
  members?: { id: string; name: string; email: string }[];
}

export interface ChatMessage {
  id: string;
  bookId: string;
  kind: "user" | "bot";
  text: string;
  createdAt: string; // ISO datetime
  authorId: string;
  authorName: string;
  transactionId?: string;
}

export interface AppSettings {
  reminderEnabled: boolean;
  reminderTime: string; // "HH:mm"
  currentBookId: string;
}
