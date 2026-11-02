# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Next.js 16 (App Router) web admin dashboard + REST API backend for **Blendn**, an event networking app. Serves two distinct clients from one codebase:

- **Dashboard** (`app/dashboard/*`) — NextAuth session-authenticated UI for `app_admin`, `organizer`, and `venue_owner` roles.
- **Mobile API** (`app/api/mobile/*`) — JWT-authenticated REST API consumed by the Expo React Native app (separate repo, `blendn/`).

Both surfaces share one PostgreSQL database via Prisma.

## Design and testing — read this first

Two documents, two gates.

`docs/DESIGN-CHAIN.md` is what every dashboard screen goes through before its
implementation files are touched: operator questions and cuts
(`ecc dashboard-builder`), a direction with a per-screen memorable detail
(`ecc frontend-design-direction`), and a mockup on disk (`/design-html`).
`docs/DASHBOARD-REDESIGN-CHECKLIST.md` lists every screen and which have been
through it. **The chain is gated.** Do not edit a file under `app/`,
`components/` or `lib/` for a screen until steps 1, 2 and 3 have produced their
artefacts, and state those artefacts in the response before the first edit:

```
Screen: /dashboard/<x>
1 · Questions:  1. …  2. …  3. …    Cutting: … because …
2 · Direction:  purpose · audience · tone · memorable detail · constraints
3 · Mockup:     <path>  (or: skipped — copy-only change, no layout effect)
```

**Testing sessions start at `docs/agents/TEST-PLAN.md`** — the shared Jira
queue (label `tq`), claims, attendee lanes, the staging world log — and run
through `/tq-setup`, `/tq-next`, `/tq-fix` (`.claude/commands/`).

`docs/TESTING-PLAYBOOK.md` starts once the screen exists: driving it in a
browser and measuring it, the six gates, the specialist fan-out (coverage EVERY
time, plus schema, latency, API, security, comment-rot, a11y by trigger), how to
brief a specialist so it returns findings rather than advice, and the local
loop. It is not a menu. The expensive failures on this project have all been one
shape — a check that was available and was not run — and the playbook's last
section lists what each check has already caught.

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
npm run seed:qa-scale       # Data at scale for the large-data drives (dry run; --apply, --remove, --grant-plus <qa.* email>). Staging or localhost only
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

**A chat room has a kind** (`chat_groups.kind`: `event`, `board_post`, and `crew` / `blend` from step 8) and one owner of that kind. Who may enter — socket join, every `/chat/groups/:id` read and write, typing — is `lib/room-kind.ts` (`roomOwnerDenial`, `roomReadDenialFor`, `mayWriteToRoomFor`): an event's room is today's rule unchanged; any other asks its owner, and a member row alone is never enough. A room's handles are minted in `roomScope(room)` — its event for an event's room (unchanged for installed clients), its own id and kind otherwise — so a handle never resolves in another room. A room that is not an event's is re-asked on every delivery, and a writer that closes its owner empties it (`lib/room-close.ts`). `board_post_id` is ON DELETE RESTRICT: a post with a room is never deleted, only taken off the board. A new reader of `chat_group.event` must decide what it does for a room with none: `__tests__/chat-group-event-readers.test.ts` counts them.

### Countries and cities are data

`markets` and `cities` are the countries and cities Blendn serves; adding one is rows, and code on this path names none (`__tests__/city-catalogue.test.ts` fails if it does). `lib/cities.ts` loads them (`cityCatalogue`, `globalThis`, 60 s) and `cityFor(catalogue, name)` maps any spelling through `match_names`. `lib/browse-scope.ts` is the one rule for which cities' rows a viewer sees: use `viewerCityRule` + `cityRuleWhere` in anything that lists events or places, and put the rule in any cache key, because it differs for a `market_previewers` member. By id, an event's gate is inside `attendeeEventAccess` and the check-in door (`mayOpenEvent`: somebody with a live check-in keeps their access) and a venue's is `mayOpenCity`: a hidden city, and a preview city for anybody but its previewers, is a 404. `__tests__/city-gate-routes.test.ts` makes a new route under `events/[eventId]` or `venues/[venueId]` say which gate it has. A spelling nothing matches ("Toronto Downtown") stays uncatalogued and is shown under Elsewhere: the gate is launch visibility, and an unknown city in a served country must not vanish. A city's state is the lower of its own and its market's. `events.city` stays free text.

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
express a CHECK constraint, so `db push` creates none — while every one below (and
more: `grep -h 'CHECK (' prisma/migrations/*/migration.sql`) exists in migration SQL
and therefore in every deployed environment:

| Constraint | What it enforces |
|---|---|
| `event_claims_one_claimant` | `(org_id IS NULL) <> (onboarding_id IS NULL)` |
| `events_capacity_non_negative` | `current_capacity >= 0` |
| `sponsored_active_needs_sponsor` | an active placement has a sponsor |
| `venues_owner_needs_claimed_at` | an owned venue has a claim date — the claim window every venue-owner read starts from (SCRUM-500) |
| `venues_day_reset_hour_range` | `day_reset_hour BETWEEN 0 AND 23` — when a venue's day starts (venue days) |
| `venues_timezone_known` | `venues.timezone` has the shape of an IANA name (`Area/Location`, or `UTC`) — whether it exists is the app's check |
| `events_venue_day_shape` | a venue day has its venue, is `unlisted` and has no `organizer_org_id` — a hard delete of a venue with days is refused rather than orphaning them, and no org-scoped reader can reach one |
| `chat_groups_one_owner` | a room has exactly the one owner its `kind` names: `event` → `event_id` only, `board_post` → `board_post_id` only, `crew` → `crew_id` only, `blend` → `blend_id` only. Who may enter is `lib/room-kind.ts` |
| `crews_name_length` | a crew name is 2–32 characters (`char_length`, so an emoji is one) |
| `crews_bio_length` | a crew bio is at most 140 characters |
| `crews_tags_max` | at most 3 crew tags (the slugs themselves are `CREW_TAGS`) |
| `crew_invites_not_self` | nobody invites themselves into a crew |
| `crew_likes_one_from` / `crew_likes_one_to` | a crew like is from a crew or one person, to a crew or one person |
| `crew_likes_has_a_crew` | a crew on at least one side — person to person is `event_likes` |
| `crew_likes_not_self` | a crew never likes itself |
| `crew_likes_solo_is_the_liker` | a person's own like is theirs (`from_user_id = liked_by_user_id`) |
| `blends_one_b` | a Blend's side B is a crew or one person (side A is always a crew) |
| `ended_friendships_canonical_pair` | a friendship that ended is stored once, `user1_id < user2_id` in the `C` collation, like `friendships` — read by `lib/room-people.ts` for the 24 h an unfriend keeps the pair apart in rooms |
| `blends_pair_order` | two crews in one order only (`a_crew_id < b_crew_id`, uuid order — no collation), so a pair is one Blend |
| `markets_code_shape` / `markets_currency_shape` | a market is an ISO-shaped country code (two capitals) with an ISO-shaped currency (three) |
| `cities_slug_shape` | a city slug is lower-case words joined by hyphens |
| `cities_timezone_known` | `cities.timezone` has the shape of an IANA name, as `venues_timezone_known` |
| `cities_bounds_order` | `min_lat < max_lat` and `min_lon < max_lon` |
| `cities_centre_in_bounds` | a city's centre is inside its box |
| `cities_licensed_min_age_floor` | a city's licensed-venue age default is never under the 18+ floor |
| `mobile_refresh_tokens_revoked_reason_known` | a refresh token's `revoked_reason` is NULL, `password_reset` or `signout_all` — the two `endPhoneSessions` reasons (`lib/session-end.ts`) the refresh turns into `PASSWORD_RESET` / `SESSION_REVOKED_ELSEWHERE` |
| `markets_ticket_fee_slabs_shape` | a market's service-fee slabs: thresholds and rates the same length, at least one, the first from ticket 1, no NULLs |
| `markets_ticket_fee_slabs_ascending` | slab thresholds strictly ascending, through the IMMUTABLE SQL function `ticket_fee_slabs_ascending` (also `parseFeeSchedule`'s, `lib/ticket-fees.ts`) |
| `markets_ticket_fee_rates_range` | slab rates, tax on the fee and processing are 0–10000 bps; the minimum fee is never negative |
| `markets_ticket_fee_min_when_selling` | a market that is not `off` charges a minimum fee of at least 1 minor unit per paid ticket |
| `events_ticketing_external_needs_url` | an event linking out to tickets has the link |
| `events_external_ticket_url_https` | that link is https with a host and no user name, and at most 2048 characters — the floor under `httpsUrl()` |
| `events_ticketing_native_needs_schedule` | an event selling tickets here has its fee snapshot (`IS NOT NULL` spelled out: `jsonb_typeof(NULL)` would pass) |
| `events_venue_day_not_ticketed` | a venue day is never ticketed |
| `events_ticketing_native_needs_enablement` | a native event was turned on by `enableTicketing` (`lib/ticketing-enable.ts`): it has `ticketing_enabled_at` |
| `events_ticket_fee_rule_with_enabled_at` | `ticket_fee_rule` and `ticketing_enabled_at` are set together: the price rule is decided once, in the database, never by a request |
| `ticket_types_not_oversold` | `sold + held <= quantity` — the last word under `reserveTickets`'s row lock (`lib/ticket-holds.ts`), read there as sold out |
| `ticket_types_price_non_negative` / `ticket_types_counts_non_negative` | a price is ≥ 0 (free is 0); quantity, sold and held are ≥ 0 |
| `ticket_types_max_per_order_range` / `ticket_types_name_length` / `ticket_types_sale_window_order` | 1–100 per order; a name of 1–80 characters after trimming; a sale ends after it starts |
| `ticket_orders_total_is_its_parts` | an order's total is its subtotal plus service fee, tax and processing — or the subtotal alone when the organiser absorbs the fees |
| `ticket_orders_paid_has_payment_ref` | a paid or refunded order has a provider payment ref and a paid time: paid only on the provider's word |
| `ticket_orders_amounts_non_negative` / `ticket_orders_currency_shape` / `ticket_orders_fee_breakdown_object` | no negative amount; an ISO-shaped currency; the breakdown is a JSON object |
| `ticket_orders_total_positive` | `total_minor > 0`: free tickets are RSVP plus capacity and never an order (ticketing decision §4.4) |
| `ticket_order_lines_quantity_positive` / `ticket_order_lines_price_non_negative` | a line holds at least one ticket, at a price ≥ 0 |
| `tickets_door_code_shape` / `tickets_redeemer_needs_time` | a door code is six of `23456789ABCDEFGHJKMNPQRSTVWXYZ` (Crockford base32 less 0 O 1 I L U, `DOOR_CODE_ALPHABET` in `lib/tickets.ts`; unique per event; NOT VALID, so new rows only); who redeemed only with when. No QR column: a QR is `<id>.<HMAC-SHA256(TICKET_QR_KEY, id)>`, derived on demand (`ticketQrPayload`, `verifyTicketQr`) |
| `legal_acceptances_document_key_shape` / `legal_acceptances_version_shape` / `…_ip_length` | a slug document key, a numeric version (`0.1`), a bounded IP |
| `legal_acceptances_ip_truncated` / `legal_acceptances_document_sha256_shape` / `legal_acceptances_user_agent_length` | NOT VALID (the table is append-only, so rows from before stay as written): the IP is a network, `a.b.c.0/24` or `x:y:z::/48` (`truncatedIp`); the sha256 of the exact text shown is present; a user agent is at most 200 code points |
| `organisations_razorpay_account_id_shape` / `organisations_razorpay_active_has_account` | an organisation's Razorpay Route linked account is `acc_` and 14 characters, and an `active` one has its id; `enableTicketing` refuses `payouts_not_connected` unless it is active (`payoutStatus`, SCRUM-1011) |
| `markets_ticket_tax_label_length` | what the buyer quote calls the tax on our fee (`GST` in India) is 1–24 characters |
| `ticket_orders_refund_request_shape` | a refund claim (`refund_requested_at`) and its amount come together, the amount 1 to `total_minor`, only on an order with a payment; a reason ≤ 200 |
| `ticket_orders_refunded_range` / `ticket_orders_refunded_has_refund` | the refunded amount is 0 to `total_minor`; a `refunded` order has Razorpay's refund id, time and an amount ≥ 1 — refunded only on Razorpay's word |
| `ticket_payouts_status_shape` | a payout `pending` or `on_hold` has a linked account, and `on_hold` has Razorpay's transfer id; `no_account` has neither |
| `ticket_payouts_amount_positive` / `…_reversed_range` / `…_currency_shape` / `…_linked_account_shape` | a payout is ≥ 1 minor unit; reversed 0 to its amount; an org debit ≥ 0; ISO currency; `acc_` account |

Nor can it express a partial index, a trigger or a data row, and these exist
only in migration SQL too: `events_one_venue_day_per_day` (one venue day per
venue per local day — `lib/venue-day.ts` recovers a lost race by that name),
`event_check_ins_expires_at_idx`, `event_check_ins_one_open_per_user` (one
open check-in per person — `lib/check-in-core.ts` recovers a lost race by that
name), `crew_members_one_owner` (one owner per
crew), `blends_open_closes_at` (the Blend sweeper's open-only index),
`venues_one_per_source_record` (a seeded venue's dataset record, once),
`cities_one_default_per_market`, the seeded `markets` and `cities` rows (on a
`db push` database the catalogue is empty and every city reads as uncatalogued,
so nothing is hidden or in preview), the
`ticket_orders_pending_expiry` partial index (what the hold sweeper,
`releaseExpiredHolds`, reads), the reconcile job's partial indexes
`ticket_orders_unconfirmed_payment`, `ticket_orders_unconfirmed_refund` and
`ticket_payouts_pending` (`lib/ticket-reconcile.ts`), India's `GST` tax label, the `markets` ticketing rows (India `native`,
Canada `external`: on a `db push` database every market is `off` with no
minimum and no GST), the `legal_acceptances_append_only` and
`legal_acceptances_no_truncate` triggers (an acceptance is evidence: a new
version is a new row, never an edit), the `tickets_order_must_be_paid` trigger
(a ticket exists only for a paid order), the
`events_city_clean` and `venues_city_clean` triggers (`clean_city_text`, the database's half of `cityKey`, so a padded or "Toronto, ON" city cannot pass the city rule), the
system user `blendn-system` that owns
every venue day, and the `system_user_is_permanent` trigger that refuses its
deletion. On a `db push` database `venueDayFor` fails for want of that user,
and says so. See `docs/VENUES.md` § Venue days.

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

Staging only: `SEED_PASSWORD` — the password of the dashboard test accounts
(`admin@`, `organizer@`, `venue.owner@`, `sponsor@blendn.app`), which the
pre-deploy step (`scripts/test-accounts.ts`) re-asserts on every deploy.
`seed:qa --apply` refuses to run without it, and refuses any database that is
not Railway `staging` or `localhost`.

Optional: Tigris object storage (`TIGRIS_ENDPOINT`, `TIGRIS_ACCESS_KEY`, `TIGRIS_SECRET_KEY`, `TIGRIS_BUCKET`, `TIGRIS_PRIVATE_BUCKET`, `TIGRIS_REGION`), Google OAuth client IDs (`GOOGLE_WEB_CLIENT_ID`, `GOOGLE_IOS_CLIENT_ID`, `GOOGLE_ANDROID_CLIENT_ID`), `OPENAI_API_KEY`, `REDIS_URL`, `NEXT_PUBLIC_SENTRY_DSN`.

**The storage vars are `TIGRIS_*`, not `AWS_*`.** This file said `AWS_ACCESS_KEY_ID` / `AWS_S3_BUCKET`, and `lib/tigris.ts` has only ever read `TIGRIS_*` — so a deployment configured from these instructions got uploads silently switched off, with no error anywhere. `DEPLOYMENT.md` and `lib/env.ts` were corrected; this file was not, and it is the one an agent reads first.

`lib/env.ts` centralizes env var access — prefer it over raw `process.env` reads in new code, and it is the authority on names when a doc disagrees.

## Deployment

Deployed to Railway via Docker (see `DEPLOYMENT.md` and `railway.json`). Health check at `GET /api/health`. Production startup fails fast if required env vars are missing (checked in `server.ts` before the HTTP server binds).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
