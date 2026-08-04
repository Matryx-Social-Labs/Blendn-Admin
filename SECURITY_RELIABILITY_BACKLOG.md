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

- [ ] **Push notification previews leak DM content to the lock screen**
  - **File**: `app/api/mobile/message-requests/route.ts:129-137`
  - **Issue**: Push `body` is set to `"${senderName}: ${message.slice(0,80)}"` — renders on a locked device.
  - **Suggested fix**: Generic body ("New message request from X"); show real content only in-app after unlock.

- [ ] **Rate limiting is in-memory per-process, not shared across replicas**
  - **File**: `lib/rate-limit.ts:13-16`
  - **Issue**: Uses a plain in-process `Map`. Railway can run multiple replicas — rate limits (including on `/api/mobile/auth/signin`) reset/bypass per instance, making brute-force/credential-stuffing protection unreliable at scale.
  - **Suggested fix**: Move to a shared store (Redis, or Railway's equivalent) for rate-limit counters.

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
