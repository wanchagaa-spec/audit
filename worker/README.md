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
   Console): set response mode to **Bot only** — this disables the human-readable chat
   inbox, so nobody but the webhook code ever sees raw messages (see PLAN.md 14.4).
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

### 6. Create the LIFF app (for the one-time account-linking step)

1. In LINE Developers Console → your channel → **LIFF** tab → **Add**.
2. Endpoint URL: `https://<your-worker>.workers.dev/liff`
3. Size: Full, Scope: `profile`.
4. Copy the generated **LIFF ID**, edit it into `worker/wrangler.toml` under
   `[vars] LIFF_ID` directly on github.com, commit — this triggers a redeploy
   automatically (or re-run the "Deploy LINE bot Worker" workflow manually).

## Try it

Add the Official Account as a friend in LINE. First message should prompt you to tap a
link to connect your Google account (opens inside LINE via LIFF, no separate browser).
After that, just type things like "ซื้อกาแฟ 60" or "สรุปเดือนนี้".

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real or test values
npm run dev                      # wrangler dev, local KV emulation
npm run typecheck
node --experimental-strip-types scripts/... # see scripts/test-flow.mjs for a logic smoke test:
npx tsx scripts/test-flow.mjs
```

`scripts/test-flow.mjs` exercises the real linking/parsing/clarification/summary code
paths against a fake in-memory KV and a mocked `fetch` standing in for Google/LINE (this
environment has no real LINE or Google credentials to test against end-to-end) — run it
after changing `src/index.ts`, `commands.ts`, or `state.ts` to catch regressions.

## Known limitations (documented honestly, not blockers)

- Account linking (`setAccountLink`) always creates a **new personal spreadsheet** the
  first time a LINE userId links — it does not yet let you pick an *existing* book from
  the web app to attach to. Fine for a fresh LINE-first user; if you already use the web
  app and want the same sheet, note the spreadsheet ID from the web app's Settings and
  wire it in manually for now (or ask to extend the linking flow to support this).
- Group books (inviting others via LINE) aren't wired up yet — only personal books.
- The monthly summary is a plain text message, not a chart image (see PLAN.md 14.3 for
  the image-generation option if wanted later).
