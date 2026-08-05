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

## Domain Setup for blendn.app

### Recommended Structure

| Subdomain | Service | Purpose |
|-----------|---------|---------|
| `api.blendn.app` | This deployment | Admin dashboard + API |
| `blendn.app` | Landing page | Marketing site (optional) |

### DNS Configuration

```
# In your domain registrar (e.g., Cloudflare, Namecheap)

# Admin/API
api.blendn.app    CNAME    <your-railway-app>.up.railway.app

# Optional: Root domain redirect
blendn.app          A        <landing-page-ip>
```

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
| `EMAIL_FROM` | No | Sender address, e.g. `Blendn <hello@blendn.app>`. Required alongside `RESEND_API_KEY`; email is off unless both are set |
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
