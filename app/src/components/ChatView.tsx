import { useEffect, useMemo, useRef } from "react";
import { useApp } from "../context/AppContext";
import { MessageBubble } from "./MessageBubble";
import { DateDivider } from "./DateDivider";
import { ChatInput } from "./ChatInput";
import { formatBaht } from "../lib/format";
import { updateTransaction as updateTransactionInDb } from "../lib/db";
import type { Transaction } from "../types";

export function ChatView() {
  const {
    messages,
    transactions,
    categories,
    currentUser,
    pending,
    currentBookId,
    sendMessage,
    removeTransaction,
  } = useApp();

  const bottomRef = useRef<HTMLDivElement>(null);

  const bookMessages = useMemo(
    () => messages.filter((m) => m.bookId === currentBookId),
    [messages, currentBookId]
  );

  const bookTransactions = useMemo(
    () => transactions.filter((t) => t.bookId === currentBookId),
    [transactions, currentBookId]
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [bookMessages.length]);

  const groups = useMemo(() => {
    const map = new Map<string, typeof bookMessages>();
    for (const msg of bookMessages) {
      const dateKey = msg.createdAt.slice(0, 10);
      const list = map.get(dateKey) ?? [];
      list.push(msg);
      map.set(dateKey, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [bookMessages]);

  function dailySummary(dateKey: string) {
    const dayTx = bookTransactions.filter((t) => t.date === dateKey);
    if (dayTx.length === 0) return null;
    const income = dayTx.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
    const expense = dayTx.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
    return { income, expense, net: income - expense };
  }

  function findTransaction(id?: string): Transaction | undefined {
    if (!id) return undefined;
    return bookTransactions.find((t) => t.id === id);
  }

  async function handleEdit(tx: Transaction) {
    const input = window.prompt("แก้จำนวนเงิน (บาท)", String(tx.amount));
    if (input === null) return;
    const amount = Number(input.replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
      window.alert("จำนวนเงินไม่ถูกต้อง");
      return;
    }
    await updateTransactionInDb({ ...tx, amount });
    window.location.reload();
  }

  const quickReplyCategories =
    pending?.kind === "category" ? categories.filter((c) => c.type === pending.type) : [];

  return (
    <div className="chat-view">
      <div className="chat-scroll">
        {groups.map(([dateKey, msgs]) => {
          const summary = dailySummary(dateKey);
          return (
            <div key={dateKey}>
              <DateDivider dateKey={dateKey} />
              {msgs.map((msg) => {
                const tx = findTransaction(msg.transactionId);
                const category = tx ? categories.find((c) => c.id === tx.categoryId) : undefined;
                const isMine = msg.authorId === currentUser.id;
                const align = msg.kind === "bot" ? "left" : isMine ? "right" : "left";
                return (
                  <MessageBubble
                    key={msg.id}
                    align={align}
                    authorName={msg.kind === "bot" ? msg.authorName : !isMine ? msg.authorName : undefined}
                    text={msg.text}
                    time={msg.createdAt}
                    amountBadge={
                      tx && category
                        ? {
                            type: tx.type,
                            amount: tx.amount,
                            categoryIcon: category.icon,
                            categoryName: category.name,
                          }
                        : undefined
                    }
                    onEdit={tx && isMine ? () => handleEdit(tx) : undefined}
                    onDelete={tx && isMine ? () => removeTransaction(tx.id) : undefined}
                  />
                );
              })}
              {summary && (
                <MessageBubble
                  align="center"
                  text={`สรุปวันนี้ — รายรับ ${formatBaht(summary.income)} บาท / รายจ่าย ${formatBaht(
                    summary.expense
                  )} บาท / คงเหลือ ${formatBaht(summary.net)} บาท`}
                  time={new Date().toISOString()}
                />
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {quickReplyCategories.length > 0 && (
        <div className="quick-replies">
          {quickReplyCategories.map((c) => (
            <button key={c.id} type="button" onClick={() => sendMessage(c.name)}>
              {c.icon} {c.name}
            </button>
          ))}
        </div>
      )}

      <ChatInput onSend={sendMessage} />
    </div>
  );
}
