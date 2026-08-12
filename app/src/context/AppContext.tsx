import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Book, Budget, Category, ChatMessage, Transaction } from "../types";
import {
  ensureSeeded,
  getSettings,
  listBooks,
  listBudgets,
  listCategories,
  listMessages,
  listTransactions,
  saveBook as saveBookToDb,
  saveBudget as saveBudgetToDb,
  saveCategory as saveCategoryToDb,
  saveMessage,
  saveSettings as saveSettingsToDb,
  saveTransaction,
  updateTransaction as updateTransactionInDb,
  deleteTransaction as deleteTransactionFromDb,
} from "../lib/db";
import { handleUserMessage, type PendingClarification } from "../lib/chatEngine";
import { generateId } from "../lib/id";
import { todayKey } from "../lib/format";
import { isGoogleConfigured, signInWithGoogle, type GoogleUser } from "../lib/googleAuth";
import { syncBookWithSheets } from "../lib/sync";
import { shareSpreadsheetWithEmail } from "../lib/driveShare";
import { pickSharedSpreadsheet } from "../lib/googlePicker";
import { readTransactions } from "../lib/sheetsService";

export interface CurrentUser {
  id: string;
  name: string;
}

interface AppContextValue {
  loading: boolean;
  books: Book[];
  currentBook: Book | undefined;
  currentBookId: string;
  categories: Category[];
  transactions: Transaction[];
  budgets: Budget[];
  messages: ChatMessage[];
  currentUser: CurrentUser;
  googleUser: GoogleUser | null;
  googleConfigured: boolean;
  skippedLogin: boolean;
  syncing: string | null;
  syncError: string | null;
  pending: PendingClarification | null;
  reminderEnabled: boolean;
  reminderTime: string;
  sendMessage: (text: string) => Promise<void>;
  switchBook: (bookId: string) => void;
  addCategory: (category: Category) => Promise<void>;
  addOrUpdateBudget: (budget: Budget) => Promise<void>;
  addBook: (book: Book) => Promise<void>;
  removeTransaction: (id: string) => Promise<void>;
  setReminder: (enabled: boolean, time: string) => Promise<void>;
  signIn: () => Promise<void>;
  continueAsGuest: () => void;
  syncCurrentBook: () => Promise<void>;
  inviteToCurrentBook: (email: string) => Promise<void>;
  joinSharedBook: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

const LOCAL_USER: CurrentUser = { id: "me", name: "ฉัน" };

const GOOGLE_USER_STORAGE_KEY = "expense-tracker:google-user";
const SKIP_LOGIN_STORAGE_KEY = "expense-tracker:continue-as-guest";

function loadStoredGoogleUser(): GoogleUser | null {
  try {
    const raw = localStorage.getItem(GOOGLE_USER_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as GoogleUser) : null;
  } catch {
    return null;
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [books, setBooks] = useState<Book[]>([]);
  const [currentBookId, setCurrentBookId] = useState("personal");
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<PendingClarification | null>(null);
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [reminderTime, setReminderTimeState] = useState("20:00");
  const [googleUser, setGoogleUser] = useState<GoogleUser | null>(() => loadStoredGoogleUser());
  const [skippedLogin, setSkippedLogin] = useState<boolean>(
    () => localStorage.getItem(SKIP_LOGIN_STORAGE_KEY) === "1"
  );
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      await ensureSeeded();
      const [b, c, t, bg, m, settings] = await Promise.all([
        listBooks(),
        listCategories(),
        listTransactions(),
        listBudgets(),
        listMessages(),
        getSettings(),
      ]);
      setBooks(b);
      setCategories(c);
      setTransactions(t);
      setBudgets(bg);
      setMessages(m);
      setCurrentBookId(settings.currentBookId);
      setReminderEnabled(settings.reminderEnabled);
      setReminderTimeState(settings.reminderTime);
      setLoading(false);
    })();
  }, []);

  const currentBook = books.find((b) => b.id === currentBookId);
  const currentUser: CurrentUser = googleUser ?? LOCAL_USER;

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      const userMsg: ChatMessage = {
        id: generateId(),
        bookId: currentBookId,
        kind: "user",
        text: trimmed,
        createdAt: new Date().toISOString(),
        authorId: currentUser.id,
        authorName: currentUser.name,
      };
      await saveMessage(userMsg);
      setMessages((prev) => [...prev, userMsg]);

      const result = handleUserMessage(trimmed, pending, categories);
      setPending(result.pending);

      // transactionDrafts (plural) is set instead of transactionDraft when
      // one message contained several separate items — see
      // parseMultilineTransactions in chatEngine.ts. Both are saved the same
      // way below, just looped for the plural case.
      const drafts = result.transactionDrafts ?? (result.transactionDraft ? [result.transactionDraft] : []);
      let transactionId: string | undefined;
      const budgetWarnings: string[] = [];
      if (drafts.length > 0) {
        // Tracks running spend locally (existing state + everything saved so
        // far in this batch) so two items in the same category within one
        // multi-line message are checked against their combined total, not
        // just each in isolation against pre-existing transactions.
        let runningTransactions = transactions;
        const seenBudgetCategories = new Set<string>();

        for (const draft of drafts) {
          const saved = await saveTransaction({
            bookId: currentBookId,
            date: todayKey(),
            type: draft.type,
            amount: draft.amount,
            categoryId: draft.categoryId,
            note: draft.note,
            rawText: trimmed,
            addedBy: currentUser.id,
            addedByName: currentUser.name,
          });
          setTransactions((prev) => [...prev, saved]);
          runningTransactions = [...runningTransactions, saved];
          transactionId = saved.id; // only the last one, when there are several — see the botMsg comment below

          if (saved.type === "expense" && !seenBudgetCategories.has(saved.categoryId)) {
            seenBudgetCategories.add(saved.categoryId);
            const month = saved.date.slice(0, 7);
            const budget = budgets.find(
              (b) => b.bookId === currentBookId && b.categoryId === saved.categoryId && b.month === month
            );
            if (budget) {
              const spent = runningTransactions
                .filter(
                  (t) =>
                    t.bookId === currentBookId &&
                    t.categoryId === saved.categoryId &&
                    t.date.slice(0, 7) === month
                )
                .reduce((s, t) => s + t.amount, 0);
              if (spent > budget.limitAmount) {
                const category = categories.find((c) => c.id === saved.categoryId);
                budgetWarnings.push(
                  `⚠️ ใช้จ่ายหมวด ${category?.icon ?? ""} ${category?.name ?? ""} เดือนนี้ไป ${spent.toLocaleString(
                    "th-TH"
                  )} บาท เกินงบที่ตั้งไว้ ${budget.limitAmount.toLocaleString("th-TH")} บาทแล้วนะ`
                );
              }
            }
          }
        }
      }

      const botMsg: ChatMessage = {
        id: generateId(),
        bookId: currentBookId,
        kind: "bot",
        text: result.botMessage,
        createdAt: new Date().toISOString(),
        authorId: "bot",
        authorName: "ผู้ช่วยจดบัญชี",
        // Only meaningful for the single-item case — a summary message for
        // several items doesn't correspond to any one of them, so the
        // amount-badge decoration this powers (see ChatView.tsx) just won't
        // show for a batch, which is correct (there's no single amount to
        // badge it with).
        transactionId: drafts.length === 1 ? transactionId : undefined,
      };
      await saveMessage(botMsg);
      setMessages((prev) => [...prev, botMsg]);

      for (const budgetWarning of budgetWarnings) {
        const warnMsg: ChatMessage = {
          id: generateId(),
          bookId: currentBookId,
          kind: "bot",
          text: budgetWarning,
          createdAt: new Date().toISOString(),
          authorId: "bot",
          authorName: "ผู้ช่วยจดบัญชี",
        };
        await saveMessage(warnMsg);
        setMessages((prev) => [...prev, warnMsg]);
      }
    },
    [pending, categories, currentBookId, currentUser.id, currentUser.name, budgets, transactions]
  );

  const switchBook = useCallback(
    (bookId: string) => {
      setCurrentBookId(bookId);
      setPending(null);
      void saveSettingsToDb({ reminderEnabled, reminderTime, currentBookId: bookId });
    },
    [reminderEnabled, reminderTime]
  );

  const addCategory = useCallback(async (category: Category) => {
    await saveCategoryToDb(category);
    setCategories((prev) => [...prev, category]);
  }, []);

  const addOrUpdateBudget = useCallback(async (budget: Budget) => {
    await saveBudgetToDb(budget);
    setBudgets((prev) => {
      const others = prev.filter((b) => b.id !== budget.id);
      return [...others, budget];
    });
  }, []);

  const addBook = useCallback(async (book: Book) => {
    await saveBookToDb(book);
    setBooks((prev) => [...prev, book]);
  }, []);

  const removeTransaction = useCallback(async (id: string) => {
    await deleteTransactionFromDb(id);
    setTransactions((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const setReminder = useCallback(
    async (enabled: boolean, time: string) => {
      setReminderEnabled(enabled);
      setReminderTimeState(time);
      await saveSettingsToDb({ reminderEnabled: enabled, reminderTime: time, currentBookId });
    },
    [currentBookId]
  );

  const signIn = useCallback(async () => {
    setSyncError(null);
    try {
      const user = await signInWithGoogle();
      setGoogleUser(user);
      localStorage.setItem(GOOGLE_USER_STORAGE_KEY, JSON.stringify(user));
      setSkippedLogin(false);
      localStorage.removeItem(SKIP_LOGIN_STORAGE_KEY);
    } catch (err) {
      setSyncError((err as Error).message);
    }
  }, []);

  const continueAsGuest = useCallback(() => {
    setSkippedLogin(true);
    localStorage.setItem(SKIP_LOGIN_STORAGE_KEY, "1");
  }, []);

  const syncCurrentBook = useCallback(async () => {
    if (!currentBook) return;
    setSyncError(null);
    setSyncing(currentBook.id);
    try {
      const bookTransactions = transactions.filter((t) => t.bookId === currentBook.id);
      const { sheetId, mergedTransactions } = await syncBookWithSheets(
        currentBook,
        bookTransactions,
        categories,
        budgets.filter((b) => b.bookId === currentBook.id)
      );

      if (sheetId !== currentBook.sheetId) {
        const updatedBook: Book = { ...currentBook, sheetId };
        await saveBookToDb(updatedBook);
        setBooks((prev) => prev.map((b) => (b.id === updatedBook.id ? updatedBook : b)));
      }

      for (const tx of mergedTransactions) {
        await updateTransactionInDb(tx);
      }
      setTransactions((prev) => [
        ...prev.filter((t) => t.bookId !== currentBook.id),
        ...mergedTransactions,
      ]);
    } catch (err) {
      setSyncError((err as Error).message);
    } finally {
      setSyncing(null);
    }
  }, [currentBook, transactions, categories, budgets]);

  const inviteToCurrentBook = useCallback(
    async (email: string) => {
      if (!currentBook?.sheetId) {
        setSyncError("ซิงก์สมุดนี้กับ Google Sheets ก่อนถึงจะเชิญคนอื่นได้");
        return;
      }
      setSyncError(null);
      try {
        await shareSpreadsheetWithEmail(currentBook.sheetId, email);
        const updatedBook: Book = {
          ...currentBook,
          members: [...(currentBook.members ?? []), { id: email, name: email, email }],
        };
        await saveBookToDb(updatedBook);
        setBooks((prev) => prev.map((b) => (b.id === updatedBook.id ? updatedBook : b)));
      } catch (err) {
        setSyncError((err as Error).message);
      }
    },
    [currentBook]
  );

  const joinSharedBook = useCallback(async () => {
    setSyncError(null);
    try {
      const fileId = await pickSharedSpreadsheet();
      if (!fileId) return;
      const newBook: Book = {
        id: generateId(),
        name: "สมุดกลุ่มที่เข้าร่วม",
        kind: "group",
        sheetId: fileId,
      };
      await saveBookToDb(newBook);
      setBooks((prev) => [...prev, newBook]);

      const remoteTransactions = await readTransactions(fileId, newBook.id);
      for (const tx of remoteTransactions) {
        await updateTransactionInDb(tx);
      }
      setTransactions((prev) => [...prev, ...remoteTransactions]);
      switchBook(newBook.id);
    } catch (err) {
      setSyncError((err as Error).message);
    }
  }, [switchBook]);

  const value = useMemo<AppContextValue>(
    () => ({
      loading,
      books,
      currentBook,
      currentBookId,
      categories,
      transactions,
      budgets,
      messages,
      currentUser,
      googleUser,
      googleConfigured: isGoogleConfigured(),
      skippedLogin,
      syncing,
      syncError,
      pending,
      reminderEnabled,
      reminderTime,
      sendMessage,
      switchBook,
      addCategory,
      addOrUpdateBudget,
      addBook,
      removeTransaction,
      setReminder,
      signIn,
      continueAsGuest,
      syncCurrentBook,
      inviteToCurrentBook,
      joinSharedBook,
    }),
    [
      loading,
      books,
      currentBook,
      currentBookId,
      categories,
      transactions,
      budgets,
      messages,
      currentUser,
      googleUser,
      skippedLogin,
      syncing,
      syncError,
      pending,
      reminderEnabled,
      reminderTime,
      sendMessage,
      switchBook,
      addCategory,
      addOrUpdateBudget,
      addBook,
      removeTransaction,
      setReminder,
      signIn,
      continueAsGuest,
      syncCurrentBook,
      inviteToCurrentBook,
      joinSharedBook,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
