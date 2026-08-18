// /view/help (PLAN.md 17.39) — the full "วิธีใช้" guide as a web page.
//
// It used to be one chat message, and it had outgrown the format. LINE
// silently truncates anything past 5,000 characters (line.ts slices to
// exactly that), so the guide was capped by the transport rather than by
// what was worth saying: PLAN.md 17.35 had to cut a 5,998-character draft
// back to fit, and every feature added since has meant shaving wording off
// existing entries to make room. A page has no such ceiling, and reads
// better besides — sections, bullets, and a scrollbar instead of one
// unbroken wall in a chat bubble.
//
// 17.35 looked at the other way out (splitting a long reply across several
// LINE messages) and turned it down for good reason: replyToLine is the one
// path every feature's reply goes through, and reworking it to serve the
// help text alone would put every other reply at risk. This needs none of
// that.
//
// No token, unlike every other /view page — deliberately. The guide is the
// same for everyone and contains no account data, so there is nothing here
// to authorise. That also means the link never expires, which is the right
// behaviour for a page someone might bookmark, and it works before an
// account is linked at all.

import { buildHelpText } from "./commands.ts";
import type { Env } from "./index.ts";
import { escapeHtml, html, pageShell } from "./viewAuth.ts";
import { isWebSearchEnabled } from "./webSearch.ts";

interface HelpSection {
  heading: string;
  bullets: string[];
}

/** Reads back the same text the chat guide is built from, rather than
 * keeping a second copy in HTML that would drift out of step with it. The
 * format is this codebase's own and fixed: a heading line, then "• " bullet
 * lines, with blank lines between sections. Anything unrecognised is treated
 * as a heading, so a malformed line shows up in the output instead of being
 * silently swallowed. */
function parseHelpSections(text: string): HelpSection[] {
  const sections: HelpSection[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("• ")) {
      // A bullet before any heading would be a malformed guide; give it a
      // home rather than dropping it on the floor.
      if (sections.length === 0) sections.push({ heading: "", bullets: [] });
      sections[sections.length - 1].bullets.push(line.slice(2).trim());
      continue;
    }
    sections.push({ heading: line, bullets: [] });
  }
  return sections;
}

function renderHelpSection(section: HelpSection): string {
  // A heading with nothing under it isn't a section — it's the guide's own
  // intro line, which reads as a stray empty card if it gets the section
  // treatment. Rendered as lead text instead.
  if (section.bullets.length === 0) {
    return section.heading ? `<p class="help-lead">${escapeHtml(section.heading)}</p>` : "";
  }
  const heading = section.heading ? `<h2>${escapeHtml(section.heading)}</h2>` : "";
  const bullets = `<ul class="help-list">${section.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`;
  return `<div class="card">${heading}${bullets}</div>`;
}

export function renderHelpPage(webSearchEnabled: boolean): string {
  const sections = parseHelpSections(buildHelpText(webSearchEnabled)).map(renderHelpSection).join("");
  return pageShell(
    "วิธีใช้",
    `<h1>วิธีใช้ทั้งหมด</h1>
<p class="subtitle">พิมพ์คำสั่งพวกนี้ในแชท LINE ได้เลย</p>
${sections}
<p class="footnote">หน้านี้เปิดได้ตลอด ไม่มีวันหมดอายุ เก็บลิงก์ไว้ได้เลย</p>
<p class="footnote"><a href="/privacy">นโยบายความเป็นส่วนตัว</a> · <a href="/terms">ข้อกำหนดการใช้งาน</a></p>`
  );
}

export async function handleViewHelpRequest(env: Env): Promise<Response> {
  return html(renderHelpPage(isWebSearchEnabled(env.ENABLE_WEB_SEARCH)));
}
