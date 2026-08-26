// ข้อความเสียง → ข้อความ (PLAN.md 17.74).
//
// The point is not transcription for its own sake: it is that a voice note
// then goes through the *same* pipeline as typed text. "ค่ากาแฟ 60" spoken
// has to behave exactly like "ค่ากาแฟ 60" typed — same interpreter, same
// confirm-before-save, same everything — so every feature this bot already
// has works by voice without any of them knowing about audio.
//
// Sent to Gemini inline rather than through the Files API. That API would
// mean an upload, a poll until the file becomes ACTIVE, and a delete: three
// more round trips inside a webhook that has to answer before LINE's reply
// token expires. The 20 MB inline ceiling is far above a voice note.

import { askGemini, type GeminiInlineMedia } from "./gemini.ts";
import { fetchLineMediaContent, toBase64 } from "./line.ts";

/**
 * Refused above this, before anything is sent anywhere.
 *
 * Well under Gemini's 20 MB request ceiling, because base64 inflates by a
 * third and the prompt rides along too. A LINE voice note is around a
 * megabyte a minute, so this is minutes of speech — the cases it stops are
 * a file that is not really a voice note, which would fail at Gemini anyway
 * after spending the upload.
 */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

const TRANSCRIBE_INSTRUCTION = [
  "คุณเป็นระบบถอดเสียงเป็นข้อความภาษาไทย",
  "ถอดสิ่งที่ได้ยินออกมาเป็นข้อความให้ตรงที่สุด โดยเฉพาะ**ตัวเลข** ให้เขียนเป็นเลขอารบิก เช่น หกสิบ → 60",
  // The first version produced "ไป โหลด เพิ่ม มา ชา หน่อย" — a space between
  // every single word (PLAN.md 17.75). Thai does not space between words,
  // and the spacing does not just look wrong: it is a second reading of the
  // sentence, and whatever reads the transcript next inherits it.
  "เขียนภาษาไทยแบบปกติ **ห้ามเว้นวรรคระหว่างทุกคำ** เว้นวรรคเฉพาะที่ภาษาไทยเว้นจริงๆ เช่น ระหว่างประโยค",
  "ตอบเฉพาะข้อความที่ถอดได้เท่านั้น ห้ามใส่คำอธิบาย ห้ามใส่เครื่องหมายคำพูด ห้ามสรุป ห้ามตอบคำถามในเสียง",
  "ถ้าฟังไม่ออกเลยหรือไม่มีเสียงพูด ให้ตอบว่า (ฟังไม่ออก)",
].join("\n");

/** Gemini's own marker for "there was nothing to transcribe". Kept as the
 * model's exact output string so the caller can tell it apart from a real
 * transcript without guessing at emptiness. */
export const UNINTELLIGIBLE = "(ฟังไม่ออก)";

export async function readLineAudio(
  messageId: string,
  channelAccessToken: string
): Promise<GeminiInlineMedia | null> {
  const { body, contentType } = await fetchLineMediaContent(messageId, channelAccessToken);
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) return null;
  // LINE reports m4a as audio/x-m4a, which Gemini does not list; the same
  // bytes as audio/mp4 are accepted, and m4a *is* an MP4 container. Anything
  // else is passed through as reported rather than guessed at.
  const mimeType = contentType.includes("m4a") ? "audio/mp4" : contentType.split(";")[0].trim();
  return { mimeType, data: toBase64(bytes) };
}

/**
 * The spoken words, or null if there is nothing usable.
 *
 * Null covers both "could not fetch or decode" and "the model heard
 * nothing": in either case there is no text to run, and inventing one would
 * mean acting on words nobody said — which, for a bot whose main job is
 * recording money, is the worst failure available to it.
 */
export async function transcribeVoiceMessage(
  messageId: string,
  channelAccessToken: string,
  geminiApiKey: string,
  kv: KVNamespace
): Promise<string | null> {
  const media = await readLineAudio(messageId, channelAccessToken);
  if (!media) return null;
  const raw = await askGemini(geminiApiKey, TRANSCRIBE_INSTRUCTION, "ถอดเสียงนี้เป็นข้อความ", {
    kv,
    media,
    maxOutputTokens: 512,
  });
  const text = raw.trim();
  // No empty-string branch here: callGemini already treats an empty response
  // as an error and throws, so the caller's catch covers that case and a
  // check for it here would be unreachable.
  if (text.includes(UNINTELLIGIBLE)) return null;
  return text;
}
