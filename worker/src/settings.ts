// Per-account settings the user can change for themselves (PLAN.md 17.48):
// what the bot is called, what character it speaks in, and what it should
// call them back. Set from /view/settings.
//
// These used to be constants compiled into the code — BOT_NAME lived in
// persona.ts and the character was a hard-coded sentence in its system
// instruction — so changing either meant a deploy. They are per-subject now
// (a person's own settings in personal mode, the group's shared ones in a
// group, keyed the same way every other piece of state in state.ts is).
//
// The defaults are exactly what was hard-coded before, so an account that
// never opens the settings page sees no change at all.

export const DEFAULT_BOT_NAME = "ไพโรจน์";
export const DEFAULT_BOT_CHARACTER = "ผู้หญิงน่ารัก อายุ 23 ปี ชอบสีชมพู กำลังเรียนภาษาญี่ปุ่นอยู่ ใช้สรรพนาม \"ฉัน\" ลงท้ายด้วย \"ค่ะ\"/\"นะคะ\"";

export interface BotSettings {
  botName: string;
  /** Free text describing how the bot should come across. Interpolated into
   * the persona prompt (persona.ts) and, in short form, into the AI
   * interpreter's (aiInterpreter.ts). */
  botCharacter: string;
  /** What the bot calls the user. Empty means "don't use a name". */
  userNickname: string;
}

export const DEFAULT_SETTINGS: BotSettings = {
  botName: DEFAULT_BOT_NAME,
  botCharacter: DEFAULT_BOT_CHARACTER,
  userNickname: "",
};

// Bounds, not validation theatre. The name is searched for as a plain
// substring of every group message (stripBotNameMention in index.ts), so a
// very long or whitespace-only one would be a nuisance rather than a name;
// the character is pasted into a system prompt whose own rules have to stay
// legible next to it, and a wall of text there both crowds them out and
// costs tokens on every single reply.
const MAX_BOT_NAME = 40;
const MAX_CHARACTER = 400;
const MAX_NICKNAME = 40;

/** Trims, collapses newlines out of single-line fields, and caps length.
 * Newlines matter: `botName` and `userNickname` are interpolated into
 * prompts as inline values, and a multi-line one reads as a new instruction
 * rather than as a name. */
function cleanLine(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeSettings(input: Partial<BotSettings>): BotSettings {
  const botName = cleanLine(input.botName ?? "", MAX_BOT_NAME);
  // Character keeps its newlines — it's a description, and someone writing
  // one across a few lines shouldn't have it mangled.
  const botCharacter = (input.botCharacter ?? "").trim().slice(0, MAX_CHARACTER);
  return {
    // A blank name or character falls back to the default rather than being
    // stored empty: an unnamed bot can't be addressed in a group at all, and
    // a characterless persona prompt would ask the model to restyle text
    // into nothing in particular.
    botName: botName === "" ? DEFAULT_BOT_NAME : botName,
    botCharacter: botCharacter === "" ? DEFAULT_BOT_CHARACTER : botCharacter,
    // A blank nickname is a real choice, though — it means "don't call me
    // anything", which is how the bot has always behaved.
    userNickname: cleanLine(input.userNickname ?? "", MAX_NICKNAME),
  };
}

export async function getBotSettings(kv: KVNamespace, subjectId: string): Promise<BotSettings> {
  const raw = await kv.get(`settings:${subjectId}`);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    return normalizeSettings(JSON.parse(raw) as Partial<BotSettings>);
  } catch (err) {
    // Never let unreadable settings take the reply down with them — the
    // whole point of this layer is cosmetic, and the defaults are a
    // perfectly good bot.
    console.error("getBotSettings: stored settings unreadable, using defaults", err);
    return DEFAULT_SETTINGS;
  }
}

export async function saveBotSettings(
  kv: KVNamespace,
  subjectId: string,
  input: Partial<BotSettings>
): Promise<BotSettings> {
  const settings = normalizeSettings(input);
  await kv.put(`settings:${subjectId}`, JSON.stringify(settings));
  return settings;
}
