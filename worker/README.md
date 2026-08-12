# LINE Bot — Cloudflare Worker (Phase 5)

Lets you log expenses by chatting with a LINE Official Account instead of (or alongside)
the web app. See [`../PLAN.md`](../PLAN.md) section 14 for the architecture and rationale.

It reuses the same parsing/clarification logic as the web app
(`../app/src/lib/parser.ts`, `chatEngine.ts`) and writes to the **same Google Sheets
layout**, so a spreadsheet stays compatible whichever interface you log from.

## What you need to set up yourself

### 1. LINE Official Account + Messaging API channel

1. Go to [LINE Developers Console](https://developers.line.biz/console/) → create a
   provider → create a channel of type **Messaging API**.
2. Under the channel's **Messaging API** tab:
   - Copy the **Channel secret** (Basic settings tab) → this is `LINE_CHANNEL_SECRET`
   - Issue and copy a **Channel access token (long-lived)** → this is `LINE_CHANNEL_ACCESS_TOKEN`
   - Turn **off** "Auto-reply messages" and "Greeting messages" (so only our webhook responds)
3. Under **Response settings** (in the LINE Official Account Manager, not the Developers
   Console): turn the **"Chat"** feature off — this disables the human-readable chat inbox,
   so nobody but the webhook code ever sees raw messages (see PLAN.md 14.4).
4. You'll set the actual webhook URL after deploying the Worker (step 4 below).

### 2. Cloudflare account

Sign up at https://dash.cloudflare.com (no credit card needed for the Workers/KV free tier).
Then create an API Token: **My Profile → API Tokens → Create Token → use the "Edit
Cloudflare Workers" template → Create Token**. Copy it once (shown only that one time).

### 3. Reuse the same Google OAuth client as the web app — plus a Client Secret

The web app's Client ID (`VITE_GOOGLE_CLIENT_ID`) only supports the browser-side implicit
flow. The bot needs a **refresh token** so it can write to Sheets when nobody has the app
open, which requires the *authorization code* flow — and that needs a Client Secret that
must never reach a browser.

1. In the same Google Cloud project as before, open the OAuth client you already created
   (APIs & Services → Credentials).
2. Add an **Authorized redirect URI**: `https://<your-worker-subdomain>.workers.dev/oauth/callback`
   (you'll know the exact subdomain after the first deploy; redeploy isn't needed to add
   this — just update it in Google Cloud Console once you know the URL).
3. Copy the **Client secret** shown on that same page.
4. Under **OAuth consent screen → Test users**, add every Google account that will use the
   bot (up to 100) — while the app is unverified/"Testing", only listed accounts can
   complete sign-in. See PLAN.md for the tradeoff against submitting the app for Google
   verification instead.
5. Under **APIs & Services → Library**, make sure **Google Sheets API**, **Google Drive
   API**, and **Google Calendar API** are all "Enabled" for this project (search each by
   name, click it, click Enable if it isn't already) — a disabled API fails with a clear
   `has not been used in this project` error from Google, so this is worth checking first
   if something that used to work suddenly errors after adding the calendar feature.
6. **If you already linked accounts before the calendar feature existed**: those refresh
   tokens only cover `drive.file`, not `calendar.events`. The bot detects this itself and
   replies with a fresh link when someone tries a calendar command — no action needed here,
   just know it'll ask once per already-linked person.

### 4. Deploy — no terminal needed, everything runs on GitHub

Two workflows under `.github/workflows/` handle this entirely in GitHub Actions:

1. Add these as **repository secrets** (Settings → Secrets and variables → Actions →
   New repository secret) — `VITE_GOOGLE_CLIENT_ID` already exists from the web app setup,
   reused automatically:

   | Secret name | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | the token from step 2 |
   | `LINE_CHANNEL_SECRET` | from step 1 |
   | `LINE_CHANNEL_ACCESS_TOKEN` | from step 1 |
   | `GOOGLE_CLIENT_SECRET` | from step 3 |
   | `STATE_SIGNING_SECRET` | any long random string you make up |

2. Go to the repo's **Actions** tab → **"One-time - Create Worker KV namespace"** →
   **Run workflow**. Open the run, expand the step, copy the `id` value from the output,
   paste it into `worker/wrangler.toml` under `[[kv_namespaces]]` (edit directly on
   github.com — pencil icon on the file — then commit).
3. Go to **Actions** → **"Deploy LINE bot Worker"** → **Run workflow**. Once it succeeds,
   open the run's log to find your Worker's URL, e.g.
   `https://expense-tracker-line-bot.<you>.workers.dev`.

After this first deploy, pushing changes under `worker/` to `main` redeploys automatically.

<details>
<summary>Prefer running it from your own computer instead?</summary>

```bash
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create ACCOUNTS   # paste the id into wrangler.toml
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put GOOGLE_CLIENT_ID          # same value as VITE_GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put STATE_SIGNING_SECRET
npx wrangler deploy
```
</details>

### 5. Point LINE's webhook at your Worker

Back in LINE Developers Console → Messaging API tab → **Webhook URL**:
`https://<your-worker>.workers.dev/webhook`, then click **Verify** (should succeed once
secrets are set) and turn **Use webhook** on.

That's it — no LIFF app or LINE Login channel needed. The link the bot sends for
account-linking goes straight to Google's OAuth screen; LINE opens it in its in-app
browser like any other link. (An earlier version of this bot tried using LIFF's
`getProfile()` to identify the LINE user before linking, but LIFF user IDs are scoped to
the *LIFF's own channel* — not the Messaging API channel that the webhook and future
messages use — so linked accounts never matched later messages. The current design signs
the id straight from the webhook event instead, which is always in the right scope.)

### 6. Set up the rich menu (optional, but recommended)

Adds a persistent 6-button image menu under the chat input in LINE — tapping a button just
sends its text as an ordinary message, so it's a shortcut into commands the bot already
understands, nothing new to build on the LINE side.

1. Go to the repo's **Actions** tab → **"One-time - Set up LINE Rich Menu"** → **Run
   workflow**. It uploads `worker/assets/rich-menu.png` and sets it as the default menu for
   everyone (needs `LINE_CHANNEL_ACCESS_TOKEN`, already a repo secret from step 4).
2. Open a chat with the bot in LINE — the menu shows up under the input within a minute or
   so (may need to close and reopen the chat once).
3. Re-run the same workflow any time you change `worker/assets/rich-menu.png` — it deletes
   the previous menu of the same name first, so it's safe to run repeatedly.

The six buttons: วิธีใช้ (help), สรุปเดือนนี้ (money summary), รายการล่าสุด (recent
transactions), ทริปตอนนี้ (trip status), มีนัดอะไรวันนี้ (today's calendar), ไดอารี่เดือนนี้มี
อะไรบ้าง (this month's diary). They're all read/status commands on purpose — commands that
need more input from you (`เริ่มทริป <ชื่อ>`, `นัด <เรื่อง> ...`, `ไดอารี่ <ข้อความ>`) can't be a
single tap, so those stay as typed commands (see `วิธีใช้` for the full list).

## Try it

Add the Official Account as a friend in LINE. First message should prompt you to tap a
link to connect your Google account. After signing in, you'll see a "เชื่อมบัญชีสำเร็จ"
page — close it and go back to the chat.

Any greeting ("สวัสดี", "hi", "เริ่ม", ...) gets a short self-introduction covering the 4
things the bot can do, with a pointer to "วิธีใช้" for the full command reference — see
`WELCOME_MESSAGE` in `src/index.ts` and the grouped help text in `src/commands.ts`. From
there, just log things like "ซื้อกาแฟ 60", or ask it questions:

- สรุปวันนี้ / สรุปสัปดาห์นี้ / สรุปเดือนนี้ / สรุปเดือนที่แล้ว
- เหลือเงินเท่าไหร่ (all-time cumulative balance) / รายรับเดือนนี้เท่าไหร่ / รายจ่ายเดือนนี้เท่าไหร่
- วันไหนใช้เงินเยอะที่สุด / หมวดไหนใช้เงินเยอะที่สุด / ซื้ออะไรบ่อยที่สุด (by count) / เฉลี่ยใช้เงินต่อวันเท่าไหร่
- งบเหลือเท่าไหร่ (reads the Budgets tab, set from the web app's Settings)
- ค้นหา &lt;คำ&gt; / รายการล่าสุด
- ลบรายการล่าสุด (or ยกเลิกรายการล่าสุด) — undoes the most recent transaction, with a confirm
  step first (`src/transactionCommands.ts`). Checked ahead of the report commands above so
  it doesn't get swallowed by "รายการล่าสุด" matching as a substring.
- วิธีใช้ (lists everything above plus trip/calendar/diary commands, grouped by feature)

All of these are plain Google Sheets reads/aggregations over data already in the
spreadsheet — no external AI involved, so they stay within the free-forever design (see
PLAN.md section 14 for the tradeoff notes on adding an AI fallback for messages none of
these cover).

### Trip photo albums (PLAN.md 15.2)

Send photos or video clips to the bot and they're organized into Google Drive automatically,
grouped by trip:

- `เริ่มทริป <ชื่อ>` — e.g. "เริ่มทริป ทะเล" — starts a trip session. Every photo or video clip
  you send after this uploads automatically into that trip's Drive folder
  (`จดบัญชี - อัลบั้มทริป/ทะเล/`), filename prefixed with the date it was sent
  (`2569-01-01_xxxxx.jpg`, zero-padded so filenames still sort chronologically), no
  captioning needed.
- `ทริปตอนนี้` — checks whether a trip is still open (in case you forgot to close one).
- `จบทริป` — closes the current trip. Sending a photo with no trip open gets rejected with
  a reminder to start one first, rather than uploading somewhere generic.
- Starting a new trip while one is already open asks for confirmation first ("ยังไม่ได้ปิด
  ทริป ... จะปิดแล้วเริ่ม ... เลยไหม") instead of silently switching — reply "ใช่" to confirm,
  anything else cancels the switch and the original trip stays open.

Uses the same `drive.file` OAuth scope already granted for the spreadsheet, so no extra
Google consent step is needed for this feature. See the callout in PLAN.md 15.2 for why
there's no "type a folder name alongside the photo" option — LINE doesn't attach captions
to image messages, they always arrive as separate events.

Files upload directly into the trip's folder rather than a per-day subfolder — an earlier
version created a subfolder per day, which turned out to have a real race (Drive's
find-or-create isn't atomic) and burn extra Cloudflare subrequests per file; both got worse
specifically when several photos/clips were sent together in one LINE multi-select, which
LINE often bundles into a single webhook call. See PLAN.md 15.2's second "แก้ไขระหว่างพัฒนา"
callout for the full story. All events in one webhook call now also share a single refreshed
Google access token (`TokenCache` in `src/index.ts`) instead of each file fetching its own.

Even after that fix, a large batch could still end up with fewer confirmation replies than
files sent — total silence for the missing ones, not an error. The remaining cause:
`handleWebhook` processed events one at a time, so a later event's reply had to wait through
every earlier event's full Drive round trip first, which could push it past its LINE reply
token's short validity window; a failed reply then retried the *same* expired token in the
catch block and swallowed that failure too. Events in one webhook call are now processed
concurrently (`Promise.allSettled` in `handleWebhook`), and any reply that still fails falls
back to a push message (`pushToLine` in `src/line.ts`), which targets the LINE user directly
and isn't tied to a token, so a reply is never silently lost. Message types this bot doesn't
handle (e.g. LINE's `file` type, which some clips can arrive as) also now get an explicit "not
supported yet" reply instead of falling through with no response at all.

A longer video clip surfaced one more failure mode: it can be tens of MB, and the upload path
used to fetch the whole thing from LINE into an `ArrayBuffer`, wrap it in a `Blob` with the
Drive multipart metadata, and only then start uploading — doubling the total wait (download
fully, then upload fully) and risking the Worker's memory limit for a big enough file. A real
report matched this exactly: a 19-second clip uploaded fine, a same-batch ~1-minute clip that
had already finished sending in LINE never got a bot reply at all.

`uploadFileToFolder` in `src/drive.ts` fixes this by streaming instead of buffering, but stays a
**single request per file** — Drive's regular multipart upload (`uploadType=multipart`), the
same endpoint used from the start, just with the request body assembled as a stream
(`concatStreams`) instead of a fully-buffered `Blob`. An earlier version of this fix switched to
Drive's resumable upload protocol instead, since it streams naturally — but resumable needs two
requests per file (an init call, then the content), and doubling the Drive request count per
file turned out to matter a lot for *large batches*: a real report of 37 photos sent in one LINE
multi-select came back with 2 silently missing from Drive, no reply and no error for either —
the two-requests-per-file version could need ~75 Drive subrequests for one webhook call, enough
to silently exceed Cloudflare's per-request subrequest budget, cutting the Worker's invocation
off outright rather than failing in a way the code could catch and reply to. Streaming a
multipart body keeps both properties that turned out to matter: nothing is buffered in memory
for a single large file, and a big batch still costs exactly one Drive request per file. It also
stays atomic — metadata and content go in the same request, so a failure never leaves an
orphaned, unnamed file behind in Drive the way a two-step upload could.

Even at one Drive request per file, a *very* large batch could still lose one: a real report of
50 photos in one send came back with 1 silently missing and no error reply for it either. Each
photo/video event needs 2 outbound requests (fetch from LINE, upload to Drive), plus the reply
itself is a request — `handleWebhook` processing the entire batch fully concurrently meant a huge
batch could spike a lot of simultaneous subrequests, likely brushing up against some platform-
level ceiling; since the fallback error reply is itself a subrequest, an event unlucky enough to
land right at that ceiling could lose its upload *and* its error message together, which is
exactly what "total silence" looks like. `handleWebhook` now processes events with **bounded**
concurrency (`WEBHOOK_EVENT_CONCURRENCY = 5` in `src/index.ts`) instead of either extreme —
one-at-a-time (which caused the earlier reply-token-expiry problem) or fully concurrent (which
caused this one) — capping how many subrequests are ever in flight together while still
processing much faster than sequentially.

Bounding concurrency shrinks the problem but can't remove it: even a modest, bounded number of
concurrent uploads still eventually adds up to the same total subrequest/CPU spend for one
webhook call, and Cloudflare's Workers Free plan caps that at roughly 50 external subrequests and
10ms of CPU time *per invocation*, however that budget gets spent. A real report of 50 photos
still lost up to 4 files with the bound in place, and there's no per-file tuning that fixes a
budget that's simply too small for a big enough batch in one invocation.

The actual fix: **very large batches don't get processed in the webhook invocation at all.**
`src/uploadQueue.ts` adds a simple KV-backed queue (one KV key per queued file, so concurrent
enqueues can't race each other on a read-modify-write). At/above `IMMEDIATE_MEDIA_BATCH_LIMIT`
(20) media files in one webhook call, `handleWebhook` queues the whole batch instead of uploading
anything immediately, and replies once with a "queued, will confirm when done" message instead of
one reply per file. A `scheduled` handler (wired to a once-a-minute cron trigger in
`wrangler.toml`) calls `drainUploadQueue`, which works through up to `DRAIN_BATCH_SIZE` (20)
queued files at a time — **and each cron firing is its own Worker invocation, with its own fresh
subrequest/CPU budget**, so a batch of any size eventually gets through completely instead of
losing files to a shared budget. Each drain sends one push message per user summarizing what
just uploaded and how many files are still queued, ending with a final "all done" message once
the queue for that user is empty. Smaller, everyday sends (below the threshold) are unaffected —
they still upload and confirm immediately, exactly as before.

### Calendar (PLAN.md 15.3)

Reminders are handled entirely by Google Calendar's own notifications — the bot never
messages you proactively, it only creates/reads/edits/deletes events when you ask:

- `นัด <เรื่อง> <วันที่> <เวลา>` — e.g. "นัด ประชุมทีม 12/1/2569 13:00" or "นัด ประชุมทีม
  12 ม.ค. 13:00" (year optional, defaults to this year). Only understands explicit
  dates/times like these, not phrases like "พรุ่งนี้บ่ายสอง" — see the note in
  `src/thaiDate.ts` for why. Always asks to confirm ("ใช่") before actually creating
  anything.
- `มีนัดอะไรวันนี้` / `มีนัดอะไรพรุ่งนี้` / `มีนัดอะไรสัปดาห์นี้` — lists events in that range.
- `ลบนัด <คำค้น>` / `แก้นัด <คำค้น> เป็น <วันที่/เวลาใหม่>` — searches your upcoming events by
  title; if more than one matches, it lists them and asks you to be more specific instead
  of guessing. Both also confirm before touching anything.

Needs the extra `calendar.events` OAuth scope (see setup step 3.6 above) — accounts linked
before this feature existed will get a one-time re-link prompt the first time they try a
calendar command.

### Diary (PLAN.md 15.4)

- `ไดอารี่ <ข้อความ>` or `บันทึก <ข้อความ>` — e.g. "ไดอารี่ วันนี้อากาศดีมาก". Add `#หมวด` right
  after the command to tag a category (e.g. "ไดอารี่ #งาน ประชุมเสร็จเร็ว"); otherwise it's
  filed under "อื่นๆ". Confirms before saving, same as calendar.
- `ไดอารี่เดือนนี้มีอะไรบ้าง` — a **summary**, not a full dump: total count, a breakdown by
  category, and the list of days that have entries. Writing a lot in a month used to produce
  one giant reply that could silently get cut off by LINE's 5,000-character text limit — this
  keeps the reply small no matter how much was written.
- `ไดอารี่วันที่ <วันที่>` — e.g. "ไดอารี่วันที่ 1/1/2569" — the full text for just that one day,
  for when you want the detail the monthly summary leaves out.
- `ค้นหาไดอารี่ <คำ>` — read entries back by keyword (capped at the 10 most recent matches).
- No edit/delete commands yet for diary entries (lower stakes than a wrong calendar event
  or a lost transaction, so this was left out of v1 — see Known limitations below).

Diary entries live in a `Diary` tab that's created automatically on first use, in your
**personal** spreadsheet only — never a shared group-book spreadsheet (group books aren't
wired up in the bot yet anyway; see Known limitations).

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real or test values
npm run dev                      # wrangler dev, local KV emulation
npm run typecheck
npx tsx scripts/test-flow.mjs    # logic smoke test, see below
```

`scripts/test-flow.mjs` exercises the real linking/parsing/clarification/summary code
paths against a fake in-memory KV and a mocked `fetch` standing in for Google/LINE (this
environment has no real LINE or Google credentials to test against end-to-end) — run it
after changing `src/index.ts`, `commands.ts`, or `state.ts` to catch regressions. It
specifically checks that the signed `state` param on the generated Google auth link
decodes back to the same LINE user id the webhook event carried, which is the exact bug
class the LIFF removal above fixed.

To tweak the rich menu's design, edit `assets/generate-rich-menu.py` (needs
`pip install pillow`) and run it — it writes `assets/rich-menu.png` from scratch every
time, so it's always reproducible from source rather than being an opaque binary someone
has to redraw by hand. Then re-run the "One-time - Set up LINE Rich Menu" Action (step 6
above) to publish it.

## Known limitations (documented honestly, not blockers)

- Account linking (`setAccountLink`) always creates a **new personal spreadsheet** the
  first time a LINE userId links — it does not yet let you pick an *existing* book from
  the web app to attach to. Fine for a fresh LINE-first user; if you already use the web
  app and want the same sheet, note the spreadsheet ID from the web app's Settings and
  wire it in manually for now (or ask to extend the linking flow to support this).
- Group books (inviting others via LINE) aren't wired up yet — only personal books.
- The monthly summary is a plain text message, not a chart image (see PLAN.md 14.3 for
  the image-generation option if wanted later).
- Trip photos only upload while a trip is open (`เริ่มทริป` first) — there's no "attach a
  folder name to a single stray photo" fallback, since LINE doesn't support captions on
  image messages (see PLAN.md 15.2). No auto-timeout closes a forgotten trip either; use
  `ทริปตอนนี้` to check.
- Calendar events are single occurrences only — no recurring/repeating events yet
  (PLAN.md 15.3). Date/time parsing is rule-based and only understands explicit formats
  ("12/1/2569 13:00", "12 ม.ค. 13.00"), not natural phrases like "พรุ่งนี้บ่ายสอง".
- Diary entries have no edit/delete command yet, only create + monthly list + search
  (PLAN.md 15.4).
- Only one confirmation can be pending at a time (trip switch, calendar create/edit/delete,
  diary create all share one slot per user) — asking a second thing before answering the
  first silently drops whichever was asked first rather than queueing it.
