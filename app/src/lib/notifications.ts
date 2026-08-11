// Daily reminder to log expenses (PLAN.md section 11). Uses the browser
// Notification API — free, no server required. This only fires reliably
// while the PWA is open or recently backgrounded; it is NOT a guaranteed
// background push. On Android/Chrome that's usually enough since the OS
// keeps installed PWAs alive longer; on iOS Safari, background delivery is
// unreliable and a real fix would need an external scheduler (e.g. a free
// GitHub Actions cron calling the Web Push API) — a documented future
// enhancement, not a Phase 4 blocker.

const LAST_FIRED_KEY = "expense-tracker:last-reminder-date";
let intervalId: ReturnType<typeof setInterval> | null = null;

export function isNotificationSupported(): boolean {
  return typeof Notification !== "undefined";
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!isNotificationSupported()) return "denied";
  if (Notification.permission === "default") {
    return Notification.requestPermission();
  }
  return Notification.permission;
}

async function fireReminder(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem(LAST_FIRED_KEY) === today) return;
  localStorage.setItem(LAST_FIRED_KEY, today);

  const title = "อย่าลืมจดบัญชีวันนี้นะ";
  const options: NotificationOptions = { body: "แวะมาจดรายรับ-รายจ่ายของวันนี้กันเถอะ" };

  if ("serviceWorker" in navigator) {
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    if (reg) {
      await reg.showNotification(title, options);
      return;
    }
  }
  new Notification(title, options);
}

export function startReminderWatcher(reminderTime: string): void {
  stopReminderWatcher();
  if (Notification.permission !== "granted") return;

  intervalId = setInterval(() => {
    const now = new Date();
    const current = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (current === reminderTime) {
      void fireReminder();
    }
  }, 30_000);
}

export function stopReminderWatcher(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
