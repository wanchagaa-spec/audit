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

/**
 * Per-entry cap (PLAN.md 17.89).
 *
 * Counting turns bounded how *many* entries were kept and nothing about how
 * big they were. A reply can be 5,000 characters — a movie list, a long
 * report, a grounded search answer — and every one of them was stored whole
 * and then pasted into the interpreter's system instruction on *every*
 * subsequent message. Measured: eight long replies left 24 KB in the window,
 * which is thousands of tokens of Thai on each call, on a free tier this bot
 * has already exhausted once (PLAN.md 17.54).
 *
 * 500 is chosen for what history is *for*: resolving "เพิ่มอีก 20", a
 * pronoun, a follow-up question. That lives in the opening of a turn, not in
 * the twentieth line of a film list. A long tail is dropped rather than
 * summarised, since summarising would cost the Gemini call this is trying to
 * make cheaper.
 */
const MAX_TURN_CHARS = 500;

function clampTurn(text: string): string {
  return text.length <= MAX_TURN_CHARS ? text : `${text.slice(0, MAX_TURN_CHARS)}…`;
}

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
  const updated = [
    ...existing,
    { role: "user" as const, text: clampTurn(userText) },
    { role: "bot" as const, text: clampTurn(botText) },
  ].slice(-MAX_TURNS);
  await kv.put(historyKey(subjectId), JSON.stringify(updated), { expirationTtl: HISTORY_TTL_SECONDS });
}

export function formatHistoryForPrompt(history: ConversationTurn[]): string {
  if (history.length === 0) return "(ยังไม่มีประวัติการคุยก่อนหน้านี้)";
  return history.map((t) => `${t.role === "user" ? "ผู้ใช้" : "บอท"}: ${t.text}`).join("\n");
}
