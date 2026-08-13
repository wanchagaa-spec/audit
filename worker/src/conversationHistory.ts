// Conversation memory (PLAN.md 17.11): a short rolling window of recent
// turns per subject (personal userId or group subject id — same identity
// space as everything else in state.ts). Used only to give the AI
// interpreter (aiInterpreter.ts) enough context to resolve follow-ups,
// pronouns, and "เพิ่มอีก 20"-style continuations across messages. Nothing
// here is itself trusted with money/dates — interpretMessage's output is
// validated the same way (aiInterpreter.ts's validateIntent) no matter how
// much history informed it, so a bad/stale history entry can at worst lead
// to a wrong *interpretation*, which still has to pass validation and, for
// anything that saves data, still goes through the same confirm-before-save
// step (PLAN.md 17.9) every other path already requires.

export interface ConversationTurn {
  role: "user" | "bot";
  text: string;
}

const HISTORY_TTL_SECONDS = 24 * 60 * 60;
// 6 exchanges (12 entries) — enough for a real multi-turn follow-up, small
// enough to keep the interpreter prompt cheap and fast.
const MAX_TURNS = 12;

function historyKey(subjectId: string): string {
  return `history:${subjectId}`;
}

export async function getConversationHistory(kv: KVNamespace, subjectId: string): Promise<ConversationTurn[]> {
  const raw = await kv.get(historyKey(subjectId));
  return raw ? (JSON.parse(raw) as ConversationTurn[]) : [];
}

// Appends both sides of one exchange (the user's message and the bot's final
// reply) in a single read-modify-write, rather than two separate calls —
// this relies on same-subject webhook events already being processed
// strictly sequentially (PLAN.md 17.10's subjectIdForSource grouping), which
// is what keeps this from racing the same way the old shared
// pendingConfirmation slot used to.
export async function appendConversationTurn(
  kv: KVNamespace,
  subjectId: string,
  userText: string,
  botText: string
): Promise<void> {
  const existing = await getConversationHistory(kv, subjectId);
  const updated = [...existing, { role: "user" as const, text: userText }, { role: "bot" as const, text: botText }].slice(
    -MAX_TURNS
  );
  await kv.put(historyKey(subjectId), JSON.stringify(updated), { expirationTtl: HISTORY_TTL_SECONDS });
}

export function formatHistoryForPrompt(history: ConversationTurn[]): string {
  if (history.length === 0) return "(ยังไม่มีประวัติการคุยก่อนหน้านี้)";
  return history.map((t) => `${t.role === "user" ? "ผู้ใช้" : "บอท"}: ${t.text}`).join("\n");
}
