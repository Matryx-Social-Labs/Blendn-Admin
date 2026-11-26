# Blendn Admin - Railway Deployment Guide

## Prerequisites

1. Railway account (https://railway.app)
2. GitHub repository connected to Railway
3. Domain configured (e.g., api.blendn.app)

## Quick Deploy

### 1. Create Railway Project

```bash
# Install Railway CLI (optional)
npm install -g @railway/cli

# Login to Railway
railway login
```

Or use the Railway dashboard at https://railway.app/new

### 2. Set Environment Variables

In Railway dashboard, add these environment variables:

**Required:**
```
DATABASE_URL=<your-railway-postgres-url>
NEXTAUTH_URL=https://api.blendn.app
NEXTAUTH_SECRET=<generate: openssl rand -base64 32>
MOBILE_JWT_SECRET=<generate: openssl rand -base64 32>
```

**Optional:**
```
TIGRIS_ENDPOINT=https://fly.storage.tigris.dev
TIGRIS_ACCESS_KEY=<your-tigris-key>
TIGRIS_SECRET_KEY=<your-tigris-secret>
TIGRIS_BUCKET=blendn-media
TIGRIS_REGION=auto
```

### 3. Connect Database

If using Railway Postgres:
1. Add PostgreSQL plugin to your project
2. Railway will automatically set `DATABASE_URL`

If using external database:
1. Set `DATABASE_URL` manually
2. Ensure the database is accessible from Railway's network

### 4. Deploy

**Option A: GitHub Integration (Recommended)**
1. Connect your GitHub repo to Railway
2. Railway will auto-deploy on push to main branch

**Option B: Manual Deploy**
```bash
railway up
```

### 5. Configure Domain

1. In Railway dashboard, go to Settings > Domains
2. Add custom domain: `api.blendn.app`
3. Configure DNS:
   - Add CNAME record pointing to Railway's domain
   - Or use Railway's provided nameservers

### 6. Run Database Migrations

```bash
# SSH into Railway or use the CLI
railway run npx prisma migrate deploy
```

Railway also runs this automatically on deploy, so you rarely need it by hand.

#### The deploy settings are on the Railway service

The pre-deploy command (the migrations), the start command, the `/api/health`
healthcheck and the restart policy are stored on the service itself, per
environment, and described in `.railway/railway.ts`. There is no `railway.json`:
Railway stops reading it on 2026-12-01, and until then it would override the
service. Railway does not read `.railway/` during a deploy. To change a setting,
edit the file, then, once per environment:

```bash
railway config plan --environment staging    # read it: only what you changed
railway config apply --environment staging   # redeploys the service
```

Production is the owner's. **A service without the pre-deploy command deploys
without migrations and says nothing**, so after any change here read the deploy
log for `prisma migrate deploy`. A settled environment plans no changes.

#### A migration is a transaction only if it says so

`prisma migrate deploy` sends a migration file **statement by statement,
outside any transaction** (measured in the step 17 review: a `CREATE` followed
by a failing statement left the table behind, and `SET LOCAL lock_timeout` set
nothing). A file that fails half-way leaves its first statements applied and
the deploy blocked on a migration Prisma marks failed. So a migration with more
than one statement wraps itself:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
-- … the statements …
COMMIT;
```

The exception is `ALTER TYPE … ADD VALUE`, which goes in a file of its own: a
value cannot be used in the transaction that added it. Migrations before
2026-10-09 (step 16's included) say "Prisma runs a migration in one
transaction"; that comment is wrong, and the files are left as they are,
because editing an applied migration changes its checksum (the renamed migrations, below).

#### A migration is additive for one release

The pre-deploy step migrates while the old container still serves, and a
rollback is "redeploy the previous build", which runs it on the new schema. So
a migration only adds: add the column or table, backfill, switch the code, and
drop or rename the old shape in a later deploy, once no running build reads it.
Rollback is therefore the previous build plus a forward-fix migration, never a
hand-reverted schema. Take a manual dump before any promotion that carries a
migration (the backups section, ops task 04).

`__tests__/migration-tx.test.ts` holds every migration after its
`LAST_UNCHECKED` to this, and to locks that last as long as the table is big:

- `DROP TABLE`, `DROP COLUMN` (or a bare `ALTER TABLE … DROP x`), `DROP TYPE`,
  any other `DROP` but the ones below, any `RENAME` (a column, a table, a
  constraint or index the code catches by name, an enum value), and `ADD COLUMN
  … NOT NULL` with no `DEFAULT` (the previous build's inserts leave it out) fail
  unless the file says `-- contract: <why> #<PR>`, naming the PR after which
  nothing reads the old shape. `DROP CONSTRAINT`, `DROP INDEX`, `DROP DEFAULT`,
  `DROP NOT NULL` and `DROP TRIGGER` are fine.
- On a table the file has not created yet: a plain `CREATE INDEX` (use
  `CONCURRENTLY`, alone in its file), a `CHECK` or `FOREIGN KEY` without `NOT
  VALID` (and `VALIDATE CONSTRAINT` goes in a later migration: in the same
  transaction it scans under the `ADD`'s lock), `UNIQUE` or `PRIMARY KEY`
  without `USING INDEX`, `ADD COLUMN … REFERENCES | CHECK | GENERATED` or with a
  volatile default (`gen_random_uuid()`), `SET NOT NULL` and `ALTER COLUMN …
  TYPE` fail unless the file says `-- lock-ok: <why>` (a table of 40 rows, say).
  `lock_timeout` bounds the wait for the lock, not how long it is held.
- A wrapped migration has a non-zero `SET LOCAL lock_timeout` as its second
  statement: an `ALTER` queued behind a long transaction blocks every read of
  the table while it waits, and an `UPDATE` waits on row locks the same way.

A marker covers the whole file, so a migration that needs one is best kept to
the statements it excuses.

#### The test accounts are written by the same step

Staging's pre-deploy command is `npm run railway:predeploy`
(`.railway/railway.ts`; production's is `npm run db:migrate`, the migrations only): the
migrations, then `scripts/test-accounts.ts`. That creates or repairs one
dashboard account per role — admin, organizer, venue owner and sponsor; the
addresses are `TEST_ACCOUNTS` in that script — with their organisations and
memberships, and sets their password to `SEED_PASSWORD`.

- **Staging only.** It writes nothing when `SEED_PASSWORD` is unset, and nothing
  on any Railway environment but `staging` even when it is set — production and
  PR environments deploy untouched. The check is an allow-list inside the shared
  function, so `seed:qa` and `db:seed` refuse the same way.
- **From a laptop**, only a `localhost` database passes. To seed staging through
  its public URL, say so: `RAILWAY_ENVIRONMENT_NAME=staging SEED_PASSWORD=…
  DATABASE_URL=<staging public URL> npm run seed:qa -- --apply`.
- **Rotation is changing the variable.** Railway redeploys and the step rehashes.
- **A password `checkPassword` refuses fails the deploy**, with the reason in the
  deploy log. Better than an account nobody can sign in to.
- It prints the addresses, never the password.

#### Seeding venues from a founders' CSV

`scripts/import-venues.ts` lists venues before any owner arrives (every venue is
live from day one). Columns: `name, address, lat, lng, maps_url, type, city` —
`name` and `city` required; `lat`+`lng` or a Google Maps link. Each row meets the
dashboard's own rules (`lib/venue-rules.ts`): refused within 100 m of a listed
venue or an earlier row, an area sized for its type, unclaimed. The owner claims
it later at `/claim/venue/<id>`.

```bash
DATABASE_URL=<url> npx tsx scripts/import-venues.ts venues.csv                # dry run: rows + duplicates, writes nothing
DATABASE_URL=<url> npx tsx scripts/import-venues.ts venues.csv --apply        # write
DATABASE_URL=<url> npx tsx scripts/import-venues.ts venues.csv --apply --osm  # + the building's OSM outline where named
```

**`npx tsx`, not `npm run`.** npm 11 takes `--apply` given to `npm run` as its
own option and drops it, which turns a write into a dry run; wrapped in an npm
script it needs `--` before the file. The first line of output says `APPLY` or
`DRY RUN`. `--apply` is all-or-nothing: a file with any refused row writes
nothing, and the rows are written in one transaction after every footprint is
worked out. Rows are reported by their line in the file, with where each row's
coordinates came from (lat/lng, the place pin, a typed pair, or only the map's
centre). Re-running is safe: rows already imported come back as duplicates.

#### `migrate status` reports two missing migration files. That is expected.

On production and staging you will see something like:

```
The following migration(s) are applied to the database but missing from
the local migrations directory: 20260805_org_onboarding,
20260805_venues_and_suspension
```

**Nothing is wrong, and nothing needs doing.** Both were renamed, on purpose:

| Was | Is now |
|---|---|
| `20260805_org_onboarding` | `20260806a_org_onboarding` |
| `20260805_venues_and_suspension` | `20260804_venues_and_suspension` |

Five migrations were written on 2026-08-05 with no time component in their
names, so their order was decided alphabetically rather than by intent — and
the dependency order turned out to be the reverse of it. `organisations` needed
`venues`, and `org_onboarding` needed `organisations`, but both sorted before
what they required. Any database built by replaying the chain failed; ours never
were, because the schema was originally created with `db push` and every
migration was recorded as applied against a database that already had
everything.

They were **renamed rather than edited** because Prisma stores a checksum for
each applied migration — editing one in place makes `migrate deploy` fail on
every environment that has already run it. Under a new name each is simply a
new migration, so existing environments run it once more. Every statement in
both is idempotent (`IF NOT EXISTS`, or catching `duplicate_object`), so that
run changes nothing.

The old rows stay behind with no matching directory. `migrate deploy` ignores
them; only `migrate status` mentions them. **Do not delete those rows** — they
are the record that the original migrations ran, and removing them would make
Prisma try to apply migrations that no longer exist.

Verified before shipping, against a database built to look like production
(schema pushed, 52 migration rows under the original names): the five new and
renamed migrations applied as true no-ops, the schema was unchanged
column-for-column, and a second `migrate deploy` reported nothing pending.

### 7. Seed the App Store review account

**Mandatory after any database wipe, and before any App Store or Play
submission.**

```bash
APP_REVIEW_EMAIL=... APP_REVIEW_PASSWORD=... npm run seed:review
```

App Review signs in with a real account. If it does not exist — or the database
was cleared after it was created — the build is rejected, and you find out days
later rather than at deploy time. The script is idempotent, so running it when
it is not needed costs nothing; forgetting it costs a review cycle.

It also makes the review event, every run: one row, slug `review-demo-event`,
found again on a re-run rather than made twice. An empty Events tab reads as a
broken app to a reviewer, and the reviewer is not in Bengaluru, so it is:

- **Unlisted.** No feed or search shows it, nor the "you're here" list to
  somebody standing at its pin, so real users never meet a fake "Rooftop
  Sessions". The reviewer opens it from its share link, the same
  `/event/<id>` address the app's Share button sends (`eventShareUrl`, on
  `PUBLIC_SITE_ORIGIN`), which the script prints. Paste that link into the App
  Review notes. Run the script with `PUBLIC_SITE_ORIGIN` as the target
  environment has it (unset is `www`, production's).
- **Open for a week.** From an hour before the run to a minute short of seven
  days after that, in daily sessions that run into each other
  (`syncOccurrences`), so check-in is open at any hour of a review that takes
  days. **Run it again on submission day**: a re-run moves the window to start
  then, on the same row, puts back anything changed on it (visibility, status,
  a called-off day), and keeps any day somebody checked in to.
- **Filed under the oldest active organizer or app_admin**, re-checked every
  run: the event's public page is hidden while its host is suspended or
  deleted. With no such account the script refuses.

It refuses, writing nothing, when `review-demo-event` is an event it did not
make (an organiser can title one "Review Demo Event") and when
`APP_REVIEW_EMAIL` belongs to a staff account, whose password it would
otherwise reset. Events from earlier runs (slugs `review-demo-event-<date>`)
lose `review_demo`, so there is one review event. It prints the event id, the
window and the share link. After running it,
sanity-check the reviewer's whole path once: sign in, open the share link, check
in. It takes a minute and it is the exact sequence a rejection would come from.

Two constraints on the password, both enforced by the script rather than left to
be discovered:

- At least 12 characters, and it must pass `checkPassword` — the same rule
  signup and password reset enforce.
- **It must not contain `blendn`.** That stem is blocklisted and trailing digits
  are stripped before the check, so `Blendn12345!` is refused.

Put the credentials in **App Store Connect → App Review Information →
Sign-In Information**. Note there that onboarding can be reviewed by creating a
fresh account, since this one is deliberately already onboarded.

#### App Review aid (`REVIEW_ACCOUNT_IDS`) — OFF by default, the owner's call

The review event is in Bengaluru and check-in is GPS-validated, so a reviewer
in Cupertino cannot reach the Room; with `PLUS_GATING` unset the plans never
show; and production refuses sandbox purchases, which is what App Review buys
with. `REVIEW_ACCOUNT_IDS` is a server-side aid for exactly those three, for
the listed accounts only (`lib/review-accounts.ts`):

- **Geofence:** check-in, and the presence ping that keeps them in, skip the
  fence at an event marked `review_demo`. The time window still applies, so the
  event must be on when the reviewer checks in.
- **Blendn+:** treated as gated for them (as if `PLUS_GATING` were on, with no
  trial), so the plans show and a purchase visibly unlocks something.
- **Sandbox purchases:** a RevenueCat `SANDBOX` purchase is credited in
  production. Purchases only; a transfer is still held to the environment.

Every bypass is logged and written to `audit_logs` as `review.bypass` (at most
once per account, bypass and event every ten minutes; the log line is every
time). Unset or empty: nothing changes and no query runs. Nothing in any API
response says an account is a review account.

**User ids, never emails.** An email is whatever somebody typed at sign-up; an
id is ours. The account must be the one `seed:review` created (it prints the id
and the line to set) and must not be deleted; a deleted review account's
address can be signed up with again, and that new account gets nothing.

```bash
# 1. The account (prints its user id):
APP_REVIEW_EMAIL=... APP_REVIEW_PASSWORD=... npm run seed:review
# 2. On the server (Railway production), only if the owner decides to turn it on:
REVIEW_ACCOUNT_IDS=<user id from step 1>
```

Only the event `seed:review` makes is ever `review_demo`, so the reviewer is
never put in a real room with real people. Turn the aid off after approval by
deleting the variable.

### 8. Populate a room — staging only

```bash
SEED_ROOM=yes SEED_ROOM_PASSWORD=<pick one> DATABASE_URL=<staging> npm run seed:room
SEED_ROOM=yes SEED_ROOM_PASSWORD=<same one> DATABASE_URL=<staging> npm run seed:room -- --clean
```

The room's organiser is the organizer test account in Nightshift Collective, so it
is on the dashboard people already sign in to. The script only looks that
account up and refuses if a deploy has not created it yet.

`SEED_ROOM_PASSWORD` has **no default** and the script refuses to run without at
least twelve characters. It was a constant in the file until the repositories
went public, at which point twenty-five accounts on a reachable host had a
password anyone could read. Re-running rotates it, so that is also how you
recover if it leaks again.

Matching, the roster, the dating tag, the small-room work-field floor and the
`just_here` damping are all invisible in an empty room, and an empty room is
what every environment has by default. This creates one event running thirty
days with twenty-five people in it, shaped so each of those behaviours shows up
on a screen rather than in a query plan.

`/api/health/matching` (signed in as an app admin; since SCRUM-946 the public
`/api/health` carries no product metrics) is the check that it worked: `status`
moves from `no_signal` to `ok` with a `rankableShare` around 0.8.

**Two guards, and the second is the one that matters.** `SEED_ROOM=yes` is
required, and the script prints the host it resolved from `DATABASE_URL` before
it writes anything. Staging and production sit on the same internal hostname and
differ only by credentials — `seed-volume.ts`'s ">1000 users means production"
check passes on both and protects neither.

Never on production. The accounts use `@blendn.invalid` addresses and a shared
password, and they would appear in real rooms.

## Domain Setup for blendn.app

### Structure

| Subdomain | Service | Purpose |
|-----------|---------|---------|
| `dashboard.blendn.app` | This deployment | Admin dashboard |
| `api.blendn.app` | This deployment | Mobile API |
| `staging-dashboard.blendn.app` | This deployment (staging) | Dashboard |
| `staging-api.blendn.app` | This deployment (staging) | Mobile API |
| `blendn.app` | Vercel | Organiser landing page |

**One service, two hostnames.** The dashboard and the API are the same
deployment — the split is cosmetic, so that organisers do not log in at a URL
called `api`. There is no second container, Socket.io server, or Prisma client.

### DNS Configuration

Each custom domain gets its own Railway edge target — they are **not
interchangeable**. Copy each `CNAME` from the Railway domain card that issued
it rather than reusing another one.

```
dashboard.blendn.app          CNAME    <target-from-railway>.up.railway.app
api.blendn.app                CNAME    <target-from-railway>.up.railway.app
staging-dashboard.blendn.app  CNAME    <target-from-railway>.up.railway.app
staging-api.blendn.app        CNAME    <target-from-railway>.up.railway.app
```

Do not proxy these through Cloudflare (orange cloud). Railway terminates TLS
itself, and a proxy in front means Railway cannot complete the ACME challenge.

### Turning the split on

Order matters — the middleware redirects, so enabling it against a host without
a valid certificate makes the dashboard unreachable on **both** names.

1. Add the second custom domain to the service and point DNS at it.
2. **Wait for the certificate.** Railway serves its `*.up.railway.app` wildcard
   until Let's Encrypt issues, and a browser rejects that with
   `ERR_CERT_COMMON_NAME_INVALID`. Confirm with:

   ```bash
   echo | openssl s_client -connect dashboard.blendn.app:443 \
     -servername dashboard.blendn.app 2>/dev/null | openssl x509 -noout -subject
   ```

   `CN=dashboard.blendn.app` means ready. `CN=*.up.railway.app` means wait.
   Issuance normally takes a few minutes; if it has not completed in ~30,
   remove and re-add the domain in Railway.
3. Set `DASHBOARD_HOST`, `API_HOST` and `NEXTAUTH_URL` for that environment.
4. Log in on staging first.

A cert error surfaces during the TLS handshake, before any request is sent —
so it is never related to session or login state.

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `MOBILE_MIN_APP_VERSION`, `MOBILE_MIN_APP_BUILD_IOS`, `MOBILE_MIN_APP_BUILD_ANDROID` | No | The oldest app version, or store build number per platform, the mobile API serves; older builds get 426 `UPDATE_REQUIRED`. Unset: no minimum. Set only once the fixed build is live (Operating production, step 5; `docs/API.md`) |
| `DATABASE_POOL_MAX` | No | Connections this process may hold (default 20), shared by every request, Socket.io and every background loop (`lib/background.ts`). A query waiting for one fails after 5 s ("timeout exceeded when trying to connect") instead of queueing for ever (SCRUM-1221); `/api/health` reports `pool.waiting` |
| `HEALTH_METRICS_TOKEN` | Production: yes, before the ops monitor | 32+ characters (`openssl rand -hex 32`). `/api/health` adds `pool`, `eventLoopDelayMs` and `sockets` only for `Authorization: Bearer <this>`; anyone else gets the plain payload, still 200, so Railway's healthcheck is unaffected. Unset: the numbers are omitted on Railway `production` and shown to anyone elsewhere (staging, local). Set but under 32 characters, `validateEnv` fails. Not set by an agent: the owner sets it (SCRUM-1221) |
| `DATABASE_STATEMENT_TIMEOUT_MS` | No | Postgres `statement_timeout` for the server's connections. `server.ts` sets **8000** when unset, so a runaway statement is cancelled (`57014`) rather than holding its connection; `0` turns the cap off. Scripts that import `lib/db` (seeds, backfills, imports) do not set it and have no cap. Not whole milliseconds: the server refuses to boot (SCRUM-1221) |
| `NEXTAUTH_URL` | Yes | Full URL of admin dashboard |
| `NEXTAUTH_SECRET` | Yes | Secret for NextAuth (min 32 chars) |
| `MOBILE_JWT_SECRET` | Yes | Secret for mobile API JWT (min 32 chars) |
| `TIGRIS_ENDPOINT` | No | Tigris S3-compatible endpoint. Uploads are disabled if unset |
| `TIGRIS_ACCESS_KEY` | No | Tigris credentials |
| `TIGRIS_SECRET_KEY` | No | Tigris credentials |
| `TIGRIS_BUCKET` | No | Bucket for uploads (default: blendn-media) |
| `TIGRIS_PRIVATE_BUCKET` | No | Private bucket for claim evidence, read only through signed URLs (default: `<TIGRIS_BUCKET>-private`, created on boot) |
| `TIGRIS_REGION` | No | Bucket region (default: auto) |
| `MEDIA_WORKER_URL` | No | The media worker's private address (`services/media-worker/README.md`). Clips are not checked unless this and its secret are both set |
| `MEDIA_WORKER_SECRET` | No | Shared with the media worker (min 32 chars) |
| `OPENAI_API_KEY` | Required in production | AI moderation. Railway `production` refuses to boot without it (`openaiKeyProblem`, `lib/env.ts`); elsewhere the server boots with a warning and moderation is keyword matching only |
| `RESEND_API_KEY` | No | Transactional email. Without it onboarding and invites still work, but nothing is sent — the dashboard shows the link/password to pass on by hand |
| `EMAIL_FROM` | No | Sender, `"Blend'n" <hello@blendn.app>`. Quote the display name — the apostrophe is legal unquoted per RFC 5322 but quoting is free. Required alongside `RESEND_API_KEY`; email is off unless both are set |
| `STAFF_ALERT_SLACK_WEBHOOK_URL` | No | Where staff alerts are sent: a Slack (or Discord-compatible) incoming webhook for new reports, severe flags and pulled sexual images, with counts, the oldest pending age and a dashboard link only (`lib/staff-alert.ts`, SCRUM-1161). A bearer secret, never logged |
| `STAFF_ALERT_EMAIL` | No | An address or alias for the same staff alert, sent through Resend (needs `RESEND_API_KEY` and `EMAIL_FROM`; outside production also `EMAIL_ALLOWLIST` or one of our domains). Set either or both |
| `EMAIL_ALLOWLIST` | No | Outside production (`RAILWAY_ENVIRONMENT_NAME` other than `production`, staging and local included) mail goes only to `blendn.app`, `matrixsociallabs.com` and `resend.dev`, plus the exact addresses listed here, comma-separated. Anything else is not sent and reads as not configured (SCRUM-452) |
| `PUBLIC_APPLY_URL` | No | Host for the public apply flow, e.g. `https://organizers.blendn.app`. Only the apply/confirm emails follow it — invite, approval and domain links stay on `NEXTAUTH_URL` because they need a session. Unset, everything uses `NEXTAUTH_URL` |
| `EMAIL_FOOTER_ADDRESS` | No | Registered office, shown in the email footer. Omitted entirely when unset — a made-up address in a compliance footer is worse than none. Set it before any bulk sending |
| `CRON_SECRET` | Yes | Bearer token for `/api/cron/*`. The endpoint rejects everything when unset |
| `SEED_PASSWORD` | Staging only | Password for the dashboard test accounts, set on every deploy by `scripts/test-accounts.ts`. Never on production — the step refuses there anyway |
| `REDIS_URL` | With more than one replica | Shares rate limits (and the match deck's exposure counts) across replicas. Set but down, both count in memory at once; nothing waits on Redis (SCRUM-1217). Set but stalled with the socket open, a command waits at most 500 ms, then that store leaves Redis alone for 5 s (SCRUM-1378). It no longer attaches the Socket.io adapter: that is `SOCKET_REDIS_ADAPTER` |
| `SOCKET_REDIS_ADAPTER` | With more than one replica | `1` attaches the Socket.io Redis adapter. Leave unset at one replica: with it every `fetchSockets` asks Redis first, so a Redis restart freezes room delivery. A second replica also needs sticky sessions (the long-polling fallback) and one owner of the `opsTimers` loop (lib/socket-server.ts). Without the adapter a Go Live's end evicts sockets only on the replica that ran it (the per-emit filter still keeps the room from reaching them) |
| `TICKETING` | No | `true` turns on ticket selling (holds, orders) and recording the organizer ticketing terms (`ticketingOn`, lib/env.ts). Unset or `false`: off, and nothing reserves a ticket or records an acceptance. Expired holds are released either way. Since Phase 2 (SCRUM-1011) it also opens the mobile ticket routes, the pay page and the ticket reconcile job; off, they are 404s and the job never starts |
| `TICKET_QR_KEY` | When `TICKETING` is on | 32+ characters (`openssl rand -hex 32`), different per environment. Signs each ticket's QR as `<ticket id>.<HMAC-SHA256(key, ticket id)>`, derived on demand and stored nowhere (`ticketQrPayload` / `verifyTicketQr`, lib/tickets.ts), so a reinstalled phone gets the same QR back. Boot refuses `TICKETING=true` without it. Rotating it invalidates every QR already shown; door codes are unaffected |
| `TICKET_PAY_KEY` | When `TICKETING` is on | 32+ characters (`openssl rand -hex 32`), different per environment and different from `TICKET_QR_KEY`. Signs the pay link's 15-minute token, bound to the order and its buyer (lib/ticket-pay-token.ts): the in-app browser has no JWT. Boot refuses `TICKETING=true` without it. Rotating it only invalidates open pay links |
| `PAY_BASE_URL` | No | The origin pay links are built on (`<PAY_BASE_URL>/pay/o/<orderId>?t=…`): `https://pay.blendn.app` once its DNS points at this service (owner action), the service's own host before that. Unset: `NEXTAUTH_URL`. Apple Pay through Razorpay needs this domain verified with Razorpay |
| `PLUS_GATING` | No | Where Blendn+ is gated and since when: comma-separated `<city>:<YYYY-MM-DD>` (the day gating goes on, midnight IST), `*:<date>` for everywhere; a city without a date is gated with no trial; `true` = everywhere, no trial. Cities match through one alias map (`Bangalore` is Bengaluru); a place with no city is gated once anything is. Unset or `false`: launch season everywhere. Setting it is the whole switch: the trial (accounts that existed and came out in the 90 days before the date) is granted by the server at their first gate (docs/IAP-SETUP.md) |
| `REVENUECAT_WEBHOOK_SECRET` | For Blendn+ | 32+ characters, chosen by us (`openssl rand -hex 32`). The RevenueCat webhook's Authorization header is `Bearer <this>`. Unset: the webhook refuses everything and no store purchase grants Blendn+. Production grants only PRODUCTION purchases, every other environment only SANDBOX ones (`RAILWAY_ENVIRONMENT_NAME`). Setup: docs/IAP-SETUP.md |
| `REVENUECAT_SECRET_KEY` | For Blendn+ transfers | RevenueCat's secret API key (`sk_…`). A `TRANSFER` moves only what RevenueCat's own record of the receiving account confirms; unset, transfers move nothing (`unreconciled`) — fail closed. Also deletes an erased account at RevenueCat. Never in the app |
| `APPLE_TEAM_ID` | For Apple account deletion | The 10-character Team ID. With `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY`, deleting an Apple-linked account revokes its Sign in with Apple grant (App Store 5.1.1(v)). Any of the three unset: the account is still deleted, and the skipped revoke is logged and audited (`account.apple_revoke`) |
| `APPLE_KEY_ID` | For Apple account deletion | The Key ID of a key with **Sign in with Apple** enabled (developer.apple.com → Certificates, IDs & Profiles → Keys), configured for the app's primary App ID |
| `APPLE_PRIVATE_KEY` | For Apple account deletion | That key's `.p8` file contents, `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----`. Newlines may be pasted as literal `\n`. A secret: never in the app, never logged |
| `APPLE_BUNDLE_ID` | No | The Sign in with Apple client id, which is the app's bundle id. Default `com.matryxsociallabs.blendn`. Also the audience Apple identity tokens are checked against |
| `REVIEW_ACCOUNT_IDS` | No (App Review aid) | Comma-separated **user ids** (not emails) of App Review accounts. OFF when unset. See § 7 "App Review aid" |
| `SHARE_PROXY_SECRET` | For public share pages | 32+ characters, chosen by us (`openssl rand -hex 32`); the SAME value as the landing site's Vercel env var of that name (Preview and Production). The landing sends it as `x-share-proxy` on its server-to-server calls to `GET /api/public/share/*`; holding it makes the forwarded `x-share-client` address believed, so the 120/min limit counts the visitor. Unset (do not create the variable): the endpoint still works, every caller is limited by its own address, and the landing's shared Vercel egress will hit the limit under traffic. **Set but empty or under 32 characters, `validateEnv` fails and production does not boot.** Not set by an agent: the owner sets it on Railway staging and production |
| `PUBLIC_SITE_ORIGIN` | No (staging: yes) | The public site every server-built link points at: the dashboard's door QR and event link, friend and crew invite links, the mails' "Visit Blend’n" links. A bare https origin, no path or trailing slash. Unset = `https://www.blendn.app`. **Staging: `https://staging.blendn.app`**, so staging hands out staging links. **Production: leave unset** (or exactly `https://www.blendn.app`); anything else fails `validateEnv` there. Not a secret. Fixed on purpose: the privacy policy link, the mail logo images, CORS (the landing reads the API server to server) |
| `SENTRY_AUTH_TOKEN` | No | Source map upload at build time |
| `NEXT_PUBLIC_SENTRY_DSN` | No | Error reporting. Sentry is disabled if unset |
| `PORT` | No | Server port (Railway sets this) |
| `NODE_ENV` | No | Set to "production" by Railway |

## Health Check

The deployment includes a health check endpoint:

```
GET /api/health
```

Returns:
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "service": "blendn-admin",
  "version": "0.1.0",
  "database": "connected",
  "pool": { "total": 6, "idle": 5, "waiting": 0 },
  "eventLoopDelayMs": { "p50": 10, "p99": 12, "max": 14 },
  "sockets": 42
}
```

`pool`, `eventLoopDelayMs` and `sockets` are counts about this process (SCRUM-1221), present only with `Authorization: Bearer $HEALTH_METRICS_TOKEN` (or anywhere but Railway production while the token is unset); the monitor that alerts on them must send that header. `pool` is `null` before the first query; `sockets` is `null` where Socket.io is not attached. `eventLoopDelayMs` is the last full minute, rotated inside the process and never reset by a read (the endpoint is public), `null` for the first minute; the 10 ms resolution of `monitorEventLoopDelay` is its floor. A rising `eventLoopDelayMs.p99` is the one process saturating, and `pool.waiting` above 0 is requests queued for a connection; the alert thresholds are kept with the other monitor settings ([Operating production](#operating-production), Monitoring).

## Troubleshooting

### Database Connection Issues
1. Check `DATABASE_URL` is correct
2. Ensure database allows Railway's IP range
3. Check Railway logs: `railway logs`

### Build Failures
1. Check Node.js version (requires 20+)
2. Run `npm ci` locally to verify dependencies
3. Check for TypeScript errors: `npm run lint`

### Socket.io Not Working
1. Ensure WebSocket connections are allowed
2. Check CORS configuration in `next.config.ts`
3. Verify client is connecting to correct URL

## Local Development

```bash
# Install dependencies
npm install

# Generate Prisma client
npm run db:generate

# Run development server (with Socket.io)
npm run dev

# Build for production
npm run build

# Start production server locally
npm start
```

## Operating production

What to do when production breaks. One replica, no over-the-air updates, and a
rollback that never touches the schema.

**Who.** The owner, and the on-call person. Who is on call, how to reach them,
how alerts reach them and the response targets are in the password manager note
"Blendn on-call", never in git.

**Severity.**
- **S1:** the API or sign-in is down, or data is exposed or lost. Call the owner at once.
- **S2:** one feature is broken for many people.
- **S3:** the rest, and anything on staging. A Jira ticket.

**First steps in an S1.** Open a Jira ticket in project SCRUM, label
`incident`, and keep the timeline in it. Consoles: railway.com (project Blendn,
service Blendn-Admin, environment production) and Sentry (project
`blendn-admin`; the address is in the password manager note). For
the CLI, once, in a clone of `Matryx-Social-Labs/Blendn-Admin`:
`railway link --project Blendn --environment production --service Blendn-Admin`.
Do step 1, then the first of steps 2 to 6 that matches.
1. **Look.** `curl -s -m 10 https://api.blendn.app/api/health` (200 and `"database":"connected"` is up;
   503 is up with the database unreachable: open the Postgres service in the console;
   a timeout is down) and `curl -s -m 10 -o /dev/null -w '%{http_code}\n' https://dashboard.blendn.app/login` (200).
   `railway deployment list` shows the deployments and their times;
   `railway logs --deployment --lines 200` (a flag, no value) shows the running one.
   Logs can hold personal data: quote the error, never paste lines into the ticket or a reply.
2. **Data exposed.** Call the owner. Contain it: revoke an exposed credential where it
   was issued; for a leaking route the owner decides whether to take the service down.
   Do not restart or redeploy before the logs are read (a restart loses the process's
   state). Whether anyone must be notified is the owner's call.
3. **Crashed or hung.** The console shows the deployment Crashed (Railway restarts a crash
   at most 3 times, then leaves it down), or health times out while it shows Active
   (Railway does not restart that: its healthcheck runs only during a deploy). Restart:
   `railway restart --yes`, or Restart in the console. It does not rebuild.
4. **The last deploy caused it** (the outage began within an hour of the newest
   SUCCESS deployment). Roll back: in the console, Deployments, the previous SUCCESS
   deployment, its ⋮ menu, Redeploy (`railway redeploy` can only repeat the newest).
   An S1 skips the live-room check below. If that deployment's commit carried a
   migration, the schema stays: never hand-revert it, forward-fix in a new migration
   ([A migration is additive for one release](#a-migration-is-additive-for-one-release)).
   If the redeploy's pre-deploy step fails, or health is not 200 within 15 minutes,
   stop and call the owner.
5. **A client build caused it.** Ship a fixed build (Hotfix path, below). Only once it is
   live in both stores, retire the bad one (console: Blendn-Admin, production, Variables;
   checked twice; saving redeploys): `MOBILE_MIN_APP_VERSION` (a version like `1.0.3`)
   if the fix has a higher version, else `MOBILE_MIN_APP_BUILD_IOS` / `_ANDROID` (the
   store build number). Older builds then get 426 "update required"; a build that sends
   no version or build header is never refused (`docs/API.md`, Update required).
6. **Data lost.** Change nothing more and call the owner.

**Comms.** The app cannot show a message without the API. In an S1, reply to
store reviews that report it (App Store Connect, Ratings and Reviews;
Play Console, Reviews; logins in the password manager) and put the same text at the
top of www.blendn.app (no banner switch exists: a commit to `main` in the
BlendnLanding repo, which deploys itself; revert it after):

> Blend'n is having trouble right now: <what people see>.
> We are working on it<, and expect it back by <time>, India time>.
> <Only once checked: nothing you posted is lost. Otherwise: we are checking what was affected.>

After an S1, the post-incident note on the ticket: **what** happened, **when**
(started, noticed, fixed), **why**, and **the check that would have caught it**.

**One replica.** Production runs one process (`.railway/railway.ts`, one
replica in `asia-southeast1-eqsg3a`). Polling clients, the ops broadcast loop and the sweepers are not
safe on two: there is no shared Socket.io adapter, so a second process splits a
room. A crash is restarted at most 3 times (`restartPolicyMaxRetries: 3`, applied to
both environments on 2026-11-25), then the service stays down until someone acts. A deploy must
not be two processes either: `.railway/railway.ts` sets `overlapSeconds: 0` (the
old process stops when the new one is healthy) and `drainingSeconds: 15` (15 s from
SIGTERM to SIGKILL, over `server.ts`'s own 10 s force-exit, so the shutdown gets to
flush, close the pool and print "Socket.io closed" and "HTTP server closed"). **Those
two are not applied yet:** the file reaches Railway only through `railway config
apply` ([The deploy settings are on the Railway service](#the-deploy-settings-are-on-the-railway-service));
staging after 2026-11-29, production with the production promotion. Until then
Railway's default, 0 s of draining, kills the old process at once. So: **no deploy
or promotion while a room is live** (an S1 rollback excepted). Before one, open
`railway connect Postgres` for that environment, run
`SET default_transaction_read_only = on;`, then this; both must be 0:

```sql
SELECT count(DISTINCT o.id) FILTER (WHERE e.kind = 'event') AS live_events, count(c.id) FILTER (WHERE c.status = 'checked_in' AND (c.expires_at IS NULL OR c.expires_at > now())) AS checked_in_now FROM event_occurrences o JOIN events e ON e.id = o.event_id LEFT JOIN event_check_ins c ON c.occurrence_id = o.id WHERE o.cancelled_at IS NULL AND e.deleted_at IS NULL AND e.status <> 'draft' AND now() BETWEEN o.start_time - interval '90 minutes' AND o.end_time;
```

(Live is from doors, 90 minutes before the start, to the end. A venue day is open
all day, so it counts only through the people checked in. The room's 24 hours of
chat after the end are not gated: a deploy then costs a reconnect, not a night.)

**Pool budget.** Processes × `DATABASE_POOL_MAX` (default 20, `lib/db.ts`) stays
under 80% of `SHOW max_connections`. Read 2026-11-26: production 500, staging 500,
so the ceiling is 400 and one replica uses 20.

**Hotfix path for 1.0.** There are no over-the-air updates (the app has no
`expo-updates`). A client defect is fixed by a new store build (the client repo's
`docs/RELEASING.md`; the owner holds the store accounts): Apple, request an
expedited review in App Store Connect; Play has no expedited review, submit to the
production track. Then retire the bad build once the fix is live (step 5). A server defect is a
normal merge and promotion, or the rollback above.

**Monitoring.** Sentry, project `blendn-admin`. The app reports errors and
traces only with `NEXT_PUBLIC_SENTRY_DSN` set, tagged with the Railway
environment (`RAILWAY_ENVIRONMENT_NAME`, `sentry.server.config.ts`), so an alert
that names `staging` is not a production incident. Uptime checks, metric
monitors and the alert rules that email the team live in the Sentry console
(Alerts, Monitors), not in this repo; which are on, their ids and their
thresholds are kept in the ops Jira tickets, not here. After a deploy: step 1's
two `curl`s, then the project's Issues filtered to that environment show nothing
new since the deploy.

Railway's own graphs (CPU, memory, HTTP) are on the service's Metrics tab;
`/api/health` reports the pool, event-loop delay and sockets only to a request with
the `HEALTH_METRICS_TOKEN` header (see Health Check, above).
