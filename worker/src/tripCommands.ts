// Trip-mode chat commands for the photo album feature (PLAN.md section 15.2):
// "เริ่มทริป <ชื่อ>" / "จบทริป" / "ทริปตอนนี้", plus the confirm-before-switch flow
// (the actual confirm/decline dispatch lives in confirmations.ts).

import { findOrCreateFolderResult, getOrCreateAlbumRoot, listTripFolders } from "./drive.ts";
import { getActiveTrip, setActiveTrip, setPendingConfirmation, type ActionCtx, type ActiveTrip } from "./state.ts";

type Handler = (ctx: ActionCtx) => Promise<string>;

function parseStartTrip(text: string): string | null {
  const m = text.trim().match(/^(?:เริ่มทริป|เปิดทริป)\s+(.+)$/s);
  return m ? m[1].trim() : null;
}

function isEndTrip(text: string): boolean {
  return ["จบทริป", "ปิดทริป", "จบทริปแล้ว"].includes(text.trim());
}

function isTripStatus(text: string): boolean {
  return ["ทริปตอนนี้", "ทริปอะไรอยู่", "สถานะทริป", "เปิดทริปอะไรอยู่"].includes(text.trim());
}

// Whole phrases, like every other trip matcher here: "ทริป" on its own sits
// inside "เริ่มทริป ทะเล" and inside ordinary sentences about travelling.
function isTripList(text: string): boolean {
  return ["ทริปทั้งหมด", "รายชื่อทริป", "ดูทริปทั้งหมด", "ทริปที่ผ่านมา", "ทริปเก่า", "อัลบั้มทั้งหมด"].includes(
    text.trim()
  );
}

async function startTrip(ctx: ActionCtx, name: string): Promise<string> {
  const root = await getOrCreateAlbumRoot(ctx.accessToken);
  const { id: folderId, existed } = await findOrCreateFolderResult(ctx.accessToken, name, root);
  const trip: ActiveTrip = { name, folderId, startedAt: new Date().toISOString() };
  await setActiveTrip(ctx.kv, ctx.lineUserId, trip);
  // Reopening an old album has always worked — the folder lookup finds it
  // and photos land back in it (PLAN.md 17.78). What was missing was saying
  // so: "เริ่มทริป ... แล้ว" reads like a new album every time, so nobody
  // could tell whether their photos were joining the old ones or starting a
  // second folder with the same name.
  if (existed) {
    return `เปิดทริป "${name}" ต่อจากเดิมแล้ว รูปที่ส่งจะไปรวมกับรูปเก่าในอัลบั้มเดียวกัน พิมพ์ "จบทริป" ตอนเสร็จนะ`;
  }
  return `เริ่มทริป "${name}" แล้ว ส่งรูป/คลิปเข้ามาได้เลย จะเก็บให้อัตโนมัติ พิมพ์ "จบทริป" ตอนเสร็จทริปนะ`;
}

/**
 * Every trip album, with the open one marked (PLAN.md 17.78).
 *
 * The folders in Drive *are* the list of past trips — /view/trips has shown
 * them since 16.3 — but there was no way to see them in chat, which is where
 * someone is when they want to reopen one. Without the list, reopening
 * depends on remembering the name exactly, and a near-miss silently creates
 * a second album rather than continuing the old one.
 */
export async function answerTripList(ctx: ActionCtx): Promise<string> {
  const folders = await listTripFolders(ctx.accessToken);
  if (folders.length === 0) {
    return 'ยังไม่มีทริปที่เคยเก็บไว้เลย พิมพ์ "เริ่มทริป <ชื่อ>" เพื่อเริ่มอันแรกได้เลย';
  }
  const active = await getActiveTrip(ctx.kv, ctx.lineUserId);
  const lines = folders.map((f) =>
    active && f.id === active.folderId ? `▶ ${f.name} — เปิดอยู่ตอนนี้` : `• ${f.name}`
  );
  return [
    `📸 ทริปทั้งหมด (${folders.length})`,
    "",
    ...lines,
    "",
    'พิมพ์ "เริ่มทริป <ชื่อ>" เพื่อเปิดทริปเดิมต่อ รูปจะไปรวมกับของเดิม',
  ].join("\n");
}

// Shared by the regex matcher below and the AI interpreter's routing table
// (aiInterpreter.ts, dispatched in index.ts) — same reasoning as
// calendarCommands.ts/diaryCommands.ts's prompt*/answer* exports.

export async function promptOrStartTrip(ctx: ActionCtx, newName: string): Promise<string> {
  const existing = await getActiveTrip(ctx.kv, ctx.lineUserId);
  if (existing && existing.name === newName) {
    return `ทริป "${newName}" เปิดอยู่แล้ว ส่งรูป/คลิปเข้ามาได้เลย`;
  }
  if (existing) {
    await setPendingConfirmation(ctx.kv, ctx.lineUserId, { kind: "tripSwitch", newName });
    return `ยังไม่ได้ปิดทริป "${existing.name}" เลย จะปิดแล้วเริ่มทริป "${newName}" แทนเลยไหม? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
  }
  return startTrip(ctx, newName);
}

export async function endTrip(ctx: ActionCtx): Promise<string> {
  const existing = await getActiveTrip(ctx.kv, ctx.lineUserId);
  if (!existing) return "ตอนนี้ไม่มีทริปที่เปิดอยู่นะ";
  await setActiveTrip(ctx.kv, ctx.lineUserId, null);
  return `ปิดทริป "${existing.name}" แล้ว`;
}

export async function tripStatus(ctx: ActionCtx): Promise<string> {
  const existing = await getActiveTrip(ctx.kv, ctx.lineUserId);
  if (!existing) {
    return 'ตอนนี้ไม่มีทริปที่เปิดอยู่ ส่งรูป/คลิปตอนนี้จะไม่ถูกเก็บอัตโนมัติ พิมพ์ "เริ่มทริป <ชื่อ>" ก่อนนะ';
  }
  const startedDate = existing.startedAt.slice(0, 10);
  return `กำลังเปิดทริป "${existing.name}" อยู่ (เริ่มเมื่อ ${startedDate}) ส่งรูป/คลิปเข้ามาได้เลย พิมพ์ "จบทริป" เมื่อเสร็จ`;
}

export async function matchTripCommand(text: string): Promise<Handler | null> {
  const newName = parseStartTrip(text);
  if (newName) {
    return (ctx) => promptOrStartTrip(ctx, newName);
  }

  if (isEndTrip(text)) {
    return (ctx) => endTrip(ctx);
  }

  if (isTripStatus(text)) {
    return (ctx) => tripStatus(ctx);
  }

  if (isTripList(text)) {
    return (ctx) => answerTripList(ctx);
  }

  return null;
}

export async function applyTripSwitch(ctx: ActionCtx, pending: { newName: string }): Promise<string> {
  const existing = await getActiveTrip(ctx.kv, ctx.lineUserId);
  const closedNote = existing ? `ปิดทริป "${existing.name}" แล้ว ` : "";
  const startMsg = await startTrip(ctx, pending.newName);
  return closedNote + startMsg;
}
