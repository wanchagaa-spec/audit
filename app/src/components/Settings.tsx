import { useState } from "react";
import { useApp } from "../context/AppContext";
import { OnboardingPermissions } from "./OnboardingPermissions";
import { generateId } from "../lib/id";
import { monthKey } from "../lib/format";
import {
  isNotificationSupported,
  requestNotificationPermission,
  startReminderWatcher,
  stopReminderWatcher,
} from "../lib/notifications";
import type { Category, EntryType } from "../types";

export function Settings() {
  const {
    currentBook,
    categories,
    budgets,
    currentBookId,
    googleConfigured,
    googleUser,
    syncing,
    syncError,
    signIn,
    syncCurrentBook,
    inviteToCurrentBook,
    joinSharedBook,
    addCategory,
    addOrUpdateBudget,
    reminderEnabled,
    reminderTime,
    setReminder,
  } = useApp();

  const [catName, setCatName] = useState("");
  const [catIcon, setCatIcon] = useState("🏷️");
  const [catType, setCatType] = useState<EntryType>("expense");
  const [catKeywords, setCatKeywords] = useState("");

  const [budgetCategoryId, setBudgetCategoryId] = useState("");
  const [budgetLimit, setBudgetLimit] = useState("");

  const [inviteEmail, setInviteEmail] = useState("");

  async function handleAddCategory(e: React.FormEvent) {
    e.preventDefault();
    if (!catName.trim()) return;
    const category: Category = {
      id: generateId(),
      name: catName.trim(),
      icon: catIcon || "🏷️",
      type: catType,
      keywords: catKeywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
      isCustom: true,
    };
    await addCategory(category);
    setCatName("");
    setCatKeywords("");
  }

  async function handleAddBudget(e: React.FormEvent) {
    e.preventDefault();
    const limit = Number(budgetLimit);
    if (!budgetCategoryId || !Number.isFinite(limit) || limit <= 0) return;
    await addOrUpdateBudget({
      id: generateId(),
      bookId: currentBookId,
      categoryId: budgetCategoryId,
      month: monthKey(),
      limitAmount: limit,
    });
    setBudgetLimit("");
  }

  async function handleReminderToggle(enabled: boolean) {
    if (enabled && isNotificationSupported()) {
      const perm = await requestNotificationPermission();
      if (perm !== "granted") {
        window.alert("ต้องอนุญาตการแจ้งเตือนในเบราว์เซอร์ก่อนถึงจะตั้งเวลาได้");
        return;
      }
    }
    await setReminder(enabled, reminderTime);
    if (enabled) startReminderWatcher(reminderTime);
    else stopReminderWatcher();
  }

  async function handleReminderTimeChange(time: string) {
    await setReminder(reminderEnabled, time);
    if (reminderEnabled) startReminderWatcher(time);
  }

  const expenseCategories = categories.filter((c) => c.type === "expense" && c.name !== "อื่น ๆ");
  const bookBudgets = budgets.filter((b) => b.bookId === currentBookId);

  return (
    <div className="settings">
      <section className="settings-card">
        <h3>บัญชี Google &amp; ซิงก์ข้อมูล</h3>
        {!googleConfigured && (
          <p className="muted">
            ยังไม่ได้ตั้งค่า Google Client ID — ดูวิธีตั้งค่าใน README เพื่อเปิดใช้ล็อกอิน/ซิงก์
          </p>
        )}
        <OnboardingPermissions />
        {!googleUser ? (
          <button type="button" disabled={!googleConfigured} onClick={() => void signIn()}>
            เข้าสู่ระบบด้วย Google
          </button>
        ) : (
          <p>เข้าสู่ระบบแล้วในชื่อ {googleUser.name} ({googleUser.email})</p>
        )}
        {googleUser && currentBook && (
          <button type="button" disabled={syncing === currentBook.id} onClick={() => void syncCurrentBook()}>
            {syncing === currentBook.id ? "กำลังซิงก์..." : "ซิงก์สมุดนี้กับ Google Sheets"}
          </button>
        )}
        {syncError && <p className="error">{syncError}</p>}
      </section>

      {googleUser && currentBook?.kind === "group" && (
        <section className="settings-card">
          <h3>เชิญสมาชิกเข้าสมุดกลุ่ม</h3>
          <div className="inline-form">
            <input
              type="email"
              placeholder="อีเมล Google ของเพื่อน"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
            />
            <button
              type="button"
              onClick={() => {
                void inviteToCurrentBook(inviteEmail);
                setInviteEmail("");
              }}
            >
              เชิญ
            </button>
          </div>
          {currentBook.members && currentBook.members.length > 0 && (
            <ul>
              {currentBook.members.map((m) => (
                <li key={m.id}>{m.email}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {googleUser && (
        <section className="settings-card">
          <h3>เข้าร่วมสมุดที่ถูกเชิญ</h3>
          <p className="muted">เลือกไฟล์ Google Sheets ที่เพื่อนแชร์มาให้</p>
          <button type="button" onClick={() => void joinSharedBook()}>
            เลือกไฟล์ที่ถูกแชร์
          </button>
        </section>
      )}

      <section className="settings-card">
        <h3>เพิ่มหมวดหมู่เอง</h3>
        <form className="stacked-form" onSubmit={handleAddCategory}>
          <input placeholder="ไอคอน (emoji)" value={catIcon} onChange={(e) => setCatIcon(e.target.value)} />
          <input placeholder="ชื่อหมวดหมู่" value={catName} onChange={(e) => setCatName(e.target.value)} />
          <select value={catType} onChange={(e) => setCatType(e.target.value as EntryType)}>
            <option value="expense">รายจ่าย</option>
            <option value="income">รายรับ</option>
          </select>
          <input
            placeholder="คำที่ใช้จับ (คั่นด้วยจุลภาค)"
            value={catKeywords}
            onChange={(e) => setCatKeywords(e.target.value)}
          />
          <button type="submit">เพิ่มหมวดหมู่</button>
        </form>
      </section>

      <section className="settings-card">
        <h3>ตั้งงบประมาณเดือนนี้</h3>
        <form className="stacked-form" onSubmit={handleAddBudget}>
          <select value={budgetCategoryId} onChange={(e) => setBudgetCategoryId(e.target.value)}>
            <option value="">เลือกหมวดหมู่</option>
            {expenseCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.icon} {c.name}
              </option>
            ))}
          </select>
          <input
            type="number"
            placeholder="วงเงิน (บาท)"
            value={budgetLimit}
            onChange={(e) => setBudgetLimit(e.target.value)}
          />
          <button type="submit">บันทึกงบ</button>
        </form>
        {bookBudgets.length > 0 && (
          <ul>
            {bookBudgets.map((b) => {
              const c = categories.find((cat) => cat.id === b.categoryId);
              return (
                <li key={b.id}>
                  {c?.icon} {c?.name}: {b.limitAmount.toLocaleString("th-TH")} บาท / เดือน
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="settings-card">
        <h3>แจ้งเตือนจดบัญชี</h3>
        {!isNotificationSupported() && <p className="muted">เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน</p>}
        <label className="inline-form">
          <input
            type="checkbox"
            checked={reminderEnabled}
            onChange={(e) => void handleReminderToggle(e.target.checked)}
          />
          เตือนให้จดบัญชีทุกวัน
        </label>
        <input
          type="time"
          value={reminderTime}
          onChange={(e) => void handleReminderTimeChange(e.target.value)}
          disabled={!reminderEnabled}
        />
        <p className="muted">
          แม่นยำเต็มที่บน Android/Chrome ส่วน iOS Safari มีข้อจำกัดเรื่องแจ้งเตือนพื้นหลัง
        </p>
      </section>
    </div>
  );
}
