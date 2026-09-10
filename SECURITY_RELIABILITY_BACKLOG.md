# Security & Reliability Backlog — 2026-08-04 Audit (Backend)

Scope: `blendn-admin/` findings from an end-to-end flow audit (backend authorization, PII/data exposure, Socket.io real-time security). See `blendn/SECURITY_RELIABILITY_BACKLOG.md` for the mobile-app half of this same audit. Separate from the general code-quality `BACKLOG.md`.

---

## Fixed

- [x] **CRITICAL — Any authenticated user could read another user's email + phone number**
  - **File**: `app/api/mobile/profiles/[userId]/route.ts` (GET)
  - **Issue**: Only checked the caller was authenticated, not that they owned the profile. Returned full `email` + `profile.phone` for any `userId`. Exploitable directly (the mobile app itself calls this as a fallback in `blendn/app/user/[id].tsx:147` when viewing another user's profile).
  - **Fix applied**: GET now returns email/phone only when `authUser.userId === userId`; all other requesters get the same safe subset the public-profile endpoint already used.

---

## To Do

### Medium priority

- [ ] **Google Maps key ships in the client with no quota cap and no app restriction**
  - **File(s)**: `blendn/lib/staticMap.ts`, `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`
  - **Issue**: `EXPO_PUBLIC_*` means the key is in the JS bundle and readable by
    anyone with the app. Today it is a single unrestricted key: no HTTP referrer
    or bundle-id restriction, no per-day quota, and no split between platforms.
    Someone extracting it can bill Maps usage to the project, and the first
    signal would be the invoice.
  - **Decision (2026-08-20)**: two keys, each scoped in the Google Cloud console
    to one app — one restricted to the iOS bundle id, one to the Android package
    name and signing certificate — plus a daily quota cap on each so an
    extracted key is bounded rather than open-ended. Two keys rather than one
    because a single key cannot carry both platform restrictions at once.
  - **Deferred deliberately**, not forgotten: it needs Google Cloud console
    access rather than a code change, and it is bounded by a quota rather than
    being a data-exposure risk. Do it once the current work lands.
  - **Blocked on**: console access. No code change is required beyond reading a
    second key per platform.

- [ ] **Push notification previews leak DM content to the lock screen**
  - **File**: `app/api/mobile/message-requests/route.ts:129-137`
  - **Issue**: Push `body` is set to `"${senderName}: ${message.slice(0,80)}"` — renders on a locked device.
  - **Suggested fix**: Generic body ("New message request from X"); show real content only in-app after unlock.

- [ ] **Rate limiting silently degrades to in-memory per-process without `REDIS_URL`**
  - **File**: `lib/rate-limit-store.ts`
  - **Update (2026-09-10)**: this item originally described `lib/rate-limit.ts` as using only a plain in-process `Map` with no shared-store option. That's stale — `lib/rate-limit-store.ts`'s `hit()` now backs onto Redis when `REDIS_URL` is set (fixed window via `INCR`/`PEXPIRE`), falling back to the in-process `Map` only when Redis is unset or unreachable. The residual gap is operational, not code: `REDIS_URL` is documented as "optional" in `CLAUDE.md`'s env list and is **missing entirely from `.env.example`**, so a fresh deploy gets the weaker per-replica behavior with no signal that a stronger mode exists.
  - **Suggested fix**: Add `REDIS_URL` to `.env.example` (done alongside this note) and confirm it's actually set in every Railway environment that runs more than one replica — check, don't assume.

### Low priority

- [ ] **No rate limit on private-message send route**
  - **File**: `app/api/mobile/conversations/[conversationId]/messages/route.ts` (POST)
  - **Issue**: Unlike group chat messages and check-ins, this route has no `rateLimit()` call — spammable DMs/push notifications.
  - **Suggested fix**: Apply the same `lib/rate-limit.ts` pattern used elsewhere.

- [ ] **Check-in attendee list exposes name/age/location to any registered user**
  - **File**: `app/api/mobile/events/[eventId]/checkins/route.ts:17-42`
  - **Issue**: Only requires a valid JWT, not that the requester is themselves an attendee of that event — any logged-in user can enumerate attendee PII for events they never joined. May be intentional "who's here" product behavior — confirm before treating as a bug.
  - **Suggested fix**: If unintentional, require the requester to be checked into (or RSVP'd to) the event before returning the attendee list.

- [ ] **No rate limiting on Socket.io typing-indicator events**
  - **File**: `lib/socket-server.ts:368-402,431-455`
  - **Issue**: `chat:startTyping/stopTyping`, `private:startTyping/stopTyping`, `private:markRead` do a DB membership lookup per event with no throttling — a malicious client can spam these to flood other clients and hammer the DB.
  - **Suggested fix**: Add basic per-socket throttling on these events.

- [ ] **`private:markRead` broadcasts unvalidated `messageIds`**
  - **File**: `lib/socket-server.ts:449-455`
  - **Issue**: Relays client-supplied `messageIds` straight into the broadcast without checking they belong to the conversation. Cosmetic risk only (read-receipt UI could show bogus ticks) — actual persisted read-state is set via the separate REST route.
  - **Suggested fix**: Validate `messageIds` belong to the conversation before broadcasting, or note as accepted risk given low impact.

- [ ] **`/api/uploads/presigned-url` checks session presence but not dashboard role**
  - **File**: `app/api/uploads/presigned-url/route.ts:31-34`
  - **Issue**: Only verifies a NextAuth session exists, unlike `/api/events` POST which checks `role === "app_admin" || "organizer"`. Any `attendee` with a dashboard session could mint S3 presigned upload URLs. Impact limited (keys are namespaced by `session.user.id`), but inconsistent with the role checks applied elsewhere.
  - **Suggested fix**: Add the same role check used in `/api/events`.

### Informational / no action needed right now

- `$queryRawUnsafe` in `app/api/mobile/events/search/route.ts:49,81` — all input is parameterized (`$1/$2/$3`), not actually SQL-injectable, but recommend switching to `$queryRaw` tagged templates for clarity/future-proofing.

---

## Verified clean (no bug found — do not re-audit unless code changes)

- Socket.io: JWT-gated connections; server-side room authorization re-checked on every join/reconnect, not just first connect; no client-spoofable sender IDs; no broad `io.emit()` leaks.
- Backend: ~70 mobile/admin API routes reviewed — ownership/membership checks consistently applied (profiles PUT, conversations, chat group messages/participants, check-ins, event PATCH/DELETE, moderation, blocks, account deletion) except the one item fixed above.
- GPS check-in is server-validated (haversine distance) and rate-limited.
- API error responses never leak stack traces. Sentry configured without PII collection.

---

## Measured against Railway, 2026-08-24

Everything below was checked against the live `staging` and `production`
environments rather than read out of the code. Both are healthy
(`/api/health` returns `ok`, database connected); production is on **v0.60.0**
and staging on **v0.69.0**.

### [ ] There is no error monitoring in production, or in staging

`NEXT_PUBLIC_SENTRY_DSN` is **absent from both environments.** All three Sentry
configs read it and set `enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN`, so
Sentry initialises disabled and reports nothing, anywhere.

The wiring is complete and good — `@sentry/nextjs` is a dependency, `beforeSend`
and `IGNORED_ERRORS` come from `lib/sentry-scrub.ts`, and `sendDefaultPii` is
false. Nothing is missing except the DSN.

This subsumes the earlier note that sourcemap upload no-ops without
`SENTRY_AUTH_TOKEN`: that is true, and it is a symptom. The larger fact is that
an unhandled exception in production is currently visible only in Railway's
deploy logs, and only if somebody is looking.

**Needs a Sentry project**, so it is the product owner's action rather than a
code change. Set `NEXT_PUBLIC_SENTRY_DSN` on both services; add
`SENTRY_AUTH_TOKEN` to get sourcemaps with it.

### [ ] Production is nine minor versions behind staging

`prod` last deployed 2026-08-08 at v0.60.0; staging is at v0.69.0. Production's
schema stops at `20260808_preferences_and_trust` and is missing `notifications`,
`city_demand` and `photo_checks` entirely.

Not a defect, but it changes how a finding should be read: several audit items
describe code that production is not yet running.

### Resolved by measurement — do not re-audit

- **`OPENAI_API_KEY` is set in both environments.** Several findings (G3, I7)
  are premised on it being absent because `lib/env.ts` marks it optional. The
  code defects are real on the error and timeout paths; the missing-key path is
  not currently taken. Staging shows `clean` and `hidden` written as recently as
  2026-08-16.
- **`REDIS_URL` is set in both.** The rate limiter and the spam burst counter
  are genuinely shared, not per-replica.
- **Tigris is configured correctly** under `TIGRIS_*`. `CLAUDE.md` documented
  `AWS_*` and has been corrected — that mismatch would have silently disabled
  uploads for anyone configuring from it.
- **No event has more than one occurrence**, in either environment. The
  multi-day counting inflation (I1/W17) is a real defect and is **latent**: it
  cannot be producing wrong numbers today.
- **No `chat_group_members` row has `status = 'muted'`** in either environment,
  so the mute-provenance backfill is a no-op against live data.
- `peer_ratings`, `message_reactions` and `event_reports` are **empty in
  production**, consistent with the audit's finding that each lacks a writer, a
  reader, or both.

### [ ] Most chat messages have no moderation status at all

356 of 389 staging messages and 332 of 363 production messages have
`moderation_status IS NULL`, spanning the same date range as the rows that do
have one. The pipeline runs — `clean` and `hidden` are written — but most
messages never reach it, which is consistent with `chat_messages` having write
paths that bypass moderation entirely (the sponsored scheduler and the
announcement routes both write the table directly).

Worth a decision: either those paths moderate, or `null` becomes a documented
state meaning "not user content".
