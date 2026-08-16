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
{ "email": "string", "password": "string", "name": "string", "age": 29 }
```
Returns **201**: `{ accessToken, refreshToken, user: { id, email, name, profile } }`

`name` is **required**. `age` is accepted and currently optional, and becomes
required once the mobile app ships the field — it is stored on the profile
because there is nowhere else to collect it: Google and Apple create profiles
without an age, and the onboarding screens that used to ask are being removed.
The floor here is 13; **dating intent separately requires 18+**. Prefer
`dateOfBirth` on `PUT /profiles/:userId` over this `age` — see *The age is
derived, never remembered* below for why the number alone is not enough.

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

### A suspended account

Every route that issues a token — `signin`, `google`, `apple`, `refresh` and
`session` — returns **403** with a message naming the suspension and an address
to appeal to. The client should show it rather than treating 403 as a generic
failure: a silent refusal to sign in is indistinguishable from a bug.

```json
{ "success": false, "error": "This account has been suspended. Contact support@blendn.app if you think that's a mistake." }
```

On `signin` it is checked **after** the password, so the response cannot be used
to discover which addresses are suspended. Suspending also revokes the account's
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

**The roster is everyone checked in.** It used to be filtered on `onboarded`, a
non-null name and a non-empty `photos` array — three fields the endpoint does not
serve. Someone who had passed the GPS gate and was standing in the room was
absent from the list and from the count, for a reason nothing in the response
could explain.

It still will not equal `/matches`, and should not: matches select on
`check_in_time: { not: null }`, the roster on `status: "checked_in"`. Someone who
checked out stays matchable and stops being listed as present — "was here" versus
"is here".

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
now. Only `city` scopes a list, and only `check_in_radius` refuses anyone, at
the door where refusing is the point.

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
  { "city": "Bengaluru", "eventCount": 12 },
  { "city": "Mumbai", "eventCount": 3 }
] } }
```

Pass `city` straight back to `GET /events` or `GET /events/search`.

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

**Active venues only.** `archived` is how a venue is retired without deleting
the events that happened in it, so it never appears in discovery.

**The card image comes from the next event.** `venues` has no image column.
Rather than a wall of grey cards or an invented placeholder, each venue carries
the soonest public event it is hosting — which supplies the artwork and doubles
as the reason to tap. Nothing upcoming returns `nextEvent: null` and
`upcomingEventCount: 0`, so no card claims something is happening when nothing
is; draw the type-based fallback.

**`upcomingEventCount` and `nextEvent` are one question asked once.** Same
filter object, so a card cannot say "3 upcoming" and then headline an event that
is not one of them.

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
`haveSharedAnEvent`, existing request, existing conversation. And
`@@unique([sender_id, recipient_id])` means **one request per pair for all
time** — decline it and that person can never send another.

### GET /conversations
Each conversation carries **`fromMatch`** — it opened from a mutual like rather
than from an accepted message request.

It has to be a server field. The payload carries the *resolved* name and
`theyRevealed`, and `mayShowRealName` returns `true` for **both** a
never-pseudonymous conversation and a revealed match, so `theyRevealed` cannot
tell them apart. Anything built on it would greet every accepted message request
as a new match. Derived from `user1_pseudonym`/`user2_pseudonym`; the pseudonyms
themselves are never sent.

### GET /events/:eventId/chat
The response carries a **`write`** block:

```json
{ "allowed": false, "reason": "window_closed",
  "message": "This chat has closed. Event chats stay open for 24 hours after the event ends.",
  "closesAt": "2026-08-17T22:00:00Z", "eventEndedAt": "2026-08-16T22:00:00Z" }
```

`reason` is one of `locked | archived | window_closed | muted | banned`, or
`null` when writing is allowed. The composer used to guess: every refusal came
back as a single `NOT_CHECKED_IN` covering several unrelated situations, so the
app either showed the wrong reason or let someone type a paragraph and then threw
it away. `closesAt` lets the room show an honest countdown.

**Write access is attendance, not presence.** A `chat_group_members` row means
you were physically at the event; checking out does not revoke it. See
`mayWriteToRoom` in `lib/chat-window.ts`.

### GET /chat/groups
Each group carries `isCheckedIn` — the caller is `checked_in` to that event with
no `check_out_time`, so the room is live for them right now. The app lifts those
rooms into The Banter's "Live now" rail and leaves them out of Recent.

It is a server field because the client cannot derive it: it has the room and the
event's times, but "the event is underway" is not "I am there". Someone who never
turned up, or who left an hour ago, has a room whose event is mid-flight.

| GET | `/chat/groups/:chatGroupId/messages` | Get messages (cursor-based) |
| POST | `/chat/groups/:chatGroupId/messages` | Send message (30/min rate limit) |
| GET | `/chat/groups/:chatGroupId/participants` | List participants |

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
`haveSharedAnEvent`, existing request, existing conversation. And
`@@unique([sender_id, recipient_id])` means **one request per pair for all
time** — decline it and that person can never send another.

### GET /conversations
Each conversation carries **`fromMatch`** — it opened from a mutual like rather
than from an accepted message request.

It has to be a server field. The payload carries the *resolved* name and
`theyRevealed`, and `mayShowRealName` returns `true` for **both** a
never-pseudonymous conversation and a revealed match, so `theyRevealed` cannot
tell them apart. Anything built on it would greet every accepted message request
as a new match. Derived from `user1_pseudonym`/`user2_pseudonym`; the pseudonyms
themselves are never sent.

### GET /events/:eventId/chat
The response carries a **`write`** block:

```json
{ "allowed": false, "reason": "window_closed",
  "message": "This chat has closed. Event chats stay open for 24 hours after the event ends.",
  "closesAt": "2026-08-17T22:00:00Z", "eventEndedAt": "2026-08-16T22:00:00Z" }
```

`reason` is one of `locked | archived | window_closed | muted | banned`, or
`null` when writing is allowed. The composer used to guess: every refusal came
back as a single `NOT_CHECKED_IN` covering several unrelated situations, so the
app either showed the wrong reason or let someone type a paragraph and then threw
it away. `closesAt` lets the room show an honest countdown.

**Write access is attendance, not presence.** A `chat_group_members` row means
you were physically at the event; checking out does not revoke it. See
`mayWriteToRoom` in `lib/chat-window.ts`.

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
| DELETE | `/conversations/:id` | **Leave — closes it for both people, permanently** |

`POST /conversations` does not create a channel out of nothing. It requires an
accepted message request between the two people, or a conversation that already
exists — otherwise `400`. A block in **either** direction makes both this and
sending return as though the other person were not there.

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

Only URLs not already on your profile are checked, so re-saving is cheap, and
the checks run concurrently.

Moderation **degrades open**: if it cannot run, the upload succeeds and the row
records `checked: false` for a later sweep. A vendor outage must not stop
somebody having a profile picture.

**It does not verify the photo is of you**, or of a person at all. Moderation
scores harm, not subject matter — a photo of a dog passes.

**`User.image` is a mirror of `photos[0]`**, nothing else. Provider avatars from
Google are no longer taken at signup: an avatar is not a choice, and it had
never been through the checks above. Clearing every photo clears it too.

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
request status.

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
| `announcement` | anyone with `canOperate` — the organising org, **or the venue owner** | no |
| `sponsored` | `canOperate` **and** an organisation with `may_sponsor` | **yes** |
| `system` | `app_admin` only — it speaks as Blend'n | no |

**This route used to compare two user ids.** `event.organizer_id !== caller.id`,
which is exactly the mistake `lib/rbac.ts` exists to end, and it failed in three
directions at once: an `app_admin` could not announce, a venue owner could not
announce for an event in their own building, and a colleague at the organising
org was refused for not being the row's creator. `organizer_id` still records who
*created* an event — a different question, still useful for audit.

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
`remember: true`. Refused with **403** and a message that names the rule:

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
in the future, or implies an age outside 13–120 is refused, because storing
nothing while telling the user their profile saved is the worse failure.

Three consequences worth knowing about:

- **Age and intent may be sent together.** The gate reads the age *after* the
  request, so the onboarding screens can save both in one call. Works with
  `dateOfBirth` in place of `age`, with the same precedence as everywhere else.
- **Lowering your age strips the tag.** Otherwise "set 25, tick dating, set 15"
  is two individually legal requests that leave a 15-year-old in the pool. A
  corrected `dateOfBirth` strips it the same way.
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
  "18+" — a shared link reaches that screen whatever the listing did.

Set by the organiser in the dashboard event form, bounded 13–25.

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

### Reports from the app

| Method | Endpoint | Writes |
|--------|----------|--------|
| POST | `/users/:userId/report` | `user_reports` |
| POST | `/messages/:messageId/report` | `message_reports` (`messageType: "group" \| "private"`) |

Both return `201 { reported: true }` and are rate limited per user.

These are **not** moderation flags and are not returned by the admin flag API
above. A flag is the pipeline's opinion about one message; a report is a person
asking for help, and may be about a person rather than a message. They are read
at `/dashboard/moderation/reports`, where an admin can dismiss, remove the
message (group rooms only — `private_messages` has no `deleted_at`), or suspend
the account. Until 0.61.0 both tables were written by these routes and read by
nothing at all.

Nothing is returned to the reporter beyond the 201. Replying to a reporter does
not exist yet; see `docs/MODERATION_RESPONSE.md`.

---

## Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/categories` | List all categories |
| GET | `/amenities` | The amenity vocabulary — what an event can say it offers |
| GET | `/work-fields` | The eighteen coarse fields of work, as `{ slug, label }` |
| GET | `/checkins/active` | Get user's active check-ins |
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

Kept: the four settings booleans (how a dead account would behave, not who the
person was), and `event_check_ins` — attendance is the organiser's history too,
and it is the co-presence that keeps a conversation open for someone who
actually met them. What they were *open to* is only theirs, and goes.
