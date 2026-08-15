// /view/diary (PLAN.md 16.3, write-capable since PLAN.md 17.36) — "สมุดโน้ต"
// notebook view: entries grouped by day, newest day first within the
// month, with prev/next month links (`?month=YYYY-MM`) instead of dumping
// the whole diary history into one page every time. Reuses
// readAllDiaryEntries (already existed for the chat "ไดอารี่เดือนนี้มีอะไร
// บ้าง" command and the AI Q&A data source).
//
// Edit/delete moved here (confirmed with the user, not assumed) instead of
// as new chat commands — every entry in the month view is directly
// editable inline (date/category/text, save immediately, same
// direct-save-no-confirm behavior /view/shifts already uses for its own
// write path) and deletable (a two-step GET-confirm-then-POST flow, unlike
// the immediate-save edit, since deleting is the one irreversible action
// here — same confirm-before-destructive-action spirit as every delete
// command in chat, just expressed as a second page instead of a "ใช่/ไม่ใช่"
// reply, since these pages are plain server-rendered HTML with no client
// JS). Search results stay read-only — editing from a search hit would
// need to carry the search query through the edit/delete round-trip for
// little benefit, so it's left for later if actually needed.

import type { Env } from "./index.ts";
import { deleteDiaryEntry, readAllDiaryEntries, updateDiaryEntry, type DiaryRow } from "./sheets.ts";
import { bangkokMonthKey } from "./thaiDate.ts";
import { DATA_FETCH_FAILED_MESSAGE, escapeHtml, html, pageShell, renderErrorPage, resolveViewSession } from "./viewAuth.ts";

const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Shape AND calendar validity — the pattern alone accepts "2026-99-99",
 * which would be written verbatim and orphan the entry from every month
 * view (only text search could ever find it again). Round-tripping
 * through Date catches that: Date("2026-99-99") is Invalid Date, and
 * Date("2026-02-30") normalizes to a different ISO day than was given. */
function isValidDateKey(raw: string): boolean {
  if (!DATE_KEY_PATTERN.test(raw)) return false;
  const d = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw;
}

function shiftMonthKey(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function groupByDate(rows: DiaryRow[]): Map<string, DiaryRow[]> {
  const groups = new Map<string, DiaryRow[]>();
  for (const r of rows) {
    const list = groups.get(r.date) ?? [];
    list.push(r);
    groups.set(r.date, list);
  }
  return groups;
}

// Reused above both the month view and the search-results view — a plain
// GET form (no client JS needed, matches every other /view page's
// server-rendered-only approach) that re-submits whatever was typed as
// `?q=`. `month` is carried along as a hidden field so clearing the search
// box returns to the month the reader was actually looking at, not always
// the current one.
function renderSearchForm(token: string, month: string, query: string): string {
  return `<form class="search-form" method="get" action="/view/diary">
    <input type="hidden" name="token" value="${escapeHtml(token)}" />
    <input type="hidden" name="month" value="${escapeHtml(month)}" />
    <input type="text" name="q" value="${escapeHtml(query)}" placeholder="ค้นหาไดอารี่..." />
    <button type="submit">ค้นหา</button>
  </form>`;
}

function diaryActionUrl(token: string, month: string): string {
  return `/view/diary?token=${encodeURIComponent(token)}&month=${encodeURIComponent(month)}`;
}

// One form per entry — date/category/text are all directly editable,
// saved immediately on "บันทึก" with no separate confirm step (same
// low-risk, easy-to-fix-again reasoning /view/shifts already applies to
// its own checkboxes). "ลบ" is a plain link to the confirm-delete page
// below instead of a same-form submit button, since deleting needs its
// own confirm step first.
function renderEntryForm(token: string, month: string, entry: DiaryRow): string {
  const confirmUrl = `${diaryActionUrl(token, month)}&confirmDelete=${encodeURIComponent(entry.id)}`;
  return `<form method="post" action="${diaryActionUrl(token, month)}" class="diary-edit-form">
    <input type="hidden" name="op" value="update" />
    <input type="hidden" name="id" value="${escapeHtml(entry.id)}" />
    <div class="diary-edit-row">
      <input type="date" name="date" value="${escapeHtml(entry.date)}" />
      <input type="text" name="category" value="${escapeHtml(entry.category)}" placeholder="หมวด" />
    </div>
    <textarea name="text" rows="2">${escapeHtml(entry.text)}</textarea>
    <div class="diary-edit-actions">
      <button type="submit">บันทึก</button>
      <a href="${confirmUrl}">ลบ</a>
    </div>
  </form>`;
}

function renderDiaryPage(token: string, month: string, monthRows: DiaryRow[], notice?: string): string {
  const nav = { token, active: "diary" as const };
  const prevMonth = shiftMonthKey(month, -1);
  const nextMonth = shiftMonthKey(month, 1);
  const searchForm = renderSearchForm(token, month, "");
  const navLinks = `<div class="nav-links">
    <a href="/view/diary?token=${encodeURIComponent(token)}&month=${prevMonth}">‹ เดือนก่อน</a>
    <a href="/view/diary?token=${encodeURIComponent(token)}&month=${nextMonth}">เดือนถัดไป ›</a>
  </div>`;
  const noticeHtml = notice ? `<p class="save-notice">${escapeHtml(notice)}</p>` : "";

  if (monthRows.length === 0) {
    return pageShell(
      "ไดอารี่",
      `<h1>ไดอารี่</h1><p class="subtitle">เดือน ${escapeHtml(month)}</p>
${searchForm}
${navLinks}
${noticeHtml}
<div class="card"><p class="empty">ไม่มีบันทึกเดือนนี้</p></div>
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว — แก้ไข/ลบบันทึกได้ตรงนี้เลย</p>`,
      nav
    );
  }

  // Newest day first within the month, like flipping to the back of a notebook.
  const groups = Array.from(groupByDate(monthRows).entries()).sort((a, b) => b[0].localeCompare(a[0]));
  const dayGroupsHtml = groups
    .map(([date, entries]) => {
      const entriesHtml = entries.map((e) => renderEntryForm(token, month, e)).join("\n");
      return `<div class="day-group"><h2>${escapeHtml(date)}</h2><div class="card">${entriesHtml}</div></div>`;
    })
    .join("\n");

  return pageShell(
    "ไดอารี่",
    `<h1>ไดอารี่</h1><p class="subtitle">เดือน ${escapeHtml(month)}</p>
${searchForm}
${navLinks}
${noticeHtml}
${dayGroupsHtml}
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว — แก้ไข/ลบบันทึกได้ตรงนี้เลย</p>`,
    nav
  );
}

// Searches across every month at once (same substring match as the chat
// command "ค้นหาไดอารี่ <คำ>" in diaryCommands.ts), not just the month
// currently being viewed — a search restricted to one month would be
// surprising and mostly useless for finding something written a while ago.
// Read-only — see this file's top comment for why.
function renderDiarySearchResults(token: string, month: string, query: string, matches: DiaryRow[]): string {
  const nav = { token, active: "diary" as const };
  const searchForm = renderSearchForm(token, month, query);
  const backLink = `<div class="nav-links"><a href="/view/diary?token=${encodeURIComponent(token)}&month=${encodeURIComponent(month)}">‹ กลับไปดูรายเดือน</a></div>`;

  if (matches.length === 0) {
    return pageShell(
      "ค้นหาไดอารี่",
      `<h1>ไดอารี่</h1>
${searchForm}
<div class="card"><p class="empty">ไม่พบบันทึกที่มีคำว่า "${escapeHtml(query)}"</p></div>
${backLink}
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
      nav
    );
  }

  // Newest first, same convention as the month view above.
  const sorted = [...matches].sort((a, b) => b.date.localeCompare(a.date));
  const resultsHtml = sorted
    .map(
      (e) =>
        `<div class="diary-entry"><span class="category">${escapeHtml(e.date)} · ${escapeHtml(e.category)}</span>${escapeHtml(e.text)}</div>`
    )
    .join("\n");

  return pageShell(
    "ค้นหาไดอารี่",
    `<h1>ไดอารี่</h1><p class="subtitle">พบ ${matches.length} รายการที่มีคำว่า "${escapeHtml(query)}"</p>
${searchForm}
<div class="card">${resultsHtml}</div>
${backLink}
<p class="footnote">เห็นได้เฉพาะคุณคนเดียว</p>`,
    nav
  );
}

function renderConfirmDeletePage(token: string, month: string, entry: DiaryRow): string {
  const nav = { token, active: "diary" as const };
  const cancelUrl = diaryActionUrl(token, month);
  return pageShell(
    "ลบบันทึกไดอารี่",
    `<h1>ลบบันทึกนี้เลยไหม</h1>
<div class="confirm-delete-text"><strong>${escapeHtml(entry.date)} · ${escapeHtml(entry.category)}</strong><p>${escapeHtml(entry.text)}</p></div>
<form method="post" action="${cancelUrl}" class="confirm-actions">
  <input type="hidden" name="op" value="delete" />
  <input type="hidden" name="id" value="${escapeHtml(entry.id)}" />
  <a href="${cancelUrl}">ยกเลิก</a>
  <button type="submit">ยืนยันลบ</button>
</form>`,
    nav
  );
}

function resolveMonthKey(url: URL): string {
  const requested = url.searchParams.get("month");
  // A malformed month (bad copy-paste, hand-edited URL) would otherwise
  // flow straight into shiftMonthKey's Number() parsing and produce
  // "NaN-NaN" prev/next links that can never recover — falls back to the
  // current month instead of trusting the query param's shape.
  return requested && MONTH_KEY_PATTERN.test(requested) ? requested : bangkokMonthKey();
}

export async function handleViewDiaryRequest(request: Request, env: Env): Promise<Response> {
  const session = await resolveViewSession(request, env);
  if (session instanceof Response) return session;

  const url = new URL(request.url);
  const month = resolveMonthKey(url);

  if (request.method === "POST") {
    try {
      const formData = await request.formData();
      const op = String(formData.get("op") ?? "");
      const id = String(formData.get("id") ?? "");

      const renderMonthWithNotice = async (notice: string) => {
        const monthRows = (await readAllDiaryEntries(session.accessToken, session.spreadsheetId, env.ACCOUNTS)).filter(
          (r) => r.date?.startsWith(month)
        );
        return html(renderDiaryPage(session.token, month, monthRows, notice));
      };

      if (op === "delete") {
        // The helper returns false when the id is already gone (deleted
        // from another tab, or a stale page) — say so honestly instead of
        // claiming this request deleted anything.
        const deleted = await deleteDiaryEntry(session.accessToken, session.spreadsheetId, env.ACCOUNTS, id);
        return renderMonthWithNotice(deleted ? "ลบบันทึกแล้ว" : "ไม่พบบันทึกนี้แล้ว อาจถูกลบไปก่อนหน้านี้");
      }

      if (op === "update") {
        const rawDate = String(formData.get("date") ?? "");
        const category = String(formData.get("category") ?? "").trim() || "อื่นๆ";
        const text = String(formData.get("text") ?? "").trim();
        // Both rejections below re-render with the entry's *stored* state
        // untouched — never silently substitute a different date, and
        // never let an accidental select-all-then-save blank an entry's
        // text with less friction than the delete flow's confirm page.
        if (!isValidDateKey(rawDate)) {
          return renderMonthWithNotice("วันที่ไม่ถูกต้อง ยังไม่ได้บันทึกการแก้ไขนะ ลองใหม่อีกครั้ง");
        }
        if (!text) {
          return renderMonthWithNotice('ข้อความว่างเปล่า ยังไม่ได้บันทึกนะ ถ้าต้องการลบบันทึกนี้ให้กดปุ่ม "ลบ" แทน');
        }
        const updated = await updateDiaryEntry(session.accessToken, session.spreadsheetId, env.ACCOUNTS, id, {
          date: rawDate,
          category,
          text,
        });
        return renderMonthWithNotice(updated ? "บันทึกการแก้ไขแล้ว" : "ไม่พบบันทึกนี้แล้ว อาจถูกลบไปก่อนหน้านี้ เลยไม่ได้บันทึกการแก้ไข");
      }

      return html(renderErrorPage("เกิดข้อผิดพลาด", "ไม่รู้จักคำสั่งนี้ ลองกลับไปที่หน้าไดอารี่แล้วลองใหม่นะ"), 400);
    } catch (err) {
      console.error("handleViewDiaryRequest: saving diary edit failed", err);
      return html(renderErrorPage("บันทึกไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
    }
  }

  const confirmDeleteId = url.searchParams.get("confirmDelete");
  const query = url.searchParams.get("q")?.trim() ?? "";

  try {
    const allRows = await readAllDiaryEntries(session.accessToken, session.spreadsheetId, env.ACCOUNTS);

    if (confirmDeleteId) {
      const entry = allRows.find((r) => r.id === confirmDeleteId);
      if (!entry) {
        const monthRows = allRows.filter((r) => r.date?.startsWith(month));
        return html(renderDiaryPage(session.token, month, monthRows));
      }
      return html(renderConfirmDeletePage(session.token, month, entry));
    }

    if (query) {
      const matches = allRows.filter((r) => r.text.includes(query));
      return html(renderDiarySearchResults(session.token, month, query, matches));
    }
    const monthRows = allRows.filter((r) => r.date?.startsWith(month));
    return html(renderDiaryPage(session.token, month, monthRows));
  } catch (err) {
    console.error("handleViewDiaryRequest: fetching diary entries failed", err);
    return html(renderErrorPage("ดึงข้อมูลไม่สำเร็จ", DATA_FETCH_FAILED_MESSAGE), 502);
  }
}
