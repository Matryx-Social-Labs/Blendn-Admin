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
| POST | `/auth/signin` | Login with email/password | 5/15min |
| POST | `/auth/google` | Google OAuth login | 10/15min |
| POST | `/auth/refresh` | Refresh access token | 20/15min |
| GET | `/auth/session` | Get current session info | - |
| POST | `/auth/signout` | Revoke refresh token | - |

### POST /auth/signup
```json
{ "email": "string", "password": "string", "name": "string" }
```

### POST /auth/signin
```json
{ "email": "string", "password": "string" }
```
Returns: `{ accessToken, refreshToken, user: { id, email, name, role } }`

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
| GET | `/events/:eventId/analytics` | Organiser analytics |
| POST | `/events/:eventId/clone` | Clone event (organiser) |
| GET | `/events/:eventId/checkins/export` | Export attendees CSV |
| POST | `/events/:eventId/announce` | Send announcement |
| GET | `/events/:eventId/chat` | Get event chat group |

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
