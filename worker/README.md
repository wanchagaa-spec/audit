# LINE Bot — Cloudflare Worker

Log expenses by chatting with a LINE Official Account. See [`../PLAN.md`](../PLAN.md)
section 14 for the architecture and rationale.

This Worker is the whole product now. It started as a second front end beside a React
PWA (`app/`), sharing that app's parsing and clarification logic and its Google Sheets
layout so a spreadsheet stayed compatible whichever one you logged from. The PWA was
removed once nobody was using it (PLAN.md 17.46); the three modules the bot depended on
moved here as `src/parser.ts`, `src/chatEngine.ts` and `src/categories.ts`, and the sheet
layout is unchanged — books the old app created are still real spreadsheets holding real
money, and the bot still reads and writes them.

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
4. You'll set the actual webhook URL after deploying the Worker (step 5 below).

### 2. Cloudflare account

Sign up at https://dash.cloudflare.com (no credit card needed for the Workers/KV free tier).
Then create an API Token: **My Profile → API Tokens → Create Token → use the "Edit
Cloudflare Workers" template → Create Token**. Copy it once (shown only that one time).

### 3. A Google OAuth client — with a Client Secret

The bot needs a **refresh token** so it can write to Sheets with nobody watching, which
requires the *authorization code* flow, and that needs a Client Secret that must never
reach a browser.

(The Client ID is still carried in a repository secret named `VITE_GOOGLE_CLIENT_ID` —
a leftover name from the removed PWA, which used it for the browser-side implicit flow.
It is deliberately not renamed: the deploy workflow reads that exact name, and renaming
it would break deploys until the secret is re-added by hand.)

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
   API**, **Google Calendar API**, **Google Tasks API**, **Gmail API**, and **People API** are
   all "Enabled" for this project (search each by name, click it, click Enable if it isn't
   already) — a disabled API fails with a clear `has not been used in this project` error from
   Google, so this is worth checking first if something that used to work suddenly errors
   after adding a new feature.
6. **If you already linked accounts before the calendar/tasks/Gmail/contacts feature
   existed**: those refresh tokens only cover whatever scopes existed at the time (e.g.
   `drive.file` alone, or `drive.file` + `calendar.events` + `tasks` + `gmail.readonly` +
   `gmail.send` but not `contacts.readonly`). The bot detects this itself and replies with a
   fresh link when someone tries a command that needs a scope they don't have yet — no action
   needed here, just know it'll ask once per
   already-linked person, per new scope.

### 4. Get a free Gemini API key (powers "ถาม <คำถาม>" / "วิเคราะห์")

This is the only piece of the bot that isn't Google Sheets/Drive/Calendar or LINE itself —
see PLAN.md 15.10 for why this one feature deliberately breaks from the rest of the project's
"no AI" design.

1. Go to [Google AI Studio](https://aistudio.google.com/apikey) and sign in with any Google
   account (doesn't need to be the same one as the OAuth client above).
2. Click **Create API key**, choose or create a Google Cloud project, and copy the key
   (starts with `AIza...`).
3. **Know what you're sending before you set this up**: on the free tier, prompts/responses
   sent to Gemini may be used by Google to improve their products (unlike the paid tier,
   which doesn't do this) — and this feature's prompts include this month's spending and
   diary entries (see `worker/src/aiCommands.ts`). If that's not acceptable for your data,
   skip this step; every other feature in the bot works fine without `GEMINI_API_KEY` set,
   "ถาม"/"วิเคราะห์" will just reply with the same fallback message a Gemini outage would
   produce.
4. The free tier has daily request quotas (varies by model — see `worker/src/gemini.ts` for
   which model this uses and why). A single-user chat bot's Q&A feature is nowhere near
   enough traffic to hit them under normal use.

### 4.5. Get a Google Maps API key (powers "หา...ใกล้ฉัน")

Unlike every other Google integration in this bot, place search doesn't need OAuth at all —
it's just a flat API key, the same shape as `GEMINI_API_KEY` above (PLAN.md 17.30/17.31).

1. In the same Google Cloud project as before (or a new one — doesn't need to match), go to
   **APIs & Services → Library**, search for **Places API (New)**, and click **Enable**. Note
   the "(New)" — this bot uses the newer Places API (Text Search), not the older "Places API"
   (they're two separate entries in the Library and bill/behave differently; see PLAN.md
   17.31 for why the newer one was chosen: free-text keyword search only exists there,
   the older API's Nearby Search only takes a fixed list of place-type categories).
2. Go to **APIs & Services → Credentials → Create Credentials → API key**. Copy the key.
3. Strongly recommended: click into the new key and under **API restrictions**, restrict it to
   just **Places API (New)** — an unrestricted key that leaks can be used against your Cloud
   billing for anything, not just this bot's place search.
4. This is optional, same as `GEMINI_API_KEY` — skip it and every other feature works fine;
   "หา...ใกล้ฉัน" will just reply that the feature isn't set up yet instead of crashing.

### 4.6. Get a free Travelpayouts token (powers the prices in travel search)

Optional, same flat-key shape as the two keys above — travel search ("หาตั๋วเครื่องบิน...",
"หาที่พัก...") always sends prefilled booking links (Google Flights/Skyscanner/Agoda/Booking/
12Go) even without this; the token only adds the real prices shown in chat (PLAN.md 17.37).

1. Sign up free at https://www.travelpayouts.com (it's Aviasales/Hotellook's partner
   platform — signup is free, no card). In the dashboard, find your **API token** (under
   the developers/API section).
2. That single token covers both the flight-prices API (Aviasales) and the hotel-prices
   API (Hotellook) this bot uses.
3. Honest caveat, said in every reply too: these are **cached** prices from recent
   searches, not a live availability check — great for comparing (and the cache does
   include Thai low-cost carriers like AirAsia/Nok Air), but the linked sites are the
   source of truth at booking time.

> **Why not Amadeus?** This feature was originally built against Amadeus Self-Service —
> then turned out to be unusable before it ever went live: Amadeus decommissioned that
> entire portal on 2026-07-17 (new registrations closed earlier; existing keys disabled),
> discovered when signing up found no Register button at all. Travelpayouts is the
> surviving free option.

### 5. Deploy — no terminal needed, everything runs on GitHub

Two workflows under `.github/workflows/` handle this entirely in GitHub Actions:

1. Add these as **repository secrets** (Settings → Secrets and variables → Actions →
   New repository secret) — `VITE_GOOGLE_CLIENT_ID` keeps its name for the reason in
   step 3:

   | Secret name | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | the token from step 2 |
   | `LINE_CHANNEL_SECRET` | from step 1 |
   | `LINE_CHANNEL_ACCESS_TOKEN` | from step 1 |
   | `GOOGLE_CLIENT_SECRET` | from step 3 |
   | `STATE_SIGNING_SECRET` | any long random string you make up |
   | `GEMINI_API_KEY` | from step 4 (optional — omit and "ถาม"/"วิเคราะห์" just always reply with the fallback message) |
   | `GOOGLE_MAPS_API_KEY` | from step 4.5 (optional — omit and "หา...ใกล้ฉัน" just replies that the feature isn't set up) |
   | `TRAVELPAYOUTS_TOKEN` | from step 4.6 (optional — omit and travel search sends booking links without in-chat prices) |
   | `TMDB_READ_TOKEN` | the **API Read Access Token** (the long bearer token, not the short v3 API Key) from https://www.themoviedb.org/settings/api, free for non-commercial use (optional — omit and the movie commands reply that the feature isn't set up) |

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
npx wrangler secret put GEMINI_API_KEY            # optional — see step 4
npx wrangler deploy
```
</details>

### 6. Point LINE's webhook at your Worker

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

### 7. Set up the rich menu (optional, but recommended)

Adds a persistent image menu under the chat input in LINE — tapping a button just
sends its text as an ordinary message, so it's a shortcut into commands the bot already
understands, nothing new to build on the LINE side.

1. Go to the repo's **Actions** tab → **"One-time - Set up LINE Rich Menu"** → **Run
   workflow**. It uploads `worker/assets/rich-menu.png` and sets it as the default menu for
   everyone (needs `LINE_CHANNEL_ACCESS_TOKEN`, already a repo secret from step 5).
2. Open a chat with the bot in LINE — the menu shows up under the input within a minute or
   so (may need to close and reopen the chat once).
3. Re-run the same workflow any time you change `worker/assets/rich-menu.png` — it deletes
   the previous menu of the same name first, so it's safe to run repeatedly.

The workflow checks out `main` explicitly, whatever branch you dispatch it from. It
publishes straight to the live LINE account with no staging step, so a run from an old
branch would replace the real menu with that branch's version **and still finish green** —
which is exactly what happened once, with nothing to show for it but a branch name on the
run. The script also prints the tile list before publishing, so the log says what it did
rather than only that it worked.

Three tiles in a single row (LINE's "compact" rich menu size): วิธีใช้ (help), เปิดเว็บดูข้อมูล
(web viewer link, PLAN.md 16), and ตั้งค่า (settings page, PLAN.md 17.48). It has been as large
as a full-size 4x2 grid; รายการล่าสุด and สรุปเดือนนี้ held the last two slots until 17.50 and gave
them up to settings — both are still typed commands and both are on the page the web-viewer tile
opens, so neither got harder to reach, while the settings page had no way in but a URL you would
have to know about first.

Every tile is a command that needs no further input, because a rich menu tap just sends its text
as an ordinary message. Anything that takes an argument (`เริ่มทริป <ชื่อ>`, `นัด <เรื่อง> ...`,
`ไดอารี่ <ข้อความ>`, `ถาม <คำถาม>`) can't be a single tap and stays typed. `ตั้งค่า` works as a
typed command too, for the same reason the tile needs it to.

### 8. (optional) Allow the bot to join group chats

Only needed for group mode (PLAN.md 17, see below) — skip this if you only want 1:1 use.
In LINE Developers Console → your Messaging API channel → **Messaging API** tab, turn on
**"Allow bot to join group chats"**. Without this the OA can't be added to a group at all,
regardless of anything on the Worker side.

## Try it

Add the Official Account as a friend in LINE. First message should prompt you to tap a
link to connect your Google account. After signing in, you'll see a "เชื่อมบัญชีสำเร็จ"
page — close it and go back to the chat.

Any greeting ("สวัสดี", "hi", "เริ่ม", ...) a brand-new account has never sent before gets a
short self-introduction — just the bare list of things the bot can do, one line each, no
usage syntax — with a pointer to "วิธีใช้" for the full, detailed command reference (PLAN.md
17.35: these two texts are deliberately kept at opposite ends of that
brief-capability-list vs. exhaustive-usage-guide spectrum). See `WELCOME_MESSAGE` in
`src/index.ts` and `buildHelpText()` in `src/commands.ts`. From there, just log things like
"ซื้อกาแฟ 60", or ask it questions:

- สรุปวันนี้ / สรุปสัปดาห์นี้ / สรุปเดือนนี้ / สรุปเดือนที่แล้ว
- เหลือเงินเท่าไหร่ (all-time cumulative balance) / รายรับเดือนนี้เท่าไหร่ / รายจ่ายเดือนนี้เท่าไหร่
- วันไหนใช้เงินเยอะที่สุด / หมวดไหนใช้เงินเยอะที่สุด / ซื้ออะไรบ่อยที่สุด (by count) / เฉลี่ยใช้เงินต่อวันเท่าไหร่
- งบเหลือเท่าไหร่ / ตั้งงบ &lt;หมวด&gt; &lt;จำนวน&gt; / ลบงบ &lt;หมวด&gt; — also settable at `/view/budgets`
- รายการล่าสุด — the five most recent, always. The AI interpreter has a `report` intent whose only job is handing the message back to this matcher, so a report keeps its deterministic wording and row count however it was phrased (`/view` shows the full month instead — different question, no 5,000-character ceiling).
- ทำอะไรได้บ้าง — a nine-line summary of what the bot does. Distinct from วิธีใช้, which links to the full guide at `/view/help`.
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
the queue for that user is empty.

Media files below the threshold still upload immediately, but — separately from the queueing
work — also changed to send **one combined reply per webhook call** (`handleImmediateMediaBatch`)
instead of one reply per file. This was originally just a requested UX improvement (a stream of
identical confirmation messages for every photo in a send is noisy), but it turned out to matter
for correctness too: a reply is itself an outbound subrequest, so the immediate path's real
per-file cost is fetch-from-LINE + upload-to-Drive + **reply** = 3, not 2. `IMMEDIATE_MEDIA_BATCH_LIMIT`
(15) was originally calibrated only against the 2-subrequest figure, meaning even a batch that
correctly stayed *under* the queueing threshold could still quietly exceed the ~50-subrequest
budget once the per-file reply was counted properly — a real report of a batch that looked "fine"
by the queueing math still lost files. Collapsing replies to one per batch brings the immediate
path back down to 2 subrequests per file (plus one reply for the whole batch), which is what
actually makes `IMMEDIATE_MEDIA_BATCH_LIMIT`'s arithmetic hold.

One nuance worth knowing: LINE doesn't always bundle a big multi-select send into a single webhook
call — if some files (especially longer clips) take noticeably longer to finish uploading from the
sender's phone, LINE can deliver the send as several smaller webhook calls spread over a few
seconds instead of one large one. Each call is evaluated against `IMMEDIATE_MEDIA_BATCH_LIMIT`
independently, which is safe (each is its own invocation with its own budget) but means the
confirmation messages for one "single" send can arrive as a few separate batches rather than
exactly one.

Cloudflare's own request metrics (Workers dashboard → Metrics → Subrequests, broken down by host)
showed a real, if small, background failure rate for the Drive upload request even after all of
the above — a handful of 4xx responses out of dozens of otherwise-successful requests over a day
of testing, ordinary transient flakiness rather than a design flaw. `uploadTripMedia` (the shared
upload function used by all three upload call sites) now retries once (`MAX_UPLOAD_ATTEMPTS = 2`)
before giving up, re-fetching from LINE fresh on the retry rather than reusing the first attempt's
stream (a `ReadableStream` can only be read once). `IMMEDIATE_MEDIA_BATCH_LIMIT` and
`DRAIN_BATCH_SIZE` both come down to 10, sized for the *worst case* rather than the happy path: a
retried file costs 4 subrequests instead of 2, and if failures are correlated (e.g. Drive has a
brief outage or rate-limits a burst of requests — exactly the scenario the retry exists to ride
out) most or all files in one batch could need a retry at once. Even fully pessimistically — every
single file retrying — 10 files stays clear of the ~50-subrequest ceiling; sizing this against just
"a handful of retries" would have reintroduced the same silent-file-drop failure at a different
threshold. A file that still fails after its retry is reported in the batch's summary message
(`(อีก N ไฟล์อัปโหลดไม่สำเร็จ ลองส่งใหม่อีกครั้งได้นะ)`) so there's always a clear next step instead
of a silently incomplete album.

One more accepted tradeoff worth knowing: the retry doesn't check whether a "failed" attempt
actually created the file in Drive before the error surfaced (e.g. the create succeeded but
reading the response body afterward threw) — in that rare case, retrying uploads a second copy
rather than detecting the first attempt actually succeeded. A duplicate file is a strictly better
outcome than the one this retry replaces (the photo never arriving at all), and checking for an
existing file first would cost another Drive subrequest per file that isn't worth spending to
guard against an edge case this narrow.

One more real bug turned up while chasing a report where one photo batch got *zero* message —
not even the generic "something went wrong" apology — while an unrelated batch in a different
webhook call succeeded normally. `replyOrPush` throws if **both** the reply and its push fallback
fail, and that exception wasn't guarded at every call site: the final combined reply in
`handleImmediateMediaBatch`/`handleQueuedMediaBatch`, and the two prompts in
`resolveMediaBatchContext` ("not linked" / "no active trip"), could all throw uncaught. Left
unguarded, that exception escaped through an unawaited-for-errors `Promise.all` in `handleWebhook`
and crashed the *entire* invocation — silencing not just the one failed batch but every other
event in the same webhook call too (other senders' batches, unrelated text messages). Every
`replyOrPush` call in the media-handling path now has a `.catch(() => undefined)` safety net (or,
for the two batch-handler functions, a top-level try/catch that makes one best-effort recovery
attempt first), and `handleWebhook`'s dispatch to per-sender batch handlers uses
`Promise.allSettled` instead of `Promise.all` as defense in depth. None of this can *guarantee* a
message gets through if LINE's API is genuinely unreachable for both calls — but it guarantees
that failure stays contained to the one batch it happened to, instead of taking the rest of the
webhook call down with it.

The actual root cause behind this whole saga turned up in Cloudflare's own request logs (Workers
dashboard → Observability → search `error`, click a row to expand the full event): a real
invocation was recorded with `"outcome": "canceled"`, `"wallTimeMs": 1993`, `"cpuTimeMs": 7` — cut
short only ~2 seconds in, nowhere near any CPU-time or subrequest ceiling this codebase had spent
several rounds tuning against. `canceled` means the request's own client — LINE, in this case —
disconnected before the Worker finished, and Cloudflare aborted the still-running code as a
result. LINE, like most webhook senders, expects a fast acknowledgment; making it wait for the
*entire* upload-and-reply pipeline to finish before responding meant a slow-enough batch could get
its connection dropped out from under it, killing the Worker mid-execution with no chance for any
of the error handling above to run at all. Every earlier fix in this section made the processing
itself more reliable — none of them made the response come back to LINE fast enough to avoid the
disconnect in the first place, which is why the symptom kept recurring even as its other causes
got fixed one by one.

The real fix: `handleWebhook` (still fully synchronous, used directly by tests) stays as-is, but
the production `fetch` handler no longer calls it. Instead it verifies the signature, then hands
the actual event processing (`processWebhookEvents`) to `ctx.waitUntil()` and returns `"ok"`
immediately — Cloudflare keeps that promise running in the background after the response has
already gone out, so LINE gets its fast acknowledgment regardless of how long the real work takes,
and never has a reason to disconnect mid-request again.

With the `outcome: "canceled"` root cause fixed, files started arriving completely — but a new,
purely cosmetic problem showed up: a single "one send" of many photos could still produce a *flood*
of separate "เก็บ 1 ไฟล์เข้าทริป..." confirmation messages instead of one summary. The cause was the
same LINE behavior noted above (splitting one multi-select send into several separate webhook
calls when individual files finish uploading from the sender's device at different times) combined
with the immediate-upload path: each of those separate webhook calls independently qualified as
"below `IMMEDIATE_MEDIA_BATCH_LIMIT`" and so each sent its own combined reply — correct per webhook
call, but "one combined reply per webhook call" isn't the same thing as "one combined reply per
send" when LINE itself splits the send. No batch-size threshold tuned from this server's side can
fix that, because the fragmentation happens before the request ever reaches the Worker.

The fix removes the immediate-upload path entirely: `IMMEDIATE_MEDIA_BATCH_LIMIT` and
`handleImmediateMediaBatch` are gone, and **every** media file — regardless of batch size — now
goes through the same upload queue and scheduled drain used for large batches. This works because
the drain doesn't care how many separate webhook calls contributed to what's sitting in the queue;
it naturally coalesces whatever has accumulated since it last ran into one summary message,
sidestepping the fragmentation problem instead of trying to out-guess it. The accepted tradeoff:
even a single photo now takes up to about a minute (the cron interval) to get its "received"
confirmation, instead of being instant — a deliberate choice of consistent, guaranteed-single
messages over speed.

That "received, uploading in background" reply turned out to be one flood source too many, even
after the fix above: `handleQueuedMediaBatch` still sent it once per *webhook call*, and since LINE
can still split one send into several webhook calls, a user could see several "รับไว้ N ไฟล์แล้ว..."
messages back to back — each individually correct, together still noisy. The user asked for it to
go away entirely: no "received" acknowledgment at all, just silence until the files are actually
uploaded. `handleQueuedMediaBatch` no longer sends any reply on the success path — it enqueues and
returns, leaving every reply token in the batch to expire unused (free, since an unused LINE reply
token costs nothing). The only message the user now gets for a media send is `drainUploadQueue`'s
own push summary once the cron drain actually finishes uploading, which was already the single
place progress/completion gets reported and already coalesces correctly regardless of how many
webhook calls contributed to what's queued. Net effect: exactly one message per accumulation,
sent only once the work is done, with the same up-to-a-minute delay as before.

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

### Tasks (PLAN.md 17.26)

A plain to-do list backed by Google Tasks — the fourth Google service this bot connects to
(after Drive, Sheets, and Calendar). Every item lives in your account's default Google Tasks
list (`@default`, always present, no separate list picker):

- `เพิ่มสิ่งที่ต้องทำ <ข้อความ>` — e.g. "เพิ่มสิ่งที่ต้องทำ ซื้อของเข้าบ้าน". Confirms before
  actually adding it, same as calendar/diary. A trailing date and/or time is optional
  (PLAN.md 17.27) — e.g. "เพิ่มสิ่งที่ต้องทำ จ่ายค่าไฟ 20/1/2569 14:00" or just "... 20/1/2569"
  with no time; leave both out and it's still a perfectly valid task, unlike a calendar
  appointment which always needs both.
- `สิ่งที่ต้องทำ` (or `รายการที่ต้องทำ` / `มีอะไรต้องทำบ้าง`) — lists everything not yet marked
  done, showing each item's due date/time when it has one.
- `ทำเสร็จแล้ว <คำค้น>` / `ลบสิ่งที่ต้องทำ <คำค้น>` — searches your incomplete tasks by title
  (Google Tasks has no server-side keyword search like Calendar's events do, so this fetches
  the list and matches client-side); if more than one matches, it lists them and asks you to
  be more specific. Both confirm before touching anything.

Needs the extra `tasks` OAuth scope (see setup step 3.5/3.6 above) — accounts linked before
this feature existed will get a one-time re-link prompt the first time they try a task
command.

**Real bug, fixed (PLAN.md 17.29)**: due dates/times used to display wrong — off by a fixed
7 hours, and for early-morning times, off by a whole day too. Google's API returns `due` as a
genuine UTC timestamp, same as every other Google integration in this bot, but the code that
read it back was slicing the raw string as if it were already Bangkok-local text. Fixed by
converting through the same `bangkokDateKey`/`bangkokHourMinute` helpers every other feature
already uses for the reverse direction.

**Known uncertainty that's separate from the bug above and still unverified**: Google Tasks'
`due` field has a long-standing quirk where the official Tasks apps historically only respected
the *date* part of it, ignoring whatever time-of-day was sent. This bot sends the time anyway
(best effort — newer Tasks clients with time-based reminders may honor it), but there's no way
to verify from this sandboxed dev environment whether Google's own apps actually surface it.
Worth checking for yourself in the real Google Tasks app after a task with a time is created.

### Gmail (PLAN.md 17.28)

Check unread mail and send new messages — the fifth Google service this bot connects to
(after Drive, Sheets, Calendar, Tasks). Deliberately the narrowest of the five: read (inbox
summaries only, no full message body ever fetched) + send only, chosen explicitly over a
broader "full inbox management" option (no reply/forward/archive/delete/mark-as-read/label
changes) because email is far more sensitive than a to-do list or calendar event — a wrong
appointment is easy to undo, a sent email is not.

- `เช็คอีเมล` (or `เช็คเมล` / `อีเมลใหม่` / `มีอีเมลใหม่ไหม` / `มีเมลใหม่ไหม`) — lists up to 5
  unread inbox messages: sender, subject, and Gmail's own snippet.
- `ส่งอีเมล ถึง <อีเมลผู้รับ หรือ ชื่อผู้ติดต่อ> เรื่อง <หัวข้อ> ข้อความ <เนื้อหา>` — e.g. "ส่งอีเมล
  ถึง friend@example.com เรื่อง นัดพรุ่งนี้ ข้อความ เจอกันบ่ายสองนะ" or "ส่งอีเมล ถึง สมชาย เรื่อง
  ...". A recipient can be a full address or a Google Contacts name (PLAN.md 17.34) — see the
  Contacts section below for how that resolution works. Confirms before actually sending, same
  as every other write action — but with an explicit "ส่งแล้วเรียกคืนไม่ได้" ("can't be recalled
  once sent") warning in the confirmation prompt, since this is the one action in the bot where
  confirming means the data leaves the bot's own system for good. The confirm prompt always
  shows the *resolved* address, even when a name was typed, so a wrong contact match still gets
  caught before anything sends, not after.
- The AI interpreter (`ถาม`-free natural language) can also trigger a send, but it's under a
  strict extra rule: it will **never** guess, invent, or infer an email address *or a contact
  name* from a vague relationship word (e.g. "แฟน", "หัวหน้า") — if the message doesn't contain
  a literal address or a real name the user typed themselves, it always asks for one instead of
  proceeding, even if that person was mentioned earlier in the conversation history (unlike
  calendar/transaction intents, which are allowed to reconstruct missing details from recent
  turns).

Needs the extra `gmail.readonly` + `gmail.send` OAuth scopes (see setup step 3.5/3.6 above) —
accounts linked before this feature existed will get a one-time re-link prompt the first time
they try an email command.

**Real bug, fixed (PLAN.md 17.29)**: `matchCalendarCommand`'s "นัด" trigger matches that word
anywhere in a message (not just at the start), and calendar's handler used to be checked before
Tasks' and Gmail's in the dispatch chain — so a task or email whose free text happened to
contain the word "นัด" (a common Thai word for "appointment") could get misrouted into an
attempted calendar create instead of reaching the task/email handler. Fixed by checking Task's
and Gmail's own fixed, unambiguous command prefixes first — they never overlap with anything
Calendar's own matcher recognizes, so this can't affect a genuine calendar command.

### Contacts (PLAN.md 17.34)

Look up a Google Contacts entry's email address by name — the seventh Google service this bot
connects to, and the second (after Places) to be read-only. Built specifically to pair with
Gmail: so "ส่งอีเมล ถึง <ชื่อ>" doesn't require typing someone's full address every time.

- `อีเมลของ<ชื่อผู้ติดต่อ>` — e.g. "อีเมลของสมชาย". Looks the name up against your Google
  Contacts and replies with the matching email address, if there's exactly one match. No
  server-side keyword search on the People API side reliable enough to depend on (its
  dedicated `searchContacts` endpoint has a known indexing lag for freshly added/edited
  contacts), so this fetches your contacts once and matches by name client-side — the same
  pattern already used for Task/Gmail keyword lookups.
- If more than one contact's name contains the search term, it lists them and asks you to be
  more specific instead of guessing which one you meant. If a matching contact has no email on
  file, it says so instead of erroring.
- `ขอรายชื่ออีเมล` / `มีอีเมลใครบ้าง` — lists every contact that has an email on file (PLAN.md
  17.56). Contacts *without* one are left out on purpose: the question is which addresses you
  have, and a bare name isn't an answer to it. Capped at 30 entries with a count of the rest,
  so a large address book can't blow past LINE's message limit. Matched on the whole phrase
  rather than as a substring, so it can't swallow `อีเมลของ<ชื่อ>`.
- Feeds directly into `ส่งอีเมล ถึง <ชื่อ>` (see the Gmail section above) — the same lookup, the
  same "found exactly one, or ask" behavior, and the confirm-before-send step always shows the
  address it actually resolved to before anything sends.

Needs the extra `contacts.readonly` OAuth scope (see setup step 3.5/3.6 above) — accounts
linked before this feature existed will get a one-time re-link prompt the first time they try
a contact lookup or a name-addressed send.

### Nearby places (PLAN.md 17.30/17.31)

Find something nearby using your real GPS location, shared through LINE's own location-sharing
UI — the sixth Google integration this bot connects to, and the only one that doesn't need
OAuth at all: place search is public data, not tied to any Google account, so it just uses a
flat `GOOGLE_MAPS_API_KEY` (see setup step 4.5 above). Backed by Places API (New)'s Text
Search, not the older/legacy Places API — see `places.ts`'s own comment for why (free-text
keyword search only exists on the newer API's Text Search; the older API's closest equivalent,
Nearby Search, only takes a fixed enum of place-type categories, not arbitrary Thai keywords).

- `หา<สิ่งที่จะหา>ใกล้ฉัน` (or `...ใกล้ตัว` / `...แถวนี้` / `...ใกล้ๆ`) — e.g. "หาร้านกาแฟใกล้ฉัน". Natural
  phrasing works too ("ร้านกาแฟใกล้ฉัน" with no "หา" at all, "แถวนี้มีร้านอาหารไหม") via the AI interpreter
  (PLAN.md 17.32) — both paths end up at the same prompt. The bot asks you to share your current
  location (tap the **+** icon next to the message box in LINE → **Location**); once you share
  it, it searches within ~1.5km and replies with up to 5 results (name, rating if available,
  address, and a Google Maps link each).
- No confirm-before-save step, unlike every write-capable feature in this bot — a place search
  never creates, changes, or sends anything, it only reads back public place data.
- The location-share message itself carries no text or @mention (LINE's location-sharing UI
  has no way to attach either), so in group mode "was this meant for the bot" is answered by
  whether a search is actually pending for that group (set by an earlier *mentioned*
  "หา...ใกล้ฉัน" text command), not by re-mentioning the bot on the location share itself — the
  same "trip active" pattern trip photos already use for the same reason. An unprompted
  location share with nothing pending gets no reply at all, in either mode.

### Travel search: flights, hotels, buses/trains (PLAN.md 17.37)

Search and compare, then book on the linked sites yourself — the bot never books, holds, or
pays for anything on the user's behalf, so (like Nearby places) this is read-only and never
confirms-before-anything. The links are the product; the in-chat prices are best-effort
decoration on top, and every failure mode of the price lookup (no Amadeus key configured,
quota exhausted, API down, route not covered) degrades to the same links plus a one-line
honest note — a search never comes back empty-handed just because the price API did.

- `หาตั๋วเครื่องบิน <ต้นทาง> ไป <ปลายทาง> <วันที่>` — e.g. "หาตั๋วเครื่องบิน กรุงเทพ ไป เชียงใหม่
  20/12/2569" — or any natural phrasing via the AI interpreter ("หาตั๋วไปเชียงใหม่พรุ่งนี้", no
  origin = assumes Bangkok, stated in the reply so a wrong assumption is visible). Shows real
  one-way cached prices (airline — Thai low-cost carriers included, departure time,
  direct/stops, baht) from Travelpayouts/Aviasales when configured, plus Google Flights and
  Skyscanner links prefilled with the route and date. Every reply carries a standing caveat
  that these are cached prices from recent searches, not a live quote — the linked sites are
  the source of truth at booking time.
- `หาที่พัก <เมือง> <เช็คอิน> ถึง <เช็คเอาท์>` — e.g. "หาที่พัก เชียงใหม่ 20/12/2569 ถึง
  22/12/2569" (omit the checkout for a 1-night stay). Shows the cheapest cached offers first
  (Hotellook resolves free-text Thai/English city names itself, so any city works — no city
  table needed for hotels), plus Agoda and Booking.com links prefilled with city and dates.
  Note: "หาที่พักใกล้ฉัน" is deliberately still a GPS nearby-search (the section above), not a
  travel search — the dispatch order guarantees it.
- `หาตั๋วรถทัวร์ <ต้นทาง> ไป <ปลายทาง> [วันที่]` (also `หาตั๋วรถไฟ`) — ground transport has no
  free price API at all, so this tier is links-only *by design and says so in the reply*: a
  12Go link prefilled with the route (and date if given), covering bus/train/van/ferry
  comparison on one page.
- The AI interpreter maps city names to IATA codes / 12Go slugs itself (standard public
  reference data, not personal-data guessing); `validateIntent` pins the shapes hard
  (`^[A-Z]{3}$`, lowercase-kebab) since they feed straight into API queries and URLs, and the
  deterministic `หาตั๋ว...` commands use a small built-in table of common Thai cities,
  pointing anything unknown at the natural-language phrasing instead.
- Backed by Travelpayouts' Data API (`travel.ts`, setup step 4.6 — including why it replaced
  Amadeus before this ever went live) — an app-level token like `GOOGLE_MAPS_API_KEY`, so
  there are no per-user re-link error classes; any Travelpayouts problem is admin-only and
  degrades to links.

### Movies and series (PLAN.md 17.57, TV added in 17.58)

Cinema listings, series listings and title search, from The Movie Database. Read-only,
nothing is saved, and — like Places and Travelpayouts — it needs no per-user OAuth at all,
just a flat `TMDB_READ_TOKEN`. Every answer comes in two halves: a five-title list in chat,
and a link to `/view/movies` carrying the same titles with posters, synopses and a per-title
"where to watch in Thailand" link. That split is forced by the medium rather than chosen —
`replyToLine` sends plain text, so a poster can only ever live on a page.

Films and series run through the same code, parameterised by `MediaType`. TMDb mirrors its
whole API across `/movie` and `/tv` — same shapes, same filters — so the only real
differences are the paths and, the part that catches people, **the field names for the same
things**: `title`/`name`, `original_title`/`original_name`, `release_date`/`first_air_date`.
`parseTitles` in `movies.ts` is the one place that difference lives. Reading the wrong set
does not error; every row is silently dropped for having no title, so the symptom is an empty
list. Two asymmetries are real and not oversights: TV has no `/tv/upcoming` (not-yet-aired
has to be discovered by `first_air_date`), and `/discover/tv` has no `include_adult`
parameter — sending one is a 400.

- `หนังใหม่` — in Thai cinemas now; `ซีรีส์ใหม่` — currently airing. `หนังกำลังจะเข้า` /
  `ซีรีส์กำลังจะมา` — not started yet. `หนังมาแรง` / `ซีรีส์มาแรง` — this week's trending.
  `หนังสตรีมมิ่ง` / `ซีรีส์สตรีมมิ่ง` — new on the subscription apps available in Thailand
  (Netflix, Prime Video, Disney+, Apple TV+, Viu). Separate TMDb endpoints, because they are
  different questions. `ซีรีย์` and `ซีรีส์` are both accepted — neither spelling is a typo.
- `หนังเรื่อง<ชื่อ>` / `ซีรีส์เรื่อง<ชื่อ>` / `ค้นหาหนัง<ชื่อ>` — search by title.
- **Bare qualifiers are not descriptions** (PLAN.md 17.58). `แนะนำหนังใหม่` leaves "ใหม่"
  after the prefix and `แนะนำหนังมันๆ` leaves "มัน"; neither describes a genre or a plot, so
  searching TMDb for them returns nonsense that looks like an answer. `DESCRIPTOR_LISTS` maps
  those onto the list the user plainly meant instead. Anything not in that map is treated as
  a genuine description.
- **Where to watch is shown; dubbing is not, and the reply says so.** `/watch/providers`
  gives the Thai subscription services carrying a title, and that is real data. Whether a
  Thai dub or Thai subtitles exist is **not in TMDb at all** — not on that endpoint, not on
  the detail endpoint, and not in `/translations`, which covers translated *metadata* (title
  and synopsis text), nothing about the soundtrack. `originalLanguage` answers a different
  question again: what language the thing was made in. So the answers show availability plus
  the original language, and state outright that dub/subtitle info has to be checked in the
  app, with a link straight to it.
- `providers === undefined` (never looked up) and `providers === []` (looked up, nothing
  there) are **different answers, and only the second may be stated**. Availability costs one
  subrequest per title, so it is fetched only for the answers whose question it is — series,
  streaming lists, and title searches — and only for the five rows shown in chat. A cinema
  listing skips it entirely, and therefore claims nothing about it.
- `หนังแนว<แนว>` / `หนังเกี่ยวกับ<เนื้อเรื่อง>` — **search by what a film is about**, which TMDb
  cannot do directly: `/search/movie` matches titles only. What it has is genres and a curated
  keyword vocabulary, both searchable, so Gemini turns the description into those and TMDb
  resolves every one against its own catalogue before use. A safe use of the model by this
  codebase's own rule (see `news.ts`): it supplies search *terms*, never facts — the films
  that come back are TMDb's answer. Genres are ANDed (a horror-comedy is both at once),
  keywords ORed (they are alternative phrasings of one idea). With Gemini unavailable, or when
  nothing resolves to a real id, it degrades to a title search rather than refusing —
  `/discover` with no filter at all would answer "the most popular films on TMDb", which looks
  like a result and answers nothing.
- Natural phrasing works too via the AI interpreter's `movie_list` / `movie_search` /
  `movie_discover` intents, each carrying `mediaType`. `movieListKind` is validated against
  the real union, since it picks an endpoint and an invented one would build a request to a
  path that does not exist; `mediaType` likewise, except that a *missing* one defaults to
  `movie` rather than rejecting the intent — films are much the more common ask, and an
  absent field is a far weaker signal of a confused model than a wrong one.
- `/view/movies` stores the *result*, not the query (same pattern as `/view/search`): the page
  then shows exactly the films the chat message listed, and opening the link costs no TMDb
  request. One-hour TTL matching the view token, and the id is scoped by subject.
- **TMDb's attribution requirement is a licence condition, not a courtesy** — the page carries
  it and a test enforces it. Don't remove it.
- Authenticated with TMDb's **API Read Access Token as a bearer header**, not the v3
  `?api_key=` query parameter. Both work against every endpoint used here and TMDb issues
  both from the same settings page; the header keeps the credential out of the URL, which is
  the part of a request that ends up in proxy logs, error messages and anything recording
  "what was requested".
- **Confirmed working against the live API** (PLAN.md 17.62). Until that, this was the largest
  unknown in the codebase: the environment it was built in blocks `api.themoviedb.org` at the
  egress proxy, so the tests drive a mock encoding the same assumptions as the code and could
  never have caught a wrong path or parameter name. Bearer auth, the base URL, the response
  shapes and the listing endpoints are now known good rather than assumed. Provider ids for
  the smaller Thai services (WeTV, iQIYI, TrueID) remain the one part taken on trust and are
  still left out — a wrong id fails silently, filtering out a catalogue with no error, so they
  should be checked against `/watch/providers/movie?watch_region=TH` before being added.

### Fixing a transaction that is not the newest (PLAN.md 17.63)

Until this, the only remedy for a mistyped amount was `ลบรายการล่าสุด`, which reaches only the
newest row. Log three more things after fat-fingering 600 for 60 and the only way to fix it was
to open Google Sheets and edit the cell by hand — money being the one thing this bot could not
correct, while diary, calendar and tasks all could.

`/view` is now write-capable, the fourth such page after shifts, budgets and settings. One month
at a time is a spreadsheet-shaped table — date, category, note, amount — with **แก้** and **ลบ**
at the end of each line, and **‹ เดือนก่อน / เดือนถัดไป ›** above it.

Rows are read-only until one is opened with **แก้** (PLAN.md 17.64; the first cut made every row
a live form, which was worse for the common case). A month of always-editable rows is a wall of
form controls to scroll past when all anyone came to do is look, and on a phone an accidental tap
becomes a silent change to a figure. Only one row is open at a time, which is what lets a single
`<form>` serve the whole table: HTML does not allow a `<form>` to wrap a group of `<td>`s, so the
open row's inputs carry `form="tx-edit"` and the form itself sits above the table.

- **Editing lives on the page rather than in chat** because the hard part of correcting an entry
  is saying *which* one, and a list you can see answers that by itself. In chat it would mean
  matching on a keyword or an amount, and picking the wrong row is a silent, wrong change to
  somebody's money.
- **Two speeds, the shape the diary page settled on**: an edit saves immediately (it is
  reversible by editing again); a delete goes through a confirm page naming the row (it is not).
- **Every rejection re-renders with the stored row untouched** — a zero, negative or
  non-numeric amount, a malformed date, an invented type, a category that does not match the
  row's type. Refusing costs one retry; writing a substituted figure puts a wrong number in
  somebody's accounts that nothing downstream can tell from a real one. The category select only
  offers matching categories, but the check is repeated server-side: a form post is not a promise.
- `rawText` and `createdAt` are carried through untouched. The first is what the user originally
  typed and stays a record of that even after the parsed figure is corrected; the second says
  when it was logged, which an edit does not change.
- **Any month, via `?month=YYYY-MM`** (PLAN.md 17.65), the same as the diary and shift pages.
  Pinned to the current month, the editing above expired at midnight on the 1st: yesterday's
  mistyped entry became unreachable exactly when you were most likely still fixing it. The data
  layer took any month all along — `readTransactionsForMonth` was written for `สรุปเดือนที่แล้ว`
  — so only the page was pinned. The month travels through `accountsUrl(token, month)`, which
  every link and form action on the page goes through: drop it from one of them (the form's
  `action`, say) and saving a row in March returns you to the current month with the edited row
  apparently vanished, which reads as a failed save. `shiftMonthKey`/`resolveMonthKey` moved into
  `viewAuth.ts` rather than being copy-pasted a third time. Changing a row's date so it leaves
  the month on screen says *where it went* instead of a bare "saved" beside a row that is no
  longer there.
- The row is found by id in the **raw** values response, never in a filtered list — a blank row
  above the target would otherwise shift every index below it and silently edit a neighbour. Same
  rule, and same reason, as `updateDiaryEntry`.
- Neither operation touches the KV month-start hint, and neither needs to: editing a date never
  moves a row physically, and the one case that could mislead a later read — editing a row *above*
  the window into this month — leaves the boundary row's month equal to the month asked for, which
  is exactly what `checkMonthWindow` rejects, forcing a rebuild.

### Recurring monthly bills (PLAN.md 17.59)

Rent, internet, phone, instalments, insurance — the fixed costs that come round every month
whether or not you think about them. **A reference list, not an automation**: the bot never
writes a transaction on its own here, and never guesses whether a bill has been paid.

- `ตั้งค่าใช้จ่ายประจำ <ชื่อ> <จำนวน>` — e.g. "ตั้งค่าใช้จ่ายประจำ ค่าเน็ต 599", optionally with a
  due date: "ตั้งค่าใช้จ่ายประจำ ค่าเช่าบ้าน 6000 ทุกวันที่ 5". Setting the same name again replaces
  the figure rather than stacking a second row the summary would count twice. Confirms first,
  like every chat write in this bot.
- `ค่าใช้จ่ายประจำ` — the whole list with a total, ticked or not for this month.
- `จ่าย<ชื่อ>แล้ว` — marks it settled for this month **and logs the expense**, in one
  confirmation that names both effects. Without the pairing, settling a bill would mean
  telling the bot twice and the two records would drift the first time someone forgot one.
- `ลบค่าใช้จ่ายประจำ <ชื่อ>` — removes it. Past payment rows are left behind; nothing joins to a
  missing id, and clearing them would mean a second pass over a second tab for no visible gain.
- `สรุปเดือนนี้` gains a closing block: the monthly total, and the names of whatever is still
  outstanding. **Only this month's summary** — "ยังไม่จ่าย" about a month that has ended reads
  as a debt still owed rather than as history. With nothing set up the block is empty, so the
  most-read message this bot sends is byte-for-byte unchanged for anyone not using this.

**Due-date reminders ride in the 7:00 briefing** (PLAN.md 17.61). 17.59 deliberately stopped
short of reminders because a reminder normally means a LINE push, and pushes are the one charged
thing this bot does — 17.54 had just made the morning briefing opt-in to reduce them. But that
briefing is already being pushed to everyone opted in, so a due-bill line costs no extra push at
all, only one more Sheets read per person per day. That is why this became worth doing later and
was not worth doing then.

Two states are raised, both actionable: due today, and past due and still unpaid. A bill with no
due date is never raised — "sometime this month" is a real answer and there is no honest morning
to raise it on; guessing one turns a daily message into noise. An overdue bill is repeated every
morning until it is marked paid, which is the feature rather than an oversight: a reminder that
gives up after a day can be missed by being busy on exactly the wrong morning. `effectiveDueDay`
clamps a due day to one that exists in the month, so a bill due on the 31st comes due on 30 April
and on the last day of February instead of never coming due at all.

Why the bot does not work out for itself which bills are paid: it would have to match amounts
against `Transactions`, and two bills of the same size in the same category are
indistinguishable that way. A wrong guess in a money feature is worse than no answer.

Two tabs, `Recurring` (the definitions) and `RecurringPaid` (one row per bill per month) —
the same shape `Budgets` already uses, so they share its upsert/delete code. Both are created
lazily and cached in KV like `Budgets` and `Diary`, which is what makes this safe for books
that already exist.

**The sharp edge worth knowing about**: `สรุปเดือนนี้` reads both tabs in the *same* batchGet as
the transactions, so the feature costs no extra Sheets request. But a batchGet naming a range
on a sheet that does not exist **fails the whole request with a 400** — it does not come back
empty. `ensureRecurringTabs` therefore has to run before that read, or every pre-existing book
would lose its month summary entirely rather than merely miss a section. The test mock
originally answered "empty" for a missing tab, which let a mutation deleting that guard survive;
it now returns a 400 like the real API, and a test drives the summary against a book that has
neither tab yet.

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

### AI Q&A / analysis (PLAN.md 15.10)

The one feature in this bot that isn't rule-based — see PLAN.md 15.10 for the full design
rationale on why this is a deliberate, documented exception rather than a quiet drift away
from the "free forever, no AI" approach everything else follows.

- `ถาม <คำถาม>` — e.g. "ถาม เดือนนี้ใช้เงินหมวดไหนเยอะสุด", "ถาม นัดพรุ่งนี้มีไหม", or "ถาม สภาพ
  อากาศวันนี้เป็นไง" (needs a province set — see `ตั้งจังหวัด` under Morning briefing below). Sends
  the question, plus this month's transactions/diary entries (with precomputed totals), upcoming
  Calendar events (today through 30 days ahead), and current weather if a province is set, to
  Google Gemini (free tier) and replies with its answer.
- `ถาม ข่าวหุ้น` (or anything matching a finance keyword — Bitcoin, gold, "การเงินสหรัฐ", etc.,
  see `FINANCE_KEYWORDS` in `aiCommands.ts`) — routes to a dedicated finance-news summary instead
  of the personal-data pipeline above, since a finance-news question has nothing to do with your
  own money/calendar/diary. Format (PLAN.md 15.13/15.14/17.16), top to bottom:
  1. A deterministic header (`marketData.ts`'s `buildMarketHeaderBlock`, never touched by
     Gemini): "ข้อมูล ณ วันที่ &lt;full Thai date&gt;", then gold/USD and BTC/USD each with a % change,
     computed from `regularMarketPrice` vs. `previousClose` on Yahoo Finance's unofficial chart
     endpoint (symbols `GC=F` and `BTC-USD`) — the same host/endpoint shape already used for
     the top movers below, switched to after goldprice.org and CoinGecko both silently came back
     empty in production even with a browser-like `User-Agent` (PLAN.md 17.15/17.16) — then up to
     2 top US gainers + 2 top losers (Yahoo Finance's screener endpoint) under a
     "* หุ้นสหรัฐฯ เคลื่อนไหวมากที่สุด" line. Building this as plain text instead of asking Gemini to
     restate the numbers removes any chance of the model paraphrasing, rounding, or mistyping a
     price.
  2. A Gemini-composed summary of CNBC's finance RSS headlines (3-5 short bullets).
  3. A curated list of today's US economic-calendar events that could move gold — real
     events/times fetched from `forexCalendar.ts` (Forex Factory's community calendar feed,
     free/no-key, filtered to USD + medium/high impact + today's Bangkok date) and handed to
     Gemini as labeled ground truth; picking *which* of those actually tends to move gold (rate
     decisions, employment data, inflation) is the one judgment call left to the model — it never
     invents an event or a time. Explicitly distinguishes "couldn't check the calendar right now"
     from "checked, there's nothing today" rather than treating both the same.
  Every fetch (gold, BTC, movers, economic calendar) degrades independently — a broken/changed
  endpoint just drops that one part instead of failing the whole summary.
- `ถาม ข่าววันนี้` (or anything matching a general news keyword — see `DOMESTIC_NEWS_KEYWORDS` in
  `aiCommands.ts`) — routes to the same Thai daily-news summary the morning briefing uses
  (`fetchNewsSummary`, Bangkok Post RSS), on demand instead of only once a day.
- `วิเคราะห์` (with or without extra text after it) — shortcut for an open-ended "analyze my
  spending and diary this month" request, without having to phrase it as a question yourself.
- **Money never gets computed by the AI.** Every number in the prompt (`aiCommands.ts`) is
  computed first by the same plain arithmetic `commands.ts` uses for its own summaries, and
  handed to Gemini pre-labeled as the only numbers it's allowed to quote — the raw
  transaction/diary rows included alongside are for pattern questions ("ซื้อกาแฟกี่ครั้งแล้ว"),
  not for the model to re-sum itself. A wrong total is structurally impossible this way, not
  just unlikely. Similarly, the prompt tells Gemini its data sources (money, diary, calendar,
  weather) are separate and must not be mixed — an earlier bug had it answering "any
  appointments?" by pattern-matching a similarly-worded Diary entry instead of using real
  Calendar data, since at the time it had no Calendar data at all (and separately, it had no
  weather data at all until this was added, so a weather question got a flat "no data" reply
  even with a province already set).
- Checked ahead of every other command matcher in `handleTextMessage`, not just the
  hardcoded report shortcuts: `matchCalendarCommand` in particular matches "นัด" anywhere in
  the text, not just at the start, so "ถาม นัด...มีไหม" used to get swallowed as a failed
  appointment-creation attempt and never reach the AI at all.
- If `GEMINI_API_KEY` isn't set, Gemini's free-tier quota is exhausted, or Calendar/weather
  access fails for whatever reason (including an older-linked account missing the
  `calendar.events` scope) — degrades gracefully (a plain apology, or answering without that
  one data source and saying so) instead of erroring or staying silent — see
  `gemini.ts`/`aiCommands.ts`.
- This is the only feature that sends your data (this month's spending/diary text, upcoming
  Calendar events, current weather) to a third party outside the Google Sheets/Drive/Calendar/
  LINE/Open-Meteo ecosystem the rest of the bot stays within — see setup step 4 above for the
  free-tier data-usage disclosure before turning it on.

### Morning briefing (PLAN.md 15.11)

The **first** greeting ("สวัสดี", "มอนิ่ง", etc. — see `GREETINGS` in `chatEngine.ts`) of each
Bangkok calendar day gets a short briefing: the date, weather (if you've set a location), and
an AI-summarized news roundup. Any later greeting the same day just gets a short "ว่าไง ให้ฉันช่วย
อะไรดี 😊" instead of repeating the whole thing. The very first greeting an account ever sends
still gets the original feature-list welcome message instead — a brand-new user has no location
set yet and no context for why they're suddenly getting a weather/news briefing.

- `ตั้งจังหวัด <ชื่อ>` — e.g. "ตั้งจังหวัด เชียงใหม่" — sets the location used for weather. Not
  required; without it, the briefing just suggests setting one instead of showing weather.
- Weather comes from [Open-Meteo](https://open-meteo.com) — both its geocoding and forecast
  endpoints are free with **no API key or account at all**, which fits this project's "free
  forever" approach even better than Gemini does (nothing to sign up for, nothing to leak).
  Purely rule-based: a weather code from the API maps to a fixed Thai description, no AI
  involved.
- News is fetched from [Bangkok Post's official RSS feed](https://www.bangkokpost.com/rss/)
  (no key needed) and summarized/translated into Thai by Gemini — a normal, low-risk use of a
  language model (summarizing text handed to it in full), unlike `aiCommands.ts`'s money/date
  guardrails, which exist specifically because those tasks *would* let the model guess at a
  fact the code already knows for certain.
- Weather and news are independent and both best-effort: either one failing doesn't take the
  other down, and neither ever blocks the greeting itself — worst case, the briefing still goes
  out with just the date.
- Needs no new secrets at all — Open-Meteo needs no key, the RSS feed needs no key, and news
  summarization reuses the `GEMINI_API_KEY` from the AI Q&A feature above. If that's not set,
  the news section is just omitted (same graceful-degradation behavior as anywhere else Gemini
  is used).

#### Daily 7:00 broadcast (PLAN.md 17.21)

The exact same briefing above also goes out **proactively** at 7:00 every morning (Asia/Bangkok),
without waiting for anyone to say hi first — the first proactive-push feature in the bot; every
other feature only ever replies to something the user typed. Personal chats only, not groups (a
group already has plenty of unrelated chatter, and an unsolicited daily push there is more likely
noise than a personal DM is).

- Reuses the existing once-a-minute cron trigger (`wrangler.toml`'s `[triggers]`, already firing
  for the trip-photo upload queue drain) instead of adding a second one — `broadcastMorningBriefings`
  is a no-op on every firing outside the 07:00 minute, and a global KV key (`last-broadcast-date`)
  guards against sending it twice on the same day if the cron ever fires more than once during
  that minute.
- News is fetched once per broadcast run and shared across everyone, instead of once per user —
  it isn't personalized (unlike weather, which is per-province), so fetching it per user would
  mean one Gemini call per linked account firing within the same minute for no benefit.
- Marks the same "already greeted today" state the reactive flow uses, so a "สวัสดี" later that
  day gets the short return-greeting instead of a duplicate full briefing.
- **Broadcast-only extras (PLAN.md 17.22)**: on top of the date/weather/news the reactive greeting
  also gets, the broadcast additionally includes today's gold/BTC price (`buildGoldBtcLines`,
  reused from the finance-news feature, minus the stock movers — not personalized, fetched once
  per run same as news), today's Calendar appointments, today's shift (from the shift-schedule
  feature above), and a short AI reflection on yesterday's diary entries (or a plain "nothing
  written" line if there's nothing to reflect on, no Gemini call needed for that case). These
  three are per-user and need a fresh Google access token, unlike everything else in the
  broadcast — a token refresh failure for one account degrades to just the base weather/news
  briefing for that person rather than failing their whole broadcast, and each of the three is
  independently best-effort on top of that (one failing never blocks the other two).

### Web viewer (PLAN.md 16)

`เปิดเว็บดูข้อมูล` in chat (or tapping the rich-menu tile) replies with a link to a web page with
six sections: accounts (`/view`), calendar (`/view/calendar`), diary (`/view/diary`), trip photos
(`/view/trips`), a personal shift schedule (`/view/shifts`), and incomplete Google Tasks
(`/view/tasks`, PLAN.md 17.36) — all sharing one token via a small nav bar.

- **No new Google sign-in, no LIFF** (LIFF was already ruled out for account linking in PLAN.md
  14.2 — same userId mismatch problem would apply here too). The link's token is signed with the
  existing `STATE_SIGNING_SECRET` (same mechanism as the OAuth `state` param, now purpose-tagged
  `k: "oauth"` vs `k: "view"` in `signedState.ts` so a leaked view-link token can't be replayed as
  an OAuth `state` to hijack the account link, or vice versa) and expires after 1 hour — request a
  fresh one any time by typing the command again.
- Every page is server-rendered HTML straight from the Worker (`viewPages.ts`, `viewCalendarPage.ts`,
  `viewDiaryPage.ts`, `viewTripsPage.ts`, sharing common plumbing in `viewAuth.ts`), not a separate
  SPA — keeps it testable by the same `test-flow.mjs` fetch-mock harness as everything else, and
  adds no new build tooling. Every value that came from user-typed chat text (transaction notes,
  diary entries) is HTML-escaped before being embedded in the page — the first place in this
  codebase where user text lands in actual HTML rather than a LINE reply or an AI prompt, so this
  one actually matters.
- Only shows the requesting LINE user's own linked account's data — the token embeds their LINE
  userId, and the Worker looks up that account's own refresh token server-side. No Google token
  ever reaches the browser.
- Trip photos (`/view/trips/:folderId`, `/view/photo/:fileId`) needed genuinely new code — nothing
  before this ever read a trip folder/file back out of Drive, only uploaded into one. New
  `listTripFolders`/`listFilesInFolder`/`fetchDriveFileContent`/`getFileName` helpers in `drive.ts`.
  Photos are proxied through the Worker rather than linked directly, since uploaded files use the
  `drive.file` scope and aren't publicly reachable — grid thumbnails are the same full-resolution
  proxied image, just CSS-scaled down (no separate lightweight-thumbnail endpoint yet).
- **Shift schedule (`/view/shifts`, PLAN.md 17.18) — the first page in this family that writes.**
  A grid of checkboxes (columns = day of the month, rows = a fixed set of 4 shift types) lets a
  user tick their own shifts and submit via a plain HTML form POST (no client JS, same as every
  other `/view/*` page) back to the same URL, token and all, so `resolveViewSession` needs no
  changes to work for POST too. Personal use only (confirmed with the user rather than assumed —
  there's no per-member attribution here the way group mode's shared spreadsheets need). Data
  lives in a `Shifts-YYYY-MM` tab per month in the user's own spreadsheet (`sheets.ts`), and every
  save overwrites the whole month's grid at once rather than diffing individual cells — simpler
  and safer for a "toggle grid" UI where the form always submits the complete checked state.
  `aiCommands.ts`'s "ถาม" pipeline reads the current month's grid alongside transactions/diary/
  calendar and feeds it into the AI prompt as labeled, guarded data, so "ถาม ใครอยู่เวรเช้าวันนี้"
  answers from what was actually ticked, never a guess.
- **Diary edit/delete (`/view/diary`, PLAN.md 17.36) — the second write-capable page.** Every
  entry in the month view is its own inline edit form (date/category/text, saved immediately on
  submit — same direct-save reasoning as the shift grid), and deleting goes through a
  confirm-page step first (GET a confirm page showing the entry's own text, then POST) since a
  delete is the one irreversible action here — the same confirm-before-destructive-action rule
  every chat delete command follows, expressed as a second page instead of a "ใช่" reply because
  these pages are plain server-rendered HTML with no client JS. Chat deliberately has no
  edit/delete diary commands at all — the web page is the one place for it (confirmed with the
  user). Backed by new `updateDiaryEntry`/`deleteDiaryEntry` helpers in `sheets.ts` that mirror
  `deleteMostRecentTransaction`'s find-row-then-batchUpdate shape; an edit preserves the entry's
  original `createdAt`. Search results stay read-only.
- **Tasks (`/view/tasks`, PLAN.md 17.36) — read-only**, same pattern as `/view/calendar`, reusing
  `listIncompleteTasks`. Groups tasks by due date (soonest first, plus a "ไม่มีกำหนด" section for
  undated ones). Deliberately read-only: chat already covers complete/delete, this page is just
  the at-a-glance overview that was asked for.

### Group mode (PLAN.md 17)

Add the bot to a LINE group (needs setup step 8 above) and it responds only when @-mentioned,
using one shared Google account for the whole group instead of everyone's own personal account.

- **No new Google sign-in flow.** Whoever's unlinked group @-mentions the bot gets a Google OAuth
  link posted straight into the group (not DM'd, unlike the personal-linking prompt — the link
  itself grants nothing and reveals nothing on its own, it just opens Google's consent screen for
  whoever clicks it, and *they* choose which of their own Google accounts to authorize). Whoever
  completes that step is simply who ends up as the group's linked account — there's no LINE API
  for "who is the group admin" to check against instead.
- Reuses the exact same account-linking/pending-state/confirmation machinery as personal mode
  (`state.ts`'s functions never actually validate that the id they're given is a real LINE
  userId — it's just an opaque KV key namespace) by synthesizing a `"group:<groupId>"` id instead
  of using a real one. A pending clarification ("จำนวนเงินเท่าไหร่คะ") is answerable by *any* group
  member, not just whoever triggered it, which falls out of this for free.
- **Silent unless @-mentioned.** LINE delivers every message sent in a group the bot belongs to
  to the webhook, mentioned or not — there's no server-side filtering, so the bot checks
  `message.mention.mentionees[].isSelf === true` itself and ignores everything else without
  touching any state.
- **Command set (PLAN.md 17.4/17.6/17.7/17.8)**: full parity with personal mode — money logging
  (natural language + "ลบรายการล่าสุด"), the read-only report shortcuts ("สรุปเดือนนี้" etc.),
  "ถาม <คำถาม>"/"วิเคราะห์" (AI Q&A), "ตั้งจังหวัด", calendar create/confirm, diary create/confirm,
  trip start/end/status ("เริ่มทริป"/"จบทริป"/"ทริปตอนนี้"), and "เปิดเว็บดูข้อมูล" (web viewer) — all
  reuse their personal-mode matchers/handlers unchanged, since they already key off whatever
  subject id `ActionCtx` (or, for the web viewer, the signed token) hands them (PLAN.md 17.3).
  Pending confirmations (calendar/diary/delete-last, same as the money clarification above) are
  answerable by any group member. The web viewer's reply text and its "not linked" error page both
  read differently in group mode — a group's reply posts into the shared chat, so the link is
  visible to whoever's in the group, not just whoever asked. Gemini's free-tier quota is one shared
  pool for the whole bot, not per-group or per-person, so a busy group asking the AI a lot eats
  into what's left for everyone else.
- **Trip photos (PLAN.md 17.7)**: LINE's @-mention only exists on text messages, never on
  photos/videos, so there's no way to gate a photo the same way text is gated. Instead: once a
  trip is active in the group (started via a mentioned text command), every photo/video any
  member sends afterward auto-uploads with **no mention needed** — mirroring how personal 1:1
  chat already never needed a per-photo trigger. When there's no active trip, or the group isn't
  linked at all, the bot stays **completely silent** on photos (unlike personal mode's explicit
  prompt) so it doesn't spam a group's ordinary, unrelated photo-sharing.
- Transactions logged in group mode are attributed to whoever actually sent them (`addedBy`/
  `addedByName`), fetched via `GET /v2/bot/group/{groupId}/member/{userId}` — unlike the general
  profile API, this works even for members who've never added the OA as a friend. Falls back to
  a generic "สมาชิกกลุ่ม" label if that lookup fails or LINE didn't include a sender id at all
  (both treated as cosmetic-detail failures, never worth blocking the save over).

### AI persona + confirm-every-save (PLAN.md 17.9)

Two things, requested together:

- **Every reply is restyled by Gemini** into a fixed character voice (a cute, pink-loving
  23-year-old studying Japanese, `persona.ts`) right before it's actually sent to LINE
  (`replyOrPush` and `drainUploadQueue`'s summary push) — never inside `handleTextMessage`/
  `handleGroupTextMessage` themselves, which still compute and return the exact same
  deterministic text as before (numbers, dates, and confirmations are never touched by AI, only
  *how* the already-decided message is phrased). Falls back to the original unstyled text on any
  failure or after a short timeout, so persona styling can never break, delay significantly, or
  silence a reply. This does mean Gemini now fires on every single reply, not just "ถาม"/
  "วิเคราะห์" — a real increase in shared free-tier quota usage and per-reply latency, accepted
  knowingly when this was requested.
- **Money logging always asks to confirm before saving now**, even for a perfectly unambiguous
  message — previously an unambiguous entry ("ซื้อกาแฟ 60") saved immediately; now it always asks
  "จะบันทึก...ใช่ไหม?" first, same as calendar/diary/delete already did. A `"transactionCreate"`
  `PendingConfirmation` (`state.ts`) holds the drafts until confirmed; in group mode, attribution
  is fixed to whoever actually completed the draft, not whoever happens to type "ใช่". The
  confirmation-word check (`isAffirmative`, `confirmations.ts`) strips common polite particles
  ("ครับ"/"ค่ะ"/"จ้า"/etc.) before matching, since a natural "ใช่ครับ" used to fail the old
  exact-match check and silently discard the pending save. `resolveConfirmation` also only clears
  the pending slot *after* a successful save — a transient failure leaves the draft in place so a
  retried "ใช่" alone recovers it, instead of forcing a full retype.
- **Events for the same subject in one webhook call are processed one at a time, not
  concurrently** (PLAN.md 17.10) — every subject shares one `pendingConfirmation` KV slot, so two
  events for the same person/group landing in the same webhook call (LINE really does bundle
  multiple messages together sometimes) used to be able to race on it, e.g. one confirming a
  draft the other had only just replaced. Different subjects still process concurrently, so an
  ordinary batch (almost always different senders) keeps the same throughput as before.

### Full AI message interpretation + conversation memory (PLAN.md 17.11)

Every fresh message is now interpreted by Gemini first (`aiInterpreter.ts`'s `interpretMessage`) —
free-form understanding of the whole sentence, plus a rolling window of recent conversation history
per subject (`conversationHistory.ts`, KV, 12 messages / 24h TTL) — instead of only recognizing
known command phrases. This is a deliberate, explicitly requested reversal of this codebase's
original guarantee that money is never decided by AI (PLAN.md 15.10); the confirm-before-save
safety net (17.9) is what stays in place to bound the risk:

- `interpretMessage` never writes to Sheets/Calendar/Drive itself — it only returns a structured,
  validated `InterpretedIntent`, which `index.ts`'s `runInterpretedIntent` routes to the **exact
  same** deterministic functions the regex matchers already used (`promptTransactionCreate`,
  `promptCalendarCreateFromDraft`, `promptDiaryCreateFromDraft`, etc.). Anything that saves data
  still always asks to confirm first — nothing about 17.9's guarantee changed, only *who decides
  what a message means* did.
- `validateIntent` never trusts the model's JSON blindly: a `categoryId` must actually exist in
  `DEFAULT_CATEGORIES` with a matching type, dates/times must be real and correctly formatted — a
  syntactically valid but semantically wrong intent (an invented category, an impossible date) is
  rejected outright, treated exactly like a failed call.
- **Graceful degradation is the default, not an edge case**: if the interpreter call fails
  (timeout, API error, malformed/invalid JSON), the message falls straight through to the original
  deterministic matcher chain (`dispatchLegacyCommands`, renamed from the old `dispatchCoreCommands`)
  and, after that, the original chatEngine parser — the exact same behavior this codebase always
  had. A pending "ใช่/ไม่ใช่" confirmation is still always resolved deterministically first, never
  handed to the AI, and a chatEngine mid-clarification (`pending`) skips the interpreter entirely
  for that one reply.
- An `"unclear"` intent asks the AI's own clarifying question directly, without ever touching
  chatEngine's `PendingClarification` state — the next message goes through the interpreter again
  with updated conversation history, rather than being forced into chatEngine's fixed
  amount/category question flow.
- Calendar/diary/trip/province command logic was refactored to expose the underlying
  apply/prompt/answer functions (e.g. `promptCalendarDeleteByKeyword`, `answerDiarySearch`,
  `promptOrStartTrip`, `setProvinceByName`) so both the regex matchers and the AI interpreter call
  the same code — no duplicated logic to keep in sync by hand.
- **When nothing recognises the message, *why* decides what happens next** (PLAN.md 17.56).
  `interpretMessage` returns a discriminated result rather than a bare `null`: `unusable` (Gemini
  answered, but with non-JSON or an intent that failed `validateIntent`) means the model is up and
  merely misread the sentence, so `answerUnrecognized` in `index.ts` puts the original message to
  it again as a plain question via `answerQuestion` — and falls back to the deterministic
  "I don't understand" text if even that fails. `unavailable` (a `GeminiError`, an aborted fetch,
  or the 17.54 breaker already open) means nothing was heard at all, so the bot says the AI is
  temporarily unavailable instead of blaming a message nobody read, and makes no second call that
  would only fail the same way.
- **Cost tradeoff, accepted knowingly**: a message can now trigger up to two sequential Gemini
  calls (interpret, then persona-style the reply) — real additional quota usage and latency on top
  of 17.9's already-accepted persona cost. `INTERPRETER_TIMEOUT_MS` (3s) keeps a slow/hanging call
  from blocking a reply for long, same reasoning as persona's own timeout.

### Bot name + name-based addressing in group mode (PLAN.md 17.12)

The bot's name, `BOT_NAME = "ไพโรจน์"` (`persona.ts`), is included in the persona voice, the AI
interpreter's own system instruction (so a "chitchat" reply it composes is self-aware), and the
welcome message. In group mode, a message no longer needs a formal LINE @mention to reach the bot
— `stripBotNameMention` (`index.ts`) checks for the name in plain text anywhere in the message
(checked only when there's no formal `@mention`) and strips it before the message is handled the
same way a stripped `@mention` is. This is a plain substring search, not a word-boundary regex —
Thai script has no reliable notion of a word boundary to anchor on. Accepted tradeoff: a group
message that happens to mention a real person also named "ไพโรจน์" (not the bot) will trigger a
reply too — this was requested directly (call the bot by name, no @ needed), so some false-positive
risk is inherent to the feature itself.

### Fixes from a real usage report (PLAN.md 17.13)

Three issues found from an actual group chat screenshot:

- **Missing `"view_link"` intent**: the interpreter's schema had no intent for the web-viewer
  feature at all, so a natural phrasing like "เปิดเว็บไซต์ให้หน่อย" (not the exact
  `"เปิดเว็บดูข้อมูล"` trigger the regex matcher needs) fell through to chitchat/unclear, and the bot
  wrongly claimed it couldn't open a website. Added `view_link`, routed to the same
  `buildViewLinkReply` the regex matcher already used.
- **Lost context after a near-miss confirmation reply**: the bot proposed a calendar event ("จะสร้าง
  นัด: ... ใช่ไหม?"); the user replied restating a detail ("ฉันนัดตอน 17.00 นะ") instead of the exact
  "ใช่" the confirm step needs — that's still treated as a decline (unchanged; loosening the exact-word
  check would reopen the accidental-confirmation risk 17.9 was built to close), but the interpreter
  then re-asked for the event's name and date from scratch, ignoring that both were in the immediately
  preceding turn's history. Added a rule: when the most recent bot turn was a confirmation prompt and
  the new message looks like it's answering/adjusting the same thing, reconstruct the same intent from
  history + the new message instead of asking again — safe either way, since the result still only
  ever produces a fresh confirm-before-save prompt, never a direct save.
- **Garbled, gender-drifted replies**: an AI-composed chitchat/unclear reply, restyled a second time
  by `applyPersona`, occasionally drifted into male pronouns (ผม/ครับ) with broken grammar — two
  sequential creative-writing passes over the same free-form text compounding drift risk. Added an
  explicit "always female pronouns, must be grammatical Thai, prefer minimal changes over risking a
  garbled rewrite" rule to both `persona.ts` and the interpreter's own instruction for composing those
  replies, so the first pass already lands in the right voice.

### Fix: a stale "จำนวนเงินเท่าไหร่คะ" clarification could trap every later message (PLAN.md 17.19)

A real report: after one ambiguous money message left a "จำนวนเงินเท่าไหร่คะ" clarification pending,
every unrelated message sent afterward (a shift-schedule question, a plain greeting-adjacent phrase,
anything without a number in it) just got the same clarification re-asked forever instead of ever being
answered — since a pending clarification skips the AI interpreter entirely (by design, so an in-progress
money answer doesn't get reinterpreted mid-flow), and chatEngine's own "doesn't look like an amount,
treat as a brand new message" fallback still runs through `parseMessage`, which — written back when this
was a money-only parser — treats *any* text with no digits as yet another incomplete expense needing an
amount. That combination meant there was no way out of a stale clarification except typing a number or
an exact-match greeting, or waiting out the 10-minute TTL. Fixed with `dropStaleAmountClarification` in
`index.ts` (used by both personal and group mode): before deciding whether to skip the AI interpreter, a
pending `"amount"` clarification whose reply contains no number and isn't a greeting is treated as stale
and cleared, so the message re-enters the normal pipeline (AI interpreter first) like any fresh message.
A reply that actually contains a number still resolves the clarification exactly as before.

### Fix: shift questions ("มีเวรมั้ย") were misread as Calendar questions ("นัด") (PLAN.md 17.20)

A real report: "พรุ่งนี้เค้ามีเวรมั้ย"/"พรุ่งนี้ได้ขึ้นเวรมั้ย" got classified by the AI interpreter as
`calendar_query` and answered from Google Calendar ("ไม่มีนัดพรุ่งนี้เลยนะคะ") instead of the actual shift
schedule (PLAN.md 17.18). The interpreter's schema had a `calendar_query` intent and a `question` intent
(which already includes shift data) but never told the model "เวร" (personal shift duty) and "นัด" (a real
Calendar event) are different data sources at all — neither the bot's own capability list nor either
intent's description mentioned shifts, since the feature was added after this prompt was last written, so
the model collapsed the unfamiliar concept into the closest one it already knew. Same shape of bug as
17.13's missing `view_link` intent. Fixed by adding shifts to the interpreter's capability list, clarifying
`calendar_query`'s description as Google-Calendar-only, and adding an explicit rule: shift questions always
use `"question"`, never any `calendar_*` intent.

### Fix: "พรุ่งนี้มีเวร แต่บอกว่าไม่มี" (PLAN.md 17.60)

A second real report about shifts, three phases after 17.20 fixed the routing. This time the
question reached the right code and still got the wrong answer, for two unrelated reasons —
found by driving a probe through the real pipeline and reading the prompt Gemini actually
received, rather than reasoning about where it might be going wrong.

**The prompt made the model do calendar arithmetic.** The roster went over as bare day numbers
(`20: เวรเช้า`) while today's date went over in Thai Buddhist years (`19 ส.ค. 2569`). Answering
"is there a shift tomorrow" meant converting the era, adding a day, and checking the roster's
month matched — three inferences, in a prompt whose own rule two paragraphs earlier is that the
model must never work out what this code already knows. Today's and tomorrow's shifts are now
computed here and stated outright, the same treatment the money totals and the weather get, and
a day with nothing on it says so rather than being silently absent (to a model, "no line" and
"no data" look identical). Every roster line now carries a full ISO date.

**And tomorrow's roster was never fetched at all.** A roster is a tab per month, and
`readAccountSnapshot` only ever loaded the current one — so on the last day of a month,
tomorrow's shifts were not missing from the answer, they were never read, and the prompt tells
the model not to guess. "No" was the only answer available to it, however good the model was.
That is a guaranteed wrong answer twelve days a year. `answerQuestion` now asks for tomorrow's
month too when it differs, riding in the same batchGet, so the other ~353 days cost exactly what
they did before.

**Two testing lessons, both the same shape as the bug.** A first pass tested the new plumbing by
calling `readAccountSnapshot` directly with a second month — which passed while a mutation
removing the argument at the real call site *survived*, because nothing exercised the Q&A path on
a month boundary. That is precisely how the original bug shipped: mechanism correct, never wired
up. The regression test now freezes the clock to a month end and goes through `handleTextMessage`.
Separately, mutations deleting either `ensureShiftsTab` call survived because the mock happily
read ranges on tabs that did not exist; it now returns a 400 like the real API, and a test reads
a month no earlier test had created a tab for.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real or test values
npm run dev                      # wrangler dev, local KV emulation
npm run typecheck
npm test                         # both suites below
```

`scripts/test-flow.mjs` exercises the real linking/parsing/clarification/summary code
paths against a fake in-memory KV and a mocked `fetch` standing in for Google/LINE (this
environment has no real LINE or Google credentials to test against end-to-end) — run it
after changing `src/index.ts`, `commands.ts`, or `state.ts` to catch regressions. It
specifically checks that the signed `state` param on the generated Google auth link
decodes back to the same LINE user id the webhook event carried, which is the exact bug
class the LIFF removal above fixed.

### Settings (`/view/settings`)

The bot's name, its character, what it calls you, and your weather province
are per-account, stored in KV by `src/settings.ts` and edited on
`/view/settings`. The defaults are exactly the values that used to be
hard-coded, so an account that never opens the page behaves identically. The
name matters beyond cosmetics: in a group, typing it in a message is how you
address the bot without a formal @mention.

The same page can wipe all income and expense rows to start over. That needs
a 6-digit code emailed to the Google account that owns the spreadsheet —
answering "are you the person whose money this is", which matters because a
`/view` link shared into a group chat can be opened by any member. The
address is read from Gmail's own profile endpoint (already covered by
`gmail.readonly`) rather than by adding the `userinfo.email` scope, which
would force every linked account to re-consent. The code lasts 15 minutes and
is destroyed after five wrong tries. The wipe clears the Transactions tab
only — diary, budgets, calendar, tasks and trip photos are untouched, which
the page states and a test enforces.

### Public pages (`/privacy`, `/terms`)

Both are tokenless and served from the root, so a LINE or Google reviewer can open them
without a LINE account and a bookmarked URL never expires. `src/legalPages.ts` writes them
from what the code actually does: the scope list comes from `googleAuth.ts`, the storage
table from every KV prefix the Worker really writes, the retention figures from the real
TTL constants, and the third-party list from the hosts it genuinely contacts (Skyscanner,
Agoda, Booking and 12go appear only as links in replies and are never called).

English versions live at `/privacy/en` and `/terms/en` for a Google OAuth reviewer who
doesn't read Thai. Both languages sit in the same file, and a test compares their shape —
section count, bullet count, table rows — so a translation can't quietly lose a row and
leave the policy saying different things to different reviewers.

A test reads `googleAuth.ts` and fails if a requested scope isn't explained in the policy.
A document claiming the bot asks for less than it does is the one way a privacy policy can
be actively harmful rather than merely stale.

### Cost and quota shape

Two things scale with the number of people using the bot, and neither is what the chat
traffic suggests:

- **The 07:00 briefing is one LINE push per person per day**, sent whether or not they use
  the bot. Pushes are the charged direction; replies are free and unlimited. It is opt-in
  as of PLAN.md 17.54 — but accounts that already had it keep it, detected by the *absence*
  of `linkedAt` on their account link, since that field only started being written then.
  No migration, no cutoff date: the accounts already receiving it are exactly the ones that
  cannot prove when they linked.
- **Every message costs two Gemini calls** — the interpreter and the persona restyle — even
  a reply as short as "saved". Questions cost three.

`src/geminiBudget.ts` is a circuit breaker on Gemini's own 429 rather than a local counter.
Google already counts accurately, and a counter would mean a KV write per Gemini call
against a 1,000-writes-a-day free budget the bot already spends a few hundred of. It is
checked inside `callGemini`, so no future Gemini caller can forget it, and every fallback
it lands on already existed: interpreter → deterministic matchers, persona → unstyled text,
Q&A → its fallback message. Only 429 opens it; a 500 is one call's problem.

### Network deadlines

`src/timeouts.ts` gives Sheets, Calendar and the weather API a deadline, applied at their
low-level fetch wrappers so every caller is covered rather than just the path that happened
to reveal the gap. Before that, the only timeouts in the codebase were on the three Gemini
calls — the wrong way round, since the Google APIs were the ones nothing else was watching,
and one hung request could hold a reply open long past the LINE token meant to answer it.

They are hang guards, not latency targets: 10s/8s/5s, far beyond how long these take when
anything is working. A timeout names the dependency that ran out of time, because "the
request was aborted" in a log is useless when half a dozen Google APIs are equally suspect.

### How much of the sheet a command reads

Reports about a single month don't read the whole `Transactions` tab. The
Worker remembers, per book and per month, which sheet row that month starts
on (KV key `tx-month-start:<sheetId>:<YYYY-MM>`) and asks Google only for
`Transactions!A<start>:J` — one request whose size follows how much has
happened since the month began rather than how long the book is. The row is
treated as a hint: the row directly above the window comes back in the same
request and must belong to an earlier month, otherwise the hint is thrown
away and rebuilt from a full read. That is what makes hand-edits in Google
Sheets safe — nothing else could notice them.

Four commands still read everything, deliberately, and say so at each call
site: `เหลือเงินเท่าไหร่` (a cumulative balance is every month there has ever
been), `ค้นหา` (searching only this month would quietly stop finding things),
`รายการล่าสุด` and `ลบรายการล่าสุด` (the five most recent overall, which on
the 1st of a month are last month's). See PLAN.md 17.47 for why monthly tabs
plus a precomputed summary tab were considered and turned down.

`scripts/chat-engine-check.mjs` covers `src/chatEngine.ts` on its own — the multi-turn
money conversation with no webhook, Sheets or KV around it. `test-flow.mjs` drives the
same engine through the whole Worker, but a wrong turn in the conversation is much
easier to read at this level. It came over with the engine when the PWA was removed.

To tweak the rich menu's design, edit `assets/generate-rich-menu.py` (needs
`pip install pillow`) and run it — it writes `assets/rich-menu.png` from scratch every
time, so it's always reproducible from source rather than being an opaque binary someone
has to redraw by hand. Then re-run the "One-time - Set up LINE Rich Menu" Action (step 7
above) to publish it.

## Known limitations (documented honestly, not blockers)

- Account linking (`setAccountLink`) always creates a **new personal spreadsheet** the
  first time a LINE userId links — it does not let you attach an *existing* book. Fine
  for a fresh user; if you have an older book (from the removed PWA, say) and want the
  bot to use that one, its spreadsheet ID has to be wired in by hand for now, or the
  linking flow extended to offer the choice.
- Group books work through LINE group mode (PLAN.md 17) — add the bot to a LINE group and it
  keeps one shared book for the whole group. (This bullet used to claim group books weren't
  wired up at all; that was stale documentation from before phase 17 shipped.)
- The monthly summary is a plain text message, not a chart image (see PLAN.md 14.3 for
  the image-generation option if wanted later).
- Trip photos only upload while a trip is open (`เริ่มทริป` first) — there's no "attach a
  folder name to a single stray photo" fallback, since LINE doesn't support captions on
  image messages (see PLAN.md 15.2). No auto-timeout closes a forgotten trip either; use
  `ทริปตอนนี้` to check.
- Calendar events are single occurrences only — no recurring/repeating events yet
  (PLAN.md 15.3). Date/time parsing understands both explicit formats ("12/1/2569 13:00",
  "12 ม.ค. 13.00", used as a fallback when the AI call itself fails) and natural phrases
  like "พรุ่งนี้บ่ายสอง" (via the AI-interpreter-first pipeline, PLAN.md 17.11/17.35 — this
  bullet used to claim the natural-phrase case didn't work at all, written before that
  pipeline shipped and never revisited until PLAN.md 17.35 caught it).
- Diary entries can't be edited/deleted from chat — create + monthly list + search only
  (PLAN.md 15.4). Editing and deleting live on the web viewer's diary page instead
  (PLAN.md 17.36).
- Only one confirmation can be pending at a time (trip switch, calendar create/edit/delete,
  diary create all share one slot per user) — asking a second thing before answering the
  first silently drops whichever was asked first rather than queueing it.
