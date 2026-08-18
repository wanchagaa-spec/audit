// /privacy and /terms (PLAN.md 17.53) — the two pages LINE and Google ask
// for when verifying an account or reviewing OAuth scopes.
//
// Public and tokenless, exactly like /view/help: a reviewer has to be able
// to open them without a LINE account, and a bookmarked policy URL must not
// expire. They hold no account data, so there is nothing here to authorise.
//
// Everything below was written from the code rather than from a template.
// The scope list is googleAuth.ts's, the storage list is every KV prefix
// state.ts and its neighbours actually write, the retention figures are the
// real TTL constants, and the third-party list is the hosts the Worker
// really contacts. A privacy policy that describes a different program than
// the one running is worse than none: it is a promise nobody kept.

import type { Env } from "./index.ts";
import { escapeHtml, html, pageShell } from "./viewAuth.ts";

/** Kept next to the pages that print it so there is one date to change, and
 * so it can't quietly drift from the text it dates. Update whenever the
 * substance below changes — not on unrelated deploys. */
const LAST_UPDATED_TH = "18 สิงหาคม 2569";
const LAST_UPDATED_EN = "18 August 2026";

/** The one contact address, named once so the Thai and English pages can
 * never disagree about where to write. */
const CONTACT_EMAIL = "wanchagaa1999@gmail.com";

export type Locale = "th" | "en";

interface Section {
  heading: string;
  /** Plain paragraphs. */
  paragraphs?: string[];
  /** Rendered as a bulleted list under the paragraphs. */
  bullets?: string[];
  /** Rendered as a two-column table: [what, why]. */
  table?: { columns: [string, string]; rows: Array<[string, string]> };
}

function renderSection(section: Section): string {
  const paragraphs = (section.paragraphs ?? []).map((p) => `<p class="legal-p">${escapeHtml(p)}</p>`).join("");
  const bullets =
    section.bullets && section.bullets.length > 0
      ? `<ul class="legal-list">${section.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`
      : "";
  const table = section.table
    ? `<div class="table-scroll"><table class="data-table legal-table">
        <thead><tr><th>${escapeHtml(section.table.columns[0])}</th><th>${escapeHtml(section.table.columns[1])}</th></tr></thead>
        <tbody>${section.table.rows
          .map(([a, b]) => `<tr><td>${escapeHtml(a)}</td><td>${escapeHtml(b)}</td></tr>`)
          .join("")}</tbody>
      </table></div>`
    : "";
  return `<div class="card"><h2>${escapeHtml(section.heading)}</h2>${paragraphs}${bullets}${table}</div>`;
}

function renderLegalPage(locale: Locale, path: "privacy" | "terms", title: string, lead: string, sections: Section[]): string {
  const isThai = locale === "th";
  const updated = isThai ? `ปรับปรุงล่าสุด ${LAST_UPDATED_TH}` : `Last updated ${LAST_UPDATED_EN}`;
  // The language switch points at the same document in the other language,
  // not at that language's front page — someone sent a link to the privacy
  // policy wants the privacy policy.
  const otherLocale = isThai
    ? `<a href="/${path}/en">English</a>`
    : `<a href="/${path}">ภาษาไทย</a>`;
  const nav = isThai
    ? `<a href="/privacy">นโยบายความเป็นส่วนตัว</a> · <a href="/terms">ข้อกำหนดการใช้งาน</a> · <a href="/view/help">วิธีใช้</a>`
    : `<a href="/privacy/en">Privacy Policy</a> · <a href="/terms/en">Terms of Use</a>`;
  const note = isThai
    ? "เอกสารนี้เขียนขึ้นจากโค้ดที่ทำงานจริงของบอท ไม่ใช่แบบฟอร์มสำเร็จรูป"
    : "This document was written from the bot's actual source code, not from a template. The Thai version is the original.";
  return pageShell(
    title,
    `<p class="locale-switch">${otherLocale}</p>
<h1>${escapeHtml(title)}</h1>
<p class="subtitle">${escapeHtml(updated)}</p>
<p class="legal-lead">${escapeHtml(lead)}</p>
${sections.map(renderSection).join("\n")}
<p class="footnote">${nav}</p>
<p class="footnote">${escapeHtml(note)}</p>`
  );
}

// ---- Privacy policy --------------------------------------------------------

const PRIVACY_SECTIONS: Section[] = [
  {
    heading: "ใครเป็นผู้ให้บริการ",
    paragraphs: [
      "บอทนี้เป็นผู้ช่วยส่วนตัวในแอป LINE ที่พัฒนาและดูแลโดยบุคคลธรรมดา ใช้ส่วนตัวและในกลุ่มเล็ก ไม่ใช่บริการเชิงพาณิชย์ ไม่มีการขายข้อมูล ไม่มีโฆษณา และไม่มีการแบ่งปันข้อมูลให้บุคคลที่สามเพื่อการตลาดใดๆ ทั้งสิ้น",
      `ช่องทางติดต่อเรื่องข้อมูลส่วนบุคคล: อีเมล ${CONTACT_EMAIL} หรือทักหาบอทในแชท LINE ได้โดยตรง`,
    ],
  },
  {
    heading: "หลักการสำคัญ: ข้อมูลของคุณอยู่ในบัญชี Google ของคุณเอง",
    paragraphs: [
      "รายรับ-รายจ่าย ไดอารี่ งบประมาณ และตารางเวรทั้งหมด ถูกบันทึกลง Google Sheets ในไดรฟ์ของคุณเอง ไม่ใช่ฐานข้อมูลของผู้พัฒนา รูปและวิดีโอจากทริปอัปโหลดขึ้น Google Drive ของคุณเอง นัดหมายเข้า Google Calendar ของคุณเอง และสิ่งที่ต้องทำเข้า Google Tasks ของคุณเอง",
      "ผู้พัฒนาไม่มีสำเนาข้อมูลเหล่านี้ และเข้าถึงไม่ได้ ระบบของบอทเก็บเพียง \"กุญแจ\" ที่ใช้เชื่อมบัญชีกับสถานะการทำงานชั่วคราวเท่านั้น ตามรายการด้านล่าง",
    ],
  },
  {
    heading: "ข้อมูลที่ระบบของบอทเก็บ และเก็บนานแค่ไหน",
    paragraphs: [
      "เก็บไว้ใน Cloudflare Workers KV (ระบบเก็บข้อมูลของ Cloudflare) เท่าที่จำเป็นต่อการทำงาน:",
    ],
    table: {
      columns: ["ข้อมูล", "เก็บนานแค่ไหน"],
      rows: [
        ["LINE user ID (หรือ group ID) คู่กับ Google refresh token และรหัสสเปรดชีต — คือสิ่งที่ทำให้บอทรู้ว่าคุณคือใครและต้องเขียนลงสมุดเล่มไหน", "จนกว่าจะยกเลิกการเชื่อมบัญชี"],
        ["การตั้งค่าบอท: ชื่อบอท คาแรคเตอร์ ชื่อที่ให้เรียกคุณ", "จนกว่าจะเปลี่ยนหรือยกเลิกการเชื่อมบัญชี"],
        ["จังหวัดสำหรับพยากรณ์อากาศ (ชื่อจังหวัดและพิกัดของจังหวัดนั้น ไม่ใช่ตำแหน่งจริงของคุณ)", "จนกว่าจะเปลี่ยนหรือยกเลิกการเชื่อมบัญชี"],
        ["ประวัติการสนทนาย้อนหลัง 6 รอบ (ข้อความของคุณและคำตอบของบอท) ใช้ให้ AI เข้าใจคำถามต่อเนื่อง", "24 ชั่วโมง แล้วลบอัตโนมัติ"],
        ["สถานะระหว่างทาง เช่น รายการที่รอคุณพิมพ์ \"ใช่\" ยืนยัน หรือคำค้นที่รอให้แชร์ตำแหน่ง", "10 นาที แล้วลบอัตโนมัติ"],
        ["รหัสยืนยันการล้างข้อมูลที่ส่งไปทางอีเมล", "15 นาที แล้วลบอัตโนมัติ"],
        ["คำตอบจากการค้นเว็บที่ยาวเกินกว่าจะส่งในแชท (ถ้าเปิดใช้ฟีเจอร์นี้)", "1 ชั่วโมง แล้วลบอัตโนมัติ"],
        ["คิวรูป/วิดีโอที่รออัปโหลด (เก็บเฉพาะรหัสข้อความของ LINE ไม่ได้เก็บตัวไฟล์)", "จนกว่าจะอัปโหลดเสร็จ"],
        ["ข้อมูลช่วยจำทางเทคนิค เช่น วันที่ทักทายล่าสุด และเลขแถวที่แต่ละเดือนเริ่มในสเปรดชีต", "สูงสุด 90 วัน"],
      ],
    },
  },
  {
    heading: "สิ่งที่ไม่เก็บ",
    bullets: [
      "ไม่เก็บสำเนารายรับ-รายจ่าย ไดอารี่ รูปภาพ วิดีโอ นัดหมาย อีเมล หรือรายชื่อผู้ติดต่อของคุณไว้ในระบบของบอท",
      "ไม่เก็บรหัสผ่าน Google ของคุณ — การเชื่อมบัญชีใช้ Google OAuth ซึ่งคุณกรอกรหัสผ่านกับ Google โดยตรง บอทไม่เคยเห็น",
      "ไม่เก็บพิกัดตำแหน่งจริงของคุณ ตอนใช้ \"หา...ใกล้ฉัน\" พิกัดที่คุณแชร์จะถูกส่งไปค้นหาทันทีแล้วทิ้ง ไม่ถูกบันทึกไว้",
      "ไม่เก็บข้อมูลบัตรเครดิตหรือข้อมูลการชำระเงินใดๆ เพราะบอทไม่มีการรับชำระเงิน",
    ],
  },
  {
    heading: "สิทธิ์ Google ที่ขอ และเหตุผลของแต่ละสิทธิ์",
    paragraphs: [
      "ขอเท่าที่จำเป็นต่อฟีเจอร์ที่คุณใช้จริง และเป็นสิทธิ์แบบแคบที่สุดที่ยังทำงานได้:",
    ],
    table: {
      columns: ["สิทธิ์", "ใช้ทำอะไร"],
      rows: [
        ["drive.file", "สร้างและแก้ไขเฉพาะสเปรดชีตบัญชีกับโฟลเดอร์รูปทริปที่บอทสร้างขึ้นเองเท่านั้น เข้าถึงไฟล์อื่นในไดรฟ์ของคุณไม่ได้เลย"],
        ["calendar.events", "สร้าง แก้ไข ลบ และอ่านนัดหมายตามที่คุณสั่ง"],
        ["tasks", "เพิ่ม ทำเครื่องหมายเสร็จ และลบรายการสิ่งที่ต้องทำ"],
        ["gmail.readonly", "อ่านหัวข้อและผู้ส่งของอีเมลล่าสุดเมื่อคุณถาม และอ่านที่อยู่อีเมลของบัญชีคุณเองเพื่อส่งรหัสยืนยันตอนล้างข้อมูล — ไม่ใช้สิทธิ์ modify จึงลบ จัดเก็บ หรือทำเครื่องหมายอ่านแล้วไม่ได้"],
        ["gmail.send", "ส่งอีเมลตามที่คุณสั่ง โดยถามยืนยันก่อนส่งทุกครั้ง และส่งรหัสยืนยันการล้างข้อมูล"],
        ["contacts.readonly", "ค้นหาที่อยู่อีเมลจากชื่อผู้ติดต่อ เพื่อให้พิมพ์ \"ส่งอีเมลถึง<ชื่อ>\" ได้ — อ่านอย่างเดียว ไม่เคยเขียนลงรายชื่อผู้ติดต่อ"],
      ],
    },
  },
  {
    heading: "บริการภายนอกที่ข้อมูลถูกส่งไปถึง",
    paragraphs: [
      "บอทเรียกใช้บริการเหล่านี้เพื่อทำงานให้ครบ ข้อมูลที่ส่งไปมีเท่าที่จำเป็นต่อคำขอนั้นๆ:",
    ],
    table: {
      columns: ["บริการ", "ข้อมูลที่ส่งไป"],
      rows: [
        ["LINE (Messaging API)", "ข้อความที่คุณส่งหาบอทและคำตอบที่บอทส่งกลับ ผ่านระบบของ LINE ตามปกติของแพลตฟอร์ม"],
        ["Google (Sheets, Drive, Calendar, Tasks, Gmail, Contacts)", "ข้อมูลที่คุณสั่งให้บันทึกหรืออ่าน ไปยังบัญชี Google ของคุณเอง"],
        ["Google Gemini API", "ข้อความที่คุณพิมพ์ ประวัติการสนทนาย้อนหลัง 24 ชั่วโมง และข้อมูลเฉพาะเดือนปัจจุบันที่เกี่ยวข้องกับคำถาม (เช่น รายการเดือนนี้ ไดอารี่เดือนนี้ งบ ตารางเวร) เพื่อให้ AI ตีความคำสั่งและตอบคำถาม — การใช้งานอยู่ภายใต้เงื่อนไขของ Google"],
        ["Cloudflare Workers และ Workers KV", "เป็นที่รันโค้ดและเก็บข้อมูลตามตารางด้านบน"],
        ["Google Maps Places API", "คำค้นและพิกัดที่คุณแชร์ เฉพาะตอนใช้ \"หา...ใกล้ฉัน\""],
        ["Open-Meteo", "ชื่อจังหวัดและพิกัดของจังหวัดที่คุณตั้งไว้ เพื่อดึงพยากรณ์อากาศ"],
        ["Travelpayouts / Hotellook", "เมืองต้นทาง-ปลายทางและวันเดินทางที่คุณระบุ เฉพาะตอนค้นตั๋วหรือที่พัก"],
        ["Bangkok Post, CNBC, Yahoo Finance, Forex Factory", "ไม่ส่งข้อมูลของคุณเลย เป็นการดึงข่าวและราคาสาธารณะมาแสดงเท่านั้น"],
      ],
    },
  },
  {
    heading: "ความปลอดภัย",
    bullets: [
      "ทุกการเชื่อมต่อเป็น HTTPS",
      "ทุกข้อความที่เข้ามาผ่านการตรวจลายเซ็นของ LINE ก่อนประมวลผล ข้อความที่ลายเซ็นไม่ถูกต้องถูกปฏิเสธทันที",
      "ลิงก์หน้าเว็บดูข้อมูลใช้โทเคนที่เซ็นด้วย HMAC และหมดอายุใน 1 ชั่วโมง ทุกหน้าตั้งค่า no-store และ no-referrer เพื่อไม่ให้โทเคนหลุดไปกับแคชหรือ referrer",
      "การล้างข้อมูลรายรับ-รายจ่ายต้องยืนยันด้วยรหัส 6 หลักที่ส่งไปยังอีเมลของบัญชี Google ที่เป็นเจ้าของสมุดเท่านั้น รหัสมีอายุ 15 นาที และถูกยกเลิกเมื่อใส่ผิดครบ 5 ครั้ง",
      "ปิดฟีเจอร์ \"แชท\" ของ LINE Official Account ไว้ จึงไม่มีกล่องข้อความให้ผู้ดูแลนั่งอ่านบทสนทนาของคุณ มีเพียงโค้ดเท่านั้นที่ประมวลผลข้อความ",
    ],
  },
  {
    heading: "สิทธิของคุณ และวิธีใช้สิทธิ",
    bullets: [
      "ดูข้อมูลทั้งหมด: เปิดสเปรดชีตและไดรฟ์ของคุณเองได้ตลอดเวลา ข้อมูลเป็นของคุณอยู่แล้ว หรือพิมพ์ \"เปิดเว็บดูข้อมูล\" ในแชท",
      "แก้ไขข้อมูล: แก้ในสเปรดชีตโดยตรง หรือผ่านหน้าเว็บของบอท",
      "ลบรายรับ-รายจ่ายทั้งหมด: พิมพ์ \"ตั้งค่า\" ในแชท แล้วใช้หัวข้อล้างข้อมูล (ต้องยืนยันทางอีเมล)",
      "ลบทุกอย่าง: ลบสเปรดชีตและโฟลเดอร์รูปในไดรฟ์ของคุณเอง แล้วถอนสิทธิ์บอทที่หน้า Google Account ของคุณ (การถอนสิทธิ์ทำให้ refresh token ที่เก็บไว้ใช้ไม่ได้ทันที)",
      `ขอให้ลบข้อมูลที่ระบบเก็บไว้: แจ้งทางแชท หรืออีเมล ${CONTACT_EMAIL} ข้อมูลตามตารางด้านบนจะถูกลบออกจาก KV`,
      "บล็อกหรือลบเพื่อนกับบอทใน LINE ได้ตลอดเวลา บอทจะไม่ส่งข้อความหาคุณอีก",
    ],
  },
  {
    heading: "ผู้ใช้ที่เป็นเยาวชน",
    paragraphs: [
      "บอทนี้ไม่ได้ออกแบบมาสำหรับเด็กอายุต่ำกว่า 13 ปี และไม่มีการเก็บข้อมูลจากเด็กโดยเจตนา",
    ],
  },
  {
    heading: "การใช้งานในกลุ่ม",
    paragraphs: [
      "เมื่อเพิ่มบอทเข้ากลุ่ม LINE สมุดบัญชีของกลุ่มจะเป็นสมุดเล่มเดียวที่ทุกคนในกลุ่มใช้ร่วมกัน ข้อความที่บอทตอบจะปรากฏในแชทกลุ่มให้สมาชิกทุกคนเห็น รวมถึงลิงก์เปิดดูข้อมูล ซึ่งสมาชิกคนใดก็เปิดได้ โปรดพิจารณาก่อนบันทึกข้อมูลที่ไม่ต้องการให้คนในกลุ่มเห็น",
      "การตั้งค่าบอทในกลุ่มเป็นค่าเดียวกันทั้งกลุ่ม ต่างจากแชทส่วนตัวที่แต่ละคนมีการตั้งค่าของตัวเอง",
    ],
  },
  {
    heading: "การเปลี่ยนแปลงนโยบาย",
    paragraphs: [
      "หากมีการแก้ไข วันที่ปรับปรุงล่าสุดด้านบนจะเปลี่ยนตาม การเปลี่ยนแปลงที่กระทบสิทธิของคุณอย่างมีนัยสำคัญจะแจ้งผ่านแชท",
    ],
  },
];

// ---- Terms of use ----------------------------------------------------------

const TERMS_SECTIONS: Section[] = [
  {
    heading: "บอทนี้ทำอะไรได้บ้าง",
    paragraphs: ["ผู้ช่วยส่วนตัวในแชท LINE ภาษาไทย ใช้งานได้ทั้งแชทส่วนตัวและในกลุ่ม:"],
    bullets: [
      "จดรายรับ-รายจ่ายจากข้อความธรรมดา เช่น \"ซื้อกาแฟ 60\" พร้อมรายงานสรุปรายวัน/สัปดาห์/เดือน",
      "ตั้งงบประมาณรายหมวด และแจ้งเตือนเมื่อใช้เกินงบ",
      "จดไดอารี่ประจำวัน พร้อมค้นหาย้อนหลัง",
      "สร้างและจัดการนัดหมายใน Google Calendar และสิ่งที่ต้องทำใน Google Tasks",
      "เก็บรูปและวิดีโอทริปขึ้น Google Drive อัตโนมัติ แยกโฟลเดอร์ตามทริปและวันที่",
      "ตารางเวรรายเดือน",
      "เช็คและส่งอีเมลผ่าน Gmail พร้อมค้นที่อยู่อีเมลจากรายชื่อผู้ติดต่อ",
      "ค้นหาร้านและสถานที่ใกล้ตัวจากตำแหน่งที่แชร์",
      "ค้นหาตั๋วเครื่องบินและที่พัก พร้อมลิงก์ไปจองที่เว็บของผู้ให้บริการ",
      "ทักทายตอนเช้าพร้อมสรุปวันที่ อากาศ ข่าว และราคาทอง-บิตคอยน์",
      "ตอบคำถามเกี่ยวกับข้อมูลของคุณเองด้วย AI",
    ],
  },
  {
    heading: "การเริ่มใช้งาน",
    paragraphs: [
      "เพิ่มบอทเป็นเพื่อนใน LINE แล้วพิมพ์อะไรก็ได้ บอทจะส่งลิงก์ให้เชื่อมบัญชี Google เมื่อเชื่อมสำเร็จ ระบบจะสร้างสเปรดชีตใหม่ในไดรฟ์ของคุณให้อัตโนมัติเพื่อใช้เป็นสมุดบัญชี",
      "พิมพ์ \"วิธีใช้\" เพื่อดูคู่มือฉบับเต็ม หรือ \"ทำอะไรได้บ้าง\" เพื่อดูรายการความสามารถแบบย่อ",
    ],
  },
  {
    heading: "ข้อกำหนดสำคัญที่ควรทราบก่อนใช้",
    bullets: [
      "ให้บริการตามสภาพที่เป็นอยู่ (as-is) โดยไม่มีการรับประกันใดๆ เป็นโครงการส่วนตัวที่ไม่มีค่าบริการ และไม่มีข้อผูกพันเรื่องเวลาให้บริการหรือการกู้คืนข้อมูล",
      "ข้อมูลอยู่ในบัญชี Google ของคุณเอง คุณจึงเป็นผู้รับผิดชอบการสำรองข้อมูลของตัวเอง (Google Sheets มีประวัติเวอร์ชันย้อนหลังให้ใช้ได้)",
      "บอทใช้ AI ช่วยตีความข้อความ ซึ่งอาจตีความผิดพลาดได้ ทุกการบันทึก แก้ไข หรือลบข้อมูล รวมถึงการส่งอีเมล จะถามยืนยันก่อนเสมอ โปรดอ่านข้อความยืนยันก่อนตอบ \"ใช่\"",
      "ตัวเลขและยอดรวมทั้งหมดคำนวณด้วยโค้ด ไม่ใช่ AI แต่ผลลัพธ์ขึ้นอยู่กับความถูกต้องของสิ่งที่บันทึกเข้าไป โปรดอย่าใช้แทนเอกสารทางบัญชีหรือภาษีอย่างเป็นทางการ",
      "ข้อมูลราคาตั๋ว ที่พัก ทอง และคริปโต ดึงมาจากแหล่งภายนอกเพื่อใช้อ้างอิงคร่าวๆ เท่านั้น ไม่ใช่คำแนะนำการลงทุน และอาจไม่เป็นปัจจุบัน โปรดตรวจสอบราคาจริงที่เว็บของผู้ให้บริการก่อนตัดสินใจเสมอ",
      "คำตอบเรื่องสุขภาพ กฎหมาย การเงิน หรือเรื่องสำคัญอื่นๆ เป็นข้อมูลทั่วไป ไม่ใช่คำแนะนำจากผู้เชี่ยวชาญ",
    ],
  },
  {
    heading: "สิ่งที่ไม่ควรทำ",
    bullets: [
      "อย่าใช้บอทเก็บข้อมูลที่อ่อนไหวมาก เช่น รหัสผ่าน เลขบัตรเครดิต หรือเลขบัตรประชาชน",
      "อย่าใช้ส่งอีเมลสแปม ข้อความหลอกลวง หรือเนื้อหาที่ผิดกฎหมาย",
      "อย่าใช้ในทางที่ละเมิดข้อกำหนดของ LINE หรือ Google",
      "ในกลุ่ม โปรดคำนึงว่าข้อมูลที่บันทึกและลิงก์ที่บอทส่งจะเห็นได้ทั้งกลุ่ม",
    ],
  },
  {
    heading: "ข้อจำกัดที่ทราบอยู่แล้ว",
    bullets: [
      "การเชื่อมบัญชีจะสร้างสเปรดชีตใหม่เสมอ ยังไม่รองรับการเลือกสมุดเล่มเดิมที่มีอยู่",
      "รูปและวิดีโอจะอัปโหลดเฉพาะตอนที่เปิดทริปอยู่เท่านั้น",
      "สรุปรายเดือนเป็นข้อความ ไม่ใช่กราฟ",
      "บอทอาจตอบช้าหรือตอบไม่ได้ชั่วคราวเมื่อบริการภายนอก (Google, LINE, AI) ขัดข้อง",
    ],
  },
  {
    heading: "การหยุดใช้งาน",
    paragraphs: [
      "บล็อกหรือลบเพื่อนกับบอทใน LINE ได้ทุกเมื่อ และถอนสิทธิ์การเข้าถึงบัญชี Google ได้ที่หน้าจัดการความปลอดภัยของบัญชี Google ของคุณ ข้อมูลในไดรฟ์และสเปรดชีตยังเป็นของคุณและอยู่ครบ คุณจะลบเองหรือเก็บไว้ก็ได้",
    ],
  },
  {
    heading: "การเปลี่ยนแปลงและการติดต่อ",
    paragraphs: [
      `ข้อกำหนดนี้อาจปรับปรุงตามฟีเจอร์ที่เพิ่มขึ้น วันที่ปรับปรุงล่าสุดแสดงอยู่ด้านบน มีคำถามหรือต้องการใช้สิทธิเกี่ยวกับข้อมูลส่วนบุคคล ติดต่อ ${CONTACT_EMAIL} หรือทักหาบอทในแชท LINE`,
    ],
  },
];


// ---- Privacy policy, English ----------------------------------------------
// Kept beside the Thai rather than in its own file so the two are edited in
// the same place and are harder to let drift. A test asserts they stay
// structurally identical — same sections, same table shapes — because a
// translation that quietly loses a row is a policy that says different
// things to different reviewers.

const PRIVACY_SECTIONS_EN: Section[] = [
  {
    heading: "Who operates this service",
    paragraphs: [
      "This is a personal assistant bot for the LINE app, built and maintained by an individual for personal use and small groups. It is not a commercial service. No data is sold, there is no advertising, and nothing is shared with third parties for marketing of any kind.",
      `Contact for privacy matters: ${CONTACT_EMAIL}, or message the bot directly in LINE.`,
    ],
  },
  {
    heading: "The core principle: your data lives in your own Google account",
    paragraphs: [
      "Income and expenses, diary entries, budgets and shift schedules are all written to a Google Sheets spreadsheet in your own Drive — not to a database belonging to the developer. Trip photos and videos upload to your own Google Drive, appointments go to your own Google Calendar, and to-dos to your own Google Tasks.",
      "The developer holds no copy of any of it and cannot read it. The bot's own systems store only the key that links your LINE account to your Google account, plus short-lived working state, listed below.",
    ],
  },
  {
    heading: "What the bot's systems store, and for how long",
    paragraphs: ["Held in Cloudflare Workers KV, limited to what the bot needs to function:"],
    table: {
      columns: ["Data", "Retention"],
      rows: [
        ["LINE user ID (or group ID) paired with a Google refresh token and a spreadsheet ID — what lets the bot know who you are and which book to write to", "Until you unlink the account"],
        ["Bot settings: its name, its character, and what it calls you", "Until changed, or until you unlink"],
        ["Weather province (the province name and that province's coordinates — not your actual location)", "Until changed, or until you unlink"],
        ["The last 6 exchanges of conversation (your messages and the bot's replies), used so the AI can follow up on what was just said", "24 hours, then deleted automatically"],
        ["In-progress state, such as an entry waiting for you to type \"ใช่\" to confirm, or a search waiting for you to share a location", "10 minutes, then deleted automatically"],
        ["The confirmation code emailed before erasing your transactions", "15 minutes, then deleted automatically"],
        ["A web-search answer too long to send in chat (if that feature is switched on)", "1 hour, then deleted automatically"],
        ["The queue of photos and videos waiting to upload (LINE message IDs only — never the files themselves)", "Until the upload finishes"],
        ["Technical bookkeeping, such as the date you were last greeted and which spreadsheet row each month starts on", "Up to 90 days"],
      ],
    },
  },
  {
    heading: "What is never collected",
    bullets: [
      "No copy of your transactions, diary entries, photos, videos, appointments, emails or contacts is kept in the bot's systems.",
      "Your Google password is never stored or seen — linking uses Google OAuth, where you enter your password with Google directly.",
      "Your real location is never stored. When you use the nearby-places search, the coordinates you share are used for that one lookup and discarded.",
      "No card or payment details, because the bot takes no payments.",
    ],
  },
  {
    heading: "Google permissions requested, and why each one",
    paragraphs: ["Only what the features you use actually need, and the narrowest scope that still works:"],
    table: {
      columns: ["Scope", "What it is used for"],
      rows: [
        ["drive.file", "Create and edit only the accounts spreadsheet and trip folders the bot itself created. It cannot reach any other file in your Drive."],
        ["calendar.events", "Create, edit, delete and read appointments as you instruct."],
        ["tasks", "Add, complete and delete to-do items."],
        ["gmail.readonly", "Read the subject and sender of recent mail when you ask, and read your own account's email address in order to send the erase-confirmation code. The modify scope is deliberately not requested, so the bot cannot delete, archive or mark anything read."],
        ["gmail.send", "Send email as you instruct, always confirming before sending, and send the erase-confirmation code."],
        ["contacts.readonly", "Look up an email address by contact name, so \"email <name>\" works. Read-only — the bot never writes to your contacts."],
      ],
    },
  },
  {
    heading: "Third-party services your data reaches",
    paragraphs: ["The bot calls these to do its job, sending only what that particular request needs:"],
    table: {
      columns: ["Service", "What is sent"],
      rows: [
        ["LINE (Messaging API)", "The messages you send the bot and the replies it sends back, through LINE's platform as normal."],
        ["Google (Sheets, Drive, Calendar, Tasks, Gmail, Contacts)", "Whatever you ask to be saved or read, to your own Google account."],
        ["Google Gemini API", "Your message text, the last 24 hours of conversation, and the current month's relevant records (this month's transactions, diary entries, budgets, shift schedule) so the AI can interpret commands and answer questions. Use is subject to Google's terms."],
        ["Cloudflare Workers and Workers KV", "Where the code runs and where the data in the table above is stored."],
        ["Google Maps Places API", "Your search term and the coordinates you shared, only when using nearby-places search."],
        ["Open-Meteo", "The name and coordinates of the province you set, to fetch a forecast."],
        ["Travelpayouts / Hotellook", "The origin, destination and dates you specify, only when searching flights or hotels."],
        ["Bangkok Post, CNBC, Yahoo Finance, Forex Factory", "Nothing about you at all — these are public news and price feeds the bot reads."],
      ],
    },
  },
  {
    heading: "Security",
    bullets: [
      "Every connection is HTTPS.",
      "Every incoming message has its LINE signature verified before it is processed; anything that fails is rejected outright.",
      "Web-viewer links use an HMAC-signed token that expires after one hour, and every page sets no-store and no-referrer so the token cannot leak through a cache or a referrer header.",
      "Erasing your transactions requires a 6-digit code sent to the email address of the Google account that owns the book. The code lasts 15 minutes and is destroyed after five wrong attempts.",
      "The LINE Official Account's \"Chat\" feature is switched off, so there is no inbox for an operator to sit and read your conversations in. Only code processes your messages.",
    ],
  },
  {
    heading: "Your rights, and how to exercise them",
    bullets: [
      "See everything: open your own spreadsheet and Drive at any time — the data is already yours — or type \"เปิดเว็บดูข้อมูล\" in chat.",
      "Correct anything: edit the spreadsheet directly, or use the bot's web pages.",
      "Erase all income and expense records: type \"ตั้งค่า\" in chat and use the erase section (email confirmation required).",
      "Erase everything: delete the spreadsheet and photo folders from your own Drive, then revoke the bot's access in your Google Account settings. Revoking immediately invalidates the stored refresh token.",
      `Ask for the data held in the bot's systems to be deleted: message the bot, or email ${CONTACT_EMAIL}. Everything in the table above is removed from KV.`,
      "Block or unfriend the bot in LINE at any time, and it will not message you again.",
    ],
  },
  {
    heading: "Children",
    paragraphs: [
      "This bot is not designed for children under 13, and no data is knowingly collected from them.",
    ],
  },
  {
    heading: "Group use",
    paragraphs: [
      "When the bot is added to a LINE group, that group shares a single book among all its members. The bot's replies appear in the group chat for everyone to see, including web-viewer links, which any member can open. Please consider that before recording anything you would not want the group to see.",
      "Bot settings in a group apply to the whole group, unlike a personal chat where each person has their own.",
    ],
  },
  {
    heading: "Changes to this policy",
    paragraphs: [
      "If this is revised, the last-updated date above changes with it. Changes that materially affect your rights will be announced in chat.",
    ],
  },
];

const TERMS_SECTIONS_EN: Section[] = [
  {
    heading: "What the bot does",
    paragraphs: ["A Thai-language personal assistant in LINE chat, usable in both one-to-one and group chats:"],
    bullets: [
      "Records income and expenses from ordinary messages such as \"ซื้อกาแฟ 60\" (bought coffee, 60 baht), with daily, weekly and monthly summaries",
      "Sets per-category budgets and warns when you go over",
      "Keeps a daily diary, searchable afterwards",
      "Creates and manages Google Calendar appointments and Google Tasks to-dos",
      "Uploads trip photos and videos to Google Drive automatically, in folders by trip and date",
      "Monthly shift schedules",
      "Checks and sends email through Gmail, resolving addresses from your contacts",
      "Finds nearby places from a shared location",
      "Searches flights and accommodation, linking out to the providers' own sites to book",
      "A morning greeting with the date, weather, news and gold/Bitcoin prices",
      "Answers questions about your own records using AI",
    ],
  },
  {
    heading: "Getting started",
    paragraphs: [
      "Add the bot as a friend in LINE and send it anything. It replies with a link to connect your Google account, and on success creates a new spreadsheet in your Drive to use as your book.",
      "Type \"วิธีใช้\" for the full guide, or \"ทำอะไรได้บ้าง\" for a short list of what it can do.",
    ],
  },
  {
    heading: "Terms you should know before using it",
    bullets: [
      "Provided as-is, with no warranty of any kind. This is a free personal project with no commitment to uptime or data recovery.",
      "Your data lives in your own Google account, so backing it up is yours to do. Google Sheets keeps version history you can fall back on.",
      "The bot uses AI to interpret messages, and AI can misread them. Every save, edit, deletion and outgoing email asks you to confirm first — please read the confirmation before answering \"ใช่\".",
      "All figures and totals are calculated by code, not by AI, but they are only as accurate as what was recorded. Do not use this in place of formal accounting or tax records.",
      "Flight, hotel, gold and crypto prices come from external sources for rough reference only. They are not investment advice and may be out of date — always check the real price with the provider before deciding.",
      "Answers about health, legal, financial or other significant matters are general information, not professional advice.",
    ],
  },
  {
    heading: "What not to do",
    bullets: [
      "Do not use the bot to store highly sensitive data such as passwords, card numbers or national ID numbers.",
      "Do not use it to send spam, scams or unlawful content.",
      "Do not use it in ways that breach LINE's or Google's terms.",
      "In a group, remember that what you record and the links the bot sends are visible to everyone in it.",
    ],
  },
  {
    heading: "Known limitations",
    bullets: [
      "Linking always creates a new spreadsheet; choosing an existing book is not supported yet.",
      "Photos and videos upload only while a trip is open.",
      "The monthly summary is text, not a chart.",
      "The bot may answer slowly or not at all while an external service (Google, LINE, the AI) is having problems.",
    ],
  },
  {
    heading: "Stopping",
    paragraphs: [
      "Block or unfriend the bot in LINE at any time, and revoke its access to your Google account from your Google Account security settings. Your Drive files and spreadsheet remain yours and stay intact — delete them or keep them, as you prefer.",
    ],
  },
  {
    heading: "Changes and contact",
    paragraphs: [
      `These terms may be revised as features are added; the last-updated date is shown above. For questions, or to exercise any privacy right, contact ${CONTACT_EMAIL} or message the bot in LINE.`,
    ],
  },
];

export function handlePrivacyRequest(_env: Env, locale: Locale = "th"): Response {
  return html(
    locale === "en"
      ? renderLegalPage(
          "en",
          "privacy",
          "Privacy Policy",
          "The short version: your data is written to your own Google account. The developer holds no copy and cannot read it. The bot's systems store only the key that links the two accounts, plus short-lived working state. Nothing is sold or shared for marketing.",
          PRIVACY_SECTIONS_EN
        )
      : renderLegalPage(
          "th",
          "privacy",
          "นโยบายความเป็นส่วนตัว",
          "สรุปสั้นที่สุด: ข้อมูลของคุณถูกบันทึกลงบัญชี Google ของคุณเอง ผู้พัฒนาไม่มีสำเนาและเข้าถึงไม่ได้ ระบบของบอทเก็บเพียงกุญแจเชื่อมบัญชีและสถานะชั่วคราวเท่าที่จำเป็น ไม่มีการขายหรือแบ่งปันข้อมูลเพื่อการตลาด",
          PRIVACY_SECTIONS
        )
  );
}

export function handleTermsRequest(_env: Env, locale: Locale = "th"): Response {
  return html(
    locale === "en"
      ? renderLegalPage(
          "en",
          "terms",
          "Terms of Use",
          "A personal assistant bot in LINE chat for expense tracking, diary keeping, appointments and everyday tasks. Free, provided as-is, with all data stored in the user's own Google account.",
          TERMS_SECTIONS_EN
        )
      : renderLegalPage(
          "th",
          "terms",
          "รายละเอียดการใช้งานและข้อกำหนด",
          "บอทผู้ช่วยส่วนตัวในแชท LINE สำหรับจดบัญชี ไดอารี่ นัดหมาย และงานประจำวัน ให้บริการฟรีตามสภาพที่เป็นอยู่ โดยข้อมูลทั้งหมดเก็บอยู่ในบัญชี Google ของผู้ใช้เอง",
          TERMS_SECTIONS
        )
  );
}

/** Exported for the structural test that keeps the two languages in step. */
export const LEGAL_SECTIONS = {
  privacy: { th: PRIVACY_SECTIONS, en: PRIVACY_SECTIONS_EN },
  terms: { th: TERMS_SECTIONS, en: TERMS_SECTIONS_EN },
};
