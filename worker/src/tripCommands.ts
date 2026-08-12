// Trip-mode chat commands for the photo album feature (PLAN.md section 15.2):
// "เริ่มทริป <ชื่อ>" / "จบทริป" / "ทริปตอนนี้", plus the confirm-before-switch flow
// (the actual confirm/decline dispatch lives in confirmations.ts).

import { findOrCreateFolder, getOrCreateAlbumRoot } from "./drive.ts";
import { getActiveTrip, setActiveTrip, setPendingConfirmation, type ActionCtx, type ActiveTrip } from "./state.ts";

type Handler = (ctx: ActionCtx) => Promise<string>;

function parseStartTrip(text: string): string | null {
  const m = text.trim().match(/^(?:เริ่มทริป|เปิดทริป)\s+(.+)$/);
  return m ? m[1].trim() : null;
}

function isEndTrip(text: string): boolean {
  return ["จบทริป", "ปิดทริป", "จบทริปแล้ว"].includes(text.trim());
}

function isTripStatus(text: string): boolean {
  return ["ทริปตอนนี้", "ทริปอะไรอยู่", "สถานะทริป", "เปิดทริปอะไรอยู่"].includes(text.trim());
}

async function startTrip(ctx: ActionCtx, name: string): Promise<string> {
  const root = await getOrCreateAlbumRoot(ctx.accessToken);
  const folderId = await findOrCreateFolder(ctx.accessToken, name, root);
  const trip: ActiveTrip = { name, folderId, startedAt: new Date().toISOString() };
  await setActiveTrip(ctx.kv, ctx.lineUserId, trip);
  return `เริ่มทริป "${name}" แล้ว ส่งรูปเข้ามาได้เลย จะเก็บให้อัตโนมัติ พิมพ์ "จบทริป" ตอนเสร็จทริปนะ`;
}

export async function matchTripCommand(text: string): Promise<Handler | null> {
  const newName = parseStartTrip(text);
  if (newName) {
    return async (ctx) => {
      const existing = await getActiveTrip(ctx.kv, ctx.lineUserId);
      if (existing && existing.name === newName) {
        return `ทริป "${newName}" เปิดอยู่แล้ว ส่งรูปเข้ามาได้เลย`;
      }
      if (existing) {
        await setPendingConfirmation(ctx.kv, ctx.lineUserId, { kind: "tripSwitch", newName });
        return `ยังไม่ได้ปิดทริป "${existing.name}" เลย จะปิดแล้วเริ่มทริป "${newName}" แทนเลยไหม? (พิมพ์ "ใช่" เพื่อยืนยัน)`;
      }
      return startTrip(ctx, newName);
    };
  }

  if (isEndTrip(text)) {
    return async (ctx) => {
      const existing = await getActiveTrip(ctx.kv, ctx.lineUserId);
      if (!existing) return "ตอนนี้ไม่มีทริปที่เปิดอยู่นะ";
      await setActiveTrip(ctx.kv, ctx.lineUserId, null);
      return `ปิดทริป "${existing.name}" แล้ว`;
    };
  }

  if (isTripStatus(text)) {
    return async (ctx) => {
      const existing = await getActiveTrip(ctx.kv, ctx.lineUserId);
      if (!existing) {
        return 'ตอนนี้ไม่มีทริปที่เปิดอยู่ ส่งรูปตอนนี้จะไม่ถูกเก็บอัตโนมัติ พิมพ์ "เริ่มทริป <ชื่อ>" ก่อนนะ';
      }
      const startedDate = existing.startedAt.slice(0, 10);
      return `กำลังเปิดทริป "${existing.name}" อยู่ (เริ่มเมื่อ ${startedDate}) ส่งรูปเข้ามาได้เลย พิมพ์ "จบทริป" เมื่อเสร็จ`;
    };
  }

  return null;
}

export async function applyTripSwitch(ctx: ActionCtx, pending: { newName: string }): Promise<string> {
  const existing = await getActiveTrip(ctx.kv, ctx.lineUserId);
  const closedNote = existing ? `ปิดทริป "${existing.name}" แล้ว ` : "";
  const startMsg = await startTrip(ctx, pending.newName);
  return closedNote + startMsg;
}
