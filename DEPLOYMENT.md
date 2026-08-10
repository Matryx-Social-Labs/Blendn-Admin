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

It also creates an event if none is upcoming. An empty Events tab reads as a
broken app to a reviewer, which is a likelier rejection than anything about
sign-in — and the event now gets its `event_occurrences` rows, without which
**check-in refuses with "Event has already ended"** on an event starting
tomorrow. `occurrence_id` is NOT NULL and `resolveOccurrence` treats "no
occurrences" as over.

After running it, sanity-check the reviewer's whole path once: sign in, open the
event, check in. It takes a minute and it is the exact sequence a rejection
would come from.

Two constraints on the password, both enforced by the script rather than left to
be discovered:

- At least 12 characters, and it must pass `checkPassword` — the same rule
  signup and password reset enforce.
- **It must not contain `blendn`.** That stem is blocklisted and trailing digits
  are stripped before the check, so `Blendn12345!` is refused.

Put the credentials in **App Store Connect → App Review Information →
Sign-In Information**. Note there that onboarding can be reviewed by creating a
fresh account, since this one is deliberately already onboarded.

### 8. Populate a room — staging only

```bash
SEED_ROOM=yes DATABASE_URL=<staging> npm run seed:room
SEED_ROOM=yes DATABASE_URL=<staging> npm run seed:room -- --clean
```

Matching, the roster, the dating tag, the small-room work-field floor and the
`just_here` damping are all invisible in an empty room, and an empty room is
what every environment has by default. This creates one event running thirty
days with twenty-five people in it, shaped so each of those behaviours shows up
on a screen rather than in a query plan.

`/api/health` is the check that it worked: `matching.status` moves from
`no_signal` to `ok` with a `rankableShare` around 0.8.

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
| `NEXTAUTH_URL` | Yes | Full URL of admin dashboard |
| `NEXTAUTH_SECRET` | Yes | Secret for NextAuth (min 32 chars) |
| `MOBILE_JWT_SECRET` | Yes | Secret for mobile API JWT (min 32 chars) |
| `TIGRIS_ENDPOINT` | No | Tigris S3-compatible endpoint. Uploads are disabled if unset |
| `TIGRIS_ACCESS_KEY` | No | Tigris credentials |
| `TIGRIS_SECRET_KEY` | No | Tigris credentials |
| `TIGRIS_BUCKET` | No | Bucket for uploads (default: blendn-media) |
| `TIGRIS_REGION` | No | Bucket region (default: auto) |
| `OPENAI_API_KEY` | No | AI moderation. Without it, moderation falls back to keyword matching only |
| `RESEND_API_KEY` | No | Transactional email. Without it onboarding and invites still work, but nothing is sent — the dashboard shows the link/password to pass on by hand |
| `EMAIL_FROM` | No | Sender, `"Blend'n" <hello@blendn.app>`. Quote the display name — the apostrophe is legal unquoted per RFC 5322 but quoting is free. Required alongside `RESEND_API_KEY`; email is off unless both are set |
| `PUBLIC_APPLY_URL` | No | Host for the public apply flow, e.g. `https://organizers.blendn.app`. Only the apply/confirm emails follow it — invite, approval and domain links stay on `NEXTAUTH_URL` because they need a session. Unset, everything uses `NEXTAUTH_URL` |
| `EMAIL_FOOTER_ADDRESS` | No | Registered office, shown in the email footer. Omitted entirely when unset — a made-up address in a compliance footer is worse than none. Set it before any bulk sending |
| `CRON_SECRET` | Yes | Bearer token for `/api/cron/*`. The endpoint rejects everything when unset |
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
  "database": "connected"
}
```

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

## Monitoring

Railway provides built-in monitoring:
- CPU/Memory usage
- Request logs
- Error tracking

For advanced monitoring, consider adding:
- Sentry for error tracking
- LogDNA/Papertrail for log aggregation
