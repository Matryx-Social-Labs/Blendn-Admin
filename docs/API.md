# Blendn Mobile API Reference

Base URL: `/api/mobile` (or `/api/mobile/v1` with versioning)

All endpoints require `Authorization: Bearer <access_token>` unless noted.

## Response Format

```json
// Success
{ "success": true, "data": { ... } }

// Error
{ "success": false, "error": "Message", "errorCode": "ERROR_CODE" }

// Validation Error
{ "success": false, "error": "Validation failed", "errorCode": "VALIDATION_FAILED", "errors": [{ "field": "email", "message": "Required" }] }
```

Error codes: `VALIDATION_FAILED`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `SERVER_ERROR`, `EVENT_FULL`, `EVENT_NOT_STARTED`, `EVENT_ENDED`, `OUT_OF_RANGE`, `ALREADY_CHECKED_IN`, `STORAGE_UNAVAILABLE`, `USER_MUTED`, `USER_BANNED`, `CHAT_LOCKED`, `NOT_CHECKED_IN`, `SPAM_BLOCKED`

---

## Authentication

| Method | Endpoint | Description | Rate Limit |
|--------|----------|-------------|------------|
| POST | `/auth/signup` | Register with email/password | 3/hr |
| POST | `/auth/signin` | Login with email/password | 5/15min per IP, 10/15min per email |
| POST | `/auth/google` | Google OAuth login | 10/15min |
| POST | `/auth/apple` | Apple Sign In | 10/15min |
| POST | `/auth/refresh` | Refresh access token | 20/15min |
| GET | `/auth/session` | Get current session info | - |
| POST | `/auth/signout` | Revoke refresh token | - |

Password reset is **not** under `/api/mobile`. See [Password reset](#password-reset) below.

### POST /auth/signup
```json
{ "email": "string", "password": "string", "name": "string" }
```
Returns **201**: `{ accessToken, refreshToken, user: { id, email, name, profile } }`

`profile` is returned so the client can decide where to route without a second
call — it carries `onboarded`, which is what that decision reads.

**Password rules.** At least **12 characters**, and rejected if it is an obvious
choice (`password1234` is twelve characters and fails) or built from the local
part of the address. This is `checkPassword` in `lib/password.ts`, the same
function `/api/auth/reset-password` runs — so a password accepted here can
always be reset to something similar. A shorter minimum here would mean users
setting passwords they could never restore.

### POST /auth/signin
```json
{ "email": "string", "password": "string" }
```
Returns: `{ accessToken, refreshToken, user: { id, email, name, profile } }`

An account created through Google or Apple has no password and returns the same
generic `401` as a wrong password — deliberately, so the response is not an
account-existence oracle.

### Password reset

Mobile clients call the shared web endpoints; there is no `/api/mobile` twin.

| Method | Endpoint | Description | Rate Limit |
|--------|----------|-------------|------------|
| POST | `/api/auth/forgot-password` | Request a reset link | 5/15min per IP, 3/hr per address |
| POST | `/api/auth/reset-password` | Set a new password with the token | 10/15min |

`forgot-password` always responds `{ ok: true }` with the same message whether or
not the address exists. The emailed link opens the **web** reset page in the
browser; there is no deep link into the app. Completing a reset revokes every
`mobile_refresh_tokens` row for that user, so all devices are signed out.

---

## Identity

Two names for one person, and which you get depends on where you are.

| Surface | You see |
|---|---|
| Event chat, participants, attendee list, sockets | **Pseudonym** — "Cosmic Panda" |
| Direct messages, message requests | Real name and photo |

The pseudonym is one per person per event, stable for the whole event and across
check-out and check-in, and **different at every event** — there is no
cross-event identity. It lives on `chat_group_members.anonymous_name` and
survives the room closing, because historical messages resolve their author
through it.

Crossing from one column to the other is the message request, and it is the only
crossing: `GET /events/:eventId/checkins` returns pseudonyms, never real names or
photos. Blocks are honoured in both directions everywhere, and are reported as
"not found" rather than "blocked" — confirming an account exists tells a blocked
person they were blocked.

---

## Events

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/events` | List events (paginated, filterable) |
| GET | `/events/:eventId` | Get event details |
| POST | `/events/:eventId/checkin` | Check in to event |
| POST | `/events/:eventId/checkout` | Check out of event |
| POST | `/events/:eventId/favorite` | Toggle favorite/interest |
| DELETE | `/events/:eventId/favorite` | Remove favorite |
| GET | `/events/:eventId/interested-users` | List interested users |
| POST | `/events/:eventId/rating` | Rate an event |
| POST | `/events/:eventId/rsvp` | RSVP — waitlists when full |
| GET | `/events/:eventId/analytics` | Organiser analytics |
| POST | `/events/:eventId/clone` | Clone event (organiser) |
| GET | `/events/:eventId/checkins/export` | Export attendees CSV |
| POST | `/events/:eventId/announce` | Send announcement |
| GET | `/events/:eventId/chat` | Get event chat group |
| GET | `/events/:eventId/peer-ratings` | Who you can still rate |
| POST | `/events/:eventId/peer-ratings` | Rate someone you met |
| GET | `/events/:eventId/matches` | Who else was in the room, ranked |
| POST | `/events/:eventId/matches/likes` | Like someone; mutual opens a conversation |
| PUT | `/events/:eventId/matches/preferences` | Your intent and reveal, for this event |

### Peer ratings and trust

`POST /events/:eventId/peer-ratings` with
`{ userId, rating: 1..5, issue?, note? }`.

The product asks strangers to meet strangers. Attendance says a night happened
and connections say people paired up; neither says whether meeting a specific
person was a good experience.

Four rules, each load-bearing:

- **Only someone you connected with** — a mutual like, so both people opted in.
  Rating anyone who merely shared a room is a review-bombing surface and a way to
  punish someone for declining. `GET` returns exactly who is eligible.
- **Only once the event has ended.** During the night a rating is leverage.
- **Never visible to the person rated.** There is no endpoint that returns it to
  them, and there will not be — nobody reports discomfort honestly when the
  subject will see it and knows who was there.
- **One per pair per event.**

`issue` is one of `none`, `uncomfortable`, `no_show`, `misrepresented`,
`harassment`. **Harassment is not a low rating with a label** — it goes to
moderation on its own and is never averaged into a score. Four glowing ratings
and one harassment report is not a 4.2.

The trust signal derived from these is **for moderation, not attendees, and that
is a safety constraint rather than a preference**.

The person most likely to rate someone badly is the person who felt least safe
with them. Surface that rating and you have told the man that the woman who met
him rated him down — at an event where he knows who she is, has her pseudonym,
and may still be in the room. The feature meant to protect her becomes what
exposes her.

No endpoint returns it and none may be added.
`__tests__/trust-not-exposed.test.ts` fails the build if anything under
`app/api/mobile` so much as imports the trust module, because this is exactly the
rule that erodes when someone wants a "verified" badge.

---

### Connections — did anyone meet anyone

`GET /events/:eventId/analytics` now carries a `connections` object. Attendance
says people came and ratings say how it felt; neither says whether the thing the
product exists for happened.

```json
{ "attendees": 40, "connections": 26, "connected": 31,
  "perAttendee": 0.7, "connectedPct": 78, "suppressed": false }
```

`perAttendee` is the industry benchmark — two connections at a 200-person event
means the format failed, twelve means it worked — and `connectedPct` is the
shape the mean hides: formats are generally considered to be working above 50%.

**A connection is mutual.** One-sided likes are never counted or exposed; a like
nobody returned is private to whoever sent it.

**Suppressed below 8 attendees.** `perAttendee` and `connectedPct` come back
null and the counts as zero, because "one connection among three attendees"
names both of them to anyone who was there. `attendees` still reports.

---

### RSVP and the waitlist

`POST /events/:eventId/rsvp` with `{ status: "going" | "maybe" | "not_going" }`.

When the event has a `max_capacity` and is already full, a `going` request comes
back as **`waitlisted`** rather than being refused. Releasing a seat — cancelling,
or moving to `maybe`/`not_going` — promotes whoever has waited longest, and they
get a push.

An event with no stated capacity is unbounded, exactly as before.

**The waitlist is not a door policy.** Check-in still refuses nobody: someone who
turns up and is inside the geofence gets in and is counted whether they were
`going` or `waitlisted`. See `CHECKIN.md` — check-in is a presence proof, not a
ticket.

---

### Matches

`GET /events/:eventId/matches` is **only for people who were in the room** —
`403` otherwise. It is a view of an event you attended, not a directory.

Each card names what the two of you share rather than who the other person is:

```json
{ "userId": "...", "displayName": "Cosmic Panda", "photo": null,
  "sharedInterests": ["Techno", "Board games"],
  "sharedIntents": ["networking"], "insideNow": true, "youLiked": false }
```

`displayName` is the room pseudonym and `photo` is null unless that person chose
to be revealed at this event. **There is no score** — the ordering is not
exposed, because a number implies a precision the data cannot support.

Staff are excluded. People who have checked out are not: they were in the room
with you, and rank lower rather than disappearing.

`youLiked` says whether *you* liked them. **Nothing anywhere says whether they
liked you** — a mutual like is the only thing that reveals it, and there is no
endpoint that leaks it early.

`POST .../likes` takes `{ "userId": "..." }` and returns
`{ "mutual": false }` or `{ "mutual": true, "conversationId": "..." }`. A mutual
like opens the conversation directly: a message request exists to establish that
both people agreed to talk, and two likes are exactly that.

`PUT .../preferences` takes `{ intent?: ("dating"|"networking"|"friendship"|"just_here")[],
revealed?: boolean, remember?: boolean }`. Per event, because both change —
someone open to dating on a Friday is often only there for the talk on Tuesday.
`remember` also writes the profile default.

### GET /events - Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| page | int | 1 | Page number |
| limit | int | 20 | Items per page (max 100) |
| search | string | - | Search title, description, venue, city |
| lat | float | - | Latitude for nearby search |
| lon | float | - | Longitude for nearby search |
| radius | float | 10000 | Search radius in meters |
| categoryId | uuid | - | Filter by category |
| categorySlug | string | - | Filter by category slug |
| startDate | ISO date | - | Events starting after |
| endDate | ISO date | - | Events ending before |
| status | string | published | Event status filter |
| sortBy | enum | start_time | `start_time`, `created_at`, `distance` |
| sortOrder | enum | asc | `asc`, `desc` |
| include | string | - | Comma-separated: `checkins,activeCheckins,profile,interestedPreview` |

### Pagination Response
```json
{ "pagination": { "page": 1, "limit": 20, "totalCount": 100, "totalPages": 5, "hasMore": true } }
```

---

## Batch Operations (30 req/min)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/events/checkins/batch` | Batch check-in statuses |
| POST | `/events/interests/batch` | Batch interest statuses |
| POST | `/events/interest-counts/batch` | Batch interest counts |

Body: `{ "eventIds": ["uuid", ...] }` (max 50)

---

## Chat

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/chat/groups` | List user's chat groups |
| GET | `/chat/groups/:chatGroupId/messages` | Get messages (cursor-based) |
| POST | `/chat/groups/:chatGroupId/messages` | Send message (30/min rate limit) |
| GET | `/chat/groups/:chatGroupId/participants` | List participants |

### GET /chat/groups/:chatGroupId/messages
| Param | Type | Description |
|-------|------|-------------|
| before | uuid | Cursor: message ID to fetch before |
| limit | int | Messages per page (default 50) |

### POST /chat/groups/:chatGroupId/messages
```json
{ "content": "string", "type": "text|image|video", "metadata": {}, "parentId": "uuid?" }
```
**Moderation (pre-emit):** Messages go through a 3-layer pipeline **before** being broadcast to other users:
1. **Spam check** (sync) — burst rate, duplicate, link density → blocks with 429
2. **Keyword filter** (sync, <1ms) — slurs/profanity in 9 languages → saves as hidden, returns `moderation_hidden: true`
3. **OpenAI Moderation** (pre-emit, 1s timeout) — AI content analysis → hides before broadcast

If caught, response returns `{ moderation_hidden: true, content: null }`. The message is never emitted via socket.
If OpenAI times out (>1s), message is broadcast and moderation falls back to async (socket delete event).

**Error codes:** `USER_MUTED` (403), `USER_BANNED` (403), `CHAT_LOCKED` (403), `NOT_CHECKED_IN` (403), `SPAM_BLOCKED` (429)

### Event Chat: POST /events/:eventId/chat
Same moderation pipeline and error codes apply.

---

## Private Conversations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/conversations` | List conversations |
| POST | `/conversations` | Open a conversation — **requires an accepted request** |
| GET | `/conversations/:id` | Get conversation |
| GET | `/conversations/:id/messages` | Get messages |
| POST | `/conversations/:id/messages` | Send message |

`POST /conversations` does not create a channel out of nothing. It requires an
accepted message request between the two people, or a conversation that already
exists — otherwise `400`. A block in **either** direction makes both this and
sending return as though the other person were not there.

---

## Message Requests

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/message-requests` | List pending requests |
| POST | `/message-requests` | Send a message request |
| POST | `/message-requests/:id/respond` | Accept / decline / block |

**You can only request someone you have shared an event with** — both of you
checked in to the same event at some point. Ever, not currently: messaging
someone the morning after is the ordinary case. An RSVP does not count; only an
actual check-in puts you in the room.

`respond` with `block` writes a real `blocked_users` row as well as setting the
request status.

---

## Settings

`PUT /profiles/:userId` accepts four preference booleans, all defaulting to
**true**:

| Field | Governs |
|---|---|
| `push_enabled` | Push notifications |
| `show_online` | Whether others see you as active |
| `read_receipts` | Whether DM reads are reported back |
| `share_location` | Whether other attendees see your distance |

These had been shown in the app and stored nowhere — there were no columns, so
hydration fell back to `true` and every switch read ON whatever the user chose.
They default true because that is what the UI has always claimed, so nobody's
apparent settings change on the day they start being honoured.

`share_location` is **not** the GPS permission. Check-in still needs a fix
regardless; this governs only whether others see how far away you are.

**Send them at the top level, with exactly these names**, and read them back
from `profile.push_enabled` and friends on `GET /profiles/:userId`. There is no
`preferences` wrapper and no camelCase alias. The Expo app was sending twelve
variants of the four — nested and camelCased — and matching none of them, so
0.55.0's columns were written by nothing and the toggles still lied.

They are returned **only to the profile's owner**. Whether someone has push on,
or shares their distance, is a statement about how careful they are being and is
not other attendees' business. `show_online` is enforced by the endpoints that
report presence, which read the column directly.

---

## Users & Profiles

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/users/:userId` | Get user profile |
| POST | `/users/:userId/block` | Block/unblock user |
| GET | `/users/:userId/favorites` | Get user's favorites |
| GET | `/profiles/:userId` | Get full profile |
| PUT | `/profiles/:userId` | Update profile |
| GET | `/profiles/:userId/interests` | Get category interests |
| PUT | `/profiles/:userId/interests` | Update interests |

---

## Uploads

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/uploads/presigned-url` | Get S3 presigned upload URL |
| DELETE | `/uploads/delete` | Delete uploaded file |

### POST /uploads/presigned-url
```json
{ "filename": "photo.jpg", "contentType": "image/jpeg", "folder": "profile|chat|events" }
```
Note: `events` folder requires organiser/admin role.

---

## Content Moderation (Admin API)

Base URL: `/api/events/:eventId/chat/moderation`
Requires admin session (NextAuth). Uses `canModerateChat()` RBAC (app_admin or event organiser).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/events/:id/chat/moderation` | List moderation flags (paginated) |
| PATCH | `/api/events/:id/chat/moderation/:flagId` | Review a flag (approve/reject) |

### GET /api/events/:id/chat/moderation
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| status | string | pending | Filter: `pending`, `approved`, `rejected`, `all` |
| page | int | 1 | Page number |
| limit | int | 20 | Items per page (max 50) |

Returns: `{ flags: [...], stats: { pending, autoHidden, total }, pagination }`

### PATCH /api/events/:id/chat/moderation/:flagId
```json
{ "action": "approve|reject", "notes": "optional review note" }
```
- **approve**: Restores the message (sets `moderation_status = "clean"`, clears `deleted_at`)
- **reject**: Keeps message hidden

### Moderation Pipeline

Messages go through a **pre-emit** pipeline — moderation runs before the message is broadcast to other users:
1. **Spam check** (sync, blocks before save) — burst rate (5 msgs/10s), duplicate detection, link density (max 2)
2. **Keyword filter** (sync, before save, <1ms) — Exact-match wordlists for English + 8 Indian languages. If matched, message saved as hidden and never broadcast.
3. **OpenAI Moderation API** (pre-emit, 1s timeout) — Multilingual AI detection for hate, harassment, sexual, violence, self-harm. If caught within 1s, message hidden before broadcast. If timeout, emitted and falls back to async.
4. **Image moderation** (async, if applicable) — OpenAI omni-moderation for images

Thresholds: `>=0.70` confidence → auto-hide, `>=0.40` → flag for review. Auto-mute after 3 hidden messages in 1 hour. Auto-unmute after 1 hour with no new violations (checked on next send attempt).

Requires `OPENAI_API_KEY` env var. Degrades gracefully to keyword-only if absent.

---

## Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/categories` | List all categories |
| GET | `/checkins/active` | Get user's active check-ins |
| POST | `/notifications/token` | Register push token |
| DELETE | `/notifications/token` | Remove push token |
