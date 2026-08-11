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

1. Sign up at https://dash.cloudflare.com if you don't have an account.
2. From this `worker/` directory, log in and create the KV namespace:

   ```bash
   npx wrangler login
   npx wrangler kv namespace create ACCOUNTS
   ```

   Paste the returned `id` into `wrangler.toml` under `[[kv_namespaces]]`.

### 3. Reuse the same Google OAuth client as the web app — plus a Client Secret

The web app's Client ID (`VITE_GOOGLE_CLIENT_ID`) only supports the browser-side implicit
flow. The bot needs a **refresh token** so it can write to Sheets when nobody has the app
open, which requires the *authorization code* flow — and that needs a Client Secret that
must never reach a browser.

1. In the same Google Cloud project as before, open the OAuth client you already created
   (APIs & Services → Credentials).
2. Add an **Authorized redirect URI**: `https://<your-worker-subdomain>.workers.dev/oauth/callback`
   (you'll know the exact subdomain after the first `wrangler deploy`; redeploy isn't
   needed to add this — just update it in Google Cloud Console once you know the URL).
3. Copy the **Client secret** shown on that same page.

### 4. Set secrets and deploy

```bash
npm install
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put GOOGLE_CLIENT_ID          # same value as VITE_GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put STATE_SIGNING_SECRET      # any long random string you make up
npx wrangler deploy
```

This prints your Worker's URL, e.g. `https://expense-tracker-line-bot.<you>.workers.dev`.

### 5. Point LINE's webhook at your Worker

Back in LINE Developers Console → Messaging API tab → **Webhook URL**:
`https://<your-worker>.workers.dev/webhook`, then click **Verify** (should succeed once
secrets are set) and turn **Use webhook** on.

### 6. Create the LIFF app (for the one-time account-linking step)

1. In LINE Developers Console → your channel → **LIFF** tab → **Add**.
2. Endpoint URL: `https://<your-worker>.workers.dev/liff`
3. Size: Full, Scope: `profile`.
4. Copy the generated **LIFF ID** and set it in `wrangler.toml` under `[vars] LIFF_ID`,
   then `npx wrangler deploy` again.

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
