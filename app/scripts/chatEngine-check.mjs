import { handleUserMessage } from "../src/lib/chatEngine.ts";
import { DEFAULT_CATEGORIES } from "../src/data/defaultCategories.ts";

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`ok - ${label}`); }
  else { fail++; console.log(`FAIL - ${label}`); }
}

// Reproduces the exact reported bug: greeting -> income reply -> should
// resolve fast, not loop for 4 turns and not lose the amount.
let pending = null;

const r1 = handleUserMessage("สวัสดี", pending, DEFAULT_CATEGORIES);
check("greeting gets a help reply, not an amount question", !r1.botMessage.includes("จำนวนเงิน"));
check("greeting does not start a pending clarification", r1.pending === null);

const r2 = handleUserMessage("เงินเข้า 16000", null, DEFAULT_CATEGORIES);
check("'เงินเข้า 16000' alone resolves directly as income", r2.transactionDraft?.type === "income");
check("amount is 16000", r2.transactionDraft?.amount === 16000);
check("category is transfer-in", r2.transactionDraft?.categoryId === "transfer-in");

// The original broken multi-turn path: ambiguous message, then a reply
// that reveals it was income all along, typed as free text (not a button).
pending = null;
const t1 = handleUserMessage("ฝากเงิน", pending, DEFAULT_CATEGORIES);
check("'ฝากเงิน' alone asks for amount", t1.botMessage.includes("จำนวนเงิน"));
const t2 = handleUserMessage("16000", t1.pending, DEFAULT_CATEGORIES);
check("amount answer moves to asking category", t2.botMessage.includes("หมวด"));
const t3 = handleUserMessage("เงินเดือน", t2.pending, DEFAULT_CATEGORIES);
check("typing the income category name resolves it, in one turn", t3.transactionDraft != null);
check("amount is preserved as 16000 (not lost)", t3.transactionDraft?.amount === 16000);
check("type corrected to income", t3.transactionDraft?.type === "income");
check("category is salary", t3.transactionDraft?.categoryId === "salary");

// Regression test for a real report: sending several items in one message,
// one per line, used to be logged as a *single* transaction — extractAmount
// only ever finds the first number in the whole text, so "ลาเต้ 40" and
// "เค้ก 80" silently never got logged at all, only "อเมริกาโน่ 50" did.
const multi1 = handleUserMessage("อเมริกาโน่ 50\nลาเต้ 40\nเค้ก 80", null, DEFAULT_CATEGORIES);
check("three items on three lines produce three drafts, not one", multi1.transactionDrafts?.length === 3);
check(
  "all three amounts are preserved, not just the first",
  multi1.transactionDrafts?.map((d) => d.amount).join(",") === "50,40,80"
);
check(
  // None of "อเมริกาโน่"/"ลาเต้"/"เค้ก" are in the food category's keyword
  // list (matching the real report this test reproduces — the bot asked
  // the user to pick a category for "อเมริกาโน่ 50" for exactly this
  // reason), so all three fall back to "other-expense" rather than being
  // silently dropped or blocking the whole batch on a clarification.
  "items with no keyword match still get logged, filed under other-expense",
  multi1.transactionDrafts?.every((d) => d.categoryId === "other-expense")
);
check("no pending clarification is left dangling for a resolved batch", multi1.pending === null);
check(
  "the combined reply mentions the item count and total",
  multi1.botMessage.includes("3 รายการ") && multi1.botMessage.includes("170")
);

// A line with an amount but no keyword match gets filed under "อื่น ๆ"
// instead of blocking the whole batch on a per-line clarification question
// (which there's no mechanism for — only one PendingClarification exists at
// a time) — never silently dropping a line is more important than getting
// every category right automatically.
const multi2 = handleUserMessage("กาแฟ 60\nอบรมงาน 500", null, DEFAULT_CATEGORIES);
check("an uncategorizable line still gets logged, just under \"other\"", multi2.transactionDrafts?.length === 2);
check(
  "the ambiguous line's category falls back to other-expense",
  multi2.transactionDrafts?.[1]?.categoryId === "other-expense"
);
check(
  "the reply flags that something was auto-categorized",
  multi2.botMessage.includes("อื่น ๆ")
);

// Only one line has an amount — this is the existing single-item flow's
// job (the whole text becomes one note), not a batch; must not regress.
const singleWithExtraLine = handleUserMessage("ซื้อของที่ตลาด\nกาแฟ 60", null, DEFAULT_CATEGORIES);
check(
  "a message with only one amount-bearing line is not treated as a batch",
  singleWithExtraLine.transactionDrafts === undefined && singleWithExtraLine.transactionDraft?.amount === 60
);

// A line with no amount at all alongside two that do have one is skipped,
// not silently merged into a neighboring item's note or dropped unremarked.
const multi3 = handleUserMessage("กาแฟ 60\nลืมจดราคา\nข้าว 45", null, DEFAULT_CATEGORIES);
check("the amount-less line is skipped, leaving the other two as drafts", multi3.transactionDrafts?.length === 2);
check("the reply mentions the skipped line so it isn't silently lost", multi3.botMessage.includes("ลืมจดราคา"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
