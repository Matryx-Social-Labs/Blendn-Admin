# Reference: environment

**Secrets are never written here.** Passwords, DB URLs, JWT secrets and tokens
are referenced by *how to retrieve them*, not by value. Emails and ids are
identifiers, not secrets.

## Targets (staging only — never production)
| Surface | URL |
|---|---|
| Dashboard | `https://staging-dashboard.blendn.app` |
| Mobile API + sockets | `https://staging-api.blendn.app` |

Production (`dashboard.blendn.app` / `api.blendn.app`) is **out of bounds** for
writes; read-only, and only when explicitly required.

## Seed accounts (staging)
Same set as local, seeded by `scripts/seed-qa.ts`. Sign in with the **staging
seed password** (held out-of-band — the session/owner, not this repo).

| Email | Role |
|---|---|
| `sagar.kishore@blendn.app` | app_admin |
| `arjun.rao@blendn.app` | organizer (Nightshift Collective) |
| `fatima.sheikh@blendn.app` | venue_owner |
| `meera.iyer@blendn.app` | sponsor (Blue Tokai) |
| `ananya.b@blendn.app`, `rohan.d@blendn.app`, `sneha.p@blendn.app`, … | attendees |

Resolve ids against the staging DB rather than hardcoding — a reseed changes
them (staging ids are `cmt…`, distinct from local).

## Staging database (read freely; write through the API)
The public connection string is a Railway variable, not a constant:

    railway variables --environment staging --service Postgres --json  → DATABASE_PUBLIC_URL

Query it through the local Docker Postgres client so the URL never lands in
shell history in plaintext — store it in a chmod-600 file and pass by env:

    docker exec -e PGURL="$(cat <secure-file>)" blendn-pg17 sh -c 'psql "$PGURL" -Atc "…"'

Prefer product writes (sign in, drive the flow). Direct writes only for fixtures
the UI cannot make (e.g. a check-in the emulator's dead GPS blocks).

## Local Docker Postgres (integration tests only)
- Container `blendn-pg17`, `postgresql://postgres:postgres@localhost:55433/blendn_test`.
- **Kept persistent**: anonymous data volume + `restart=unless-stopped` (survives
  reboot). Do not `docker rm` it without a dump.
- Integration tests need `MOBILE_JWT_SECRET` (≥32 chars) and `NEXTAUTH_SECRET`
  (≥32 chars) in the env; the config is in `jest.integration.config.ts`.
- Build the schema with `db:migrate`, **not** `db:push` — push omits three CHECK
  constraints that exist in every deployed environment.

## Token / scratch files
Short-lived access tokens (15 min) and the secure DB-URL file live under a
gitignored scratch dir (this session used `/tmp/mflows/`). Re-sign-in via
`POST /api/mobile/auth/signin` when a token expires; vary `X-Forwarded-For` to
avoid the per-network sign-in rate limit.

## Ports
- Metro: `8081` (Android needs `adb reverse tcp:8081 tcp:8081`).
- Local dev server (if used for itests / a local drive): `3100`.
