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

Error codes: `VALIDATION_FAILED`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `SERVER_ERROR`, `EVENT_FULL`, `EVENT_NOT_STARTED`, `EVENT_ENDED`, `OUT_OF_RANGE`, `ALREADY_CHECKED_IN`, `STORAGE_UNAVAILABLE`, `USER_MUTED`, `USER_BANNED`, `CHAT_LOCKED`, `NOT_CHECKED_IN`, `SPAM_BLOCKED`, `NOT_LIVE`, `EVENT_LIVE_HERE`, `PLUS_REQUIRED`, `NO_CHECK_IN_AREA`, `GPS_TOO_VAGUE` (the last five: Go Live, below)

A refusal that names no specific code carries the one its status stands for:
401 `UNAUTHORIZED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`, 409 `CONFLICT`,
429 `RATE_LIMITED`, 5xx `SERVER_ERROR` (SCRUM-324). A bare 400 or 422 has no
default, because it covers too many different mistakes to name one.

**Bad input is a 4xx, never a 500** (SCRUM-430, SCRUM-433). Each was a 500
until 2026-09: Postgres refused the uuid cast, or `request.json()` threw, and
the route's catch-all called the caller's mistake an outage.

- A path id that is not a UUID answers `400` "Invalid … ID format". The
  handlers that already answered one `404` for malformed and unknown alike keep
  it: room leave, mute and report, the rating GET, and friend requests.
- A `before` or `cursor` that cannot be one answers `400` "Invalid cursor". An
  empty one is no cursor.
- A required body that is not JSON answers `400`: `VALIDATION_FAILED` from the
  route's schema, or its own missing-field `400`.
- An optional body (reveal, leaving a DM, board requests, marking notifications
  read, mute) is the default when absent, and a `400` when present but not
  JSON. A truncated body never takes the default.
- A `limit`, `offset` or `page` that is not a whole number falls back to the
  route's default, and is held to its bounds.
- A NUL byte (`%00` in a URL, `\u0000` in a body) answers `400`: Postgres text
  cannot hold one, and nothing legitimate sends one (SCRUM-434).

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
{ "email": "string", "password": "string", "name": "string", "age": 29 }
```
Returns **201**: `{ accessToken, refreshToken, user: { id, email, name, profile } }`

`name` and `age` are **required**, and `age` must be **18 or over**: Blend'n is
18+ (SCRUM-330). A missing age or one under 18 is **400** with
`errors: [{ field: "age", message: "…Blend'n is for people 18 and over." }]`,
and no account is written. Google and Apple create profiles without an age;
those accounts cannot finish onboarding until a date of birth of 18+ is on file
(see `PUT /profiles/:userId`). Accounts made before the ruling keep whatever age
they have. Prefer
`dateOfBirth` on `PUT /profiles/:userId` over this `age` — see *The age is
derived, never remembered* below for why the number alone is not enough.

`profile` is returned so the client can decide where to route without a second
call — it carries `onboarded`, which is what that decision reads.

**The address is stored lowercase.** One inbox is one account whatever its
case: `Priya@Example.com` is saved as `priya@example.com`, and `user.email` in
the response is the lowercase form. A second signup in another case gets the
same **409** as any taken address. `signin`, Google, Apple, the dashboard and
password reset all lowercase what they are given too (SCRUM-328).

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

### A staff account

The app is for attendees. Organisers, venue owners, sponsors and admins sign in
at the dashboard; an operator app is planned for after the launch. `signin`,
`google`, `apple`, `refresh` and `session` return **403** for any account whose role is
not `attendee`, checked after the password so the route is not an oracle:

```json
{ "success": false, "error": "This app is for attendees. Organisers, venue owners and sponsors sign in at the dashboard." }
```

A staff session that existed before this rule ends at its next refresh — at
most one access-token lifetime (15 minutes) after deploy.

### A suspended account

Every route that issues a token — `signin`, `google`, `apple`, `refresh` and
`session` — returns **403** with a message naming the suspension and an address
to appeal to. The client should show it rather than treating 403 as a generic
failure: a silent refusal to sign in is indistinguishable from a bug.

```json
{ "success": false, "error": "This account has been suspended. Contact support@blendn.app if you think that's a mistake." }
```

On `signin` it is checked **after** the password, so the response cannot be used
to discover which addresses are suspended.

On `refresh` it is answered even for the token the suspension **revoked** — which
is every live token, since suspending revokes them all. A token we signed, not
expired, whose stored row was revoked at or after the account's `suspended_at`
gets the 403 above; nothing is issued. Every other refused token gets `401` and
learns nothing about the account: one revoked earlier (sign-out, a killed token
family), a staff or deleted account's revoked token, a forged or expired one.
Before this (SCRUM-290) the revocation was checked first, so a suspended phone got
`401` and could only say "You were signed out".

Suspending also revokes the account's
refresh tokens, so an existing session stops working within one 15-minute access
token — `getAuthenticatedUser` verifies the JWT without a database read, and
adding one there would cost a query on every mobile request to shorten that
window.

A deleted account keeps returning the generic 401 or `User not found` it always
did; deletion is never confirmed to a caller.

### Password reset

Mobile clients call the shared web endpoints; there is no `/api/mobile` twin.

| Method | Endpoint | Description | Rate Limit |
|--------|----------|-------------|------------|
| POST | `/api/auth/forgot-password` | Request a reset link | 5/15min per IP, 3/hr per address |
| POST | `/api/auth/reset-password` | Set a new password with the token | 10/15min |
| GET | `/api/auth/reset-password?token=` | Does the link still work? `{ valid }`, consumes nothing; one answer for used, expired, tampered or erased (SCRUM-461) | 30/15min |

`forgot-password` always responds `{ ok: true }` with the same message whether or
not the address exists. The emailed link opens the **web** reset page in the
browser; there is no deep link into the app. Completing a reset revokes every
`mobile_refresh_tokens` row for that user, so all devices are signed out.

---

## Identity

Two names for one person, and which you get depends on where you are.

**`interestedPreview` was removed.** It returned `user.image` — real
photographs — for everyone who had favourited an event, to any authenticated
caller, with no identity gate. Unlike the roster, favouriting has no check-in,
no pseudonym and no reveal: it is a private act, and nobody who used it consented
to being shown. It was also harvestable by topic — favourite an event, ask for
the preview, collect faces of everyone else interested in that category.
`favoriteCount` is the social proof, and it was always on the payload.
`interestedPreviewLimit` is still accepted and ignored so builds in the field do
not 400 on the events list.

| Surface | You see |
|---|---|
| Event chat, participants, attendee list, sockets | **Pseudonym** — "Cosmic Panda" |
| Direct messages, message requests | Real name and photo — the **sender's**, to the person asked; the person asked stays an id to the sender until they accept (SCRUM-182) |

The pseudonym is one per person per event, stable for the whole event and across
check-out and check-in, and **different at every event** — there is no
cross-event identity. It lives on `chat_group_members.anonymous_name` and
survives the room closing, because historical messages resolve their author
through it.

Crossing from one column to the other is the message request, and it is the only
crossing: `GET /events/:eventId/checkins` returns pseudonyms, never real names or
photos — except for someone who turned on "Show who I am" in that room
(`event_match_preferences.revealed`), who is listed by name with `image`, the
same rule the Grid card already applied. Blocks are honoured in both directions everywhere, and are reported as
"not found" rather than "blocked" — confirming an account exists tells a blocked
person they were blocked.

**The roster is everyone checked in.** It used to be filtered on `onboarded`, a
non-null name and a non-empty `photos` array — three fields the endpoint does not
serve. Someone who had passed the GPS gate and was standing in the room was
absent from the list and from the count, for a reason nothing in the response
could explain.

It still will not equal `/matches`, and should not: matches select on
`check_in_time: { not: null }`, the roster on `status: "checked_in"`. Someone who
checked out stays matchable and stops being listed as present — "was here" versus
"is here".

### Room handles

A room never sends another person's real user id (SCRUM-371). Wherever a room
surface names somebody by id — the roster's `attendees[].userId`, the match
deck's `matches[].userId`, `participants[].userId`, every message's `user.id`
(and the group history's `user_id`, `deleted_by` and quoted
`parent_message.user.id`), the chat list's `lastMessage.user.id`, the
`group_message` push's `senderId`, and every `chat:*`, `event:*` and `room:*`
socket event — it sends that person's **room handle** instead: `rh_` followed by
an opaque, url-safe string. Field names and shapes did not change.

- **Your own id is always your real id.** Align your own bubbles, find your own
  check-in, drop your own typing and leave yourself off the roster exactly as
  before, by comparing with your id.
- **One handle per person per event.** Stable for the whole event and the same
  on every surface and socket event, so a card, a message and a match can be
  matched up. The same person at another event has an unrelated handle — there
  is no cross-event identity, for ids as for pseudonyms.
- **Every endpoint that takes a user id accepts a handle**: `GET /users/:userId`,
  `POST|DELETE /users/:userId/block`, `POST /users/:userId/report`,
  `GET /profiles/:userId`, `GET /profiles/:userId/interests`,
  `POST /message-requests` (`recipientId`), `POST /conversations`
  (`otherUserId`), `POST /friends/requests` (`userId`), `GET|DELETE
  /friends/:userId` and `POST /friends/:userId/conversation`. Raw ids still work
  on these.
- **Likes and waves take only this event's handles.** `POST /events/:id/matches/likes`
  (`userId`) and `POST /events/:id/waves` (`toUserId`) name somebody only by the
  handle that event's roster or deck gave you — or you by your own id, which is
  refused as "not yourself". A raw id, another event's handle and a forged
  handle are all answered exactly as an unknown person (likes `404 User not
  found`, waves `403 RECIPIENT_NOT_HERE`): these two answer from who is in the
  room right now, so a raw id asked "is this account here", and the per-pair
  wave window turned one raw-id wave into a way to find which handle it was.
- **A handle belongs to one room, of one kind.** An event's room scopes its
  handles by the event, exactly as before. A room of another kind scopes them
  by its own id and kind, so its handles are refused in every other room (an
  event's likes and waves included) and are not accepted by the profile,
  friend, block, report or message-request routes above: there they read as an
  unknown id, until those rooms say who may recognise whom.
- **A handle is not a lookup key for what the room hides.** The friends routes
  and `POST /conversations` resolve a handle only for someone you may already
  see (`identityVisible`); otherwise they answer exactly as for a stranger. A
  forged or tampered handle is answered exactly as an unknown user id.
- **A handle is answered in its own room's terms.** Whether you may see who a
  handle is follows what that event's roster shows: they chose "show who I am"
  in *that* event (and you checked in there), or they are a friend who turned
  on `friends_see_me_in_rooms`. A reveal at another event, a mutual like or an
  open conversation does not name them through this room's handle — a raw id
  still answers as before. For somebody the room keeps anonymous,
  `GET /users/:userId` returns only `{ id, name, age, location, isOwnProfile,
  identityVisible: false }` with `name` their pseudonym in that room;
  `GET /profiles/:userId` returns only `{ id, name, profile: { id, age,
  onboarded, location } }`; and `GET /profiles/:userId/interests` returns an
  empty list. The same rule decides the 409-or-201 answer of
  `POST /message-requests` and whether `POST /friends/requests` is refused.
  Otherwise `GET /users/:userId` also sends `work_field`, and, when
  `identityVisible` is false, `blurPhoto` (the stored derivative) in place of
  `image` and `photos` (SCRUM-458).
- **Echoes stay handles.** `GET /users/:userId`, `GET /profiles/:userId` (`id`
  and `profile.id`) and `POST /message-requests` (`recipientId`, `recipient.id`)
  return the ref you sent — a handle in, the same handle out — except for your
  own profile, which answers with your id.
- Handles are keyed to the server secret: rotating `NEXTAUTH_SECRET` retires
  every handle a client holds. Re-fetch the room rather than caching them.

---

### GET /me/attendance

The events behind the number. A profile has always reported
`stats.eventsAttended` with no way to see which events they were.

```
GET /api/mobile/me/attendance?page=1&limit=20
```

```json
{ "success": true, "data": {
  "events": [
    { "id": "…", "kind": "event", "slug": "…", "title": "Design Week",
      "cover_image_url": null, "start_time": "…", "end_time": "…",
      "venue_name": "The Humming Tree", "city": "Bengaluru",
      "attendedAt": "2026-08-14T18:04:00.000Z" }
  ],
  "pagination": { "page": 1, "limit": 20, "totalCount": 7, "totalPages": 1, "hasMore": false }
} }
```

Three things are worth knowing before building against it.

**`/me`, and there is no `/users/:id/attendance`.** Attendance history is where
somebody was, on which nights, at which venues — the correlation the whole
pseudonym design exists to prevent being assembled. Scoping it to the caller by
construction means there is no id in the path to get wrong and no later change
that widens it by accident.

**One entry per event, however many days of it you attended.** `event_check_ins`
holds a row per person per occurrence, so a three-day conference is three rows
and one event. `attendedAt` is the **first** check-in for that event — when you
arrived, not when you last turned up.

**`totalCount` is the same figure as `stats.eventsAttended`** on the profile, by
construction: the list and the count share one predicate, so they cannot
disagree. Working an event as staff is not attending it, and appears in neither.

An event the platform has since deleted is in neither the list nor the count,
so every page is full and `totalCount` is the number of events listed
(SCRUM-432).

**Places you went live at are in it too** (D-6), with `kind: "venue_day"`:
show them labelled as a place, by `venue_name`. A venue day's `title` is
bookkeeping ("Venue day · … · date") and is not for display.

### GET /me/rsvps

The events you said you are going to — what the app's **Going** tab lists above
your saved events. Until this route, RSVPs were only readable one event at a
time, so the tab showed hearts and never the events you had said yes to.

```
GET /api/mobile/me/rsvps?page=1&limit=20
```

```json
{ "success": true, "data": {
  "events": [
    { "id": "…", "slug": "…", "title": "Rooftop Sessions",
      "coverImageUrl": null, "coverImage": null,
      "startTime": "…", "endTime": "…", "timezone": "Asia/Kolkata",
      "status": "published", "venueName": "…", "address": "…", "city": "Bengaluru",
      "latitude": 12.97, "longitude": 77.59,
      "rsvpStatus": "waitlisted", "rsvpAt": "2026-09-20T10:12:00.000Z" }
  ],
  "pagination": { "page": 1, "limit": 20, "totalCount": 3, "totalPages": 1, "hasMore": false }
} }
```

- **`/me` only**, like attendance: where somebody is going is the same
  correlation, in the future tense.
- **`going` and `waitlisted`**, with `rsvpStatus` saying which, so a waitlisted
  place is never shown as a confirmed one. Not `maybe` or `not_going`.
- **Upcoming only, soonest first.** An event is listed until its `endTime`.
  Cancelled events stay, with `status: "cancelled"`; drafts and deleted events
  do not appear.

## Events

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/events` | List events (paginated, filterable) |
| GET | `/events/:eventId` | Get event details. Also carries `doorPolicy`, `details` (or null) and `amenities`, none of which the list has. `chatGroup` is `{ id, name, status, member_count }` — snake_case, the row as selected — or null. `categories[]` are the leaves as stored, `{ id, name, slug, description, icon }`, with no `parent`. `distance` is kilometres from `lat`/`lon`, and `null` (never absent) without them. `organizer.id` is null when the host is the platform |
| POST | `/events/:eventId/checkin` | Check in to event. 404 for a venue day's id: a venue's room is entered by going live (`POST /venues/:venueId/live`) |
| POST | `/events/:eventId/checkout` | Check out of event |
| POST | `/events/:eventId/favorite` | Toggle favorite/interest |
| DELETE | `/events/:eventId/favorite` | Remove favorite |
| GET | `/events/:eventId/interested-users` | `{ interestedCount, users: [], pagination }` — a count. `users` is always empty: who favourited an event is not disclosed |
| GET | `/events/:eventId/rating` | Your own rating → `{ rating: 1..5 \| null, review, ratedAt }`; null when you have not rated. Nobody else's is ever returned. 404 `NOT_FOUND` for an unknown or deleted event |
| POST | `/events/:eventId/rating` | Rate an event — stars 1–5, optional review; anyone with a check-in row, **once it has ended** (attendance, not presence: leaving does not forfeit it — SCRUM-181); one row per person, rating again edits it. Answers `eventStats: { ratingCount }` and no average, and the event's `stats` carry none either: an attendee who can poll an average reads each new score from its change (SCRUM-437) |
| POST | `/events/:eventId/rsvp` | RSVP — waitlists when full |
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

The organiser's event page (`/dashboard/events/:id`) carries a `connections` block. Attendance
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

`POST .../likes` takes `{ "userId": "<this event's room handle>" }` — the card's
own `userId` — and returns
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
| search | string | - | Fuzzy match across title, description, venue, city. **Not a scope** — "Bengaluru" also matches an event *titled* "Bengaluru Meetup" held in Delhi |
| city | string | - | **Scope the list to one city.** Exact, case-insensitive. Values come from `GET /events/cities` |
| lat | float | - | Latitude — sorts and labels by distance, never excludes |
| lon | float | - | Longitude |
| radius | float | **none** | Hard limit in **km**. No default: sending coordinates alone no longer filters |
| categoryId | uuid | - | Filter by category. Parent-inclusive — picking a parent sweeps in its children |
| categorySlug | string | - | Same, by slug |
| startDate | ISO date | - | Events starting after |
| endDate | ISO date | - | Events ending before |
| status | string | published | Event status filter |
| sortBy | enum | start_time | `start_time`, `created_at`, `distance` |
| sortOrder | enum | asc | `asc`, `desc` |
| include | string | - | Comma-separated: `checkins,activeCheckins,profile` |

**`radius` lost its default, and that was the point.** It used to be `10` km, so
any request carrying coordinates — which the home screen sends in order to sort
by distance — was silently cut to a 10 km box. Every section of that screen
reads from one such query, so a user outside the box saw an entirely blank page
telling them to "explore with location enabled". Distance is a sort and a label
now. Only `city` scopes a list, and only the check-in area refuses anyone, at
the door where refusing is the point.

**`checkInRadius` on `GET /events/:eventId` covers the whole check-in area**
(SCRUM-350). The door judges the event's real area — its own geofence (a copy of its
venue's, taken when the event is saved), a circle or an outline, plus its buffer. The app knows only a circle,
so `checkInRadius` is the radius around `latitude`/`longitude` that holds all of
that area: the farthest corner of an outline, or a circle's radius, plus the
buffer. It used to be the stored column, which only circles kept in step — a
~260 m stadium outline sent 60 or 100, and a phone inside the stadium read as
outside. The field's name and type are unchanged; for an outline it is larger
than before, which only ever makes the app more lenient than the door.

**`claim` on `GET /events/:eventId` is the app's "Running this event? Claim it"**
(step 1 of the product-completion plan). `{ url }` when the event was added by
Blendn (curated) and nobody has claimed it, and it is a page `/claim/[eventId]`
would show (published or completed, not private); `null` otherwise. The URL is
built by the server on the **dashboard host** (`DASHBOARD_HOST`, else
`NEXTAUTH_URL`), so the app hard-codes no environment and never sends a person
to the API host. It carries the event id and nothing about the viewer. The
page it opens is public: the claimant needs no account, filing grants nothing,
and a person reviews every claim. Computed by `offersClaim` in `lib/curation.ts`.

**`venue` on each card of `GET /events` is the place to name** — `{ id, name }`
of the venue the event is at, by the takeover's own test: a `confirmed` link,
or the event's own area at the venue (`atTheVenue`). `null` for a disputed
link, an auto-link whose area is elsewhere (any organiser can link any venue,
and a card must not lend them a famous bar's name), an archived or deleted
venue, or none; then say the organiser's free-text `venueName`. Only those two fields: never the venue's area
or owner. While the event has the venue (an hour before it starts until it
ends) `GET /venues` leaves the venue out, so this card is where the app says
"at The Humming Tree". Computed by `eventVenue` in `lib/venue-visibility.ts`.

**`session` is the window "live" is judged by** — on `GET /events`,
`GET /events/:eventId` and `GET /me/rsvps`. `startTime`/`endTime` span the
whole run, so a three-day festival read as LIVE for three days straight,
through the nights between days and through a cancelled last day, while the
door (which goes by occurrence) refused. `session` is `{ startTime, endTime }`
of the day running now, else the next day going ahead, else the last day that
went ahead (so it reads as ended); `null` when every day is cancelled. On a
single-day event it equals `startTime`/`endTime`. Computed by `eventSession` in
`lib/occurrences.ts`. The rating route's "once it has ended" uses the same
window.

**A check-in refused on the clock names the day** on a multi-day event:
`Day 3 starts Tue, Sep 29, 12:45 AM.` (`EVENT_NOT_STARTED`), `Day 2 has been
cancelled. Day 3 starts …` (`EVENT_NOT_STARTED`), or `Day 3 of 3 has been
cancelled, so the event is over.` (`EVENT_ENDED`), in the event's timezone. A
day still to come that is cancelled is skipped when finding the next one.
Single-day events keep "Event has not started yet" / "Event has already ended".

**Each category on an event now carries its `parent`** (or `null` at top level).
Events are tagged to **leaves** — an event is "Classical and Carnatic", never
"Music" — so a client wanting a whole family groups on the parent rather than
guessing from the leaf's name. The app's "Best Parties" section used to guess,
matching `party|night|club|music` as substrings, and therefore filed Classical
and Carnatic as a party.

### GET /events/cities

The city picker's list — every city with events, busiest first.

```json
{ "success": true, "data": { "cities": [
  { "city": "Bengaluru", "eventCount": 12, "centre": { "latitude": 12.9716, "longitude": 77.5946 } },
  { "city": "Mumbai", "eventCount": 3, "centre": null }
] } }
```

Pass `city` straight back to `GET /events` or `GET /events/search`.

**`centre` is where the home map goes when the city is picked** (plan v2
step 2): the mean of the city's listed events' points, folded on the same key
as the counts. Events with no point, or the 0,0 an unset point reads as, are
left out; `null` when none has a point, and the app leaves its map where it
is. A mean rather than a stored point, so it follows where the city's events
actually are (`cityCentres`, lib/address.ts).

**A city listed with N events opens with N events.** The counts apply the same
visibility, end-time and age rules as the browse query, so the two cannot drift
— a picker that promises three events and opens empty gets blamed on the app,
not the filter. Events with no city appear in neither, which is the same rule
applied consistently; `npm run backfill:cities` gives older rows a city.

Spellings differing only by case or whitespace are folded into one entry,
labelled with whichever spelling is most common.

### POST /events/demand

Fire-and-forget. Call it when the device's city is **not** in `GET /events/cities`
— the user is standing somewhere we have not launched.

```json
{ "city": "Saarbrücken", "country": "Germany" }
```

**One row per person per city.** Reopening the app is not a new signal, so send
this at most once per session; a second write from the same user changes the
count by nothing. That constraint is the measurement — *"forty people in
Saarbrücken"* has to mean forty people, and a log of opens would let one
enthusiast outrank a crowd.

No coordinates are stored. City and country are what a launch decision needs;
a per-open GPS trail would be a much larger promise about privacy than this
feature is worth. Rows cascade on account deletion.

### Pagination Response
```json
{ "pagination": { "page": 1, "limit": 20, "totalCount": 100, "totalPages": 5, "hasMore": true } }
```

### A venue day's id is not an event's

A venue's live room hangs off a hidden `events` row (`kind = venue_day`,
docs/VENUES.md). Its id is **not an event** to `GET /events/:eventId`, RSVP,
favourite, interest, the board, the room preview, rating or the plain
check-in: each answers `404` as for an unknown id. Go Live is its one door. The
room's own routes — `GET /events/:venueDayId/checkins`, `/matches`,
`/matches/likes`, `/matches/preferences`, `/waves`, `/presence`,
`/checkout`, `/chat` — work with it, for somebody live there now.

---

## Venues — the Hotspots feed

### GET /venues

The venue-shaped twin of `GET /events`. The Pulse answers *what is on*; Hotspots
answers *where is worth going*, and one screen switches between them — so this
takes the **same** `page`, `limit`, `search`, `city`, `lat`, `lon` and `radius`
vocabulary, meaning exactly what it means there.

```json
{ "success": true, "data": { "venues": [{
  "id": "…", "name": "The Humming Tree", "address": "12 Indiranagar",
  "city": "Bengaluru", "latitude": 12.97, "longitude": 77.59,
  "capacity": 300,
  "venueType": "live_music_venue", "venueTypeLabel": "Live music venue",
  "distance": 1.4,
  "upcomingEventCount": 2,
  "liveNow": "quiet",
  "nextEvent": {
    "id": "…", "title": "Friday session", "slug": "friday-session",
    "coverImageUrl": "https://…", "startTime": "…", "endTime": "…"
  }
}], "pagination": { "…": "…" } } }
```

| Parameter | Notes |
|---|---|
| `city` | Exact, case-insensitive. Venues with no city are unreachable this way, as with events |
| `lat` + `lon` | Enables `sortBy=distance` and populates `distance`. **Does not filter** |
| `radius` | km. **No default.** Only bites when you send it |
| `venueType` | One of the 35 slugs; anything else is a 400 |
| `sortBy` | `name` (default) or `distance` |

60 a minute per person, then 429 — every row carries a live count, as on the
venue page.

**Active venues only.** `archived` is how a venue is retired without deleting
the events that happened in it, so it never appears in discovery.

**A venue a real event has taken over is not listed** (plan v2 step 2). From an
hour before an event at it starts until that event ends, the place is the
event's: the venue is left out of this list (and its `totalCount`), Go Live
there answers `EVENT_LIVE_HERE`, and the event's card on `GET /events` names the
venue (`venue`). The event must be published, public and not deleted; its link
not `disputed` (an unset link is a link); linked by a `confirmed` link, or with
its area at the venue; judged per day of a multi-day run (D-2), so the nights
between days hide nothing; and one the caller may attend (D-3), so a 21+ night
does not hide its venue from a 19-year-old. A venue's own Go Live day never
hides it (F3). One rule, `lib/venue-visibility.ts`, for this list, the venue
page and the door.

**`liveNow` is a bucket, never a number** — `quiet` (fewer than 5, none
included), `5-9`, `10-19` or `20+`: the same figure as `live.liveNow` on
`GET /venues/:venueId` (both count through `liveGuestIds`: distinct guests,
never staff), read at most once a minute per venue and slow to fall (D-19,
F14). You are left out only when the figure counted you, so going live or
leaving inside the minute moves nothing you see. **`null`** for a caller the
venue page would refuse — not onboarded, or no known adult age — and the app
hides the chip.

**Order** is by name, then id (or distance, then id): two venues with one name
keep one order, so a page boundary between them never repeats or skips one.
A venue taken over between your page reads shifts the offsets (a venue may be
skipped, none repeated); dedupe by `id` regardless.

**The card image comes from the next event.** `venues` has no image column.
Rather than a wall of grey cards or an invented placeholder, each venue carries
the soonest public event it is hosting — which supplies the artwork and doubles
as the reason to tap. Nothing upcoming returns `nextEvent: null` and
`upcomingEventCount: 0`, so no card claims something is happening when nothing
is; draw the type-based fallback.

**`upcomingEventCount` and `nextEvent` are one question asked once.** Same
filter object, so a card cannot say "3 upcoming" and then headline an event that
is not one of them. An event whose link the venue disputed is in neither: the
owner said it is not theirs.

**The age gate applies here too.** `nextEvent` is a real event shown to a real
person, so it passes the same `min_age` rule as the browse query — otherwise the
18+ event the feed correctly hides reappears, title and cover art intact, as the
headline of a venue card. An **unknown** age hides nothing, matching `GET /events`.

`distance` is kilometres, or `null` when either side has no fix — not `0`, which
a client would render as "here".

**No "most going on" sort, yet.** That is the ordering Hotspots actually wants,
and it is absent rather than faked: Prisma's `orderBy: { events: { _count } }`
counts *every* related row, so it would rank by an all-time total including
cancelled drafts — a different number from the one on the card. Ranking the page
you were handed is not ranking the set, and the difference shows the moment
there is a second page. Needs raw SQL.

### GET /venues/:venueId

One venue, as the Go Live screen needs it. 404 for an unknown, archived or
deleted venue; 403 `FORBIDDEN` for a profile not onboarded, `AGE_RESTRICTED`
for one with no known adult age (as at its door). 60 a minute per person, then
429.

```json
{ "success": true, "data": {
  "venue": { "id": "…", "name": "The Humming Tree", "address": "…", "city": "Bengaluru",
             "latitude": 12.97, "longitude": 77.64,
             "venueType": "live_music_venue", "venueTypeLabel": "Live music venue",
             "claimed": false },
  "live": { "open": true, "closedReason": null, "eventId": null,
            "liveNow": "quiet",
            "youAreLive": true, "expiresAt": "2026-10-02T21:20:00.000Z", "stay": false,
            "venueDayId": "…", "chatGroupId": "…" },
  "tonight": { "id": "…", "title": "Friday session", "slug": "…", "coverImageUrl": null,
               "startTime": "…", "endTime": "…" },
  "claim": { "url": "https://dashboard.blendn.app/claim/venue/…" }
} }
```

| Field | Meaning |
|---|---|
| `live.open` | Whether going live here would be accepted now, the fence aside |
| `live.closedReason` | `event_live_here` (a real event has the venue: check in to `live.eventId`) or `no_check_in_area` (nobody drew this venue's area — judged against the same area as the door: today's copy once anybody went live) |
| `live.liveNow` | `quiet` (fewer than 5, none included), `5-9`, `10-19` or `20+`. **Never a number** (D-19, D-x2): a count that moved from 4 to 5 as you watched would tell you somebody just walked in. Guests only (not the venue's staff), never counting you, read at most once a minute per venue, and slow to fall (it drops a bucket only once one more person would not hold it) |
| `live.youAreLive` … `chatGroupId` | Your own window. Count down from `expiresAt`, never from the tap; open the room by `venueDayId` / `chatGroupId` |
| `venue.claimed` | False: the app may offer "Own this place? Claim it" |
| `claim` | `{ url }` for an unclaimed venue: the public claim page (`/claim/venue/:venueId`) on the dashboard host, built for the environment the app talks to — open it as given. Null once claimed. As `claim` on `GET /events/:eventId` |
| `tonight` | The next public event here before the venue's day resets (06:00 local by default), age-filtered for you, or null |

**Not on it:** the check-in area (no payload draws the boundary), and who is
live. People are the venue day's roster and grid
(`GET /events/:venueDayId/checkins`, `/matches`), which only somebody live
there may read — you see people only while you can be seen.

### POST /venues/:venueId/live

Go Live: be visible at this venue for a window you choose.

```json
{ "latitude": 12.9784, "longitude": 77.6408, "deviceInfo": { "gpsAccuracy": 12 },
  "minutes": 20 }
```

`minutes` is `20`, `45` or `60`; or send `"stay": true` instead — 60 minutes,
then each presence ping **inside** the area carries it on 20 minutes past the
ping, up to four hours from the first time you chose "stay" at this venue
today (choosing it again does not restart the four hours). Anything else is
`400`.

```json
{ "success": true, "data": {
  "venueDayId": "…", "chatGroupId": "…",
  "expiresAt": "2026-10-02T21:20:00.000Z", "stay": false, "stayUntil": null,
  "checkIn": { "id": "…", "status": "checked_in", "checkInTime": "…" },
  "revealSuggestion": false, "intentNeeded": false
} }
```

- **No window runs past the venue's reset** (06:00 local by default): a session
  open then ends `expired` there, and tomorrow is a new room with new
  pseudonyms. In the last five minutes before the reset, Go Live opens
  tomorrow's room.
- **Going live again while live extends**, never shortens, and the room is not
  told of an arrival. Going live somewhere else, or checking in to an event,
  ends it as a switch.
- **When it ends** you are checked out (`departed_source = expired`), and the
  venue's room is closed to you at that second — reading, posting, the socket,
  the roster and the grid answer `403 NOT_LIVE` ("You're not live here any
  more. Go live at the venue to join today's room."). Your sockets get
  `live:ended` (docs/SOCKET_EVENTS.md) and leave its rooms. Leave early with
  `POST /events/:venueDayId/checkout`.
- **When a public event at the venue starts** — its link confirmed by the
  venue, or its own area at the venue — everyone live there is checked out
  (`ended`) and pushed once: "An event just started here — tap to check in"
  (`kind: event_update`, `data.eventId`). The words are ours, never the event's.
- `POST /events/:venueDayId/presence` answers `expiresAt` too, and a ping past
  the end answers `{ status: "checked_out", reason: "expired" }`.

| Refusal | When |
|---|---|
| 403 `PLUS_REQUIRED` | `stay` while Plus gating is on (off today: "stay" is everyone's) |
| 404 | Unknown, archived or deleted venue, or today's room there was deleted |
| 403 `FORBIDDEN` / `AGE_RESTRICTED` | Not onboarded / no known adult age (an unknown age is refused here) |
| 409 `EVENT_LIVE_HERE` | A public event at this venue (link confirmed, or its own area at the venue) is on, or starts within the hour. The body carries `eventId`: hand off to that event's check-in. Checked before the fence |
| 400 `GPS_TOO_VAGUE` | A fix worse than 150 m (`deviceInfo.gpsAccuracy`): a better fix where you stand, not directions |
| 400 `NO_CHECK_IN_AREA` | Nobody has drawn this venue's area: no position fixes it |
| 400 `OUT_OF_RANGE` | A position outside the area — "You're not at ‹venue› yet.", never a distance. Before step 5 this code also covered the two rows above; the event check-in still uses it for all three. A refusal writes nothing: no venue day is made for it |
| 429 `RATE_LIMITED` | 20 a minute per person; ceilings per address and per venue |

```json
{ "success": false, "error": "Friday session is on here. Check in to it instead.",
  "errorCode": "EVENT_LIVE_HERE", "eventId": "…" }
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

**Rooms of every kind (step 7).** A room has a kind: an event's room, a board
post's (its author and the askers the author accepted), a crew's (its members
now — see Crews), and a Blend's (see Blends). The `/chat/groups/:chatGroupId/...` routes take a room of any kind and
admit whoever its owner admits — for a room that is not an event's, a
membership row alone is not enough, and a refusal reads exactly as "not a
member". Every id they send is a handle in that room's own scope (see Room
handles). `GET /chat/groups` lists event rooms in `groups` (each
`kind: "event"`, with its `event`) and crew and Blend rooms in `rooms` — see
below; a board post's room is not listed. In a board post's room the roster (`/participants`) lists only the
people its owner admits, an asker in a block with the author is out, writes
stop 12 hours after the event ends (`CHAT_CLOSED`), and a withdrawn or
taken-down post closes the room (404). To block or report somebody there, use
the board's own routes (by post or by ask): the user routes read a board
room's handle as an unknown id. In a crew's room people are named by **first
name** (history, live messages, typing, roster, reply push) — they are there
because a friend invited them and they said yes — and a member who leaves or is
removed is out of the room at once, their row kept `left` for the history.

### GET /chat/groups
Lists every **event** room the caller is still a member of: `active` and **`muted`** memberships (a mute silences, it does not banish — the room stays readable and a post is refused with the reason), in `active` and **`locked`** rooms (read-only until the organiser reopens it). Each row carries `membership.status` and the room's `status` so the client can label _Muted_ / _Locked_. Banned and left memberships, and archived rooms, are not listed.

**`rooms`: crews' and Blends' rooms (step 9).** Beside the paged `groups`, the
response carries `rooms` — the caller's crews' chats and their Blends' rooms,
each `{ id, kind: "crew" | "blend", name, crewId, blendId, closesAt,
unreadCount, mute, lastMessageAt, lastMessage, membership, status }`, newest
message first, not paged (at most ten crews and a night's few Blends) — sent
with the first page, and `[]` on later pages. Each is
listed as its door admits the caller now: a crew's while they are in the crew;
a Blend's only while it is open (`closesAt` is its clock — gone from the list
then, sweeper or not) and never to two people a block across it parted.
`lastMessage.user` is named as that room names people: a crewmate's first
name; in a Blend, tonight's pseudonym (a reveal names people on `GET /blends`,
never in the chat). Own list rather
than more `groups` rows because an installed app reads `event` off every
`groups` row, and these rooms have none. A hidden crew's chat stays listed to
its members — hiding takes a crew off every surface outside it, not its own
chat (C12) — while a Blend with a hidden side is gone for everyone.

**Nothing in a row comes from somebody in a block with you.** On every row,
`groups` and `rooms` alike, `lastMessage` and `unreadCount` leave out messages
from anybody you blocked or who blocked you — the same filter the room's
history applies — so a blocked person's line is never previewed, named or
counted. On `rooms`, `lastMessageAt` is the time of the newest message you can
see, and the list is ordered by it. (A `groups` row's `lastMessageAt`, and the
paging order, are still the room's own last message.)

### POST /message-requests
**`message` is required.** A request with no message is indistinguishable from a
like with a reveal stapled to it, and the two are separate actions:

| | Like | Connect (message request) |
|---|---|---|
| Who learns | nobody, unless mutual | the recipient, immediately |
| Identity | stays pseudonymous | **sends `sender.name` and `sender.image`** |
| Conversation | opens on mutual, pseudonymous | opens on accept, real names |

The reveal is deliberate, not a leak: the anonymity exists to stop people being
*identified*, not to let people send unsolicited messages without
accountability. Anonymous plus unsolicited is the harassment shape. It is also
what makes the recipient's decision possible — "Someone wants to connect" is a
coin flip.

Guards, in order: rate limit, self-send, recipient exists, blocks either way,
closed pair (an unmatch — same 404 as a block, so the refusal never says "this
person ended it"), `haveSharedAnEvent`, existing request, existing
conversation. And
`@@unique([sender_id, recipient_id])` means **one request per pair for all
time** — decline it and that person can never send another.

**The last two refusals are said only to someone who can see who this is**
(SCRUM-371). An existing request or conversation is a fact about the pair, and a
room handle hides the pair: a friend DM would otherwise answer 409 and pick the
friend out of a roster. To a caller for whom `identityVisible` is false they
answer `201` with the created-request shape and a fresh id, write nothing and
notify nobody. The 409s are unchanged for everyone else — the app can read the
same facts from `GET /users/:userId`'s `connection`.

### GET /conversations
Each conversation carries **`fromMatch`** — it opened from a mutual like rather
than from an accepted message request.

It has to be a server field. The payload carries the *resolved* name and
`theyRevealed`, and `mayShowRealName` returns `true` for **both** a
never-pseudonymous conversation and a revealed match, so `theyRevealed` cannot
tell them apart. Anything built on it would greet every accepted message request
as a new match. Derived from `user1_pseudonym`/`user2_pseudonym`; the pseudonyms
themselves are never sent.

Each conversation (list row and `GET /conversations/:id`) also carries
**`pseudonymous`** — whether there is anything left to reveal. It is `false` for
a conversation from an accepted message request, which has real names from the
moment it exists because the request was the crossing. The app used to infer
this from the reveal fields being *absent*, and the routes always sent them, so
an accepted request drew the match header — "You can see their name. They can't
see yours." — and a reveal button the server refuses with 400.

### GET /events/:eventId/chat
The response carries a **`write`** block:

```json
{ "allowed": false, "reason": "window_closed",
  "message": "This chat has closed. Event chats stay open for 24 hours after the event ends.",
  "closesAt": "2026-08-17T22:00:00Z", "eventEndedAt": "2026-08-16T22:00:00Z" }
```

`reason` is one of `locked | archived | window_closed | not_open_yet | hidden |
not_live | muted | banned | left`, or `null` when writing is allowed; `message` is null
when allowed and for `muted`, `banned` and `left`. The composer used to guess: every refusal came
back as a single `NOT_CHECKED_IN` covering several unrelated situations, so the
app either showed the wrong reason or let someone type a paragraph and then threw
it away. `closesAt` lets the room show an honest countdown.

**Write access is attendance, not presence.** A `chat_group_members` row means
you were physically at the event; checking out does not revoke it. See
`mayWriteToRoom` in `lib/chat-window.ts`.

**Except in a venue's room.** A venue day's room is for the people live in it:
read, write and the socket join answer `403 NOT_LIVE` once your Go Live has
ended, and there is no auto-join — going live is the only way in. It closes at
the venue's reset (`closesAt` is the reset, not a day later).

### GET /chat/groups
A venue's room (a venue day) is listed only while your Go Live there is open;
once it ends the room leaves the list — its last message and counts are not
readable from outside a room you can no longer open. Its row's `event.kind` is
`venue_day` (an event's room says `event`): name it by the row's `name`, which
is the place, not by `event.title` ("Venue day · ‹place› · ‹date›", bookkeeping).
`event.venueId` is the place ("Go live again" opens it). Its `memberCount` is
**null**: an exact count of a venue's room, moving as people go live and
expire, is the differencing the venue's bucket exists to stop (D-19).

Each group carries `isCheckedIn` — the caller is `checked_in` to that event with
no `check_out_time`, so the room is live for them right now. The app lifts those
rooms into The Banter's "Live now" rail and leaves them out of Recent.

It is a server field because the client cannot derive it: it has the room and the
event's times, but "the event is underway" is not "I am there". Someone who never
turned up, or who left an hour ago, has a room whose event is mid-flight.

### GET /chat/groups/:chatGroupId/messages
| Param | Type | Description |
|-------|------|-------------|
| before | uuid | Cursor: message ID to fetch before |
| limit | int | Messages per page (default 50) |

**The shape is the stored row, snake_case** — `created_at`, `is_edited`, `edited_at`, `parent_id`, `client_id`, `deleted_at`, `deleted_by`, `moderation_status`, plus `moderation_hidden`, `user`, `reactions` (tallies), `parent_message` (`{ id, type, metadata, content, user: { id, name } }` or null) and `_count.replies`. It is not the camelCase message of `GET /events/:eventId/chat`; `pagination` is `{ hasMore, nextCursor }`.

**Who may read (SCRUM-205):** an `active`, `muted` or `left` member. A `banned` member gets `403 USER_BANNED` — "The organiser has removed you from this room." when a person pressed Ban. A ban nobody pressed is the one a suspension leaves behind, and only a restored account can reach this point, so it reads "Your account was restored, but you are not back in this room yet. Check in at the event to rejoin it." Checking in lifts that ban (SCRUM-291). A draft or deleted event's room answers `404`. The same rule (`roomReadDenial`, `lib/chat-window.ts`) governs `GET …/participants`, `GET /events/:eventId/chat` and the socket's `join:chat`; before it, the three GETs served the room to anybody with a membership row, banned included.

### POST /chat/groups/:chatGroupId/messages
```json
{ "content": "string", "type": "text|image|video", "metadata": { "mediaUrl": "url?" }, "parentId": "uuid?" }
```
**Media (SCRUM-426).** `metadata` takes `mediaUrl` and nothing else; any other key is `400`. The server writes the rest, such as `sponsored_message_id`, which the app uses to draw a sponsored card. `mediaUrl` must be the sender's own chat upload (`POST /uploads/presigned-url` with `folder: "chat"`, so `chat/<yourId>/…` on our bucket). Anything else is `400` "Send photos through the app rather than linking to them". The same rules apply to `POST /events/:eventId/chat`. What is stored and sent to the room is a copy of the upload that nobody can write to (SCRUM-425), so `metadata.mediaUrl` comes back different from the one you sent. That copy's key is `chat/sealed/<uuid>` and names nobody (SCRUM-448); the upload's `chat/<yourId>/` key is never shown to anyone else. An upload that never arrived, is over 50 MB, or is not an allowed type is `400`. The same applies to a DM's `mediaUrl`.

**Moderation (pre-emit):** Messages go through a 3-layer pipeline **before** being broadcast to other users:
1. **Spam check** (sync) — burst rate, duplicate, link density → blocks with 429
2. **Keyword filter** (sync, <1ms) — slurs/profanity in 9 languages → saves as hidden, returns `moderation_hidden: true`
3. **OpenAI Moderation** (pre-emit, 1s timeout) — AI content analysis → hides before broadcast

If caught, response returns `{ moderation_hidden: true, content: null }`. The message is never emitted via socket.
If OpenAI times out (>1s), message is broadcast and moderation falls back to async (socket delete event).

**Error codes:** `USER_MUTED` (403), `USER_BANNED` (403), `CHAT_LOCKED` (403), `NOT_CHECKED_IN` (403), `LEFT_ROOM` (403), `NOT_LIVE` (403, a venue's room after your Go Live ended), `SPAM_BLOCKED` (429)

**Rate limit:** 30 sends a minute per person, across this route and `POST /events/:eventId/chat` together, whichever token or device they send from → `429 RATE_LIMITED` (SCRUM-439).

### Event Chat: POST /events/:eventId/chat
Same moderation pipeline and error codes apply.

### Leaving, muting and reporting a room

| Method | Endpoint | Result |
|--------|----------|--------|
| POST | `/chat/groups/:chatGroupId/leave` | `{ chatGroupId, left: true }` — idempotent |
| DELETE | `/chat/groups/:chatGroupId/leave` | Rejoin → `{ chatGroupId, left: false }` — idempotent |
| POST | `/chat/groups/:chatGroupId/mute` | Body `{ until?: ISO \| null }` → `{ chatGroupId, mute: { muted, until } }` |
| DELETE | `/chat/groups/:chatGroupId/mute` | → `{ chatGroupId, mute: { muted: false, until: null } }` |
| POST | `/chat/groups/:chatGroupId/report` | Body `{ reason, description? }` → 201 `{ reported: true }` |

All five answer one `404 NOT_FOUND` for a malformed id, an unknown room, a draft
or deleted event's room, a room whose owner does not admit you, or a room you
have no membership in (report alone still accepts a room whose event was taken
down). **Reporting a room is an event room's only** — it is filed against the
event — so it answers 404 for a room of any other kind; report its messages one
by one (`POST /messages/:messageId/report`), which works in every room.

**Leaving** marks the membership `left` with `left_at` — kept, not deleted,
because your pseudonym on past messages resolves through it. Until you come
back the room is closed to you: `GET /events/:eventId/chat` answers
`403 LEFT_ROOM` with `chatGroupId` in the body **instead of rejoining you**,
history, roster and polls answer as for a non-member, a post or reaction is
`403 LEFT_ROOM`, the socket join is refused, and no push from the room reaches
you. Your live sockets leave `chat:{id}` and the room gets `chat:memberLeft`.
Opening the room never rejoins you — the Room tab loads it for the event you
are checked in to, so it would undo the leave the moment the tab was shown.
**Two ways back:** checking in to the event again (the check-in clears
`left_at`), or `DELETE …/leave` while the room is open. A person muted by the
organiser when they left comes back muted. The sweeper's `left` (archived room)
and account deletion's keep their old behaviour; only `left_at` marks a choice.

**Muting** is yours and silent: it stops the room's pushes to you — a reply to
you, an organiser's announcement and its bell row — and nothing else. Not the
organiser's mute (`member_status = muted`), which stops a person posting.
Stored in `chat_group_members.notification_preferences` as
`{ muted, muted_until }`; a lapsed `until` reads as not muted. `until` must be
in the future and at most a year away. The state is returned as `mute` by
`GET /events/:eventId/chat` and on each `GET /chat/groups` item.

**Reporting a room** is for what no single message shows. Members only, any
status — somebody who left or was banned may need it most. Stored in
`event_reports` with `chat_group_id`; the admin queue shows it as "Room" and
does not offer Delist.

---

## Private Conversations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/conversations` | List conversations |
| POST | `/conversations` | Open a conversation — **requires an accepted request**; a closed pair gets 409 "This conversation was closed and cannot be reopened", as the respond route answers (SCRUM-300) |
| GET | `/conversations/:id` | Get conversation |
| GET | `/conversations/:id/messages` | Get messages |
| POST | `/conversations/:id/messages` | Send message. A `mediaUrl` must be the sender's own chat upload, or `400` (SCRUM-426) |
| DELETE | `/conversations/:id` | **Leave — closes it for both people, permanently** |

#### Opening a thread, delivery, replies and retries (SCRUM-406, 408, 409, 410)

- **`GET /conversations/:id/messages`** (first page, no `before`) returns `firstUnreadId` and `unreadCount`, answered **before** anything is marked. The app opens at that message with an "Unread messages" divider. The same call then marks the **whole** thread read and delivered, not only the page, so the inbox count clears. Older pages mark nothing.
- **Delivered.** Each of your own messages carries `deliveredAt`: null until the recipient's app has it, which is any of:
  - a socket ack (`private:delivered`);
  - loading this thread;
  - loading the inbox (`GET /conversations`).
  The sender is told over the socket. Delivered is shown whatever the recipient's `read_receipts` setting; read stays gated.
- **Replies.** `POST` takes `replyToId`, which must be a message in the same conversation, otherwise `400`. Every message carries `replyTo: { id, senderName, text, mediaType, unavailable }`. `senderName` resolves through the reveal rules (a pseudonym until revealed). A quote of a hidden message is `unavailable: true` with no text.
- **Retries.** `POST` takes `clientId` (a uuid the app makes per message). A repeat with the same `clientId` returns the first write instead of writing a second; a `clientId` already used in another conversation gets `409`. Both room write paths accept `clientId` the same way.
- **Rate limit.** 30 sends a minute per person → `429 RATE_LIMITED`, counted before the conversation is looked up, so sends refused with `404`/`403`/`400` count too (SCRUM-451). A retry of a send that landed is answered over the limit and does not count.

`POST /conversations` does not create a channel out of nothing. It requires an
accepted message request between the two people, or a conversation that already
exists — otherwise `400`. A block in **either** direction makes both this and
sending return as though the other person were not there.

#### What checks a direct message

**Deterministic checks only: keyword, spam, contact details. No model, and that
is a decision rather than a gap.** A model check sends an unreviewed private
message to a third party and, on a hit, turns it into something a human may
read. Nothing here is read by anybody unless the recipient reports it.

Until this landed, a DM was checked by **nothing at all**. `lib/moderation` was
imported by exactly two files and both were group chat — so the one channel
where somebody is alone with a stranger was the one channel nobody was watching,
and `contact-info.ts`'s own docstring names the DM as where the harm it targets
lands.

| Check | What happens |
|---|---|
| **Spam** | Refused, `429 SPAM_BLOCKED`. A flood is the one failure the recipient feels immediately — so it is stopped at the door and the sender is told. Counted per conversation, so messaging ten people is not throttled as flooding one |
| **Keyword** | Stored hidden, never delivered, and the sender is told (`moderation_hidden: true`). Not a silent drop — somebody who thinks a message arrived and gets no reply concludes they were ignored |
| **Contact details** | Flagged and **delivered**. Refusing teaches the sender exactly where the boundary is, and the next attempt is spelled out with nothing behind it |

A hidden message is stored and not sent. It has to be stored:
`moderation_flags.message_id` is a `NOT NULL` foreign key to `chat_messages`, so
a flag against a DM is structurally impossible and the row itself is the only
record a later report can rest on. It is excluded from the thread, from the
inbox preview, and from the unread count — the last is the one that gets
forgotten, and leaving it in is a badge nobody can clear on a thread with
nothing in it to clear.

**`private_messages.moderation_status` is NULL for an ordinary message, and NULL
is not "clean".** No model runs here, so there is no clean bill to record;
writing one would store an unchecked message as checked, which is exactly the
defect `G3` describes in the group pipeline.

### Profile photos

Every photo added through `PUT /profiles/:userId` is checked before it is
stored. Three gates, cheapest first:

1. **Ours, and yours.** The URL must point at an object in our bucket under
   `profile/<your-id>/`. Anything else is refused with `not_ours` — upload
   through `POST /uploads/presigned-url` and post back the `publicUrl` you were
   handed. This gate exists because the other two *fetch* the URL, and a field
   the server fetches is an SSRF primitive otherwise.
2. **Not blank** (`too_small`). One metadata call, no download. A solid colour
   or a lens cap compresses to a few KB where a photograph is hundreds.
3. **Not harmful** (`unsafe`). OpenAI omni-moderation, which is free.

What is stored, checked and moderated is a copy of the upload with a key of
its own (SCRUM-425), so `photos` comes back with different URLs from the ones
you sent. Send those back when you reorder or remove. The blank and size gates
are applied to the copy; a file that is not an image is `wrong_type`.

Only URLs not already on your profile are checked, so re-saving is cheap, and
the checks run concurrently.

Moderation **degrades open**: if it cannot run, the upload succeeds and the row
records `checked: false` for a later sweep. A vendor outage must not stop
somebody having a profile picture.

**A photo moderation pulls stays pulled** (SCRUM-479). The check runs after
the response, and a `hide` verdict takes the photo off `photos` (and
`User.image`, and a primary's `blur_photo` with it). The object leaves the
public bucket, so its URL answers 404 for everyone who was already served it.
It is kept privately for its 180 days, per docs/RETENTION.md. A later save that
still lists the URL, or re-sends that `blur_photo`, has it dropped silently. The
rest of the save goes through, so the app should re-read `photos` from the
response.

**It does not verify the photo is of you**, or of a person at all. Moderation
scores harm, not subject matter — a photo of a dog passes.

**`User.image` is a mirror of `photos[0]`**, nothing else. Provider avatars from
Google are no longer taken at signup: an avatar is not a choice, and it had
never been through the checks above. Clearing every photo clears it too.

**`blur_photo` is the blurred copy of `photos[0]`** (SCRUM-476), and what a
viewer who cannot identify you sees instead of your photos (`blurPhoto`). Make
it on the device (40 px wide), upload it like a photo, and send its `publicUrl`
as `blur_photo` — with the photos or after them. It is held to the photo rules
with two differences:

- **Small, not large:** anything over 4 KB is `too_large` — the app's 40 px
  JPEG is 1–2 KB, and a file much bigger is sharp enough to be the photo. There
  is no blank-image floor. It is moderated and recorded like a photo.
- **It never outlives its photo.** A save that changes `photos[0]` without a new
  `blur_photo`, or leaves no photos, clears it; so does moderation pulling the
  primary. A blur sent with no photo on the profile is refused (`no_photo`).

Like `photos`, it comes back as the sealed copy's URL; sending that back
unchanged does not copy it again. `null` clears it.

### Revealing

A conversation opened by a mutual like carries **the same pseudonym the match
card showed**. Real name and photos appear only when that side reveals.

| Endpoint | Effect |
|---|---|
| `POST /conversations/:id/reveal` | Your side becomes visible to them |
| `POST /conversations/:id/reveal` with `{ "ask": true }` | Ask them to reveal |

Each side moves independently — revealing is a standing offer, not a trade, so
going first does not expose the other person and waiting is not a refusal. It is
**not retractable**: nothing can unsee a name and a face, and there is no path
back to `false`.

Revealing without a name and a photo is refused with `reveal_incomplete`.
Otherwise the switch turns on and the other person's screen is unchanged, so
they conclude the feature is broken rather than that the profile is empty.

**Asking has no decline.** The request is one boolean on the side being asked,
so asking twice writes the same value and cannot nag, and there is deliberately
no refusal to deliver. Someone who does not want to reveal simply does not, and
the asker sees "requested" rather than "refused". Asking somebody who has
already revealed is a `400` — there is nothing left to ask for.

**A side already public in the room starts revealed.** If you were visible on
the match card, the person who saw it has nothing left to be shown, so your side
is seeded `true` at match time and only theirs is pending. Revealing in the room
later carries into DMs from that room; un-revealing there does **not** carry
back.

`GET /conversations` and `GET /conversations/:id` return `youRevealed`,
`theyRevealed` and `revealRequested`, and gate the other person's `name` and
`image` on their state — the inbox has to hold the pseudonym on its own, since
it renders before anything is opened.

Conversations from an accepted **message request** have no pseudonym and show
real names throughout, as they always have.

### Notifications from a match

Three, and **none of them carries a name — not even a pseudonym.**

| Moment | Body |
|---|---|
| Mutual like | "Someone you liked has liked you back." |
| Reveal requested | "Someone you matched with wants to see who you are." |
| They revealed | "Someone you matched with showed you who they are." |

A lock screen is not an authenticated surface, and a dating match visible to
whoever picks the phone up is a safety problem rather than a UX one. A body that
carried a name would also have to branch on reveal state to stay correct, and
the branch that leaks is the one that ships. Each carries `conversationId` in
`data` so the app can deep-link; identity lives in the app, behind auth.

The match notification goes to the **earlier** liker only. The person who just
tapped Like is holding the phone and gets the mutual in the response.

### Blocking

Blocking is `POST /users/:id/block`, and it now reaches every surface rather
than only DMs:

- the conversation between you **closes** (see above) — block implies unmatch
- their messages leave your **event room history**, live socket stream and push
  notifications, in both directions
- you are not told when they check in to an event you are at
- pending message requests are cancelled **both ways**, and an old request
  cannot be accepted into a conversation between two blocked people

Unblocking (`DELETE /users/:id/block`) restores profile visibility and the
ability to receive a request. It does **not** restore the match: leaving is
permanent whichever door it came through.

### Leaving a conversation

`DELETE /conversations/:id` **closes**, it does not delete. The conversation
leaves **both** inboxes, refuses new messages, drops out of both people's socket
rooms, and the pair never appears on each other's match cards again. There is no
way back: a later mutual like returns `{ "mutual": false }` and an accepted
message request returns `409`.

Two things it is worth being precise about:

- **It is mutual, not a personal hide.** A one-sided hide would leave the other
  person writing into a conversation you had left. They would get no reply, but
  they could keep sending.
- **Nothing is destroyed.** The rows are retained so a report filed about the
  conversation still resolves to readable content. This route previously
  hard-deleted and cascaded the messages, which meant the subject of a report
  could erase the evidence against themselves.

**Leaving and reporting in one call.** `POST /conversations/:id/leave` takes
`{ action: "unmatch" | "block", report?: { reason, description?, messageId? } }`
and does all of it in one transaction. That is why it exists alongside `DELETE`:
composing close and report as two client calls can half-fail into a closed
thread whose evidence is out of reach, which is the state this design exists to
prevent. Omit `report.messageId` to report the person rather than a message.

Reporting a message requires that you could see it — group membership, or being
a participant in the DM. It deliberately does **not** require the conversation
to still be open, so somebody who leaves and only later decides to report still
can.

Leaving also removes the identity you had shown: `GET /users/:id` returns a
pseudonym afterwards, even though the mutual likes still exist. It does **not**
un-reveal anything already seen — nothing can.

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
request status. A request that is not yours to answer is `404` — the same as one
that does not exist (it was `403`), so a sender cannot use `respond` to check
which request ids are real.

---

## Friends

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/friends` | My friends, newest first, and `count` |
| GET | `/friends/:userId` | A friend's profile (404 for anyone else) |
| DELETE | `/friends/:userId` | Unfriend — silent, leaves any DM alone |
| POST | `/friends/:userId/conversation` | Open (or find) a DM with a friend → `{ conversationId }` |
| GET | `/friends/invite` | My invite link `{ token, url }`, made on first ask |
| POST | `/friends/invite` | Reset it — the old link stops working |
| GET | `/friends/invite/:token` | Who sent this link → `{ person, state }` |
| GET | `/friends/invite/:token/preview` | **No auth.** Signed-out invite screen → `{ name, photoUrl }` — first name only. Per-IP limit (20/min). Same 404 |
| GET | `/friends/requests` | `{ incoming, outgoing }` |
| POST | `/friends/requests` | Ask: `{ token }` or `{ userId }` → `{ state: "requested" \| "friends" }` |
| POST | `/friends/requests/:id` | `{ action: "accept" \| "dismiss" }` — recipient only |
| DELETE | `/friends/requests/:id` | Withdraw — sender only. Kept as withdrawn: asking again later neither re-notifies nor undoes a "Not now" |

**Nobody can be looked up.** There is no search. A request reaches someone only
through their invite link (`https://www.blendn.app/f/<token>`, 128 random bits,
resettable) or, by `userId`, someone you can already see under
`maySeeIdentity` — a match, a conversation, someone public in your room. Every
refusal a stranger could reach answers with the **same 404**: an unknown,
malformed or reset token, a deleted account, a block either way, a pair who
left each other, an id you have no relationship with.

Opening a link, asking and accepting all need a finished profile (the
participation gate, SCRUM-331). Ask, accept and block take a lock on the pair,
so two people asking each other at once become friends once, and an accept
racing a block never leaves a blocked person on the list. Refusals cost the
same work as a link that never existed, so timing tells a caller nothing either.

**"Not now" is never delivered.** `dismiss` hides the request from the
recipient; the sender keeps seeing it in `outgoing`. Asking again neither
notifies again nor un-dismisses. Two people who ask each other are friends at
once.

**Friends are still pseudonyms in a room.** Friendship shows real names on the
friend surfaces above, because both people said yes. It is *not* a branch of
`maySeeIdentity`, which every room surface asks — unless the person turned on
`friends_see_me_in_rooms` (see Settings). A DM opened from `/friends/:userId/conversation`
is marked `origin_friendship`, so it does not open that gate either. A friend
you can recognise in a room is left out of your match pool; one who has not
turned the switch on stays in it, as the stranger they chose to be — leaving
them out while the roster lists them would say which handle is your friend.

**A block** deletes the friendship and any request between the pair; unblocking
does not restore it. **Deleting your account** removes your friendships,
requests and link.

Pushes: `friend_request` (`requestId`) and `friend_accepted`. Neither names
anybody — both render on a lock screen.

**The signed-out preview** (`/friends/invite/:token/preview`) is the one
friends route a stranger can reach. It says only the owner's **first name** and
one photo — no full name, id or friend state, since the link may have been
forwarded — and refuses with the same 404 for a malformed, unknown or reset
token or a deleted or suspended owner. A caller who sends a bearer token also
gets the block rule, so the public door never shows what the signed-in one
hides.

## Crews

Friends who go out together (plan v2 §6). 2–12 people, made from the friend
graph, with a crew chat (a room of kind `crew`), "We're here", and crew cards
at an event. `lib/crews/`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/crews` | My crews `{ crews, invites }` — open invites waiting for me that an accept would take, by the inviting friend's first name |
| POST | `/crews` | Make one: `{ name, bio?, intent?, tags?, openToSolo?, inviteUserIds?, revealConsent: true, keepMeAnonymous? }` → 201 `{ crewId, chatGroupId, invited }` |
| GET | `/crews/:crewId` | One of my crews: members by first name and photo, each by their handle in the crew's room |
| PATCH | `/crews/:crewId` | The owner edits `name`, `bio`, `intent`, `tags`, `openToSolo` |
| POST | `/crews/:crewId/invites` | Any member invites their own friends `{ userIds }` → `{ invited }` |
| POST | `/crews/:crewId/join` | Accept my invite `{ revealConsent: true, keepMeAnonymous? }` → `{ chatGroupId }` |
| DELETE | `/crews/:crewId/join` | Decline my invite — told to nobody |
| PATCH | `/crews/:crewId/members/:userId` | My own settings (`userId` = my id): `{ keepMeAnonymous }` |
| DELETE | `/crews/:crewId/members/:userId` | Leave (my id), or the owner removes a member (their handle) → `{ dissolved }` |
| POST | `/crews/:crewId/here` | "We're here" `{ eventId }` → `{ notified, repeated }` |
| POST | `/crews/:crewId/report` | Report a crew's card `{ reason, description? }` → 201 `{ reported: true }` |
| GET | `/events/:eventId/crews` | The crews here now, as cards, a page at a time (`?limit=&offset=`) → `{ crewsEnabled, crews, myCrews, total, hasMore }` |

**Made from friends.** Every invitee must be a friend of whoever invites them —
at creation and on every later invite, by any member. Anybody else (a stranger,
an erased account, an id nobody has) is the **same 404** and nothing is
written, so inviting cannot be used to learn who uses the app. Crews are 18+
with a **known** age and need a finished profile (403 otherwise, an account
with no age included).

**Who is asked, and who is skipped.** `invited` is always how many friends you
asked for, so the answer says nothing about any of them. Each is invited, or
skipped without a word: already in the crew, or invited and the invite still
open; **declined in the last 30 days** (a no is not re-asked or re-pushed for a
month; after that, asking is a new ask); **removed by the owner** (only an
owner's invite brings them back, and clears the removal); **kept apart from
anybody in the crew** — a block or a closed conversation, either way. An
invite **lapses after 14 days**: it stops showing, holds no seat, and can be
sent again. One invite push per inviter and invitee a day, whatever the crew
(read from the invites, so it holds across restarts).

**Accepting asks again**, under the crew's lock: the invite open; whoever sent
it still in the crew and still your friend; nobody in the crew kept apart from
you. Any of those failing is the same 404 as no invite. A block or an unfriend
also withdraws the invites between the two people at once. `GET /crews` lists
only an invite that would pass these checks now: one the accept would refuse is
not on the screen, so a 404 after a listed invite never says a block is there.

**Caps.** You can own 3 standing crews and be in 10 (409 past either), and make
3 new crews in 24 hours (429).

**2–12.** `CREW.MAX_MEMBERS` is 12. An invite that would take members plus open
invites past 12 is 409, and an accept counts the members under a row lock on
the crew, so two accepts at once can never both take the last seat. A crew left
with fewer than two **active** members — suspended and erased people do not
count — **dissolves** (D-15): its chat archives and closes (404 from then on),
the rest are let go, open invites are withdrawn. A crew without an active owner
passes to the active member who has been in it longest — when its owner leaves,
is erased or is suspended. The chat sweeper repairs any crew left below two or
without an owner every 15 minutes, so a suspension (which writes no crew row)
or a failed erasure settle is not left standing. **Except a crew still waiting
on its friends:** every crew starts as its owner and the invites out, and the
sweeper leaves a crew of one standing while it has an open invite or is younger
than an invite lives (14 days) and has only ever had the one member row. An
invite counts while it is open and its sender is still an active member — the
accept's own rule. Once every invite has lapsed, been declined or lost its
sender, and the crew is past 14 days old (or had a second member, now
suspended), the next pass dissolves it. A departure is not a
wait: a crew somebody leaves down to one dissolves at once.

**Joining is consent.** Creating or joining requires `revealConsent: true`. The
app shows, beside it: *"Anyone in this crew can reveal the crew — your name and
photos — to people you match with."* `keepMeAnonymous` is the personal override
("Keep me anonymous even when my crew reveals"); changing it later applies from
then on — a reveal already made can't be unseen (D-10).

**The name and bio** — 2–32 characters (not unique) and ≤ 140 — are shown to
strangers on the crew card. They are **folded** first (`lib/moderation/fold.ts`):
compatibility forms to ordinary ones (fullwidth `９８４５`, ligatures, `․` to
`.`), any script's digits to 0–9 (`९८४५`), Cyrillic and Greek look-alikes to
Latin — and the folded form is what is stored. A name with an invisible
character (zero-width space, bidi override; an emoji's own joiner aside) is
400; a bio has them stripped. Then the moderation pipeline and a **strict**
contact-detail check (`findProfileContactInfo`): phone numbers, any @handle,
emails and web addresses, written out or spelled ("nine eight four…", "at
gmail dot com", "dot in"). A refusal is 400 with a sentence naming what was
found, and nothing is stored. Tags are curated slugs (`quiz-team`, `run-club`,
`techno-heads`, `office-gang`, `birthday-crew`, `foodies`, `board-gamers`,
`gig-goers`, `book-club`, `dance-floor`), at most 3. Intent is the person
intent enum.

**Reports.** `POST /crews/:crewId/report` (`reason`: `spam`, `offensive`,
`contact_details`, `impersonation`, `other`) files a `message_reports` row
(`message_type: "crew"`, the name and bio as they read then). Nobody in the
crew is told. In the admin queue a moderator can **hide** the crew — off every
surface outside it: no card, no like, no Blend; its members keep their crew and
its chat — or **dissolve** it (D-15). Both are audited.

**Inside a crew people are named** — first name and one photo, never the full
name — on `/crews` and in the crew's room. Member ids are handles in the crew's
room (yours is your own id); `DELETE /crews/:crewId/members/:userId` takes that
handle back, and a raw id or another room's handle names nobody (404). Two
members kept apart (a block or a closed conversation) are not listed to each
other on `/crews`, and not counted to each other either — `size` is the
members that viewer is shown, so a size one bigger than the list never says
somebody is hiding — and the crew chat already hides each one's messages and
roster entry from the other. Each member carries **`isFriend`** — one of the
viewer's friends (never true for the viewer) — so an invite picker can leave
out a friend already in without the client ever holding another member's
account id.

**"We're here"** needs the tapper checked in at the event now (403 otherwise)
and checks **nobody else** in: every member checks in by their own GPS. It
writes a line in the crew chat (type `system`, `"We're here 👋"`, metadata
`{ kind: "crew_here", eventId, occurrenceId }`) and sends `crew_here`
(`crewId`, `chatGroupId`) to every other member who has not muted the crew
chat or blocked the tapper — **once per person per crew per occurrence**; a
second tap answers `repeated: true` and tells nobody. The line itself is the
record (read and written in one transaction under a lock), so it holds across
restarts and replicas; the next occurrence is a new night. A member who turned
notifications off (`push_enabled`) gets the bell line, not a push. The push
names nobody and no place: *"Someone from your crew is here 👋"*, titled with
the crew's name. A crew invite sends `crew_invite` (`crewId`), naming nobody.

**Presence is derived, never stored.** A crew is *here* when two or more of its
active members are checked in at the same occurrence now (`checked_in`, no
checkout; at a venue day, while live). `GET /events/:eventId/crews` is for
people checked in there now (403 `NOT_CHECKED_IN` otherwise) and lists the
crews here, never your own (those are `myCrews`, what a like is sent as). A
card is the emblem seed, name, bio, `size` ("Crew of N", active members),
`presentCount`, tags and intent — **counts, never people**: no name, photo,
id or pseudonym of anybody on it (a list of pseudonyms beside a crew that later
reveals would single out the ones who stayed anonymous). Most here first, then
by id; `limit` 30 by default, at most 50, `offset`, with `total` and
`hasMore`. Hidden from you: a hidden crew, and any crew with a member kept
apart — a block or a closed conversation, either way — from you or from any
member of your crews here. Here without a crew of your own, you see crews only
after opting in ("Open to joining a crew tonight", `open_to_crews_until`: it
lasts until the end of the occurrence you said it at), and only crews with
"room for one more" (`openToSolo`) of 6 or fewer active members. When the host
turns crews off (`events.crews_enabled`, the dashboard's "Allow crews at this
event" switch), the list is `crewsEnabled: false` and "We're here" is 403.

**Safety.** A suspended member is on no crew surface (cards, counts, the crew
room). Reinstating them does not undo what the suspension did: the ban it wrote
into the crew chat stays until a person lifts it (as in every room), and a crew
that dissolved or passed to another owner meanwhile stays that way. Deleting
your account takes you out of every crew — inside the erasure's transaction,
the crews locked first — and deletes every crew invite to or from you; each of
those crews is then settled (dissolved below two, owner handed on). Your
messages in a crew chat stay, as in any room.

### Blends — crews matching crews, or a crew and one person

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/events/:eventId/crews/:crewId/like` | Like a crew here: `{ asCrewId? }` — as one of your crews here, or as yourself → `{ liked: true, blend }` |
| POST | `/events/:eventId/matches/likes` | With `asCrewId`: like one person on your crew's behalf → `{ liked: true, blend }` |
| PUT | `/events/:eventId/matches/preferences` | `openToCrews` — "Open to joining a crew tonight" (until the end of your occurrence) |
| POST | `/blends/:blendId/reveal` | One tap reveals your crew **in this Blend** → `{ revealed: true }` |
| GET | `/blends` | My open Blends: room, clock, both sides' people |

**No voting.** Any member of a crew that is here (two or more checked in) likes
on the crew's behalf; the crew chat gets a line, *"liked Crew Nebula for the
crew"*, from the member who tapped — transparency instead of a quorum. Only
for a like of a crew: a like of a person gets no line, because a line only for a
like that stood would tell the crew what the answer hides. Nobody else is told: no push, no bell row, and the card's
`youLiked` is only ever about your side. Liking twice is liking once. When the
host turned crews off, every crew like is 403.

**Crew ↔ person** has guardrails (§8.3): the person turned on `openToCrews` —
which lasts until the end of the occurrence they said it at, and `false` clears
it (403 for their own like until they do — it is their switch); the crew has
"Room for one more" (`openToSolo`) and 6 or fewer **active** members (403 for a
crew member's like until it does); and if the crew is out for dating, the
person must be too. A crew member's like of a **person** tells them nothing
about that person: not here, not opted in, not out for dating, or kept apart
from anybody in the crew — each answers `{ liked: true, blend: null }`, exactly
as a like that stood, and nothing is stored. Anything about the other side of a
like of a **crew** — not here, hidden, a guardrail, anybody on one side kept
apart (a block or a closed conversation) from anybody on the other, two crews
sharing a member — is the same 404 as a crew that does not exist. The block
check is asked again inside the transaction that would write the like and the
Blend: a block landing in between aborts both.

**A Blend.** Crew A liked crew B and B liked A (any members), or a crew and a
person liked each other: `blends` gets one row — two likes at the same instant
still make one, under a lock on the pair and a unique per pair per occurrence —
and a room of kind `blend`. A Blend between the pair that has closed stays
their one row for the occurrence: liking again answers `blend: null`. Everyone
it lets in but the person whose like made it gets `blend` (`blendId`,
`chatGroupId`): *"It's a Blend"*, naming nobody.

**Who is in it: who was here when it matched.** The room gets a member row for
each member of either crew **checked in at the occurrence at that moment**, and
the person — a snapshot. A crewmate who arrives later is not in it (no row, and
every door to a room starts from the row). A member who leaves their crew
leaves its Blends (out live, refused after); a suspended or erased one is out
too. They speak in **tonight's pseudonyms** (the ones they carry in the event's
room), handles scoped to the Blend's room. `GET /blends` lists the snapshot as
its door admits it now, minus anybody kept apart from you and anybody who
turned "show online" off. Anyone may leave on their own
(`POST /chat/groups/:id/leave`); the room stays for the rest.

**A block inside a Blend hides that pair; the room goes on** (D-9). Anybody on
one side kept apart from anybody on the other — a block, or a closed
conversation, either way — is refused by the Blend's door, both of them, and
every writer of a block takes their sockets out at once; everyone else keeps
the room. A Blend handle (from its roster) is enough to block somebody: the
block route opens it for the people that Blend lets in, and for nobody else.

**It closes** 12 hours after the occurrence ends — the door on the clock, the
sweeper archiving it from `blends.closes_at` (`blends_open_closes_at`) — and
earlier when either side's crew dissolves or a moderator hides it. Crew likes
that never made a Blend are deleted 12 hours after their occurrence ends.

**The crew reveal is scoped to one Blend** (owner decision (a), C2). In an open
Blend, any member taps reveal: each member of their crew who is checked in now
and in the Blend's room, and has not switched on "keep me anonymous" (read
again as the reveal is written) — consent was given on joining — is revealed
**to that Blend's people only** (`blend_reveals`): first name and one photo on
`GET /blends`. Not to the event's room, its roster or deck, not in any DM, not
in another Blend. The matched person in a crew ↔ person Blend reveals only
themselves. `GET /blends` says *"N revealed · M keep it private"* for the
**other** side only. Your own side is you and a count (`mine: true`, `count`,
`people` = you alone, `revealed` and `keptPrivate` null), and the reveal
answers `{ revealed: true }` with no count: your crewmates' faces beside one
pseudonym, or "1 keeps it private", would tell your crew which of you said no.
Switching "keep me anonymous" on afterwards applies from then on (D-10): a
reveal already made is not undone. Deleting your account deletes your reveals.

---

## Matching inputs on the profile

`PUT /profiles/:userId` also accepts what ranking reads.

| Field | Values | Who sees it |
|---|---|---|
| `intent_default` | `dating` · `networking` · `friendship` · `just_here` | the shared subset only, via `sharedIntents` on a match card |
| `gender` | `woman` · `man` · `non_binary` · `prefer_not_to_say` | **nobody but the owner** |
| `interested_in` | array of the same values | **nobody but the owner** |
| `orientations` | array of `straight` · `gay` · `lesbian` · `bisexual` · `pansexual` · `queer` · `asexual` · `prefer_not_to_say` — **up to three**, distinct, and `prefer_not_to_say` alone | **nobody but the owner**, unless `show_orientation` *and* `maySeeIdentity` |
| `work_field` | a slug from `GET /work-fields` | anyone who can see the profile |

`intent_default` is the person-level default; the per-event override lives in
`event_match_preferences`, written by
`PUT /events/:eventId/matches/preferences`, and `effectiveIntents` prefers the
per-event value when one exists. **One row per person per event** — it used to
live on the check-in row, which stopped being one-per-event when check-ins went
per-occurrence, so on a multi-day event the answer you got back was whichever of
your check-ins the query happened to return. Until now the default could **only** be written
through that route with `remember: true`, which 403s without a check-in — so a
stable fact about a person was unrecordable until they had walked into a venue.

`gender` and `interested_in` are matching inputs, never card content. They are
absent from every response but the owner's, and a match card carries neither.

`reveal_by_default` is deliberately **not** settable here. Being named in a room
has to be something a person did in that room, not a profile switch they flipped
once — see `PUT /events/:eventId/matches/preferences`.

### Reveal is suggested, never applied

**Check-in always creates `revealed: false`.** It used to seed from
`profiles.reveal_by_default`, which meant walking into a room could name you:
someone who chose to be visible at a work meetup in March was visible at a club
in August without touching anything.

The default is not discarded. `POST /events/:eventId/checkin` returns
**`revealSuggestion: true`** for those accounts, and the app offers it — *"You
usually join as Sagar. Do that here?"* — applied by a tap. Suggesting rather than
undoing means there is no window in which somebody is named before they have
answered, and declining writes nothing at all because the row is already false.

### Intent is asked at the first door

Onboarding never writes `intent_default`, and `profileIsComplete()` needs one
intent before the board opens — so every account that came through onboarding
was refused the board for a field it was never asked. The question is asked
where it makes sense: at the door of the first room.

`POST /events/:eventId/checkin` returns **`intentNeeded: true`** while
`profiles.intent_default` is empty and nothing was chosen for this event. The
app asks *"Why do you go out?"* and sends the answer with **`rememberIntent:
true`** on `PUT /events/:eventId/matches/preferences`, which writes both the
per-event intent and the default. After that it is `false` at every later door,
and re-checking in to a room already answered for does not ask again. An
under-18 profile is refused `dating` on that PUT (403), as everywhere else.

**`remember` on the preferences route is split.** It set *both*
`intent_default` and `reveal_by_default`, while the app renders that switch
under the reveal toggle labelled "Do this at future events too" — so agreeing to
be named at future events silently overwrote a person-level intent set on a
different screen. Send `rememberIntent` or `rememberReveal`. `remember` is still
accepted and still means both, because a build in the store is a client you
cannot upgrade.

### Dating compatibility is a tag filter, not a pool filter

`lib/matches.ts` never read gender, so a straight man who ticked dating got
**"Both open to dating"** on cards for other straight men.

The fix removes the **tag**, never the person. Everyone stays in the list — two
men who both ticked dating still match on interests and on networking — and what
changes is whether `dating` appears in `sharedIntents`. A hard filter here would
be *"the partition the one-pool decision exists to avoid"*, and it would also
mean a card whose absence discloses something. It follows that a card reading
"Both open to dating" has already had compatibility checked, so it never has to
state anyone's gender to be accurate.

Compatibility is **mutual**: `A.gender ∈ B.interested_in && B.gender ∈
A.interested_in`. Anything undeclared **fails closed** — no tag, person still
listed.

**Under 18, none of this is collected.** `orientations`, `interested_in` and
`show_orientation` exist for dating, and dating is 18+, so `PUT /profiles/:id`
answers **403** `Orientation and who you're interested in are for 18+ only.` for
a profile under 18 (`Add your age to your profile first.` when the age is
unknown), and an age that drops below 18 clears all three on the row. The app
does not show the Orientation step to a minor.

**`interested_in` is what matching reads; `orientations` is what someone calls
themselves.** Both are stored, because the labels only *sometimes* imply the
set:

| Sent | Result |
|---|---|
| `interested_in` explicitly | stored as given — **client always wins** |
| `gender` + `orientations`, every label unambiguous | derived and stored |
| `gender` + `orientations`, any label ambiguous | **column untouched** — the app asks directly |

Ambiguous means what it says: "straight" plus "non-binary" has no defined target
set, and neither do `pansexual` or `queer`, which are identities rather than
tables. `asexual` derives to an **empty** set — a complete answer, not a missing
one. Sending only one of the pair re-derives against the stored other, so saving
gender and orientation in two steps ends up where sending both would.

**More than one label unions.** People hold more than one — "queer" alongside
"bisexual", "asexual" alongside a romantic orientation — so `orientations` takes
up to three and `interested_in` is the union of what they imply. Never the
intersection: adding a label must not narrow the pool, because nobody picks a
second word for themselves in order to be shown fewer people. A biromantic
asexual person is the case that settles it — `asexual` alone derives `[]`, and
an intersection would delete a real combination down to nobody.

**One unrecognised label makes the whole derivation unknown.** If any single
label returns "ask", so does the set, rather than unioning the ones that
resolved. A woman who picked `straight` and `queer` would otherwise derive from
`straight` alone and be pinned to `["man"]`, having just said in her second
label that this is not the whole picture.

`prefer_not_to_say` cannot be combined with anything — the same rule
`intentsAreCoherent` applies to `just_here`. Declining to answer is not a fourth
thing you are.

**The singular `orientation` is deprecated and still accepted**, writing one
label into `orientations`; a singular `null` clears them. It is kept because
dropping it fails silently — an old client's save would return 200 and store
nothing. Send `orientations`.

The precedence is the load-bearing part. Two writers to one column with no
ordering is how a hand-picked preference gets silently replaced by a derived
empty set on the next save.

### Field of work

`work_field` is a **slug from `GET /work-fields`**, never free text. Eighteen
buckets, no employer, no seniority.

It is deliberately a different column from `occupation`, which stays behind the
identity gate: "works in design" is an attribute, "Principal Designer at Swiggy"
is an address. So `work_field` is returned to anyone who can see the profile,
and appears on match cards as a **label** (`"Design"`) — a client never receives
a raw slug and never needs its own copy of the mapping.

Serving the list rather than hardcoding it is the lesson from `interests`, which
was collected as free text: "Software" and "software engineering" were two
buckets that could never match, and the fix cost two PRs. A validator that only
checked `z.string()` would repeat it exactly.

### Pre-event chat — who is in the room, and when it opens

The room used to have **one** way in: `event_check_ins.status === "checked_in"`,
a tap *at the venue with GPS agreeing*. It now has three, ranked:

| entitlement | how | good when |
|---|---|---|
| `checked_in` | at the venue, GPS validated | **always** |
| `rsvp` | `event_rsvps.status === "going"` | inside the window |
| `interested` | the event is favourited | inside the window |

**The window gained a floor.** `chatWindowState` was open from the moment the
group existed until `end_time + 24h`. That had no lower bound because it did not
need one — you cannot check in to an event that has not started, so the floor was
implicit in the only way in. Pre-event chat removes that, so the room now opens
`PRE_EVENT_CHAT_HOURS` (24) before `start_time`, mirroring the window on the
other side.

Without a floor, favouriting a festival three months out would be a licence to
sit in its chatroom for three months — and a room with no event around it is a
public channel that happens to be named after a date.

**The bound is also the mitigation for a weaker filter.** An RSVP is a tap from
anywhere; a check-in is a tap at the venue. The pre-event room therefore admits a
much broader group than the live one, and a day is what keeps that group small.

**Being checked in ignores the clock**, deliberately: it is proof you are there,
and somebody standing inside an event that started early must not be refused
their own room.

**`waitlisted` and `maybe` do not count.** Neither is a commitment, and
`waitlisted` specifically means the event is full — putting somebody in the room
for a thing they may never get into is worse than telling them no.

**Two refusals, not one.** *"RSVP to this event to join the chat"* and *"This
chat opens 24 hours before the event starts"* have different remedies, and a
single message would tell somebody who already RSVP'd that they are not welcome.

**A missing `start_time` means no floor.** Several callers select only
`end_time`; treating an absent start as "closed" would silently shut rooms that
used to open, which reads as the chat being broken rather than as a rule.

### Contact details in the room — flagged, never blocked

`lib/moderation/contact-info.ts` looks for phone numbers, social handles and
direct-message links in group chat. It **always returns `flag`** and can never
hide a message.

That is the design, not a first pass. Every deterministic detector has a next
bypass — `9876543210` → `nine eight seven` → `n1ne e1ght` → "the number of
fingers on two hands minus one" — and a filter that blocks teaches the boundary
in one message, after which you have the evasion **and** an empty flag stream.
A warning costs one tap when it is wrong.

**What it decodes:** stretched words (`Nineeee onEe`), leetspeak inside words
(`n1ne`), digit words (`nine one eight`), and any mix. Un-leeting is per token
and never global — applied to the whole string it would rewrite `9876543210` as
`987654321o` and destroy the thing being looked for.

**A run must reach 7 digits.** E.164's minimum, so it is the shortest thing that
can be a real number anywhere. A token that is neither a number nor a
number-word breaks the run, which is why *"I have 2 tickets and 3 friends"* does
not fire.

**Handles are keyed on the platform name**, not on `@word`. `@priya you coming?`
is a room working as intended; a rule that fired on it would fire constantly.

**Addresses are deliberately not detected.** *"Meet at the Blue Door on MG
Road"* is an address and is also exactly what an event chat is for.

**Known limits, and they are recorded rather than papered over:** it cannot tell
whose number it is — doxxing and self-disclosure are the same string, and the
report button is the remedy for the first — and a fully spelled date like
`16 08 2026` fires. Both are acceptable *because* the response is a warning.

**None of this touches profanity.** The keyword filter is a **slur** list and
contains no plain profanity, so *"fuck the party was good"* passes every layer.
Profanity is a property of a word; harassment is a property of a relationship,
and only the second is worth blocking.

### Broadcasting into an event's room

`POST /events/:eventId/announce` takes a `kind`, defaulting to `announcement`:

| kind | who | media |
|---|---|---|
| `announcement` | `canEdit` — the organising org, or an `app_admin`. **Not** the venue owner | no |
| `sponsored` | one organisation holding `may_sponsor` **and** an approved placement at this event, or an `app_admin` | **yes** |
| `system` | `app_admin` only — it speaks as Blend'n | no |

**This route used to compare two user ids.** `event.organizer_id !== caller.id`,
which is exactly the mistake `lib/rbac.ts` exists to end: an `app_admin` could
not announce, and a colleague at the organising org was refused for not being the
row's creator. `organizer_id` still records who *created* an event — a different
question, still useful for audit.

**A venue owner operates an event in their building and does not announce into
it** (R37). Every announcement is signed with the organising org's name, so one
from the venue would speak for somebody else. The dashboard composer and
`/api/events/:id/announcements` always required `canEdit`; this table said
`canOperate` until SCRUM-335, which let a venue owner post polls through
`createPoll`. A venue owner who hosts their own event is its organiser and
announces as one.

**Why `sponsored` needs its own flag.** It is a claim that somebody *paid*. If
everyone who can announce can also mark a message sponsored, the label stops
meaning anything and becomes a styling choice — an organiser could dress an
advertisement as an announcement or the reverse, and a reader has no way to tell
which they are looking at. `organisations.may_sponsor` is off for every row and
granted by an admin, because the word is only worth having if it is scarce.

It is an **organisation** flag rather than a role: the permission belongs to the
company with the commercial agreement, not to whichever of its staff is logged
in.

**Why `system` is admin-only.** It renders as Blend'n. An organiser who could
send one could issue a safety notice, or a "verified by Blend'n" claim, in the
platform's voice.

**Media rides on `sponsored` alone, and that is a safety rule.** The event room
is pseudonymous, and a photograph is an identity — of whoever is *in* it, who is
not always the person posting. Attendee media is not built at all. An
announcement is a host addressing that same room, so it inherits the rule.
Sponsored artwork depicts nobody in the room, which is what makes it the
exception.

**One refusal message for all three.** "Your organisation is not approved for
sponsored messages" tells an attacker probing the API which flag to go after, and
tells an organiser about a capability they cannot self-serve anyway.

**The role is read from the database, not the token.** The mobile JWT carries
`{ userId, email }` and no role, which is the right call: with a 30-day refresh
cycle a role baked into a token outlives the decision that changed it, so an
organiser demoted this morning would keep broadcasting until it expired.

### Polls in an event room

```
GET  /events/:eventId/polls/:pollId          results, disclosed
POST /events/:eventId/polls/:pollId/vote     { optionId }
```

A poll is a `chat_messages` row of type `poll` with a `chat_polls` row hanging
off it, so it scrolls in the transcript, can be moderated, and is deleted with
the room. The question doubles as the message `content`, which means a client
that does not yet know the `poll` type still renders something meaningful rather
than an empty bubble.

**Who may read or vote is the room.** The poll must belong to the event in the
URL, and its message must not be deleted: otherwise `404 Poll not found`, as it
is for a draft event. The read then applies the room's own read rule
(`roomReadDenial`, the same one the history, roster and socket use): somebody
who was never in the room gets `403 You are not in this chatroom`, a banned
member gets `403` with the room's ban sentence, and `muted` and `left` members
still read. A vote additionally needs an `active` or `muted` membership and an
open room (`409`). Before SCRUM-298 the read loaded the poll by id alone.

Who may post one is the same table as above: an `announcement` poll needs
`canEdit`, a `sponsored` poll needs the same grant a sponsored message needs.
A poll from a brand carries that brand's name into the room and takes the same
attention, so it does not get a weaker gate because the payload is a question.

**Every count is disclosed before it leaves the server.** `null` means WITHHELD.
It never means zero, and rendering it as zero turns "we are not telling you" into
a false claim about the room.

The rule is four parts and each one is load-bearing:

1. any option under 5 votes is hidden
2. if *anything* is hidden, `total` is hidden too — otherwise you subtract
   `98 + 41` from `142` and recover the 3
3. if suppression would leave exactly one option visible, hide that one as well;
   a lone survivor *is* the complement
4. suppression is sticky — a figure hidden once is not republished because the
   number later grew

Rule 3 is the one that gets forgotten, and rule 2 is what makes rule 1 worth
anything. `lib/disclosure.ts` owns all four, and the poll module is not able to
return raw counts to anybody.

**Results are hidden until the poll closes** unless it was created with
`resultsVisible`. Two reasons, and the second is the stronger one: a running
total pushes later voters toward whatever is already winning, and streaming
counts is a timing oracle — in a room of four, everyone watching sees `0 → 1` the
instant somebody votes, which is the same leak shape as the typing indicator.
There is no per-vote emission to leak from; counts are computed on read.

**Closing time defaults to the end of the event, not the end of the room.** The
room opens before doors and stays open for a feedback window after, so "closes
with the room" would leave a poll posted during setup collecting votes for days
from people who have gone home.

**One vote per person, and it can be changed.** The unique on
`(poll_id, user_id)` makes that a database fact rather than an application
convention. Changing a vote is allowed while the poll is open — a misclick that
cannot be corrected is worse than a changed mind, and the count is recomputed on
read either way.

Voting requires being *in* the room (`active` or `muted` — a muted member still
reads it, and a poll is not speech). Anything the voter can act on comes back
**409** with the reason: poll closed, room closed, not a member, or an option
belonging to another poll.

### Expertise — the specialism inside the field

`GET /api/mobile/work-fields` also returns `expertiseByField`, keyed by the same
slugs, plus `maxExpertise` (3). One request, because the picker is one question
in two steps — field, then what you do within it — and a client holding only the
first would have to fetch between two taps of the same screen.

Slugs are **prefixed with the field that owns them**: `design_ux_research`, not
`ux_research`. Two reasons, and the second is the load-bearing one:

1. Nothing collides. "Research" is a real specialism in six of these fields and
   means six different things.
2. A stored value can be validated against the field without a second column —
   which is what makes the pruning below possible at all.

**Writes are pruned, not rejected.** `PUT /profiles/:userId` silently drops any
slug the resulting `work_field` does not own, and *the resulting field is the one
after this request*. So a body carrying only `work_field: "finance"` clears a
Design specialism that is already stored. Without that, somebody who changes
career keeps "UX Psychology" on their card indefinitely, under a heading that
contradicts it — a fossil of an attribute they have changed.

Rejecting instead would be worse: a work-field change is a legitimate edit, and
refusing it with *"your expertise is invalid"* asks the user to clear a field
they cannot see in order to change one they can.

**Reads return labels, never slugs.** `expertise: ["UX Research"]`, outside the
identity gate for the same reason `work_field` is — a subject, not a person.
That is only true because the vocabulary is curated: it carries no seniority and
no employer, so there is nothing in it to gate. A free-text version would have
belonged below the gate with `occupation`.

**"Something else" has an empty list, on purpose.** It is the bucket for people
the taxonomy failed; sub-dividing it would invent a structure they have already
told us they are outside of. The key is present rather than missing, so a client
can tell "no specialisms here" from "this field is unknown to me".

**Suppressed in small rooms.** A match card omits `workField` when the room has
fewer than 8 other attendees. The roster already gives an unrevealed person an
age and a city; adding a field of work makes four attributes, and "29,
Bengaluru, works in fintech, into techno and board games" is one specific person
in a room of eight. Ranking still uses it there — the score never leaves the
server, so suppressing the *attribute* costs nothing in ordering.

**`sharedWorkField` is suppressed by the same floor, and must be.** The card also
carries a boolean for "they work in your field", which the ranking has always
computed for `WORK_FIELD_BONUS`. It is not a convenience copy of `workField` — it
is a *stronger* statement, because the caller knows their own field, so `true`
names the other person's exactly. Returning it below the floor while `workField`
is null would hand the suppressed attribute back through a second door. `false`
is weaker and not free either: it eliminates one field of nineteen per card, which
in a room of eight is a real cut. So below the floor every card gets `false` —
the same answer a caller with no field of their own receives, which is what makes
it uninformative.

This is the same failure shape as a `?workField=` query parameter, which is why
the client filters the payload it already holds instead: a feature meant to *use*
the data must not become the thing that leaks it.

### Dating is 18+

Enforced on **both** write paths — `PUT /profiles/:userId` and
`PUT /events/:eventId/matches/preferences` — because a gate on one of two is not
a gate, and the per-event route also writes the profile default via
`remember: true`. `PUT /profiles/:userId` applies it to `looking_for` as well:
that field is free text, so `"dating"` is matched in any case and spacing, and
an age that drops below 18 takes it out of `looking_for` (the other choices
stay) as it does out of `intent_default` (SCRUM-294). Refused with **403** and a
message that names the rule:

```json
{ "success": false, "error": "Dating is for 18+ only. Your other choices are fine." }
```

**An unknown age is refused too**, with different words (`"Add your age to your
profile before choosing dating."`) because the user's next action differs. This
matters more than it looks: `profiles.age` is nullable, OAuth accounts are
created without one, and in JavaScript `null < 18` is `true` — so the obvious
check admits exactly the case it was written to stop. The rule lives in
`lib/age.ts` and is tested there.

### The age is derived, never remembered

`PUT /profiles/:userId` accepts **`dateOfBirth`** as `"YYYY-MM-DD"`, and it is
what every age rule reads wherever a profile has one. `age` stays accepted and
is the fallback for rows written before the column existed — a number cannot be
turned back into a date.

Why it exists: **`profiles.age` was a snapshot that started decaying the day it
was taken.** Nothing ever rewrote it, so someone who signed up at 17 was refused
every 18+ event and the dating tag a year later, indefinitely, and the only way
out was to lie about their age — the opposite of what the gate wants. A birth
date does not go stale.

Three rules follow from that:

- **The date wins over the number, in both directions.** A stale 17 does not
  keep an adult out, and a stale 30 does not let a 17-year-old in.
- **Writing a date refreshes the number beside it**, so the fallback stays
  usable and the dashboard column stays true on the day it is set.
- **Nothing returns it.** Not `GET /profiles/:userId` even to its owner, not
  `GET /users/:userId`, not the check-in roster, and not the five auth
  responses or `GET /events?include=profile` — all of which return the
  *derived* `age` instead. Those seven each spread the whole profile row, which
  is a deny-list; they now go through `profileForSelfResponse` in
  `lib/self-profile.ts`. A birth date is a standard security-question answer
  and half of an identity-theft pair; the age derived from it is not. It is also
  cleared on account deletion along with the rest of the profile.

Malformed input is **400, not a silent no-op**: a date that does not parse, is
in the future, or implies an age outside 18–120 is refused, because storing
nothing while telling the user their profile saved is the worse failure.

Five consequences worth knowing about:

- **Age and intent may be sent together.** The gate reads the age *after* the
  request, so the onboarding screens can save both in one call. Works with
  `dateOfBirth` in place of `age`, with the same precedence as everywhere else.
- **A new age or `dateOfBirth` under 18 is refused (400)** since SCRUM-330, so
  "set 25, tick dating, set 15" never lands. Clearing the age (`age: null`, no
  birth date on file) makes it unknown, and unknown strips the tag.
- **Finishing onboarding needs an adult on file.** `onboarded: true` on a profile
  that is not yet onboarded is **403** "Blend'n is for people 18 and over. Add
  your date of birth to finish." unless the age after the request is 18+ — send
  `dateOfBirth` in the same call or before it. Google and Apple accounts start
  with no age, so this is where they are held. A profile already onboarded
  (including one under 18 from before the ruling) is not re-checked.
- **Taking part needs the same.** RSVP, favourite, the board, check-in,
  starting a conversation, a message request and a DM send answer **403**
  `FORBIDDEN` "Finish setting up your profile first. Blend'n is for people 18
  and over." to a profile that is neither onboarded nor of a known adult age
  (SCRUM-331), so the hold above is not only the app's. Viewing events is not
  gated; neither are replies to a message request (decline and block are
  safety actions). An onboarded profile with no age keeps taking part.
- **Check-in filters rather than refuses.** A profile written before this rule
  can still carry `dating`; copying it onto a check-in row drops it silently,
  because nobody should be kept out of a room over a stale profile field.

### Orientation is shown only when two things are true

`profiles.show_orientation` defaults **false** and is settable on
`PUT /profiles/:userId`. When it is true, `GET /profiles/:userId` returns
`orientations` — **and only to callers who also pass `maySeeIdentity`**.

Two gates, because they answer different questions:

| Gate | Question |
|---|---|
| `show_orientation` | may this be shown at all? |
| `maySeeIdentity` | shown to *whom*? |

**Why the second one exists.** The design asked for a single "show on profile"
switch, which would publish orientation to any caller holding a token. This API
withholds someone's real name and photograph from anyone who has not matched,
opened a conversation, or been revealed to — so a field more sensitive than a
name cannot be less protected than one. Co-presence at an event is enough to
send a message request; it is not enough to learn who someone is, and it is not
enough for this.

**Why the first one exists.** Orientation is special-category data under GDPR
Article 9. The lawful basis for showing it is explicit consent, and a column
that defaults on is not consent. It resets to false on account deletion.

`gender` and `interested_in` stay withheld from everyone regardless. They are
matching *inputs*; the compatibility they compute surfaces as a tag on a card —
"Both open to dating" — never as the values behind it. That separation is not
incidental: the allow-list this sits in was written because a deny-list once
shipped `orientation` and `gender` together to any authenticated caller.

### Events can require a minimum age

`events.min_age` is null for almost every event. When set:

- **Check-in returns 403 with `errorCode: "AGE_RESTRICTED"`** — this is the real
  door, and it refuses an unknown age as well as one below the line.
- **The events list and search omit the event** for anyone whose stated age is
  below it. An unknown age does **not** hide restricted events: OAuth accounts
  have no age, and hiding them all would empty the feed to punish a missing
  field. Discovery is permissive, the door is not.
- **`GET /events/:eventId` returns `minAge`**, so the detail screen can say
  "18+" — a shared link reaches that screen whatever the listing did. For a
  viewer whose derived age is **below** the line it returns 403
  `AGE_RESTRICTED` instead, like the door; an unknown age is shown the event.
- **RSVP, favourite/interest and the board (`/rsvp`, `/favorite`, `/interest`,
  `/board`, `/board/:postId/requests`) refuse 403 `AGE_RESTRICTED`** for an under-age
  *or unknown* age — these are the beginning of being there, so they take the
  door's posture, not discovery's. Until this, only the feed and the door
  applied the rule, and a 17-year-old could RSVP to, save and read the board
  of an 18+ event by id (SCRUM-130). The rule lives in one place,
  `lib/event-access.ts`, which also answers a **draft** or a stranger's
  **private** event with 404 on every one of those routes. `DELETE /rsvp`
  included; **`DELETE /favorite` is never refused** — not on age, and since
  SCRUM-176 not on status either, because an event saved while published and
  then delisted (or hidden by its organisation's suspension, SCRUM-8) was a
  card that could be neither opened nor dismissed. It deletes your own row
  and returns `favoriteCount: 0` for an event you may not see. A private
  event admits its guests (an RSVP) and the staff of the organisation running
  it, not only the row's creator — at the door too, since SCRUM-147.

**`private` is not on offer.** With no invite mechanism a private event could
never gain a guest (seeing it needs an RSVP; RSVPing needs to see it), so the
dashboard form and both write schemas refuse `visibility: "private"` with a
sentence naming `unlisted` — hidden from the feed and search, opened by link.
The enum keeps the value for rows that already have it; they behave as above.
It returns with the invite that makes it true (SCRUM-147).

**Retired 2026-09-18 (SCRUM-166):** `GET /events/:id/analytics`,
`GET /events/:id/checkins/export`, `POST /events/:id/clone` — no client
called them; the dashboard owns each job. `PATCH`/`DELETE /events/:id` and
`POST /events/:id/announce` stay: the app's organiser tray calls them, and
`mobile-organiser-routes.itest.ts` holds their organisation-shaped rules.

Set by the organiser in the dashboard event form, bounded 13–25.

**A suspended organiser's events are drafts** (SCRUM-8). Suspending an
organisation flips its published events to `draft` and reinstating flips them
back, so everything above applies: absent from `GET /events` and
`/events/search`, 404 on `GET /events/:id` and every participation write, the
roster 404, the chat/counter/roster rooms refuse to join, and a message into
the room is refused with *"This event is no longer available."* RSVPs and
check-ins survive the suspension. People who had RSVP'd to one not yet over get
one `event_update` notification saying so.

---

## Settings

`PUT /profiles/:userId` accepts four preference booleans, all defaulting to
**true**, and `friends_see_me_in_rooms`, defaulting to **false**:

| Field | Governs |
|---|---|
| `push_enabled` | Push notifications |
| `show_online` | Whether others see you as active |
| `read_receipts` | Whether DM reads are reported back |
| `share_location` | Whether other attendees see your distance |
| `friends_see_me_in_rooms` | Whether friends see who you are in a room. Off: a friend is a pseudonym there like anyone else |

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
not other attendees' business. `show_online` is honoured by the two surfaces where another attendee can
see that you are in a room: `GET /events/:eventId/checkins` (the roster) and
`GET /events/:eventId/matches` (the grid). With it off you are **counted and
not listed** — the room's numbers include you, nobody is offered your card, and
nobody can like you. Chat is unaffected: posting a message is its own choice to
be seen.

---

## Users & Profiles

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/users/:userId` | Get user profile. `:userId` may be a room handle, echoed back as `id`, and is then answered in that room's terms — see Room handles. When `identityVisible` is true it also carries `connection: { conversationId, request: "sent" \| "received" \| null }` — your open conversation and any pending message request between you; absent otherwise |
| POST | `/users/:userId/block` | Block/unblock user (`DELETE` to unblock) |
| GET | `/users/blocked` | The people you blocked. `blocked_id` is an **opaque ref to the block** (`bk_…`), not their account id — somebody blocked by their board post or room handle was never shown one, and this list must not be where it arrives. Send it back to `DELETE /users/:userId/block` to unblock; only a block you made is removed. A raw id still unblocks, for older clients, on your own block only. Name and photo appear only where the identity rules allow |
| GET | `/users/:userId/favorites` | Get your saved events — your own id only (403 otherwise); drafts are dropped, cancelled ones stay with `status` set (SCRUM-176) |
| GET | `/profiles/:userId` | Get a profile. Your own carries `email` and the whole `profile` row except `date_of_birth` (`age` derived) — `name`, `gender`, `interested_in`, `intent_default`, `reveal_by_default`, `blur_photo`, `interests`, `created_at`, `updated_at` included, and `expertise` as slugs. Anybody else's `profile` is `id, age, onboarded, location, interests, work_field, expertise` (labels), plus `bio, occupation, education, photos` if you can see who they are, else `blurPhoto`; no `email`, and `image` only if you can see who they are |
| PUT | `/profiles/:userId` | Update profile |
| GET | `/profiles/:userId/interests` | Get category interests — 404 when either of you has blocked the other, as the profile answers (SCRUM-299); empty through a room handle for somebody that room keeps anonymous |
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

PUT the file to `uploadUrl` with **exactly** the `Content-Type` you asked for.
The type is signed into the URL, so any other type, or none, is refused by
storage with `403 SignatureDoesNotMatch` (SCRUM-425). The URL can write its
key for 15 minutes, so a profile or a message never stores it: attaching the
upload stores a **copy** under a new key nobody can upload to, and the URL you
get back (`photos`, `metadata.mediaUrl`, a DM's `mediaUrl`) is the copy's,
not the `publicUrl` you sent.

**Chat media is private (SCRUM-427).** `folder: "chat"` uploads go to the
private bucket; `publicUrl` is the stored reference, which answers an
anonymous GET with `403`. Wherever a message's media comes back (the send
response, history, the `private:message` socket event), `mediaUrl` is a signed
URL valid for **15 minutes**. Load it when you draw the message, not later;
refetch the history for a fresh one. Profile photos, event media and sponsored
creatives stay public.

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

### Reports from the app

| Method | Endpoint | Writes |
|--------|----------|--------|
| POST | `/users/:userId/report` | `user_reports` |
| POST | `/messages/:messageId/report` | `message_reports` (`messageType: "group" \| "private"`) |
| POST | `/events/:eventId/report` | `event_reports` |
| POST | `/chat/groups/:chatGroupId/report` | `event_reports` with `chat_group_id` — shown as "Room" |
| POST | `/events/:eventId/board/:postId/report` | `message_reports` with `message_type: "board_post"` — shown as "Board · offer\|seeking\|chat" |
| POST | `/board/requests/:requestId/report` | `message_reports` with `message_type: "board_request"` — shown as "Board ask" |

### The pre-event board

| Method | Endpoint | Gate |
|--------|----------|------|
| GET | `/events/:eventId/board` | RSVP'd (any committed status) **or** favourited; before doors. Posts by anybody blocked either way are left out |
| POST | `/events/:eventId/board` | RSVP'd **going**, complete profile, under both caps; the text passes moderation |
| DELETE | `/events/:eventId/board/:postId` | Your own post (anyone else's is a 404) |
| POST | `/events/:eventId/board/:postId/requests` | Same as posting, plus not blocked, not a `chat` post, not a full offer, and not asked before |
| GET | `/board/requests` | Yours, both directions |
| PATCH | `/board/requests/:requestId` | `{ action: accept \| decline \| withdraw }` |

Going alone, and looking for somebody to go with. This is what gives
`event_rsvps` a job — it has been a dead-end signal that existed only as a
dashboard number.

**Reading is cheap and posting is not, deliberately.** A favourite is one tap,
and somebody deciding whether to go is exactly who the board is for: *"is anyone
else going alone"* is a reason to commit, and requiring the commitment first
inverts it. Posting takes `going`, because offering a seat in a car you may not
be driving to is worse than not offering.

The ask here — travel with me, share a car — is materially riskier than a
message in a crowded room, and it is the one place in the product where two
people arrange to meet away from a venue full of witnesses. So posting also
requires a **complete profile**: name, age, two structured interests, one
intent. Server-enforced, and deliberately not `profiles.onboarded`, which is a
client-set boolean no API has ever checked.

**No photo.** The board is pseudonymous, so a photo would be collected and never
shown.

Two caps, bounding different abuses: **5 unanswered requests at once** bounds a
spray, and **20 per rolling week** bounds persistence — the first alone is
defeatable by withdrawing and re-sending.

Authors are pseudonyms, the same handle the room uses, so somebody who posts and
then talks in the room is recognisably the same person *at that event* and
nowhere else. `requestCount` is a number and never a list: how many have asked
is useful, naming them would disclose who is looking for company to everyone
browsing.

**The board closes at doors** — for reading as well as posting and asking, all
three **403** *"The board closes when the doors open — the room is open
instead"*, judged on the event's `start_time`. After that the room is the place,
and it is gated on presence rather than intent — a board that stayed open would
be a second room with a weaker gate running beside the real one, and a readable
one would be a list of who came alone, open during the night.

**Blocks apply both ways.** A post by somebody who blocked you, or whom you
blocked, is not on your board; asking on one is refused exactly as asking on a
post that is gone; and an ask from somebody blocked either way is left out of
your incoming list.

**A post is checked before it is stored** (SCRUM-301). The text gets the room's
checks: the keyword filter, contact details, then OpenAI within one second. A
room message that fails is stored hidden and counted toward a mute. The board has
no moderation queue, so a failing post is refused with **422** and never stored.
Contact details say what was found (*"This looks like a phone number. The board is
anonymous, so contact details can't go on it."*). Anything else reads
*"This can't go on the board."*, which tells a poster nothing about the filter.

If OpenAI doesn't answer inside the second, the post goes up, as a room message
does. Then, as in the room, it is looked at again without the time limit, and
taken down (`moderation_status = "hidden"`) if it would have been refused. A
request's `message` gets the same checks as a post and returns the same **422**.
It has no second look, because a request has nowhere to be hidden later.

**An author can withdraw their own post** with `DELETE /events/:eventId/board/:postId`.
It is soft (`deleted_at`): the post leaves every board read, requests filed against
it stop counting toward their senders' caps, and `GET /board/requests` returns its
`body` as `null`.

#### Reporting, blocking and removal (SCRUM-322)

| Method | Endpoint | Who |
|--------|----------|-----|
| POST | `/events/:eventId/board/:postId/report` | Anyone who was ever this event's audience — an RSVP of any answer (one later changed to not going included) or a save — or who has an ask on the post |
| POST | `/events/:eventId/board/:postId/block` | The same |
| POST | `/board/requests/:requestId/report` | Either of the ask's two people |
| POST | `/board/requests/:requestId/block` | The same |

The board never gives the client a user id, so a person is reported and blocked
**by the post or the ask they wrote**. The server resolves who and never returns
it — not in these responses, and not later in `GET /users/blocked`, which lists
an opaque ref (below). Anything the caller could not have seen, including no
such post or ask, is the same **404** body as a missing one, so the routes cannot
be used to probe ids. Your own post is **400**.

**These stay reachable when the board does not.** They are safety actions, so
neither the doors nor a block closes them: somebody reading a message after the
night began, or who has just been blocked by its author, can still report it and
block back. A withdrawn or removed post can be reported too — the person most
motivated to take a post down is the one about to be reported for it.

- **Reports** take `{ reason, description? }`, with `reason` one of `harassment`,
  `hate_speech`, `inappropriate_content`, `spam` or `other` (the app's message
  reasons), and `description` up to 500 characters. They return
  `201 { reported: true }`. They land in `message_reports` (`message_type`
  `board_post` / `board_request`), so they show in the admin reports queue beside
  room messages and DMs, as "Board · offer", "Board · seeking", "Board · chat" or
  "Board ask", with how many reports name the same thing. An ask is reported
  about whichever of its two people did not file it.
- **One report per person per post or ask while it is pending.** A second tap is
  the same `201` and no new row (a partial unique). Reports are limited to 20 a
  minute and **30 a day** per person — a queue showing the oldest hundred is
  otherwise one script away from burying everybody else's.
- **The evidence is kept.** A report stores the words as they were when it was
  filed (`excerpt`), and stamps the post `moderation_status = "reported"`.
  Account erasure deletes only posts with no status, so a reported post is kept
  (and taken off the board) until it is reviewed, and an ask somebody reported
  keeps its message until then. Dismissing the last pending report on a post
  clears the stamp.
- **Blocking** is exactly `POST /users/:userId/block` once the person is known:
  the same transaction and the same `{ blocked: true }`. Board asks between the
  two are left as they are — hidden from the blocker, not acceptable, and read by
  the asker as an ask on a withdrawn post.
- **Removal** is the queue's *Remove post* on a board-post report. It marks the
  post `moderation_status = "removed"` — whether or not its author had already
  withdrawn it — and sets `deleted_at` if it was still up, which takes it off
  every board read and lapses the asks filed against it. It records
  `report.remove_message` in `audit_logs` with the post's id and `removed: true`,
  or `removed: false` when the post was already removed. A post erased with its
  author's account cannot be removed (the button is not offered; the action is
  refused). Asks are not removable: an ask went to one person, like a DM, so the
  lever there is the person.

#### Asking somebody

**You cannot cold-request a person who has not posted**, and that is structural
rather than a check: a request is filed against a post, `board_requests.post_id`
is required, and the recipient is read off the post. There is no field in which
to name somebody, so there is no path that forgets the rule.

**One ask per post, ever.** A second ask on a post you have asked before is
**409** *"You have already asked — give them a moment"*, whatever became of the
first — waiting, declined, withdrawn or accepted. It used to be refused only
after a decline, with *"They have already answered this one"*, and that sentence
was the decline delivered: the only answer a re-ask can be refused after is a no.
Refusing after a decline but not after a withdrawal fails the same way one step
later, since a declined ask can be withdrawn and re-asked. So every re-ask gets
the sentence a double tap gets.

A request on a **`chat`** post is **422** — it asks nothing of anybody, so there is
nothing to ask to join.

Blocks are consulted **in both directions**, and the refusal is the same sentence
as a deleted post. Telling the asker they have been blocked tells them a fact
about somebody else's decision, which is the one thing a block should not leak.

#### Answering

`accept`, `decline` and `withdraw`. The last is the asker's alone, and
`withdrawn` is a separate status from `declined` because afterwards, which of the
two people ended it is the thing worth knowing.

**A decline is never delivered to the asker.** Nothing is pushed, and nothing the
asker reads changes. In their `GET /board/requests` a declined ask is
`status: "pending"`, `decidedAt: null`, `live` while its event and post are, and
it lapses with them like any unanswered ask; it sorts with the pending ones. It
still counts toward their five outstanding until it lapses — a decline that
freed a slot would tell somebody at the cap that one of their asks was refused.
Withdrawing a declined ask succeeds exactly as withdrawing a pending one does,
and withdrawing twice succeeds again. Only an accepted ask cannot be withdrawn,
and the asker was told about that one. A withdrawn pending ask becomes
`withdrawn`; a withdrawn **declined** ask keeps the author's `declined` and
`decided_at` — their decision is not the asker's to rewrite — and records
`asker_withdrawn_at`, so the asker sees it `withdrawn` and it frees their slot.

**A block reads as a withdrawn post.** To the asker, an ask to somebody blocked
either way — pending or declined alike — shows exactly as an ask on a post its
author took down: `post.body: null`, `live: false`, and it no longer counts
toward their five. A live ask with the post's words, beside a board that no
longer lists the post, would tell them which of the two had happened.

**`GET /board/requests` pages by what still matters.** Each direction is the live
asks first (newest first), then the settled ones (accepted before withdrawn, or
answered, for the author), then the lapsed ones, up to 50. A lapsed ask stays
`pending` for ever, because nothing closes one when its night ends, so ordering
"pending first" let fifty of them push the accepted asks — the ones with a
conversation behind them — off the page.

**Accepting an offer spends a seat** (SCRUM-514). On an `offer` with a number of
seats, `spacesLeft` drops by one, in the same transaction as the claim and the
conversation: of two accepts racing for the last seat exactly one gets it, and
the other is **409** *"That offer is full"* — said to the author, and the ask
stays pending. A CHECK keeps it from going below zero. An offer that never named
its seats (`spacesLeft: null`) has none to run out of. Asking on an offer
already at `spacesLeft: 0` is the same **409** — the board already shows it
full.

**Every refusal of an accept** (`PATCH /board/requests/:id` with
`action: "accept"`):

| Status | Sentence | When |
|---|---|---|
| 404 | Request not found | No such ask, or not yours to answer or withdraw |
| 403 | Only the person who was asked can answer | The asker tried to accept or decline |
| 409 | That request has already been answered | It is not pending any more (a double tap included) |
| 409 | That post was taken down | Its post was withdrawn or removed, before or during the accept |
| 409 | That event has ended | Its event is over |
| 409 | This request can no longer be accepted | A block either way, **or** a pair whose conversation was closed — one status and one sentence for both, so the answer does not say which |
| 409 | That offer is full | No seat left on the offer |

The claim, the seat and the conversation are one transaction, so any of the
last five leaves the ask pending and the seat where it was.

**A decision is still possible after the doors open**, unlike everything else on
this surface. A pending request holds a slot in the asker's outstanding cap, so
refusing to let it be answered would leave one unanswered ask on a Tuesday
costing a fifth of every future board, for ever.

**Accepting opens a conversation**, pseudonymous and scoped to the event, and it
needs no exception to the co-presence rule. `mayConverse` requires having been in
the same room *and* returns true when a conversation already exists — so opening
one is enough and every later check passes on the strength of the row. The plan
anticipated a distinct conversation kind that graduates; it is not needed.

The conversation carries `origin_board_request_id`, and the reason is worth
stating. `fromMatch` used to be **inferred**: a match snapshots both pseudonyms
and a message-request conversation snapshots neither, so the presence of one told
you which. A board conversation is pseudonymous too — it has to be, because a
conversation without pseudonyms shows real names — so the inference would call it
a match, and the client draws the match opener on anything it calls a match. Two
origins can be told apart by a side effect; three cannot.

#### The handle before the room exists

A pseudonym and a room membership are the same row: `chat_group_members` carries
`anonymous_name`, and socket room access is granted to any member who is not
banned. So there is no way to give somebody a handle without also giving them the
live room — which is gated on presence deliberately, because doors close on
people who did not come.

The board therefore **derives** a handle from `(event_id, user_id)`: stable for
that person at that event, different at the next one, no row and no table. Before
this every board post rendered as the literal string `"Attendee"` — a wall of one
name, on the surface whose whole job is letting people tell each other apart well
enough to agree to travel together.

Check-in then **prefers** that handle when it is free, so the name someone
answered on the board is the name they carry into the room. Preference, not
override: uniqueness is enforced per chat group, and ~6,480 combinations means a
large room collides.

#### What the push says

`board_request` and `board_request_accepted` carry neither the pseudonym nor a
word of what was written. A board request is the one message in this product sent
to somebody who has not agreed to hear from the sender at all, and all of it
renders on a lock screen other people can see. The push says that something
happened; the board says what.

### Reactions

| Method | Endpoint | Behaviour |
|--------|----------|-----------|
| POST | `/chat/groups/:chatGroupId/messages/:messageId/reactions` | Toggles `{ emoji }` |

One toggling call rather than add and remove. A tap is a toggle, and splitting
it makes the client responsible for knowing which state it is in — which it gets
wrong exactly when two devices disagree, and the recovery is a duplicate-key
error or a silent no-op depending on which way it guessed.

The emoji is an allow-list of six. `message_reactions.emoji` is an unbounded
`String` keyed by `(message_id, user_id, emoji)`, so free text would be both an
unbounded write and a channel of arbitrary text under somebody's post that the
moderation pipeline never sees.

The response carries `{ emoji, count, mine }`. The socket broadcast
(`chat:reaction`) carries `{ emoji, count }` and **never who reacted** — each
client already knows its own reaction from its own request. Gated by
`mayWriteToRoom`, the same rule as the two message write paths: a reaction is
participation, so a muted member cannot post a smaller version of what they were
muted for. A refusal carries the **same sentence and `errorCode`** a message
would get (`CHAT_CLOSED` / `CHAT_LOCKED` / `USER_MUTED` / `USER_BANNED`) —
it used to say "This room is not open" with no code for every closed state,
while the post beside it said when the chat had closed (SCRUM-154).

All three return `201 { reported: true }` and are rate limited per user.

**The event route takes no check-in.** Two of the three things worth reporting
about an event — a misleading listing and a dangerous-looking organiser — are
visible from the listing itself, and the point is catching them *before*
somebody travels to a venue. Requiring attendance would restrict reporting to
people who had already taken the risk.

These are **not** moderation flags and are not returned by the admin flag API
above. A flag is the pipeline's opinion about one message; a report is a person
asking for help, and may be about a person or an event rather than a message.
They are read at `/dashboard/moderation/reports`, where an admin can dismiss,
remove the message (group rooms only — `private_messages` has no `deleted_at`),
**delist the event**, or suspend the account.

Delisting sets `visibility = unlisted`: out of the feed, out of search, out of
the city counts, with the room, the RSVPs and the check-ins untouched — so it is
reversible in a way `cancelled` is not. There is no Suspend on an event report,
because `organizer_id` records who *created* the row and for a curated event
that is the admin who curated it.

Until 0.61.0 `user_reports` and `message_reports` were written by these routes
and read by nothing at all. `event_reports` had neither a writer nor a reader
until 0.69.0 — so a person who wanted to report an unsafe venue had no path.

Nothing is returned to the reporter beyond the 201. Replying to a reporter does
not exist yet; see `docs/MODERATION_RESPONSE.md`.

---

## Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/categories` | List all categories |
| GET | `/amenities` | The amenity vocabulary — what an event can say it offers |
| GET | `/work-fields` | The eighteen coarse fields of work, as `{ slug, label }` |
| GET | `/checkins/active` | Get user's active check-ins. Each carries `kind` (`venue_day` is a Go Live: label it by `event.venueName`), `venueId` (the venue a Go Live is at, to extend or go again; null at an event), `expiresAt` (a Go Live's end; null at an event) and `stay`. A Go Live past its end is never listed, swept or not |
| POST | `/notifications/token` | Register push token |
| DELETE | `/notifications/token` | Remove push token |
| GET | `/notifications` | The notifications centre, newest first |
| POST | `/notifications/read` | Mark notifications read |
| DELETE | `/notifications` | Clear the notifications centre |
| DELETE | `/account` | Delete your own account |

### Amenities

`GET /amenities` returns the seeded vocabulary; `GET /events/:id` returns what
the organiser ticked for that event. **The list endpoint does not carry them** —
the cards draw none, and `/events` is the hottest endpoint in the product.

**A vocabulary, not free text.** `events.house_rules` already exists and is a
different thing: "open bar (from 9)" typed by one organiser and "Free drinks!!"
by another are two facts nothing can group, give an icon, or translate.

**Retired, never deleted.** The foreign key from `event_amenities` is
`RESTRICT`, so an amenity that events reference cannot be removed — deleting one
would rewrite what past events said they offered. `is_active = false` withdraws
it from every picker and leaves history intact.

**Ordering is `sort_order`, not alphabetical**, or "Accessible Entrance" leads
every picker and every event card in the app.

**The organiser asserts; nothing is inherited.** The event stores its own rows
and never reads through to the venue, so a venue editing its list next month
cannot change what last month's event claimed. The venue layer that would
*pre-tick* these is deliberately not built — see `docs/AMENITIES.md`: an unowned
venue has no list to suggest from, and almost no venue is owned yet, so it would
be a permission system and a picker that did nothing.

### The notifications centre

The bell in The Pulse's top bar. `GET /notifications` returns the caller's own
rows, newest first, with the unread count alongside so the bell costs one
request rather than two.

**Cursor, not page.** The list grows at the head — rows arrive while somebody is
reading it — and offset pagination on a list like that silently repeats items,
because page 2 shifts by however many landed since page 1. Same reason chat
messages use a cursor.

**Every row is written by `sendPushNotification`, before the token lookup.** A
push fails to arrive for three reasons that have nothing to do with the
notification being real: notifications turned off in settings, no device
registered yet, and an expired token. All three return early from the sender, so
recording after that point would make this a log of successful *deliveries* —
the opposite of somewhere you look for what you **missed**. Bulk sends record
every recipient, not only the ones with a registered device.

**Bodies are stored as sent, and must stay that way.** The reveal gate already
applies to push titles (`maySeeIdentity`), so a pseudonymous match is
pseudonymous here too. This table must never be given a richer copy of the same
event — that would route around a gate it took three PRs to close.

**Messages are not in the bell.** DMs and room messages have their own inbox —
the Banter list and the Room badge count what is unread — so the feed never
returns `private_message`, `group_message` or `event_checkin`, and nothing writes
them any more. Rows written before that are hidden, and retention removes them.

#### What pushes, and when

| What happened | Who gets a push | On the phone |
|---|---|---|
| A DM | The recipient, when the conversation goes from read to unread; while it stays unread, at most once every 5 minutes, as "N new messages" | One notification per conversation, replaced in place (`dm:{conversationId}`) |
| A room message | **Nobody** | — |
| A reply to your room message | Its author, if still in the room and not in a block with the sender; at most once per room every 3 minutes. `data: { type: "group_message", chatGroupId, senderId, kind }` — `kind` is the room's: `event` (a venue day's room too), `crew` (with `crewId`), `blend` (with `blendId`) or `board_post`; open the tap as that room | `room:{chatGroupId}`, replaced in place |
| A check-in | **Nobody** — the live roster carries arrivals | — |
| An event you RSVP'd to or saved changes time or place, is cancelled, or starts in an hour | Going, maybe, waitlisted and saved | `event:{eventId}`, replaced in place: only the latest state is true |
| An organiser announcement | Everyone in the room | Stacked with its event, never replaced |
| Friend request / accepted, match, reveal, board, message request | The person it is about, immediately | One each |
| A crew invite | The friend invited (`crew_invite`, `crewId`), naming nobody | One each |
| "We're here" | Every other crew member who has not muted the crew chat or blocked the tapper (`crew_here`, `crewId`, `chatGroupId`), once per person per night; no name, no place | One each |
| A Blend | Everyone the Blend room lets in, but the person whose like made it (`blend`, `blendId`, `chatGroupId`); no name, nothing about who liked first | One each |
| An event you checked in to ends | Everyone with a check-in row, once per event, within ~5 minutes of the end (only events that ended in the last 6 hours). `data: { type: "rating_request", eventId }` → the app opens `/rate/[eventId]`. People with a mutual like to rate (blocks excluded) get "rate the people you met"; the rest "rate the night"; somebody who already rated and has nobody to rate is skipped | `rate:{eventId}` on `events`, replaced in place |

A room you muted (`POST /chat/groups/:id/mute`) sends you neither the reply push
nor announcements.

Every push carries an Android `channelId` the app creates — `messages`,
`rooms` or `events` — so each can be silenced in system settings, and an iOS
`threadId` that stacks a conversation's or an event's notifications. Chosen by
`deliveryFor` from `data.type`, never by the caller.

`POST /notifications/read` with no `ids` marks all of the caller's. The caller's
`user_id` stays in the filter even when ids are named, so a uuid alone cannot
reach somebody else's row; already-read rows are skipped rather than re-stamped,
because `read_at` answers "when did they see this" and a bell tapped twice must
not move the answer.

### DELETE /account

**Anonymises rather than hard-deletes.** `organized_events`, `chat_messages` and
several other relations cascade on `User`, so removing the row would destroy
other people's event and chat history to honour one person's request. Instead
the row is kept, every field on it is scrubbed, `deletedAt` is set, and all auth
is revoked — refresh tokens, push tokens, OAuth links and dashboard sessions.
Sockets the account already had open are closed too (`io server disconnect`),
so a second phone stops receiving its rooms and DMs at once (SCRUM-449).
The account can never be signed back into.

That decision has a cost worth stating: **nothing is removed automatically**, so
every column added to `profiles` survives deletion until it is explicitly
scrubbed. `goals` and `looking_for` already survived a release that way.
`__tests__/account-deletion.test.ts` now reads the schema and fails when a field
is neither scrubbed nor listed as deliberately kept.

Scrubbed: name, phone, age, location, bio, occupation, education, interests,
photos, goals, looking_for, **gender, orientations, interested_in,
intent_default, reveal_by_default, work_field**, plus the structured
`user_interests` rows and every `event_match_preferences` row.

Removed from storage, after the transaction: everything the person uploaded
from the app, meaning `profile/<id>/` (photos) and `chat/<id>/` (images sent in
DMs and rooms, SCRUM-428), plus the `chat/sealed/<uuid>` copies their own messages point at
(SCRUM-448). The exception is removed content, kept 180 days
(`docs/RETENTION.md`): an image in a message that moderation hid or flagged,
that someone else deleted, or that someone else reported, where the flag or
report was not dismissed. If that set can't be read, `chat/` is left alone. A failure is logged by user and folder,
and the other folder is still erased. `events/`, `sponsored/` and `claims/` belong to an
organisation's records and stay. A public URL can keep serving from Tigris'
cache until its `max-age` runs out.

Kept: the four settings booleans (how a dead account would behave, not who the
person was), and `event_check_ins` — attendance is the organiser's history too,
and it is the co-presence that keeps a conversation open for someone who
actually met them. What they were *open to* is only theirs, and goes.

A check-in still open is checked out after the transaction, the same way the
person checking out would be (`performCheckout`). The row stays as attendance
and their presence session is closed, but they stop counting as here now in
the live headcount (SCRUM-481).

Kept for 180 days, then purged (IT Rules 2021): a copy of what they registered
with (name, email, phone, date of birth, sign-up method), written in the same
transaction before the scrub. No route returns it. Their board posts that
moderation hid are kept too. See `docs/RETENTION.md`.
