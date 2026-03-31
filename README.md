# mail-puller

> a cloudflare worker that checks your email and yells at discord about it!!
> built with pure vibes and raw tcp sockets 🎶

---

## what does it do

every day at **16:20 UTC** this little worker wakes up, sneaks into your IMAP inbox over a raw TLS socket, grabs any new emails since last time, and fires them off as Discord embeds. no email client needed. no polling service. just a cron job living on the edge (literally, cloudflare edge).

it tracks the last-seen UID per account in **KV storage** so it never sends you the same email twice, even across cold starts !!

---

## features

- raw IMAP over TLS using `cloudflare:sockets` — no npm imap library, built from scratch
- custom s-expression parser for IMAP FETCH responses (yes really)
- multi-account support — add as many inboxes as you want
- discord webhook notifications with pretty embeds
- first-run baseline: won't flood you with old mail on initial deploy
- runs serverless on cloudflare workers — zero infra

---

## setup

### 1. create KV namespace

```sh
npx wrangler kv namespace create MAIL_STATE
```

paste the returned `id` into [wrangler.jsonc](wrangler.jsonc) under `kv_namespaces`.

then regenerate types:

```sh
npm run cf-typegen
```

### 2. configure secrets

copy [secrets.example.json](secrets.example.json) and fill it in:

```json
{
  "DISCORD_WEBHOOK": "https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN",
  "ACCOUNTS_JSON": [
    {
      "name": "My Account",
      "host": "imap.gmail.com",
      "port": 993,
      "user": "you@gmail.com",
      "password": "your-app-password"
    }
  ]
}
```

> for gmail use an [App Password](https://myaccount.google.com/apppasswords), not your real password !!

push secrets to cloudflare:

```sh
npm run secrets
```

or push them individually:

```sh
npx wrangler secret put DISCORD_WEBHOOK
npx wrangler secret put ACCOUNTS_JSON
```

### 3. deploy

```sh
npm run deploy
```

---

## local dev

```sh
npm run dev
```

trigger the scheduled handler manually:

```sh
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

---

## cron schedule

currently set to `20 16 * * *` (16:20 UTC daily). change it in [wrangler.jsonc](wrangler.jsonc) under `triggers.crons`.

---

## project structure

```
src/
  index.ts    — worker entrypoint, orchestrates accounts
  imap.ts     — raw IMAP client + response parser
  discord.ts  — discord webhook sender
  config.ts   — account type definitions
scripts/
  push-secrets.mjs  — bulk secret upload helper
```

---

## tech stack

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare KV](https://developers.cloudflare.com/kv/) — state persistence
- [`cloudflare:sockets`](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) — raw TLS connections
- TypeScript
