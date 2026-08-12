// One-time (or re-run after changing assets/rich-menu.png) setup: creates a
// LINE Rich Menu, uploads the generated image, and sets it as the default
// menu everyone sees under the chat input. See PLAN.md 15.9 / worker/README.md.
//
// Run with: LINE_CHANNEL_ACCESS_TOKEN=... node scripts/setup-rich-menu.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!token) {
  console.error("Missing LINE_CHANNEL_ACCESS_TOKEN env var");
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const imagePath = join(__dirname, "..", "assets", "rich-menu.png");

// Tap area texts must exactly match phrases the bot already understands
// (see src/commands.ts, tripCommands.ts, calendarCommands.ts, diaryCommands.ts,
// aiCommands.ts) — a rich menu tap sends the text as an ordinary message,
// nothing special. Bounds must stay in sync with the 4x2 grid drawn in
// assets/generate-rich-menu.py (625x843 per tile) — only 7 of the 8 tiles
// get an area here; the 8th (bottom-right) is a non-tappable brand tile.
const richMenuDefinition = {
  size: { width: 2500, height: 1686 },
  selected: true,
  name: "expense-tracker-main-menu",
  chatBarText: "เมนู",
  areas: [
    { bounds: { x: 0, y: 0, width: 625, height: 843 }, action: { type: "message", text: "วิธีใช้" } },
    { bounds: { x: 625, y: 0, width: 625, height: 843 }, action: { type: "message", text: "สรุปเดือนนี้" } },
    { bounds: { x: 1250, y: 0, width: 625, height: 843 }, action: { type: "message", text: "รายการล่าสุด" } },
    { bounds: { x: 1875, y: 0, width: 625, height: 843 }, action: { type: "message", text: "ทริปตอนนี้" } },
    { bounds: { x: 0, y: 843, width: 625, height: 843 }, action: { type: "message", text: "มีนัดอะไรวันนี้" } },
    {
      bounds: { x: 625, y: 843, width: 625, height: 843 },
      action: { type: "message", text: "ไดอารี่เดือนนี้มีอะไรบ้าง" },
    },
    { bounds: { x: 1250, y: 843, width: 625, height: 843 }, action: { type: "message", text: "วิเคราะห์" } },
  ],
};

async function lineFetch(base, path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`LINE API error ${res.status} on ${path}: ${await res.text()}`);
  }
  return res;
}

// 1. Clean up any menu(s) from previous runs so re-running this script after
// changing the design doesn't pile up unused rich menus.
const list = await (await lineFetch("https://api.line.me", "/v2/bot/richmenu/list")).json();
for (const menu of list.richmenus ?? []) {
  if (menu.name === richMenuDefinition.name) {
    console.log(`Deleting previous menu ${menu.richMenuId}`);
    await lineFetch("https://api.line.me", `/v2/bot/richmenu/${menu.richMenuId}`, { method: "DELETE" });
  }
}

// 2. Create the new rich menu definition.
const created = await (
  await lineFetch("https://api.line.me", "/v2/bot/richmenu", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(richMenuDefinition),
  })
).json();
console.log(`Created rich menu ${created.richMenuId}`);

// 3. Upload the image (must match the size declared above exactly).
const imageBytes = readFileSync(imagePath);
await lineFetch("https://api-data.line.me", `/v2/bot/richmenu/${created.richMenuId}/content`, {
  method: "POST",
  headers: { "Content-Type": "image/png" },
  body: imageBytes,
});
console.log("Uploaded menu image");

// 4. Set as the default menu every user sees, including people who haven't
// linked their Google account yet.
await lineFetch("https://api.line.me", `/v2/bot/user/all/richmenu/${created.richMenuId}`, { method: "POST" });
console.log("Set as the default rich menu for all users. Done — check LINE, it can take a minute to show up.");
