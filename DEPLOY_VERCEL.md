# Deploy Retium Pay to Vercel (one consolidated update)

This package updates the existing app. Web/API run on Vercel with PostgreSQL persistence.
Telegram polling and the payments/DEX background worker continue on your Windows PC.
Do NOT deploy the old file-storage version first. Do NOT use /tmp as persistent storage.

## 1. Install once
Stop the web, Telegram bot and worker before upgrading/importing. Keep the original data folder.
Run install-vercel.ps1. It backs up replaced source/config files in BOTH existing folders,
updates the runtime app and the existing GitHub checkout, and never copies .env.local/data to GitHub.
Then in D:\Projects\Retium\retium-pay run:

    npm ci
    npx tsc --project tsconfig.json --noEmit --incremental false
    npm run lint
    npm run build

## 2. Prepare ONE database before deploying
Create a Neon PostgreSQL project (https://console.neon.tech/) in Singapore if available.
Copy the pooled connection string privately into DATABASE_URL in the original app's .env.local.
Retain TELEGRAM_BOT_TOKEN and RETIUM_RPC_URL. Do not paste credentials into chat, GitHub, or client code.
While ALL old app/bot/worker processes are stopped, run from the original app:

    npm run db:import

This imports the allowlisted existing bill, wallet-link, Telegram, DEX, worker status and key documents
in one database transaction. It never overwrites different remote data and leaves local files unchanged.
If it reports a conflict, stop and investigate; do not delete database rows or retry with overwrite.
For a genuinely new app with no old data, skip import and run check:deploy after configuring APP_URL.
Do not run both the old file-storage app and upgraded PostgreSQL app against the same user population.

## 3. Configure Vercel BEFORE the production deploy
Sign in at https://vercel.com/new with the GitHub account that owns nguyenhuu0304/retium-pay.
Import that repository as a Next.js project. Choose its final production domain/project name.
Use the exact assigned production HTTPS origin for APP_URL (no /payments path), for example the
actual project domain shown by Vercel. Do not assume that retium-pay.vercel.app is available.

Set server-side Production environment variables:

* DATABASE_URL: the SAME database used during import
* APP_URL: the final public HTTPS origin
* TELEGRAM_BOT_TOKEN: your current Retium Pay bot token
* RETIUM_RPC_URL: https://rpc.retium.org

Never prefix these secret values with NEXT_PUBLIC_. Do not point preview deployments at production
credentials/data. This release supports one production APP_URL; unrelated preview origins cannot sign in.
Update APP_URL in the local .env.local to that same public origin too. Run:

    npm run check:deploy

Once configuration passes, run publish-github.ps1 from this extracted package, then deploy the updated
main branch ONCE from Vercel. Do not deploy before the consolidated source has reached GitHub.
Build: npm run build. Install: npm ci. Framework: Next.js. Node: 24.x. Root directory: repository root.
There is no Vercel cron in this release: the existing local worker performs continuous monitoring.

## 4. Start the two local runners
From D:\Projects\Retium\retium-pay in two separate PowerShell windows:

    npm run bot:telegram
    npm run worker

Both use .env.local with DATABASE_URL and the public APP_URL. Do not start a second Telegram poller.
The local web server is no longer needed for public users. Keep the PC awake for Telegram commands
and background payment/DEX monitoring. If the PC stops, Vercel web still loads and records requests,
but Telegram commands/background confirmation notifications wait until the runners resume.

## 5. Verify before announcing the site
Open the production HTTPS domain, connect the wallet again and sign in on that origin.
Check My History and Telegram links from the migrated database. Create a small test bill with two
separate wallets. A NEW Telegram bill should now contain Pay <amount> RTM linking to the public site.
Use the actual payer wallet to approve the testnet transfer. Verify HardFinal, one confirmation notice,
and persistence after refreshing. Verify Swap and token-deploy review without approving unintended calls.
Localhost links in OLD Telegram messages are not edited; newly sent messages use APP_URL.
Existing pending payments retain their TX IDs; do not manually resend a transfer to fix a display delay.

## Validation performed on this package
TypeScript, ESLint src, optimized Next.js build passed.
50 native-payment/authentication/idempotency/background regression checks passed.
Signed split-bill/member identity/consent/privacy regression checks passed.
14 persistence checks passed, including PostgreSQL wire-protocol tests using PGlite,
rollback, insert-only migration, concurrent updates and reconnect persistence.
This is NOT a claim of successful deployment or a test against your actual Neon/Vercel account.
The first live production smoke test is required after your account configuration.

## Implementation boundary
State is stored in private PostgreSQL documents with transactional per-document locks, preserving the
existing authentication and bill formats. Appropriate for this single-instance community test release;
this does not claim an independently audited or large-scale production payment service.
Schema creation is automatic with database permissions; keys remain server-side and persistent.
If DATABASE_URL is missing on Vercel, writes fail instead of silently using ephemeral disk.
