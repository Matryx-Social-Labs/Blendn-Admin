# Blendn-Admin Repository Audit — Backlog

Scope: `blendn-admin/` only (Next.js 15 admin dashboard + REST/mobile API + Socket.io backend). Read-only audit, no code changed.

---

## 1. Missing Features

### 1.1 No env var documented for OpenAI moderation key
- **Priority**: Medium
- **Category**: Missing Features / Production Readiness
- **File(s)**: `.env.example`; `lib/moderation/openai-moderation.ts`
- **Evidence**: `OPENAI_API_KEY` is required for AI moderation but absent from `.env.example`. Code degrades silently to keyword-only moderation when unset, masking misconfiguration in new environments.
- **Suggested Fix**: Add `OPENAI_API_KEY` (and `OPENAI_ORG_ID` if used) to `.env.example` with a comment on the degraded fallback behavior.
- **Estimated Effort**: XS

### 1.2 Sponsored-message scheduler has no graceful shutdown
- **Priority**: Low
- **Category**: Missing Features / Broken Logic
- **File(s)**: `lib/socket-server.ts:145-236`
- **Evidence**: `SponsoredMessageScheduler` stores `setInterval` handles in a `Map` with no hook to clear them on `SIGTERM`/`SIGINT`. `server.ts` already has a shutdown handler for HTTP/Socket.io but never calls into this scheduler.
- **Suggested Fix**: Add a `stop()`/`stopAll()` method and call it from `server.ts`'s shutdown handler.
- **Estimated Effort**: S

### 1.3 Unused, fully-built `data-table.tsx` component
- **Priority**: Low
- **Category**: Missing Features / Code Quality
- **File(s)**: `components/data-table.tsx` (807 lines)
- **Evidence**: A complex drag-and-drop, multi-tab table component exists but is never imported anywhere in the app — either dead weight or an unfinished feature that was scaffolded and abandoned.
- **Suggested Fix**: Confirm intent with the team; either wire it into a screen that needs it or delete it.
- **Estimated Effort**: S (Needs Verification)

---

## 2. Broken Logic

### 2.1 Socket room joins have no membership/authorization check
- **Priority**: Critical
- **Category**: Broken Logic / Backend-API
- **File(s)**: `lib/socket-server.ts:303-363` (`join:chat`, `join:event`, `join:conversation` handlers)
- **Evidence**: Any authenticated socket can join any chat group, event room, or private conversation room by ID — there's no DB check that the joining user is actually a member/participant. This allows cross-group message eavesdropping by any authenticated user who can guess/enumerate an ID.
- **Suggested Fix**: Before completing a `join:*`, query membership (chat_group_members / event participant / conversation participant) and reject with an error event if unauthorized.
- **Estimated Effort**: L

### 2.2 Socket.io CORS allows wildcard origin
- **Priority**: High
- **Category**: Broken Logic / Production Readiness
- **File(s)**: `lib/socket-server.ts:245-246`
- **Evidence**: `cors: { origin: "*" }`, with an inline comment acknowledging it should be restricted in production. Combined with 2.1, this widens the attack surface for unauthorized real-time access.
- **Suggested Fix**: Restrict Socket.io CORS to the same allow-list `middleware.ts` already uses for HTTP CORS.
- **Estimated Effort**: S

### 2.3 Typing indicator handlers skip membership re-check
- **Priority**: Low
- **Category**: Broken Logic
- **File(s)**: `lib/socket-server.ts:316-350`
- **Evidence**: `chat:startTyping`/`chat:stopTyping` emit to the whole room without re-verifying the emitting user is still an active (non-removed/non-muted) member, which can leak typing state for users who were just removed.
- **Suggested Fix**: Check membership status is active before emitting; no-op otherwise.
- **Estimated Effort**: XS

### 2.4 CRON endpoint auth is permissive when `CRON_SECRET` is unset
- **Priority**: High
- **Category**: Broken Logic / Backend-API
- **File(s)**: `app/api/cron/event-reminders/route.ts:6-11`
- **Evidence**: `if (cronSecret && authHeader !== ...)` — if `CRON_SECRET` is not configured, the check is skipped entirely and the endpoint accepts unauthenticated requests.
- **Suggested Fix**: Fail closed — require `CRON_SECRET` to be set; reject all requests if it's missing rather than defaulting to open.
- **Estimated Effort**: S

### 2.5 Non-null assertions on potentially-undefined JWT/DB fields
- **Priority**: Medium
- **Category**: Broken Logic
- **File(s)**: `lib/mobile-auth.ts:95` (`decoded.jti!`), `~:160` (`m.lastReadAt!`)
- **Evidence**: `!` assertions bypass TypeScript's null checking on values that are plausibly undefined (token without a `jti`, a membership row with no `last_read_at`), risking a runtime crash instead of a typed error.
- **Suggested Fix**: Replace assertions with explicit guards/defaults.
- **Estimated Effort**: S

### 2.6 Unawaited/fire-and-forget DB write on chat group access
- **Priority**: Medium
- **Category**: Broken Logic / Backend-API
- **File(s)**: `app/api/mobile/chat/groups/route.ts:22-30`
- **Evidence**: `db.chat_groups.updateMany().catch()` for auto-archiving runs detached from the response with no logging of failure — silent data-consistency drift if it fails.
- **Suggested Fix**: Either await it and log failures, or explicitly document why it's fire-and-forget.
- **Estimated Effort**: S

### 2.7 Race condition in moderation queue filter/page fetch
- **Priority**: Medium
- **Category**: Broken Logic / UI
- **File(s)**: `components/moderation-queue.tsx:68`
- **Evidence**: Effect depends on `[eventId, filter, page]` but doesn't cancel in-flight requests; rapid filter changes can let an older response overwrite a newer one, showing stale moderation data to an admin.
- **Suggested Fix**: Use `AbortController` per request, or a request-id guard to drop stale responses.
- **Estimated Effort**: S

### 2.8 Possible unguarded access on optional nested relation
- **Priority**: Medium
- **Category**: Broken Logic
- **File(s)**: `app/dashboard/chatrooms/page.tsx:234`
- **Evidence**: `event.chat_group._count.messages` accessed without confirming `chat_group` exists; events without a chat room (e.g. freshly created) would throw a render-time TypeError.
- **Suggested Fix**: Add optional chaining / guard clause with a fallback (e.g. "No chat room").
- **Estimated Effort**: XS

---

## 3. UI Issues

### 3.1 Duplicate events-table implementations
- **Priority**: Medium
- **Category**: UI / Code Quality
- **File(s)**: `components/events-table.tsx` (272 lines) vs `app/dashboard/events-table.tsx` (500 lines)
- **Evidence**: Two separate table components for the same entity, one simpler and one with sorting/filtering/column visibility/row selection — divergent behavior depending on which page is touched next.
- **Suggested Fix**: Consolidate into a single reusable `EventsTable`.
- **Estimated Effort**: M/L

### 3.2 Missing empty-state UI on organisers/venue-owners tables
- **Priority**: Medium
- **Category**: UI
- **File(s)**: `app/dashboard/organisers/page.tsx`; `app/dashboard/venue-owners/page.tsx`
- **Evidence**: Tables render with no check for an empty dataset, unlike `app/dashboard/chatrooms/page.tsx:132` which already has a "no results" pattern.
- **Suggested Fix**: Reuse the chatrooms empty-state pattern on these two pages.
- **Estimated Effort**: S

### 3.3 No loading skeletons on data-heavy dashboard pages
- **Priority**: Medium
- **Category**: UI
- **File(s)**: `app/dashboard/users/page.tsx`
- **Evidence**: Stats + table + session load in parallel with no skeleton; a slow API leaves the page blank rather than indicating progress.
- **Suggested Fix**: Add skeleton placeholders for stat cards and table rows during initial load.
- **Estimated Effort**: S

### 3.4 Icon-only buttons missing accessible labels
- **Priority**: Medium
- **Category**: UI / Accessibility
- **File(s)**: `components/chat-feed.tsx:215`; `components/event-messaging.tsx:250,256`; `components/nav-documents.tsx`
- **Evidence**: Refresh/edit/delete/trash icon buttons rely on `title` or nothing at all — no `aria-label`, so screen readers announce nothing meaningful.
- **Suggested Fix**: Add `aria-label` (or visually-hidden text) to every icon-only interactive element.
- **Estimated Effort**: S

### 3.5 Hardcoded brand colors instead of design tokens
- **Priority**: Low
- **Category**: UI / Code Quality
- **File(s)**: `app/dashboard/chatrooms/page.tsx`, `app/dashboard/events/page.tsx`, `components/role-users-table.tsx`, `components/nav-main.tsx`, `components/nav-user.tsx`, `components/dashboard/report-overview.tsx`, `app/login/page.tsx`, `app/page.tsx`
- **Evidence**: `#F05423`, `#d84a1d`, `#865693`, `#BE5C71` repeated 20+ times as inline values rather than CSS variables/Tailwind theme tokens — any rebrand touches 8+ files.
- **Suggested Fix**: Promote to CSS variables in the Tailwind theme and reference by name.
- **Estimated Effort**: S

### 3.6 Inconsistent spacing scale across dashboard pages
- **Priority**: Low
- **Category**: UI
- **File(s)**: dashboard pages under `app/dashboard/**`
- **Evidence**: Mix of `px-4 lg:px-6`, `px-6`, `p-5`, `p-4`, `px-6 py-6` for what's visually the same outer container across pages.
- **Suggested Fix**: Define and enforce one spacing scale/constant for page containers.
- **Estimated Effort**: S

### 3.7 Tab switcher implemented with raw buttons instead of shared `Tabs` component
- **Priority**: Low
- **Category**: UI / Code Quality
- **File(s)**: `components/event-messaging.tsx:401-424` vs `app/dashboard/events/[id]/messaging/page.tsx:59`
- **Evidence**: Two different tab implementations in the same feature area — one uses the design system's `Tabs`, the other hand-rolls buttons.
- **Suggested Fix**: Standardize on the shared `Tabs` component.
- **Estimated Effort**: XS

### 3.8 No upload progress indicator on event form
- **Priority**: Low
- **Category**: UI
- **File(s)**: `components/event-form.tsx`
- **Evidence**: Cover image upload only disables the submit button — no percentage/progress bar, so large uploads look frozen.
- **Suggested Fix**: Surface upload progress (S3/Tigris presigned upload already supports progress events via XHR/fetch).
- **Estimated Effort**: S

### 3.9 No list virtualization on large tables
- **Priority**: Low
- **Category**: UI / Performance
- **File(s)**: users/events/organisers/venue-owners tables
- **Evidence**: All rows render unconditionally regardless of viewport — fine at current scale, a real cost once any table crosses a few hundred rows.
- **Suggested Fix**: Adopt TanStack Virtual (already using `@tanstack/react-table`) for tables expected to grow.
- **Estimated Effort**: M (Needs Verification — depends on actual row-count growth)

### 3.10 Clipboard write has no failure handling
- **Priority**: Low
- **Category**: UI / Broken Logic
- **File(s)**: `components/credential-modal.tsx:66`
- **Evidence**: `navigator.clipboard.writeText()` called with no try/catch or feature check; fails silently on unsupported browsers/permission-denied contexts.
- **Suggested Fix**: Wrap in try/catch with a fallback toast on failure.
- **Estimated Effort**: XS

---

## 4. Code Quality

### 4.1 Oversized components mixing data, logic, and rendering
- **Priority**: Medium
- **Category**: Code Quality
- **File(s)**: `components/event-form.tsx` (1,248 lines); `app/dashboard/actions.ts` (1,150 lines); `components/chat-feed.tsx` (622 lines); `app/dashboard/users/users-table.tsx` (729 lines)
- **Evidence**: Each combines form/validation/state/async logic and rendering in one file, making changes risky and hard to test in isolation.
- **Suggested Fix**: Split into smaller sub-components/hooks (e.g. event-form sections, server actions grouped by entity).
- **Estimated Effort**: L/XL

### 4.2 console.error/console.log used instead of `lib/logger.ts` throughout API routes
- **Priority**: Medium
- **Category**: Code Quality / Production Readiness
- **File(s)**: ~50+ call sites incl. `app/api/health/route.ts:14`, `app/api/uploads/presigned-url/route.ts:12`, `app/api/mobile/chat/groups/route.ts:30`, `app/api/mobile/auth/refresh/route.ts:33`, `app/api/mobile/auth/google/route.ts:43`, `app/dashboard/users/actions.ts:115,153,216,245,265,314`, `lib/socket-server.ts` (15+ sites)
- **Evidence**: A structured logger (`lib/logger.ts`) already exists with levels and metadata, but most of the codebase bypasses it for raw `console.*`, fragmenting log output and losing structured fields (user id, op name) needed to correlate production incidents.
- **Suggested Fix**: Sweep-replace `console.error`/`console.log`/`console.warn` with `logger.*` equivalents.
- **Estimated Effort**: M

### 4.3 Debug log left in event creation handler
- **Priority**: Low
- **Category**: Code Quality / Production Readiness
- **File(s)**: `app/api/events/route.ts:89`
- **Evidence**: `console.log("Debug: Log cover_image_url:", ...)` — leftover debug statement in a live POST handler.
- **Suggested Fix**: Remove.
- **Estimated Effort**: XS

### 4.4 Raw error objects logged in catch blocks (potential sensitive-data leak)
- **Priority**: Medium
- **Category**: Code Quality / Production Readiness
- **File(s)**: `app/api/events/route.ts:182`, `app/api/events/[id]/route.ts:39-40`, and similar pattern repeated across many route handlers
- **Evidence**: `console.error('Error:', error)` logs the full error object, which can include raw Prisma query text/params — risk of leaking schema/data details into log aggregators.
- **Suggested Fix**: Log `error.message`/`error.code` only; keep full error server-side only behind the structured logger, never to stdout unfiltered.
- **Estimated Effort**: M

### 4.5 Inconsistent error response shape: dashboard vs mobile API
- **Priority**: Medium
- **Category**: Code Quality / Backend-API
- **File(s)**: `app/api/events/**` (raw string responses: "Unauthorized", "Not found") vs `app/api/mobile/**` (structured via `lib/api-response.ts`)
- **Evidence**: Two different error contracts in the same backend make client-side error handling inconsistent and harder to standardize.
- **Suggested Fix**: Migrate dashboard API routes onto `lib/api-response.ts` helpers.
- **Estimated Effort**: M

### 4.6 Hardcoded pagination/limit magic numbers instead of shared constants
- **Priority**: Low
- **Category**: Code Quality
- **File(s)**: `app/api/events/[id]/announcements/route.ts:28` (`take: 50`), `app/api/mobile/chat/groups/route.ts:35` (`Math.min(..., 100)`), others
- **Evidence**: `lib/constants.ts` and `lib/pagination.ts` exist precisely to centralize these values, but individual routes hardcode their own limits.
- **Suggested Fix**: Replace literals with named constants from `lib/constants.ts`.
- **Estimated Effort**: S

### 4.7 Unused dependencies (needs verification)
- **Priority**: Low
- **Category**: Code Quality
- **File(s)**: `package.json` — `@dnd-kit/*`, `leaflet`/`@types/leaflet`
- **Evidence**: Grep across `app/`/`lib/` shows usage only in `components/event-form.tsx`, `components/data-table.tsx`, `components/location-picker.tsx`. If `data-table.tsx` (4.x / 1.3 above) is genuinely dead, `@dnd-kit/*` may be removable too.
- **Suggested Fix**: Confirm actual usage post-decision on 1.3, then prune `package.json`.
- **Estimated Effort**: XS (Needs Verification)

---

## 5. Backend / API

### 5.1 Missing zod validation on sponsored-message PATCH
- **Priority**: Medium
- **Category**: Backend-API
- **File(s)**: `app/api/events/[id]/sponsored-messages/[msgId]/route.ts:27-40`
- **Evidence**: Body fields (`content`, `interval_minutes`, `is_active`) validated with inline ad-hoc checks instead of a zod schema, unlike the announcements route which already has one to copy from.
- **Suggested Fix**: Add a zod schema mirroring the announcements pattern.
- **Estimated Effort**: S

### 5.2 Weak validation on mobile message-request fields
- **Priority**: Medium
- **Category**: Backend-API
- **File(s)**: `app/api/mobile/message-requests/route.ts:16-18`
- **Evidence**: `recipientId` only checks `.min(1)` (no UUID format check); `message` has `.max(500)` but no explicit `.min(1)`.
- **Suggested Fix**: Add `z.string().uuid()` for `recipientId` and an explicit min-length bound for `message`.
- **Estimated Effort**: XS

### 5.3 Unbounded `findMany()` queries on several list endpoints
- **Priority**: Medium
- **Category**: Backend-API / Performance
- **File(s)**: `app/api/events/route.ts:26-29` (GET), `app/api/events/[id]/sponsored-messages/route.ts:21-26`, `app/api/mobile/profiles/[userId]/interests/route.ts:29-34`
- **Evidence**: No `.take()`/pagination on these list queries — fine today, a real risk once organizers/events/interests scale.
- **Suggested Fix**: Apply `lib/pagination.ts` consistently to every list endpoint.
- **Estimated Effort**: S

### 5.4 No rate limiting on dashboard write endpoints
- **Priority**: Medium
- **Category**: Backend-API / Production Readiness
- **File(s)**: `app/api/events/[id]/announcements/route.ts` (POST), `app/api/events/[id]/sponsored-messages/route.ts` (POST)
- **Evidence**: Organizer-authenticated endpoints that broadcast to all event attendees have no rate limit — a compromised organizer session could spam announcements.
- **Suggested Fix**: Apply `lib/rate-limit.ts` per-user on these write paths (same caveat as the existing rate-limit module: in-memory/single-process only).
- **Estimated Effort**: M

### 5.5 RBAC helper exists but enforcement at the route level is unverified
- **Priority**: High
- **Category**: Backend-API
- **File(s)**: `lib/rbac.ts:17-25` (`canModerateChat`); `app/api/events/[id]/chat/moderation*` routes
- **Evidence**: `canModerateChat()` correctly scopes by organizer/admin, but it needs to be confirmed every moderation route actually calls it before acting — same class of bug already fixed once for the emit-before-moderation issue.
- **Suggested Fix**: Audit each moderation route handler for an explicit `canModerateChat()`/ownership check before mutation.
- **Estimated Effort**: S

### 5.6 Zero test coverage on highest-risk auth/authorization modules
- **Priority**: High
- **Category**: Backend-API / Production Readiness
- **File(s)**: `lib/mobile-auth.ts`, `lib/socket-server.ts`, `lib/rbac.ts`, `lib/moderation/actions.ts` — none have a corresponding file in `__tests__/`
- **Evidence**: Only 5 test files exist total (`keyword-filter`, `api-response`, `rate-limit`, `spam-detector`, `logger`); the modules controlling token issuance, socket room access, and moderation actions — the most security-sensitive code in the repo — have no regression protection.
- **Suggested Fix**: Add test files for these four modules, prioritizing token expiry/rotation and socket join authorization (ties directly to issue 2.1).
- **Estimated Effort**: M (per module)

---

## 6. Performance

### 6.1 Possible N+1 / per-group raw query for unread counts (needs verification)
- **Priority**: Medium
- **Category**: Performance
- **File(s)**: `app/api/mobile/chat/groups/route.ts:142-176`
- **Evidence**: Unread-count logic builds a `$queryRaw` per membership group rather than confirmed single batched query — written defensively but worth confirming it isn't issuing one query per chat group.
- **Suggested Fix**: Verify the raw SQL batches all group IDs in one query; if not, batch it.
- **Estimated Effort**: S (Needs Verification)

### 6.2 No virtualization on large dashboard tables
- (Cross-ref UI 3.9 — same issue, performance angle.)

---

## 7. Production Readiness

### 7.1 Sentry config has no PII filtering or noise suppression
- **Priority**: Medium
- **Category**: Production Readiness
- **File(s)**: `sentry.server.config.ts`, `sentry.client.config.ts`, `sentry.edge.config.ts`
- **Evidence**: No `beforeSend`, `ignoreErrors`, or `denyUrls` — risk of PII (user IDs, emails in error context) reaching Sentry, plus quota burn from expected/noisy errors.
- **Suggested Fix**: Add `beforeSend` scrubbing and an `ignoreErrors` list for known benign errors.
- **Estimated Effort**: S

### 7.2 Sentry sourcemap upload silently no-ops without `SENTRY_AUTH_TOKEN`
- **Priority**: Medium
- **Category**: Production Readiness
- **File(s)**: `next.config.ts:76-80`
- **Evidence**: `silent: !process.env.SENTRY_AUTH_TOKEN` — if the token is absent in CI/Railway, the build still "succeeds" but ships without sourcemaps, silently degrading error traceability in production.
- **Suggested Fix**: Either fail the build loudly when the token is required, or document the tradeoff explicitly in `.env.example`/CI.
- **Estimated Effort**: S

### 7.3 Stale documentation vs actual socket payload/event names
- **Priority**: Low
- **Category**: Production Readiness
- **File(s)**: `docs/SOCKET_EVENTS.md:28,55` vs `lib/socket-server.ts:103,433-439`
- **Evidence**: Docs list `event:checkin` payload as including `checkInId`/`currentCapacity`, but code actually sends `checkInTime`; docs also mix `chat:join` and `join:chat` naming, code uses `join:chat`. Any client built strictly from docs will break.
- **Suggested Fix**: Reconcile docs with actual code, pick one event-naming convention, update the table.
- **Estimated Effort**: XS

### 7.4 Moderation doc threshold mismatched with config
- **Priority**: Low
- **Category**: Production Readiness
- **File(s)**: `docs/chat-moderation.md:50` vs `lib/moderation/config.ts:11`
- **Evidence**: Docs say "3+ URLs" triggers hide; config sets `MAX_LINKS_PER_MESSAGE = 2` (i.e., hides at >2, which is consistent, but worth double-checking the off-by-one wording matches intent).
- **Suggested Fix**: Align doc wording with the exact configured threshold.
- **Estimated Effort**: XS

---

# Feature Completion Checklist

- [ ] Real-time / Socket.io
    - [ ] Room authorization on join (chat/event/conversation) — **Critical, unimplemented**
    - [ ] CORS origin restriction (currently wildcard)
    - [ ] Scheduler graceful shutdown
    - [ ] Typing-indicator membership re-check
    - [ ] Structured logging (replace console.*)
    - [ ] Test coverage

- [ ] Mobile Auth & RBAC
    - [ ] Non-null assertion cleanup (jti, lastReadAt)
    - [ ] Test coverage for token issuance/rotation
    - [ ] Verify RBAC enforcement on every moderation route

- [ ] Moderation
    - [ ] Test coverage for auto-mute/unmute logic
    - [ ] Doc/config threshold reconciliation
    - [ ] OPENAI_API_KEY documented in env example

- [ ] Dashboard — Events
    - [ ] Consolidate duplicate events-table components
    - [ ] Split `event-form.tsx` into sub-components
    - [ ] Upload progress indicator
    - [ ] Pagination on sponsored-messages list

- [ ] Dashboard — Users / Organisers / Venue Owners
    - [ ] Loading skeletons on users page
    - [ ] Empty states on organisers/venue-owners tables
    - [ ] Split `users-table.tsx`
    - [ ] Split `app/dashboard/actions.ts`

- [ ] Dashboard — Chat / Moderation Queue
    - [ ] Fix race condition on filter/page fetch (AbortController)
    - [ ] Guard optional `chat_group` access
    - [ ] Accessible labels on icon buttons

- [ ] Cross-cutting UI
    - [ ] Design tokens for hardcoded brand colors
    - [ ] Consistent spacing scale
    - [ ] Standardize on shared `Tabs` component
    - [ ] Decide fate of unused `data-table.tsx` (+ possibly `@dnd-kit/*` deps)

- [ ] Backend API Hygiene
    - [ ] Replace console.* with logger.* repo-wide
    - [ ] Standardize error response shape (dashboard vs mobile)
    - [ ] zod validation on sponsored-message PATCH and message-request fields
    - [ ] CRON endpoint fail-closed when secret unset
    - [ ] Rate limiting on announcement/sponsored-message writes
    - [ ] Replace hardcoded limits with `lib/constants.ts`

- [ ] Observability / Production Readiness
    - [ ] Sentry beforeSend/ignoreErrors PII scrubbing
    - [ ] Fail-loud (or document) missing SENTRY_AUTH_TOKEN in CI
    - [ ] Reconcile docs/SOCKET_EVENTS.md and docs/chat-moderation.md with actual code

---

# Execution Order

**Phase 1 — Critical security/crash risk**
- Socket room authorization on join (2.1)
- Socket CORS wildcard (2.2)
- CRON endpoint fail-closed (2.4)
- RBAC enforcement audit on moderation routes (5.5)
- Test coverage for mobile-auth, socket-server, rbac, moderation actions (5.6)

**Phase 2 — Backend correctness & hygiene**
- Non-null assertion cleanup (2.5)
- Unawaited DB write logging (2.6)
- zod validation gaps (5.1, 5.2)
- Unbounded queries / pagination (5.3, 6.1)
- Rate limiting on write endpoints (5.4)
- console.* → logger.* sweep (4.2, 4.3, 4.4)
- Error response standardization (4.5)
- Hardcoded limits → constants (4.6)

**Phase 3 — Dashboard UI completeness**
- Consolidate duplicate events-table (3.1)
- Empty states (3.2), loading skeletons (3.3)
- Accessibility labels (3.4)
- Race condition in moderation queue (2.7)
- Optional-chain guard on chat_group (2.8)
- Clipboard error handling (3.10)
- Upload progress indicator (3.8)

**Phase 4 — Code quality / structural cleanup**
- Split oversized components (4.1)
- Resolve unused `data-table.tsx` and dependent deps (1.3, 4.7)
- Design tokens for colors (3.5), spacing scale (3.6), Tabs standardization (3.7)
- Scheduler graceful shutdown (1.2)
- Typing indicator membership check (2.3)

**Phase 5 — Observability & docs polish**
- Sentry PII scrubbing and ignoreErrors (7.1)
- SENTRY_AUTH_TOKEN build behavior (7.2)
- Docs reconciliation: SOCKET_EVENTS.md, chat-moderation.md (7.3, 7.4)
- .env.example completeness (1.1)
- List virtualization, once row counts justify it (3.9)
