# Cloudflare Worker + D1 Setup

## Install
```bash
npm i -g wrangler
wrangler login
```

## Create D1 DB
```bash
wrangler d1 create mpqm1
```

Copy the returned `database_id` into `cloudflare/wrangler.toml`.

## Apply Schema
```bash
wrangler d1 execute mpqm1 --file=cloudflare/schema.sql
```

For an existing database that was created before session auth/versioning, run this one time:

```bash
wrangler d1 execute mpqm1 --file=cloudflare/migrate_existing_d1.sql
```

## Set Secrets
```bash
cd cloudflare
wrangler secret put ADMIN_INVITE_CODE
wrangler secret put ALLOWED_ORIGIN
```

Use a long random admin invite code. Set `ALLOWED_ORIGIN` to your production frontend origin, for example:

```text
https://your-domain.com
```

## Deploy API Worker
```bash
cd cloudflare
wrangler deploy
```

## Deploy Static CMS
From the project root:

```bash
npm run build:main
wrangler deploy
```

## Frontend Config
Only the API URL belongs in `firebase-config.js`:

```js
window.MPQM_CLOUDFLARE_API = 'https://your-api-worker.workers.dev';
window.MPQM_BACKEND = 'cloudflare';
```

Never put admin tokens or invite codes in frontend files.
