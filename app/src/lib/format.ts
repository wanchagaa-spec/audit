export function formatBaht(amount: number): string {
  return amount.toLocaleString("th-TH", { maximumFractionDigits: 2 });
}

export function todayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function monthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

const THAI_MONTHS = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

export function formatDateDivider(dateKey: string): string {
  const today = todayKey();
  const yesterday = todayKey(new Date(Date.now() - 86400000));
  if (dateKey === today) return "วันนี้";
  if (dateKey === yesterday) return "เมื่อวาน";
  const [y, m, d] = dateKey.split("-").map(Number);
  return `${d} ${THAI_MONTHS[m - 1]} ${y + 543}`;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
}
