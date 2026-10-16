# Retium Pay

A community-built workspace for the Retium testnet: payment requests, group bills, Telegram notifications, token swaps, liquidity tools, token deployment and a read-only explorer.

This is an independent community project. It is not an official Retium product. Testnet only.

## Features

- Connect a Web Wallet once on the Dashboard; approve signatures and transactions in your wallet.
- Request native RTM payments and verify direct transfers at HardFinal.
- Split a bill equally or assign custom amounts to 2–20 payers. Exact integer arithmetic preserves the total.
- Optional Telegram notifications, verified wallet linking, member registration with `/contact`, and personal contact nicknames.
- Track requests and group totals in My History. Background workers continue checking saved transactions after the browser closes.
- Swap and manage liquidity through the existing testnet trading contract; deploy a fungible test token.
- Look up public transactions, wallets and contracts in Retium Pay Explorer.

## Local setup (Windows PowerShell)

Install Node.js 24 and npm. In the project directory:

```powershell
npm ci
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
code .env.local
```

For file-based local testing, remove the placeholder DATABASE_URL line. Set `TELEGRAM_BOT_TOKEN` to your own bot token. Leave `APP_URL=http://localhost:3000` for local testing. Never share or commit `.env.local`.

Build and start the web server:

```powershell
npm run build
npm run start
```

In a second PowerShell window, in the same directory:

```powershell
node --env-file=.env.local .\scripts\telegram-bot.mjs
```

In a third window:

```powershell
node --env-file=.env.local .\scripts\payments-worker.mjs
```

Open http://localhost:3000. Keep all three processes running. For development use `npm run dev`; production mode avoids development hot reloads during normal testing.

## Telegram onboarding

1. Start your own deployed bot and send `/register` for a fresh registration code.
2. Connect your wallet on the Dashboard. Open Telegram settings, paste the code, prepare verification and sign to link.
3. Send `/status` to check the actual verified wallet link.
4. Send `/contact` to opt into the shared member directory. Signed-in app users can see the enrolled Telegram name, username and public wallet. `/contact off` stops the listing; existing bills and saved contacts remain.
5. The bill owner signs into the member directory, selects an enrolled member, sets a private contact nickname and clicks Add member.

Telegram is optional for Split Bill. A bill can use public payer wallet addresses and payment links only. Telegram usernames are display labels; membership uses the Telegram User ID and verified wallet link.

## Payments

Creating a bill signs and saves requests; it does not send a blockchain transaction. Each payer must connect the requested payer wallet, verify, then approve their own RTM transfer. A name is not proof of ownership.

Payment confirmation checks sender, recipient, atomic amount, nonce, transaction identity, time and HardFinal. A TX cannot settle two different requests. Contract calls and swaps cannot be used as direct payment receipts.

After a response is interrupted, check My History or use bill recovery before creating another request or sending again. Recovery records public request IDs, not wallet secrets.

## Hosting and persistence

A public GitHub repository does **not** host this application. GitHub Pages cannot run its server APIs or workers.

For Vercel, set DATABASE_URL to a private PostgreSQL database shared by the web, Telegram bot and worker. See [DEPLOY_VERCEL.md](DEPLOY_VERCEL.md) for the insert-only migration and deployment order. On Vercel there is no file-storage fallback. The two background runners continue on the Windows host in this release.

For local mode without DATABASE_URL, use the persistent writable data directory and one app instance; keep the bot and worker in that same directory.

Set `APP_URL=https://YOUR_APP_HOST` before starting the web server and worker. Telegram messages generated with a public HTTPS URL include a Pay button for the request amount. Localhost test links only work on the computer running the app. Previously sent Telegram messages do not automatically change after the URL is updated.

After changing the public origin, connect and verify again on that origin. The wallet provider must support the deployed origin. Do not expose environment files, private runtime data or signing keys as public assets.

## Data and secrets

With DATABASE_URL, runtime data and service keys are held in the private PostgreSQL database. Protect its connection string and database backups. Without DATABASE_URL in local mode, runtime data is stored under data/. Keep local files for backup after migrating; they are no longer the live source once PostgreSQL is enabled. Neither credentials nor user data belong in GitHub.

The app does not need wallet seed phrases or private keys; wallet approval remains with the user. `.env.example` contains placeholders only. Use your own Telegram bot; the source UI currently references `@RetiumPay_Bot`, so adjust those display links for a separate deployment.

## Validation

```powershell
npx tsc --project tsconfig.json --noEmit --incremental false
npm run lint
npm run build
```

Development checks covered signed payment validation, duplicate prevention, group arithmetic, contact privacy/registration, profile snapshots, interrupted-save recovery and full-address copying. Live wallet, Telegram delivery and public-hosting tests are still required for each deployment.

## Attribution

Retium Wallet Connect and the Retium RPC are external services. DEX actions use the existing trading contract; using the Retium Pay interface does not change the on-chain contract's ownership or identity.

The bundled fungible-token WASM template originates from Whisk. See THIRD_PARTY.md. Project-wide licensing has not been selected in this snapshot; public source visibility alone does not grant a new redistribution license.


## Vercel deployment

This release adds shared PostgreSQL persistence for Vercel. See [DEPLOY_VERCEL.md](DEPLOY_VERCEL.md) for migration, environment configuration and the two local runners. The older file-storage hosting notes below/above apply only when DATABASE_URL is absent in local mode.
