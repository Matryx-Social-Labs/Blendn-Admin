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

Error codes: `VALIDATION_FAILED`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `SERVER_ERROR`, `EVENT_FULL`, `EVENT_NOT_STARTED`, `EVENT_ENDED`, `OUT_OF_RANGE`, `ALREADY_CHECKED_IN`, `STORAGE_UNAVAILABLE`

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
**Moderation:** Messages are spam-checked before saving (burst rate, duplicate, link density). After saving, async moderation runs (keyword filter + OpenAI Moderation API) — flagged messages are hidden retroactively via socket event.

### Event Chat: POST /events/:eventId/chat
Same moderation pipeline applies to event chat messages.

---

## Private Conversations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/conversations` | List conversations |
| GET | `/conversations/:id` | Get conversation |
| GET | `/conversations/:id/messages` | Get messages |
| POST | `/conversations/:id/messages` | Send message |

---

## Message Requests

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/message-requests` | List pending requests |
| POST | `/message-requests` | Send a message request |
| POST | `/message-requests/:id/respond` | Accept/decline request |

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

Messages go through this async pipeline after being saved:
1. **Spam check** (sync, blocks before save) — burst rate (5 msgs/10s), duplicate detection, link density (max 2)
2. **Keyword filter** (sync, <1ms) — Exact-match wordlists for English + 8 Indian languages (Hindi, Tamil, Telugu, Kannada, Malayalam, Bengali, Marathi, Gujarati) in both native script and transliterated Latin
3. **OpenAI Moderation API** (async, 50-200ms) — Multilingual AI detection for hate, harassment, sexual, violence, self-harm
4. **Image moderation** (async, if applicable) — OpenAI omni-moderation for images

Thresholds: `>=0.85` confidence → auto-hide, `>=0.5` → flag for review. Auto-mute after 3 hidden messages in 1 hour.

Requires `OPENAI_API_KEY` env var. Degrades gracefully to keyword-only if absent.

---

## Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/categories` | List all categories |
| GET | `/checkins/active` | Get user's active check-ins |
| POST | `/notifications/token` | Register push token |
| DELETE | `/notifications/token` | Remove push token |
