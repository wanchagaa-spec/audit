// The category list the whole bot classifies money against, and the two
// types that describe it.
//
// Lived in the React PWA (app/src/data/defaultCategories.ts) until the PWA
// was removed (PLAN.md 17.46) — the Worker had always imported it across the
// repo, so it moved here rather than being deleted with the rest. Category
// and EntryType came along from app/src/types.ts, where they sat among a
// dozen React-only interfaces; these two are the only ones the bot ever used.

export type EntryType = "income" | "expense";

export interface Category {
  id: string;
  name: string;
  icon: string;
  type: EntryType;
  keywords: string[];
  isCustom: boolean;
}

export const DEFAULT_EXPENSE_CATEGORIES: Category[] = [
  {
    id: "food",
    name: "อาหาร/เครื่องดื่ม",
    icon: "🍜",
    type: "expense",
    isCustom: false,
    keywords: [
      "กาแฟ", "ข้าว", "อาหาร", "ร้านอาหาร", "ก๋วยเตี๋ยว", "ชานม", "ชา",
      "น้ำ", "ขนม", "บุฟเฟ่ต์", "สตาร์บัค", "นม", "ผลไม้", "ส้มตำ", "หมูกระทะ",
    ],
  },
  {
    id: "transport",
    name: "เดินทาง/น้ำมัน",
    icon: "🚗",
    type: "expense",
    isCustom: false,
    keywords: [
      "น้ำมัน", "ทางด่วน", "แท็กซี่", "แกร็บ", "grab", "bts", "mrt",
      "รถไฟฟ้า", "ที่จอดรถ", "ค่ารถ", "วินมอเตอร์ไซค์", "ค่าโดยสาร",
    ],
  },
  {
    id: "shopping",
    name: "ช้อปปิ้ง",
    icon: "🛍️",
    type: "expense",
    isCustom: false,
    keywords: ["เสื้อผ้า", "ช้อปปิ้ง", "shopee", "lazada", "รองเท้า", "กระเป๋า"],
  },
  {
    id: "bills",
    name: "บิล/สาธารณูปโภค",
    icon: "🧾",
    type: "expense",
    isCustom: false,
    keywords: ["ค่าน้ำ", "ค่าไฟ", "ค่าเน็ต", "อินเทอร์เน็ต", "ค่าโทรศัพท์", "มือถือ", "บิล"],
  },
  {
    id: "housing",
    name: "ที่พัก/ผ่อนบ้าน",
    icon: "🏠",
    type: "expense",
    isCustom: false,
    keywords: ["ค่าเช่า", "ผ่อนบ้าน", "หอพัก", "คอนโด"],
  },
  {
    id: "health",
    name: "สุขภาพ",
    icon: "💊",
    type: "expense",
    isCustom: false,
    keywords: ["หมอ", "โรงพยาบาล", "ยา", "ฟิตเนส", "ประกัน"],
  },
  {
    id: "education",
    name: "การศึกษา",
    icon: "📚",
    type: "expense",
    isCustom: false,
    keywords: ["ค่าเทอม", "หนังสือ", "คอร์ส", "เรียน"],
  },
  {
    id: "entertainment",
    name: "บันเทิง",
    icon: "🎬",
    type: "expense",
    isCustom: false,
    keywords: ["หนัง", "เกม", "คอนเสิร์ต", "เน็ตฟลิกซ์", "netflix", "สปอติฟาย", "spotify"],
  },
  {
    id: "personal",
    name: "ของใช้ส่วนตัว",
    icon: "🧴",
    type: "expense",
    isCustom: false,
    keywords: ["สบู่", "แชมพู", "เครื่องสำอาง"],
  },
  {
    id: "debt",
    name: "ผ่อนชำระ/หนี้สิน",
    icon: "💳",
    type: "expense",
    isCustom: false,
    keywords: ["ผ่อนรถ", "หนี้", "บัตรเครดิต"],
  },
  {
    id: "other-expense",
    name: "อื่น ๆ",
    icon: "📦",
    type: "expense",
    isCustom: false,
    keywords: [],
  },
];

export const DEFAULT_INCOME_CATEGORIES: Category[] = [
  {
    id: "salary",
    name: "เงินเดือน",
    icon: "💼",
    type: "income",
    isCustom: false,
    keywords: ["เงินเดือน"],
  },
  {
    id: "side-income",
    name: "รายได้เสริม",
    icon: "🧑‍💻",
    type: "income",
    isCustom: false,
    keywords: ["รายได้เสริม", "ฟรีแลนซ์", "พาร์ทไทม์"],
  },
  {
    id: "bonus",
    name: "โบนัส",
    icon: "🎁",
    type: "income",
    isCustom: false,
    keywords: ["โบนัส"],
  },
  {
    id: "transfer-in",
    name: "เงินโอน/ได้รับ",
    icon: "💸",
    type: "income",
    isCustom: false,
    keywords: ["โอนเข้า", "ได้รับ", "เงินเข้า"],
  },
  {
    id: "interest",
    name: "ดอกเบี้ย/เงินปันผล",
    icon: "📈",
    type: "income",
    isCustom: false,
    keywords: ["ดอกเบี้ย", "ปันผล"],
  },
  {
    id: "other-income",
    name: "อื่น ๆ",
    icon: "📦",
    type: "income",
    isCustom: false,
    keywords: [],
  },
];

export const DEFAULT_CATEGORIES: Category[] = [
  ...DEFAULT_EXPENSE_CATEGORIES,
  ...DEFAULT_INCOME_CATEGORIES,
];

// Words that signal the message is about money coming in rather than spending.
export const INCOME_SIGNAL_WORDS = [
  "เงินเข้า", "เข้าบัญชี", "ได้รับ", "เงินเดือนเข้า", "เงินเดือน", "โบนัส",
  "รายได้", "โอนเข้า", "ดอกเบี้ย", "ปันผล", "ขายของได้",
];
