// /view/shifts (PLAN.md 17.18) — "ตารางเวรของฉัน": a personal duty-roster
// grid, columns = day of the month, rows = a fixed set of shift types, with
// a checkbox at every (day, shift) cell. The only /view/* page that writes
// data back — every other page in this family (accounts/calendar/diary/
// trips) is read-only. Reuses the exact same signed-token session
// (viewAuth.ts's resolveViewSession) as the read-only pages; the token
// lives in the URL query string for both GET and POST, so the form's
// `action` carries it forward the same way every GET link on this page
// does, and resolveViewSession itself needs no changes at all.
//
// Personal use only, by design (confirmed with the user rather than
// assumed): there's no per-member identity to track here the way group
// mode's shared spreadsheets need, so a checked cell just means "this
// account's shift," no attribution column needed.

import type { Env } from "./index.ts";
import { readShiftGrid, saveShiftGrid, SHIFT_TYPES, type ShiftType } from "./sheets.ts";
import { bangkokMonthKey } from "./thaiDate.ts";
import { DATA_FETCH_FAILED_MESSAGE, escapeHtml, html, pageShell, renderErrorPage, resolveViewSession } from "./viewAuth.ts";

const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;

function shiftMonthKey(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function cellValue(day: number, shiftType: ShiftType): string {
  return `${day}|${shiftType}`;
}

/** Parses "3|เวรเช้า" back into {day, shiftType} — returns null for
 * anything malformed rather than throwing, since this reads untrusted
 * POST body values. */
function parseCellValue(raw: string): { day: number; shiftType: ShiftType } | null {
  const sep = raw.indexOf("|");
  if (sep === -1) return null;
  const day = Number(raw.slice(0, sep));
  const shiftType = raw.slice(sep + 1);
  if (!Number.isInteger(day) || day < 1) return null;
  if (!(SHIFT_TYPES as readonly string[]).includes(shiftType)) return null;
  return { day, shiftType: shiftType as ShiftType };
}

function renderShiftsPage(
  token: string,
  monthKey: string,
  grid: { days: number; checked: Record<ShiftType, number[]> },
  justSaved: boolean
): string {
  const nav = { token, active: "shifts" as const };
  const prevMonth = shiftMonthKey(monthKey, -1);
  const nextMonth = shiftMonthKey(monthKey, 1);
  const navLinks = `<div class="nav-links">
    <a href="/view/shifts?token=${encodeURIComponent(token)}&month=${prevMonth}">‹ เดือนก่อน</a>
    <a href="/view/shifts?token=${encodeURIComponent(token)}&month=${nextMonth}">เดือนถัดไป ›</a>
  </div>`;

  const checkedSets = Object.fromEntries(
    SHIFT_TYPES.map((t) => [t, new Set(grid.checked[t])])
  ) as Record<ShiftType, Set<number>>;

  const headerCells = Array.from({ length: grid.days }, (_, i) => `<th>${i + 1}</th>`).join("");
  const bodyRows = SHIFT_TYPES.map((type) => {
    const cells = Array.from({ length: grid.days }, (_, i) => {
      const day = i + 1;
      const checked = checkedSets[type].has(day) ? " checked" : "";
      return `<td><input type="checkbox" name="cell" value="${escapeHtml(cellValue(day, type))}"${checked} /></td>`;
    }).join("");
    return `<tr><th>${escapeHtml(type)}</th>${cells}</tr>`;
  }).join("\n");

  const savedNotice = justSaved ? `<p class="save-notice">บันทึกตารางเวรแล้ว ✓</p>` : "";

  return pageShell(
    "ตารางเวร",
    `<h1>ตารางเวรของฉัน</h1><p class="subtitle">เดือน ${escapeHtml(monthKey)}</p>
${navLinks}
${savedNotice}
<form method="post" action="/view/shifts?token=${encodeURIComponent(token)}&month=${encodeURIComponent(monthKey)}">
  <div class="card">
    <div class="table-scroll"><table class="data-table shift-table">
      <thead><tr><th>เวร</th>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table></div>
    <button type="submit" class="save-button">บันทึกตารางเวร</button>
  </div>
</form>
${navLinks}
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว — ติ๊กวันที่เข้าเวรแต่ละประเภท แล้วกดบันทึก</p>`,
    nav
  );
}

function resolveMonthKey(url: URL): string {
  const requested = url.searchParams.get("month");
  // A malformed month (bad copy-paste, hand-edited URL) would otherwise
  // flow straight into shiftMonthKey's Number() parsing and produce
  // "NaN-NaN" prev/next links that can never recover — falls back to the
  // current month instead of trusting the query param's shape (same
  // guard viewDiaryPage.ts already uses for the same reason).
  return requested && MONTH_KEY_PATTERN.test(requested) ? requested : bangkokMonthKey();
}

export async function handleViewShiftsRequest(request: Request, env: Env): Promise<Response> {
  const session = await resolveViewSession(request, env);
  if (session instanceof Response) return session;

  const url = new URL(request.url);
  const monthKey = resolveMonthKey(url);

  if (request.method === "POST") {
    try {
      const formData = await request.formData();
      const cells = formData
        .getAll("cell")
        .map((v) => parseCellValue(String(v)))
        .filter((c): c is { day: number; shiftType: ShiftType } => c !== null);
      await saveShiftGrid(session.accessToken, session.spreadsheetId, env.ACCOUNTS, monthKey, cells);
      const grid = await readShiftGrid(session.accessToken, session.spreadsheetId, env.ACCOUNTS, monthKey);
      return html(renderShiftsPage(session.token, monthKey, grid, true));
    } catch (err) {
      console.error("handleViewShiftsRequest: saving shift grid failed", err);
      return html(renderErrorPage("บันทึกไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
    }
  }

  try {
    const grid = await readShiftGrid(session.accessToken, session.spreadsheetId, env.ACCOUNTS, monthKey);
    return html(renderShiftsPage(session.token, monthKey, grid, false));
  } catch (err) {
    console.error("handleViewShiftsRequest: fetching shift grid failed", err);
    return html(renderErrorPage("ดึงข้อมูลไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
  }
}
