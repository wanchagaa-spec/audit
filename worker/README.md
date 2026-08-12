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

## Try it

Add the Official Account as a friend in LINE. First message should prompt you to tap a
link to connect your Google account. After signing in, you'll see a "เชื่อมบัญชีสำเร็จ"
page — close it and go back to the chat. From then on, just log things like
"ซื้อกาแฟ 60", or ask it questions — see `src/commands.ts` for the full matcher list
(each with several accepted phrasings), summarized by texting "วิธีใช้":

- สรุปวันนี้ / สรุปสัปดาห์นี้ / สรุปเดือนนี้ / สรุปเดือนที่แล้ว
- เหลือเงินเท่าไหร่ (all-time cumulative balance) / รายรับเดือนนี้เท่าไหร่ / รายจ่ายเดือนนี้เท่าไหร่
- วันไหนใช้เงินเยอะที่สุด / หมวดไหนใช้เงินเยอะที่สุด / ซื้ออะไรบ่อยที่สุด (by count) / เฉลี่ยใช้เงินต่อวันเท่าไหร่
- งบเหลือเท่าไหร่ (reads the Budgets tab, set from the web app's Settings)
- ค้นหา &lt;คำ&gt; / รายการล่าสุด
- วิธีใช้ (lists all of the above)

All of these are plain Google Sheets reads/aggregations over data already in the
spreadsheet — no external AI involved, so they stay within the free-forever design (see
PLAN.md section 14 for the tradeoff notes on adding an AI fallback for messages none of
these cover).

### Trip photo albums (PLAN.md 15.2)

Send photos to the bot and they're organized into Google Drive automatically, grouped by
trip and day:

- `เริ่มทริป <ชื่อ>` — e.g. "เริ่มทริป ทะเล" — starts a trip session. Every photo you send
  after this uploads automatically into that trip's Drive folder, in a subfolder for the
  day it was sent (`จดบัญชี - อัลบั้มทริป/ทะเล/1-1-2569/`, ...), no captioning needed.
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
