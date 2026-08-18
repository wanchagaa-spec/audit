// /view/settings (PLAN.md 17.48) — the bot's name, character, what it calls
// you, your weather province, and a way to wipe the money and start over.
//
// The third write-capable page in the /view family, after ตารางเวร and งบ,
// and the first with anything destructive on it. Everything above the danger
// zone saves the same way งบ does: one form, one POST, pressing Save is the
// confirmation.
//
// Wiping is not like that, and deliberately doesn't look like it. It asks
// for a code emailed to the Google account that owns the spreadsheet, which
// answers a question a button alone cannot: not "did you mean to press
// this", but "are you the person whose money this is". That matters most in
// a group, where the view link is shared into the chat and any member can
// open it — the code goes to the one mailbox that owns the book.

import type { Env } from "./index.ts";
import { setProvinceByName } from "./greetingCommands.ts";
import {
  getOwnEmailAddress,
  GmailApiDisabledError,
  InsufficientGmailScopeError,
  sendEmail,
} from "./gmail.ts";
import { clearAllTransactions } from "./sheets.ts";
import {
  DEFAULT_BOT_CHARACTER,
  DEFAULT_BOT_NAME,
  getBotSettings,
  saveBotSettings,
  wantsMorningBriefing,
} from "./settings.ts";
import { getAccountLink, getUserProvince } from "./state.ts";
import {
  DATA_FETCH_FAILED_MESSAGE,
  escapeHtml,
  html,
  pageShell,
  renderErrorPage,
  resolveViewSession,
} from "./viewAuth.ts";

// Long enough that guessing is hopeless within the window, short enough to
// retype from a phone's mail app without switching back and forth twice.
const WIPE_CODE_TTL_SECONDS = 15 * 60;
const MAX_WIPE_ATTEMPTS = 5;

interface WipeChallenge {
  code: string;
  email: string;
  attempts: number;
}

function wipeKey(subjectId: string): string {
  return `wipe-code:${subjectId}`;
}

async function getWipeChallenge(kv: KVNamespace, subjectId: string): Promise<WipeChallenge | null> {
  const raw = await kv.get(wipeKey(subjectId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WipeChallenge;
  } catch {
    return null;
  }
}

/** Six digits from crypto.getRandomValues rather than Math.random — this is
 * the only thing standing between a shared view link and someone else's
 * transaction history being deleted. */
function generateWipeCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

/** Shows enough of the address to recognise, not enough to learn. The person
 * who owns the mailbox knows which one it is; anyone else holding a shared
 * link doesn't get handed a full address to go looking in. */
function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "•••";
  const head = user.slice(0, 2);
  return `${head}${"•".repeat(Math.max(3, user.length - 2))}@${domain}`;
}

/** Length-independent-ish comparison. The codes are always six characters so
 * there is no length to leak, and this is a rate-limited 15-minute code
 * rather than a long-lived secret — but comparing every character costs
 * nothing and means the check can't be shortcut by timing. */
function codesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- Rendering -------------------------------------------------------------

interface PageState {
  token: string;
  botName: string;
  botCharacter: string;
  userNickname: string;
  provinceName: string | null;
  morningBriefing: boolean;
  /** Set once a code has been emailed and is still valid. */
  pendingWipeEmail: string | null;
  notice: string | null;
  error: string | null;
}

function renderSettingsPage(state: PageState): string {
  const action = `/view/settings?token=${encodeURIComponent(state.token)}`;
  const notice = state.notice ? `<p class="save-notice">${escapeHtml(state.notice)}</p>` : "";
  const error = state.error ? `<p class="danger-notice">${escapeHtml(state.error)}</p>` : "";

  const wipeBlock = state.pendingWipeEmail
    ? `<p class="danger-text">ส่งรหัส 6 หลักไปที่ <strong>${escapeHtml(maskEmail(state.pendingWipeEmail))}</strong> แล้ว ใส่รหัสเพื่อยืนยันการล้างข้อมูล (รหัสใช้ได้ 15 นาที)</p>
      <form method="post" action="${action}" class="danger-form">
        <input type="hidden" name="action" value="confirm-wipe" />
        <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required />
        <button type="submit" class="danger-button">ล้างข้อมูลรายรับ-รายจ่าย</button>
      </form>
      <form method="post" action="${action}" class="danger-cancel">
        <input type="hidden" name="action" value="cancel-wipe" />
        <button type="submit">ยกเลิก</button>
      </form>`
    : `<p class="danger-text">ลบรายรับ-รายจ่ายทั้งหมดออกจากสเปรดชีต เพื่อเริ่มจดใหม่ตั้งแต่ต้น <strong>ย้อนกลับไม่ได้</strong><br />ไม่แตะไดอารี่ งบที่ตั้งไว้ ปฏิทิน สิ่งที่ต้องทำ หรือรูปทริป</p>
      <form method="post" action="${action}">
        <input type="hidden" name="action" value="request-wipe" />
        <button type="submit" class="danger-button">ส่งรหัสยืนยันไปที่อีเมล</button>
      </form>`;

  return pageShell(
    "ตั้งค่า",
    `<h1>ตั้งค่า</h1><p class="subtitle">ปรับให้บอทเป็นแบบที่คุณอยากให้เป็น</p>
${notice}
${error}
<form method="post" action="${action}">
  <input type="hidden" name="action" value="save" />
  <div class="card">
    <h2>บอท</h2>
    <label class="field">
      <span>ชื่อบอท</span>
      <input type="text" name="botName" maxlength="40" value="${escapeHtml(state.botName)}" placeholder="${escapeHtml(DEFAULT_BOT_NAME)}" />
      <small>ในกลุ่ม พิมพ์ชื่อนี้ในข้อความก็เรียกบอทได้เลย ไม่ต้องแท็ก</small>
    </label>
    <label class="field">
      <span>คาแรคเตอร์</span>
      <textarea name="botCharacter" rows="4" maxlength="400" placeholder="${escapeHtml(DEFAULT_BOT_CHARACTER)}">${escapeHtml(state.botCharacter)}</textarea>
      <small>บอทจะใช้น้ำเสียงนี้ตอบทุกข้อความ ใส่สรรพนามกับคำลงท้ายที่อยากให้ใช้ไปด้วยได้ เช่น "ผู้ชายสุภาพ ใช้ผม/ครับ" ตัวเลขและลิงก์ยังคงเดิมเสมอไม่ว่าตั้งคาแรคเตอร์ยังไง</small>
    </label>
    <label class="field">
      <span>ให้บอทเรียกคุณว่า</span>
      <input type="text" name="userNickname" maxlength="40" value="${escapeHtml(state.userNickname)}" placeholder="เว้นว่าง = ไม่ต้องเรียกชื่อ" />
    </label>
  </div>
  <div class="card">
    <h2>สรุปเช้า 7 โมง</h2>
    <label class="check-field">
      <input type="hidden" name="morningBriefingSubmitted" value="1" />
      <input type="checkbox" name="morningBriefing" value="on"${state.morningBriefing ? " checked" : ""} />
      <span>ส่งสรุปเช้าให้ทุกวัน 7 โมง</span>
    </label>
    <small class="field-note">วันที่ อากาศ ข่าว ราคาทอง-บิตคอยน์ นัดวันนี้ เวรวันนี้ และสรุปไดอารี่เมื่อวาน · ปิดไว้ก็ยังทัก "สวัสดี" เพื่อขอสรุปเองได้ทุกเมื่อ</small>
  </div>
  <div class="card">
    <h2>พื้นที่พยากรณ์อากาศ</h2>
    <label class="field">
      <span>จังหวัด</span>
      <input type="text" name="province" maxlength="60" value="${escapeHtml(state.provinceName ?? "")}" placeholder="เช่น เชียงใหม่" />
      <small>ใช้บอกสภาพอากาศตอนทักทายครั้งแรกของวันและในสรุปเช้า 7 โมง</small>
    </label>
  </div>
  <button type="submit" class="save-button">บันทึกการตั้งค่า</button>
</form>
<div class="card danger-card">
  <h2>ล้างข้อมูลเพื่อเริ่มใหม่</h2>
  ${wipeBlock}
</div>
<p class="footnote">เห็นได้เฉพาะคนที่มีลิงก์นี้ · การล้างข้อมูลต้องยืนยันทางอีเมลของบัญชี Google ที่เป็นเจ้าของสมุด</p>`,
    { token: state.token, active: "settings" }
  );
}

// ---- Handler ---------------------------------------------------------------

async function buildState(
  env: Env,
  session: { lineUserId: string; token: string },
  overrides: Partial<PageState> = {}
): Promise<PageState> {
  const [settings, province, challenge, link] = await Promise.all([
    getBotSettings(env.ACCOUNTS, session.lineUserId),
    getUserProvince(env.ACCOUNTS, session.lineUserId),
    getWipeChallenge(env.ACCOUNTS, session.lineUserId),
    getAccountLink(env.ACCOUNTS, session.lineUserId),
  ]);
  return {
    token: session.token,
    botName: settings.botName,
    botCharacter: settings.botCharacter,
    userNickname: settings.userNickname,
    provinceName: province?.name ?? null,
    // Shows what would actually happen tomorrow, not just what was saved —
    // an account that predates the opt-in has no stored preference and is
    // still receiving the briefing, so an unticked box would be a lie.
    morningBriefing: wantsMorningBriefing(settings, link ?? {}),
    pendingWipeEmail: challenge?.email ?? null,
    notice: null,
    error: null,
    ...overrides,
  };
}

/** Saving the profile fields. Province goes through the same
 * setProvinceByName the chat command uses, so it geocodes exactly the same
 * way and a place that can't be found says so instead of being stored as a
 * name the weather lookup will silently never match. */
async function handleSave(env: Env, lineUserId: string, form: FormData): Promise<{ notice: string; error: string | null }> {
  await saveBotSettings(env.ACCOUNTS, lineUserId, {
    botName: String(form.get("botName") ?? ""),
    botCharacter: String(form.get("botCharacter") ?? ""),
    userNickname: String(form.get("userNickname") ?? ""),
    // An unticked checkbox sends nothing at all, which is indistinguishable
    // from a form that never had the field. The hidden marker beside it is
    // what makes "off" an answer rather than a silence — without it, turning
    // the briefing off would save as "never chosen" and a grandfathered
    // account would keep receiving it.
    ...(form.get("morningBriefingSubmitted") !== null
      ? { morningBriefing: form.get("morningBriefing") !== null }
      : {}),
  });

  const typedProvince = String(form.get("province") ?? "").trim();
  const currentProvince = await getUserProvince(env.ACCOUNTS, lineUserId);
  let error: string | null = null;
  // Only re-geocode when it actually changed — an unchanged field on every
  // save would mean an Open-Meteo lookup for nothing, and would turn a
  // transient geocoder outage into a failure to save the other fields.
  if (typedProvince !== "" && typedProvince !== (currentProvince?.name ?? "")) {
    const result = await setProvinceByName(env.ACCOUNTS, lineUserId, typedProvince);
    // setProvinceByName answers in chat prose. Only its failures matter here
    // — success is already obvious from the field holding the new name.
    if (!result.startsWith("ตั้งพื้นที่")) error = result;
  }
  return { notice: "บันทึกการตั้งค่าแล้ว ✓", error };
}

async function handleRequestWipe(
  env: Env,
  session: { lineUserId: string; accessToken: string }
): Promise<Partial<PageState>> {
  let email: string;
  try {
    email = await getOwnEmailAddress(session.accessToken);
  } catch (err) {
    console.error("handleRequestWipe: could not read the account's own email", err);
    if (err instanceof InsufficientGmailScopeError) {
      return { error: 'บัญชีนี้ยังไม่ได้ให้สิทธิ์ Gmail เลยส่งรหัสยืนยันไม่ได้ กลับไปที่แชทแล้วพิมพ์ "เชื่อมบัญชีใหม่" เพื่อให้สิทธิ์ก่อนนะ' };
    }
    if (err instanceof GmailApiDisabledError) {
      return { error: "Gmail API ยังไม่ได้เปิดใช้ในโปรเจกต์ Google Cloud เลยส่งรหัสยืนยันไม่ได้" };
    }
    return { error: DATA_FETCH_FAILED_MESSAGE };
  }

  const code = generateWipeCode();
  try {
    await sendEmail(
      session.accessToken,
      email,
      "รหัสยืนยันการล้างข้อมูลรายรับ-รายจ่าย",
      [
        `รหัสยืนยันของคุณคือ ${code}`,
        "",
        "ใส่รหัสนี้ในหน้าตั้งค่าเพื่อลบรายรับ-รายจ่ายทั้งหมดออกจากสเปรดชีต การลบย้อนกลับไม่ได้",
        "รหัสใช้ได้ 15 นาที",
        "",
        "ถ้าคุณไม่ได้เป็นคนขอ ไม่ต้องทำอะไร ไม่มีอะไรถูกลบจนกว่าจะมีคนใส่รหัสนี้",
      ].join("\n")
    );
  } catch (err) {
    console.error("handleRequestWipe: sending the confirmation email failed", err);
    return { error: "ส่งอีเมลรหัสยืนยันไม่สำเร็จ ลองใหม่อีกครั้งนะ" };
  }

  // Stored only after the mail is actually away — a challenge the user can
  // never receive a code for would just lock the section into a state with
  // no way forward but waiting out the TTL.
  await env.ACCOUNTS.put(
    wipeKey(session.lineUserId),
    JSON.stringify({ code, email, attempts: 0 } satisfies WipeChallenge),
    { expirationTtl: WIPE_CODE_TTL_SECONDS }
  );
  return { pendingWipeEmail: email, notice: `ส่งรหัสยืนยันไปที่ ${maskEmail(email)} แล้ว` };
}

async function handleConfirmWipe(
  env: Env,
  session: { lineUserId: string; accessToken: string; spreadsheetId: string },
  form: FormData
): Promise<Partial<PageState>> {
  const challenge = await getWipeChallenge(env.ACCOUNTS, session.lineUserId);
  if (!challenge) {
    return { pendingWipeEmail: null, error: "รหัสหมดอายุแล้ว กดขอรหัสใหม่อีกครั้งนะ" };
  }

  const typed = String(form.get("code") ?? "").trim();
  if (!codesMatch(typed, challenge.code)) {
    const attempts = challenge.attempts + 1;
    if (attempts >= MAX_WIPE_ATTEMPTS) {
      // Burn the code rather than let it be ground down. Nothing has been
      // deleted, so the cost of being wrong here is one more email.
      await env.ACCOUNTS.delete(wipeKey(session.lineUserId));
      return { pendingWipeEmail: null, error: "ใส่รหัสผิดหลายครั้งเกินไป รหัสนี้ถูกยกเลิกแล้ว กดขอรหัสใหม่ได้เลย" };
    }
    await env.ACCOUNTS.put(
      wipeKey(session.lineUserId),
      JSON.stringify({ ...challenge, attempts } satisfies WipeChallenge),
      { expirationTtl: WIPE_CODE_TTL_SECONDS }
    );
    return {
      pendingWipeEmail: challenge.email,
      error: `รหัสไม่ถูกต้อง เหลืออีก ${MAX_WIPE_ATTEMPTS - attempts} ครั้ง`,
    };
  }

  try {
    await clearAllTransactions(session.accessToken, session.spreadsheetId, env.ACCOUNTS);
  } catch (err) {
    console.error("handleConfirmWipe: clearing transactions failed", err);
    // The challenge survives a failed wipe on purpose: the user proved who
    // they were, the delete is what broke, and making them redo the email
    // round trip to retry would be punishing them for our outage.
    return { pendingWipeEmail: challenge.email, error: "ล้างข้อมูลไม่สำเร็จ ลองกดยืนยันอีกครั้งนะ" };
  }
  await env.ACCOUNTS.delete(wipeKey(session.lineUserId));
  return { pendingWipeEmail: null, notice: "ล้างรายรับ-รายจ่ายทั้งหมดแล้ว เริ่มจดใหม่ได้เลย ✓" };
}

export async function handleViewSettingsRequest(request: Request, env: Env): Promise<Response> {
  const session = await resolveViewSession(request, env);
  if (session instanceof Response) return session;

  try {
    if (request.method === "POST") {
      const form = await request.formData();
      const action = String(form.get("action") ?? "");

      if (action === "save") {
        const { notice, error } = await handleSave(env, session.lineUserId, form);
        return html(renderSettingsPage(await buildState(env, session, { notice, error })));
      }
      if (action === "request-wipe") {
        return html(renderSettingsPage(await buildState(env, session, await handleRequestWipe(env, session))));
      }
      if (action === "confirm-wipe") {
        return html(renderSettingsPage(await buildState(env, session, await handleConfirmWipe(env, session, form))));
      }
      if (action === "cancel-wipe") {
        await env.ACCOUNTS.delete(wipeKey(session.lineUserId));
        return html(renderSettingsPage(await buildState(env, session, { pendingWipeEmail: null })));
      }
      return html(renderSettingsPage(await buildState(env, session, { error: "ไม่รู้จักคำสั่งนี้" })), 400);
    }

    return html(renderSettingsPage(await buildState(env, session)));
  } catch (err) {
    console.error("handleViewSettingsRequest failed", err);
    return html(renderErrorPage("เปิดหน้าตั้งค่าไม่ได้", DATA_FETCH_FAILED_MESSAGE), 502);
  }
}
