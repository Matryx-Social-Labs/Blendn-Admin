# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Next.js 15 (App Router) web admin dashboard + REST API backend for **Blendn**, an event networking app. Serves two distinct clients from one codebase:

- **Dashboard** (`app/dashboard/*`) — NextAuth session-authenticated UI for `app_admin`, `organizer`, and `venue_owner` roles.
- **Mobile API** (`app/api/mobile/*`) — JWT-authenticated REST API consumed by the Expo React Native app (separate repo, `blendn/`).

Both surfaces share one PostgreSQL database via Prisma.

## Testing and review — read this first

`docs/TESTING-PLAYBOOK.md` is the chain every page, path and fix goes through:
the design chain (`ecc dashboard-builder` → `ecc frontend-design-direction` →
`/design-html`), driving the screen in a browser and measuring it, the six gates,
the specialist fan-out (coverage EVERY time, plus schema, latency, API, security,
comment-rot, a11y by trigger), how to brief a specialist so it returns findings
rather than advice, and the local loop.

It is not a menu. The expensive failures on this project have all been one shape
— a check that was available and was not run — and the playbook's last section
lists what each check has already caught.

**The chain in §1 is gated.** Do not edit a file under `app/`, `components/` or
`lib/` for a screen until steps 1, 2 and 3 have produced their artefacts, and
state those artefacts in the response before the first edit:

```
Screen: /dashboard/<x>
1 · Questions:  1. …  2. …  3. …    Cutting: … because …
2 · Direction:  purpose · audience · tone · memorable detail · constraints
3 · Mockup:     <path>  (or: skipped — copy-only change, no layout effect)
```

An earlier version of §3 said `/design-html` was "only for a NEW composition".
That clause was used to skip it every time, because any change can be argued
not-new-enough. It is now a test with no judgement in it — see §1.

**And a second gate, before calling anything done.** A flow is not tested until
it has been driven end to end on the surface a real person uses, and the row it
should have written has been read back. State it:

```
8 · Driven:     <maestro flow + result, iOS>  |  <same flow, Android>  |  <dashboard journey driven>
    Read back:  <the SELECT, and what it returned>
    Or:         not driven — <the specific reason>, and the ticket stays open
```

Green unit, integration and a screenshot are not that. Every defect this project
has shipped passed all three — the interest graph nobody wrote, the preference
that stored `true` when somebody said no, the push token that survived sign-out.
Each was caught by driving the product and reading the database. See §8.

## Common Commands

```bash
npm install
npm run db:generate         # Generate Prisma client (required after install/schema changes)
npm run dev                 # Dev server via custom server.ts (Next.js + Socket.io), port 3000
npm run dev:next            # Plain `next dev`, no Socket.io — only for UI-only work
npm run build               # next build + compile server.ts (build:server)
npm run start               # Run compiled dist/server.js (production)
npm run lint                # ESLint
npm test                    # Jest
npm run test:watch          # Jest watch mode
npx jest __tests__/spam-detector.test.ts   # Run a single test file
npm run db:push             # Schema without a migration. NOT equivalent to db:migrate — see below
npm run db:migrate          # Apply migrations. Use this to build a local database
npm run db:migrate          # Apply migrations (prisma migrate deploy)
npm run db:seed             # Seed database
```

Use `npm run dev`, not `dev:next`, when working on anything touching chat/sockets — `server.ts` is the actual entrypoint that wires up Socket.io and is also what runs in production.

## Architecture

### Custom server entrypoint

`server.ts` creates a raw HTTP server, wraps the Next.js request handler, and attaches Socket.io (`lib/socket-server.ts`) to the same server instance. In production it validates `DATABASE_URL`, `NEXTAUTH_SECRET`, `MOBILE_JWT_SECRET` are set before binding, and binds to `0.0.0.0` (Railway requirement — `HOSTNAME` env var is the container name, not a bind address).

### Two auth systems, one middleware

`middleware.ts` branches request handling by path prefix:

- `/api/mobile/v1/*` is rewritten to `/api/mobile/*` (version stripping) and tagged with `X-API-Version`.
- `/api/mobile/*` gets CORS headers applied (allowed origins: `api.blendn.app`, `blendn.app`, `NEXTAUTH_URL`) and short-circuits `OPTIONS` preflight.
- `/dashboard/*` requires a NextAuth session token; users with `role === "attendee"` are redirected away (attendees are mobile-only, never get dashboard access).
- `/` and `/login` redirect already-authenticated non-attendee users straight to `/dashboard`.

Dashboard auth: `lib/auth.ts` (NextAuth). Mobile auth: `lib/mobile-auth.ts` — separate JWT scheme with 15-min access tokens, 30-day refresh tokens (rotated, tracked in `mobile_refresh_tokens`), Google OAuth token verification, bcrypt password hashing. Don't conflate the two — mobile endpoints never read the NextAuth session, and dashboard pages never read the mobile JWT.

### RBAC

Authorization logic is centralized in `lib/rbac.ts` as plain functions, not middleware-based. Apply these checks inside route handlers, not just at the middleware layer.

**Authorization is organisation-shaped, not identity-shaped.** Scope on organisation membership (`organizer_org_id`, `venue.owner_org_id`), never on `events.organizer_id`. `organizer_id` records who *created* the row, which is a different question and is useful only for audit: a colleague at the same org must get the same access, and a member who left must lose it. `venues.owner_id` has no writer at all — always use `owner_org_id`.

The API:

| Function | Answers |
|---|---|
| `eventPermissions(actor, event)` | `{ canEdit, canOperate }` for one event. The main resolver. `canEdit` = edit/publish/cancel. `canOperate` = chat, moderation, the attendee list. |
| `eventPermissionSelect` | The `select` fragment `eventPermissions` needs. Spread it rather than hand-picking columns; a select missing `venue` reads as "no venue" and silently denies a venue owner. |
| `canBroadcast(actor, event, kind, maySponsor)` | Who may put a non-user message in a room. |
| `broadcastMayCarryMedia(kind)` | Whether a broadcast kind may carry an image. |
| `canAccessDashboard(role)` | Dashboard entry. Read by `middleware.ts`. |

Build the actor with `actorFor(user)` from `lib/org-membership.ts` — it loads memberships, and `PermissionActor.orgIds` is required precisely so a bare session user cannot typecheck into the resolver and silently deny everyone.

Mobile routes must read the role from the database, not the JWT: the token carries no role, and a 30-day refresh cycle would outlive any role change baked into it.

`__tests__/authz-scoping-boundary.test.ts` fails the build on a hand-rolled `organizer_id !==` or `owner_id:` outside the resolver. If it fires, you want `eventPermissions`.

Historical note, because this paragraph used to say otherwise: `canManageEvent` and `canModerateChat` were **deleted** and replaced by `eventPermissions`. `canSendSystemMessages` and `canSendPushNotifications` still exist and currently have no callers.

### Moderation pipeline

`lib/moderation/` runs message content through multiple checks before a chat message is persisted or socket-emitted: `keyword-filter.ts` (deterministic banned-word matching), `spam-detector.ts`, `openai-moderation.ts` (OpenAI moderation API), orchestrated by `actions.ts`/`index.ts`. Moderation must complete and pass *before* the message is broadcast over Socket.io — emitting first and moderating after creates a window where flagged content is briefly visible to other users (this was a real bug; see recent git history). `moderation_flags` table records flagged content for audit/admin review.

### Real-time (Socket.io)

`lib/socket-server.ts` initializes Socket.io on the shared HTTP server. Rooms are scoped per event/conversation. Handles group chat (`chat_groups`/`chat_messages`), private DMs (`private_conversations`/`private_messages`), typing indicators, check-in/check-out, and presence. See `docs/SOCKET_EVENTS.md` for the event catalog and `docs/chat-moderation.md` / `docs/client-chat-moderation-guide.md` for how moderation integrates with the socket flow from the client's perspective.

### Mobile API conventions

Mobile-facing routes live under `app/api/mobile/*` and follow a consistent shape: JWT auth via `lib/mobile-auth.ts`, responses normalized through `lib/api-response.ts`, pagination via `lib/pagination.ts`. OpenAPI spec generation lives in `lib/openapi/`; served at `app/api/docs` and `app/api-docs` (Swagger UI). When adding or changing a mobile endpoint, update the OpenAPI schema and `docs/API.md` together — both are checked into the repo and expected to stay in sync with actual route behavior.

### File uploads

S3-compatible storage via Tigris (`lib/tigris.ts`, uses AWS S3 SDK against a Tigris endpoint). `ensureBucketExists()` runs at server startup to guarantee the bucket exists with a public-read policy. Presigned upload URLs are issued through `app/api/mobile/uploads/presigned-url`; `lib/media-response.ts` shapes media objects returned to clients.

### Audit logging

Admin actions (role changes, moderation overrides, etc.) are recorded via `lib/audit-log.ts` into `audit_logs`. Use this rather than ad-hoc logging when an admin/organizer action changes state that matters for accountability.

## Database

Prisma schema: `prisma/schema.prisma`. Key models: `User`/`profiles` (NextAuth user vs. extended profile — two separate models, joined), `events`/`event_details`/`recurring_events`, `event_check_ins` (GPS-validated), `chat_groups`/`chat_messages`/`chat_group_members`/`message_reactions`, `private_conversations`/`private_messages`, `event_rsvps`/`event_favorites`/`event_ratings`/`event_reports`, `moderation_flags`, `blocked_users`/`message_requests`, `push_tokens`, `mobile_refresh_tokens`, `audit_logs`.

When changing the schema: run `npm run db:generate` after editing
`schema.prisma`, use `db:push` for local iteration, and a real migration
(`prisma migrate dev` then `db:migrate` for deploy) for anything going to a
shared environment.

**But build your local database with `db:migrate`, not `db:push`.** They do not
produce the same schema, and the difference is silent. `schema.prisma` cannot
express a CHECK constraint, so `db push` creates none — while three exist in
migration SQL and therefore in every deployed environment:

| Constraint | What it enforces |
|---|---|
| `event_claims_one_claimant` | `(org_id IS NULL) <> (onboarding_id IS NULL)` |
| `events_capacity_non_negative` | `current_capacity >= 0` |
| `sponsored_active_needs_sponsor` | an active placement has a sponsor |

A `db push` database is therefore **strictly weaker than production**, and code
tested against one can write rows the real database rejects. That is not
hypothetical: `scripts/seed-qa.ts` created event claims with neither `org_id`
nor `onboarding_id` and passed locally for as long as it existed, because the
constraint that forbids it was never there. CI caught it the day that lane
switched to `migrate deploy`.

It also means a schema comparison by columns alone proves less than it appears
to — `information_schema.columns` matched exactly between the two while all
three constraints were missing.

## Environment Variables

Required: `DATABASE_URL`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET` (32+ chars), `MOBILE_JWT_SECRET` (32+ chars).

Optional: Tigris object storage (`TIGRIS_ENDPOINT`, `TIGRIS_ACCESS_KEY`, `TIGRIS_SECRET_KEY`, `TIGRIS_BUCKET`, `TIGRIS_REGION`), Google OAuth client IDs (`GOOGLE_WEB_CLIENT_ID`, `GOOGLE_IOS_CLIENT_ID`, `GOOGLE_ANDROID_CLIENT_ID`), `OPENAI_API_KEY`, `REDIS_URL`, `NEXT_PUBLIC_SENTRY_DSN`.

**The storage vars are `TIGRIS_*`, not `AWS_*`.** This file said `AWS_ACCESS_KEY_ID` / `AWS_S3_BUCKET`, and `lib/tigris.ts` has only ever read `TIGRIS_*` — so a deployment configured from these instructions got uploads silently switched off, with no error anywhere. `DEPLOYMENT.md` and `lib/env.ts` were corrected; this file was not, and it is the one an agent reads first.

`lib/env.ts` centralizes env var access — prefer it over raw `process.env` reads in new code, and it is the authority on names when a doc disagrees.

## Deployment

Deployed to Railway via Docker (see `DEPLOYMENT.md` and `railway.json`/`nixpacks.toml`). Health check at `GET /api/health`. Production startup fails fast if required env vars are missing (checked in `server.ts` before the HTTP server binds).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
