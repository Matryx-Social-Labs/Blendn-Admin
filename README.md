# Blendn Admin

Web admin dashboard and REST/realtime API for **Blendn**, an event networking app.
Users find events nearby, check in with GPS at the venue, and meet the other
people who are actually in the room — pseudonymous group chat first, direct
messages once both sides agree.

One Next.js 15 app serves two very different clients:

| Surface | Path | Auth | Consumer |
|---|---|---|---|
| Dashboard | `app/dashboard/*` | NextAuth session | `app_admin`, `organizer`, `venue_owner` |
| Mobile API | `app/api/mobile/*` | JWT (15 min access, 30 day refresh) | The Expo app (separate repo) |

Attendees never reach the dashboard; `middleware.ts` redirects them out.

## Quick start

```bash
npm install
cp .env.example .env        # then fill in the required values
npm run db:generate         # required after install and after schema edits
npm run db:push             # local schema sync
npm run dev                 # http://localhost:3000
```

Use `npm run dev`, not `dev:next`. `server.ts` is the real entrypoint — it wires
up Socket.io alongside the Next handler and is what runs in production.
`dev:next` gives you the UI with no realtime.

## Commands

```bash
npm run dev          # Next.js + Socket.io via server.ts
npm run build        # next build + compile server.ts
npm start            # run the compiled dist/server.js
npm test             # Jest
npm run lint         # ESLint
npm run db:migrate   # apply migrations (shared environments)
npm run db:seed      # seed data
```

Run a single test file: `npx jest __tests__/socket-auth.test.ts`

## How the product works

1. **Check in** (`app/api/mobile/events/[eventId]/checkin`) is the gate everything
   hangs off. It validates that today's session is running and that you are
   inside its geofence, with GPS accuracy folded into the distance test rather
   than used as a separate pass/fail. **It does not refuse at capacity** — the
   fence covers the queue outside, and turning away someone standing at the door
   would deny them the chatroom and erase them from attendance. Occupancy is
   counted from check-in rows, never stored. See `docs/CHECKIN.md`.
2. **You join the event chat automatically**, under a generated anonymous name
   (`Cosmic Panda`). Group chat is pseudonymous by design.
3. **You can only be checked into one event at a time.** Checking into another
   checks you out of the first and closes your chat write access there.
   While you are checked in the app pings `…/presence`, so leaving the venue
   eventually checks you out instead of leaving you counted for ever.
4. **Match** shows the other people currently checked into your event, ranked by
   shared interests.
5. **DMs are gated** behind a message request the other person has to accept.

## Architecture

- **`server.ts`** — raw HTTP server wrapping the Next handler with Socket.io
  attached. Validates required env vars before binding and binds `0.0.0.0` in
  production (Railway sets `HOSTNAME` to the container name, not a bind address).
- **`middleware.ts`** — branches by path: version rewriting and CORS for
  `/api/mobile/*`, session and role checks for `/dashboard/*`. When
  `DASHBOARD_HOST` and `API_HOST` are both set it also serves each surface on
  its own hostname — `/dashboard` and `/login` **redirect** to the dashboard
  host (people follow links, including our own emails), while `/api/mobile` on
  the dashboard host **404s** (a misconfigured client, not a bookmark).
- **Two auth systems.** `lib/auth.ts` (NextAuth, dashboard) and
  `lib/mobile-auth.ts` (JWT, mobile). They do not overlap — mobile routes never
  read the session, dashboard pages never read the JWT.
- **`lib/rbac.ts`** — authorization as plain functions over the `user_role` enum,
  applied inside route handlers rather than at the middleware layer.
- **`lib/socket-server.ts` + `lib/socket-auth.ts`** — realtime. A valid JWT gets
  you a connection, not a room: every `join:*` is checked against the database.
  See `docs/SOCKET_EVENTS.md`.
- **`lib/moderation/`** — keyword filter, then OpenAI text and image moderation.
  Text is checked before broadcast with a 1s timeout; on timeout the message
  goes out and moderation continues asynchronously, hiding it if needed.
- **`lib/tigris.ts`** — S3-compatible object storage. Uploads are silently
  disabled if the `TIGRIS_*` vars are unset.

## Configuration

Every variable is documented in `.env.example`; `lib/env.ts` is the validated
schema. Production fails to boot on a missing or malformed required value, so
misconfiguration surfaces as a failed deploy rather than a broken runtime.

Two that fail quietly and are worth checking in a new environment:

- **`OPENAI_API_KEY`** unset — moderation silently degrades to keyword matching.
- **`TIGRIS_*`** unset — uploads return 503.

## Testing

```bash
npm test                  # unit; mocks lib/db, no database needed
npm run test:integration  # real Postgres, real route handlers
```

The unit suite mocks `lib/db`, which means it cannot tell a working route from
one that throws — a boundary bug reached production that way. The integration
suite exists to close that: it drives real handlers against a real database,
including check-in, which is the mechanic everything else hangs off.

Run it against a throwaway Postgres:

```bash
docker run -d --name blendn-test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=t -p 55432:5432 postgres:16
DATABASE_URL=postgresql://postgres:test@localhost:55432/t npx prisma db push
DATABASE_URL=postgresql://postgres:test@localhost:55432/t npm run test:integration
```

## Docs

| File | Contents |
|---|---|
| `docs/API.md` | REST endpoint reference |
| `docs/SOCKET_EVENTS.md` | Socket.io event catalog and room authorization |
| `docs/chat-moderation.md` | Moderation pipeline and thresholds |
| `docs/VENUES.md` | Venues, claims, geofencing, and how events link to a venue |
| `docs/CHECKIN.md` | Check-in, occupancy, attendance, presence and multi-day events |
| `docs/LEADS.md` | Demo-request ingest from the organiser landing page, and the inbox |
| `docs/ORGANISATIONS.md` | Organisations, membership, and how permissions resolve |
| `docs/ROADMAP.md` | Claimed-but-not-built, known product gaps, open decisions |
| `DEPLOYMENT.md` | Railway deployment and environment variables |
| `CHANGELOG.md` | Release history |

## Deployment

Railway via Docker. Health check at `GET /api/health`. Branches: `dev` →
`stage` (internal testing) → `prod`. CI runs lint, typecheck, tests, and build
on all three.
