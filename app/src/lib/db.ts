import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Book, Budget, Category, ChatMessage, Transaction } from "../types";
import { DEFAULT_CATEGORIES } from "../data/defaultCategories";
import { generateId } from "./id";

interface AppDB extends DBSchema {
  transactions: {
    key: string;
    value: Transaction;
    indexes: { "by-bookId": string };
  };
  categories: {
    key: string;
    value: Category;
    indexes: { "by-bookId": string };
  };
  budgets: {
    key: string;
    value: Budget;
    indexes: { "by-bookId": string };
  };
  books: {
    key: string;
    value: Book;
  };
  messages: {
    key: string;
    value: ChatMessage;
    indexes: { "by-bookId": string };
  };
  settings: {
    key: string;
    value: unknown;
  };
}

const DB_NAME = "expense-tracker";
const DB_VERSION = 1;
const PERSONAL_BOOK_ID = "personal";

let dbPromise: Promise<IDBPDatabase<AppDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<AppDB>> {
  if (!dbPromise) {
    dbPromise = openDB<AppDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const txStore = db.createObjectStore("transactions", { keyPath: "id" });
        txStore.createIndex("by-bookId", "bookId");

        const catStore = db.createObjectStore("categories", { keyPath: "id" });
        catStore.createIndex("by-bookId", "bookId");

        const budgetStore = db.createObjectStore("budgets", { keyPath: "id" });
        budgetStore.createIndex("by-bookId", "bookId");

        db.createObjectStore("books", { keyPath: "id" });

        const msgStore = db.createObjectStore("messages", { keyPath: "id" });
        msgStore.createIndex("by-bookId", "bookId");

        db.createObjectStore("settings");
      },
    });
  }
  return dbPromise;
}

export async function ensureSeeded(): Promise<void> {
  const db = await getDb();
  const existingBook = await db.get("books", PERSONAL_BOOK_ID);
  if (existingBook) return;

  await db.put("books", {
    id: PERSONAL_BOOK_ID,
    name: "สมุดส่วนตัว",
    kind: "personal",
  });

  const tx = db.transaction("categories", "readwrite");
  for (const category of DEFAULT_CATEGORIES) {
    await tx.store.put(category);
  }
  await tx.done;

  await db.put("settings", { reminderEnabled: false, reminderTime: "20:00", currentBookId: PERSONAL_BOOK_ID }, "app");
}

export async function listTransactions(): Promise<Transaction[]> {
  const db = await getDb();
  const all = await db.getAll("transactions");
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function saveTransaction(tx: Omit<Transaction, "id" | "createdAt">): Promise<Transaction> {
  const db = await getDb();
  const record: Transaction = {
    ...tx,
    id: generateId(),
    createdAt: new Date().toISOString(),
  };
  await db.put("transactions", record);
  return record;
}

export async function updateTransaction(tx: Transaction): Promise<void> {
  const db = await getDb();
  await db.put("transactions", tx);
}

export async function deleteTransaction(id: string): Promise<void> {
  const db = await getDb();
  await db.delete("transactions", id);
}

export async function listCategories(): Promise<Category[]> {
  const db = await getDb();
  return db.getAll("categories");
}

export async function saveCategory(category: Category): Promise<void> {
  const db = await getDb();
  await db.put("categories", category);
}

export async function listBudgets(): Promise<Budget[]> {
  const db = await getDb();
  return db.getAll("budgets");
}

export async function saveBudget(budget: Budget): Promise<void> {
  const db = await getDb();
  await db.put("budgets", budget);
}

export async function listMessages(): Promise<ChatMessage[]> {
  const db = await getDb();
  const all = await db.getAll("messages");
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function saveMessage(message: ChatMessage): Promise<void> {
  const db = await getDb();
  await db.put("messages", message);
}

export async function listBooks(): Promise<Book[]> {
  const db = await getDb();
  return db.getAll("books");
}

export async function saveBook(book: Book): Promise<void> {
  const db = await getDb();
  await db.put("books", book);
}

export async function getSettings(): Promise<{ reminderEnabled: boolean; reminderTime: string; currentBookId: string }> {
  const db = await getDb();
  const settings = await db.get("settings", "app");
  return (settings as never) ?? { reminderEnabled: false, reminderTime: "20:00", currentBookId: PERSONAL_BOOK_ID };
}

export async function saveSettings(settings: {
  reminderEnabled: boolean;
  reminderTime: string;
  currentBookId: string;
}): Promise<void> {
  const db = await getDb();
  await db.put("settings", settings, "app");
}
