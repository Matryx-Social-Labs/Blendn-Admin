# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Next.js 15 (App Router) web admin dashboard + REST API backend for **Blendn**, an event networking app. Serves two distinct clients from one codebase:

- **Dashboard** (`app/dashboard/*`) — NextAuth session-authenticated UI for `app_admin`, `organizer`, and `venue_owner` roles.
- **Mobile API** (`app/api/mobile/*`) — JWT-authenticated REST API consumed by the Expo React Native app (separate repo, `blendn/`).

Both surfaces share one PostgreSQL database via Prisma.

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
npm run db:push             # Push schema changes to DB without a migration (dev only)
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

Authorization logic is centralized in `lib/rbac.ts` as plain functions over a `user_role` enum (`app_admin`, `organizer`, `venue_owner`, `attendee`), not middleware-based: `canAccessDashboard`, `canManageEvent`, `canModerateChat`, `canSendSystemMessages`, `canSendPushNotifications`. `app_admin` always passes; `organizer`/`venue_owner` checks are scoped to resources they own (matched by `organizerId`). Apply these checks inside route handlers, not just at the middleware layer.

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

When changing the schema: run `npm run db:generate` after editing `schema.prisma`, use `db:push` for local iteration, and a real migration (`prisma migrate dev` then `db:migrate` for deploy) for anything going to a shared environment.

## Environment Variables

Required: `DATABASE_URL`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET` (32+ chars), `MOBILE_JWT_SECRET` (32+ chars). Optional: AWS/Tigris S3 vars (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_BUCKET`), Google OAuth client IDs (`GOOGLE_WEB_CLIENT_ID`, `GOOGLE_IOS_CLIENT_ID`, `GOOGLE_ANDROID_CLIENT_ID`). `lib/env.ts` centralizes env var access — prefer it over raw `process.env` reads in new code.

## Deployment

Deployed to Railway via Docker (see `DEPLOYMENT.md` and `railway.json`/`nixpacks.toml`). Health check at `GET /api/health`. Production startup fails fast if required env vars are missing (checked in `server.ts` before the HTTP server binds).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
