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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
