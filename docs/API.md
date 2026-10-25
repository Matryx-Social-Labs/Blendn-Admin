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

Error codes: `VALIDATION_FAILED`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `SERVER_ERROR`, `EVENT_FULL`, `EVENT_NOT_STARTED`, `EVENT_ENDED`, `OUT_OF_RANGE`, `ALREADY_CHECKED_IN`, `STORAGE_UNAVAILABLE`, `USER_MUTED`, `USER_BANNED`, `CHAT_LOCKED`, `NOT_CHECKED_IN`, `SPAM_BLOCKED`, `NOT_LIVE`, `EVENT_LIVE_HERE`, `PLUS_REQUIRED`, `NO_CHECK_IN_AREA`, `GPS_TOO_VAGUE` (those five: Go Live, below), `ACCOUNT_DELETED`, `SESSION_REVOKED_ELSEWHERE`, `PASSWORD_RESET`, and from the middleware `UPDATE_REQUIRED` (426) and `MAINTENANCE` (503); see *Why an account was refused or a session ended*. The body can also carry **`reasonCode`** (`ACCOUNT_SUSPENDED`, `ACCOUNT_STAFF`, `ACCOUNT_DELETED`, `SESSION_REVOKED_ELSEWHERE`, `PASSWORD_RESET`, `AGE_UNKNOWN`, `PROFILE_INCOMPLETE`) beside an `errorCode` that keeps its old value

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
| GET | `/auth/session` | Get current session info, with `signInMethod` | - |
| POST | `/auth/signout` | Revoke refresh token (none given: every phone session) | - |

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

A deleted account is told nothing at a **password** sign-in: the generic 401
it always was, so deletion is never confirmed to a caller who only has an
address. Google, Apple, `session` and a signed refresh token say
`ACCOUNT_DELETED` (below).

### Why an account was refused or a session ended (Flow 15)

**Backward compatibility is the rule.** Builds in the field match on a response's
`errorCode` and its sentence (`FORBIDDEN` plus the sentence is what they show for
a suspended or staff account; `AGE_RESTRICTED` and `FORBIDDEN` drive the check-in
and Go Live sheets). So an `errorCode` that already existed **never changes**, and
the reason goes in a separate body field, **`reasonCode`**. A client that knows it
reads `reasonCode ?? errorCode`. The sentences are unchanged too. Only where a
response had nothing but the default 401 code (which no installed build reads) is
the new code in `errorCode` as well, and `reasonCode` repeats it.

| Where | Status | `errorCode` | `reasonCode` | Sentence (unchanged) |
|---|---|---|---|---|
| `signin`, `google`, `apple`, `refresh`, `session` | 403 | `FORBIDDEN` | `ACCOUNT_SUSPENDED` | "This account has been suspended. Contact support@blendn.app if you think that's a mistake." |
| the same five | 403 | `FORBIDDEN` | `ACCOUNT_STAFF` | "This app is for attendees. Organisers, venue owners and sponsors sign in at the dashboard." |
| `google`, `apple` | 401 | `ACCOUNT_DELETED` | `ACCOUNT_DELETED` | "Account not found" |
| `session` | 404 | `NOT_FOUND` | `ACCOUNT_DELETED` | "User not found" |
| `refresh`, a signed unexpired token of a deleted account | 401 | `ACCOUNT_DELETED` | `ACCOUNT_DELETED` | "Invalid or expired refresh token" |
| `refresh`, a session a password reset or change ended | 401 | `PASSWORD_RESET` | `PASSWORD_RESET` | "Invalid or expired refresh token" |
| `refresh`, a session `signout` with no token ended (every phone) | 401 | `SESSION_REVOKED_ELSEWHERE` | `SESSION_REVOKED_ELSEWHERE` | "Invalid or expired refresh token" |

**One `errorCode` did change.** The deleted-account 401s (`google` / `apple`
"Account not found", `refresh` for a deleted account) used to carry the default
`UNAUTHORIZED` and now carry `ACCOUNT_DELETED`, and `session`'s 404 keeps
`NOT_FOUND`. No installed build reads `UNAUTHORIZED` on these (checked against the
app in the field: it matches `FORBIDDEN`, `AGE_RESTRICTED`, `NOT_FOUND` elsewhere,
`RATE_LIMITED` and a few room codes), so nothing it does depends on the old value.

`signin` with a password never says `ACCOUNT_DELETED`: it is the generic 401
`UNAUTHORIZED` "Invalid email or password", so it still confirms nothing. A
forged or expired refresh token learns no reason: `UNAUTHORIZED`, no `reasonCode`. Signing
out **one** device, a rotation and an old token with no recorded reason are also
plain `UNAUTHORIZED`.

The reason is stored on the revoked `mobile_refresh_tokens` row
(`revoked_reason`: `password_reset` | `signout_all`), written by
`endPhoneSessions` (`lib/session-end.ts`) for a password reset or change and for
Settings' sign-out of every phone. `POST /auth/signout` with **no**
`refreshToken` takes that same path, which means it now also refuses the
account's earlier access tokens and closes its live sockets, as the other
"all phones" callers always did. A token revoked that way and presented again
after the reuse grace is **not** read as theft (it used to revoke every session
opened since).

The row is kept until the token's own `expires_at` (the hourly sweep of revoked
rows leaves any row that carries a reason), so a phone that comes back a day
later is still told why. `revoked_reason` is limited by a CHECK to those two
values. A refresh and a sign-out-everywhere are serialised on the account's row
(`FOR SHARE` against `FOR NO KEY UPDATE`): a refresh in flight can never leave a
live session behind a sign-out, and sign-out reads its stamp only once it holds
the lock, so no access token issued before the commit outlives it.

A token that was already rotated out (revoked, no reason, still inside the reuse
grace) is ended too: `endPhoneSessions` also stamps the reason on revoked,
unexpired rows, and the refresh refuses, under the lock, any token whose row was
created at or before the account's `mobile_sessions_revoked_at`. A replay after a
sign-out-everywhere or a password reset is therefore a 401 with the reason and
mints no session; a token issued after the sign-out refreshes normally.

An account suspended, deleted or signed out in the last twenty minutes is turned
away at `GET /auth/session` earlier still, as a bare 401 "Invalid or expired
token" (`lib/account-blocklist.ts`); the refresh that follows says why.

**`GET /auth/session` also returns `signInMethod`**: `"password" | "google" |
"apple"`. The tokens do not carry how this phone signed in, so it answers for the
account: `password` when it has one, else the provider linked most recently.
And `appleLinked` (boolean, additive): Sign in with Apple is linked, whatever
`signInMethod` says. An account made with Apple that later set a password reads
`signInMethod: "password"` and `appleLinked: true`; the app fetches an Apple
`authorizationCode` before `DELETE /account` whenever `appleLinked` is true.

**Socket handshake.** `io` refuses a mobile token whose account is not live with
`Error("Authentication required")` and `error.data.code` of `ACCOUNT_SUSPENDED`,
`ACCOUNT_STAFF` or `ACCOUNT_DELETED`. A phone signed out everywhere is refused with the
same message and no code.

**Update required.** The app sends `X-App-Version` (native only). When
`MOBILE_MIN_APP_VERSION` is set and the header is a plain dotted version
(`1.4.0`, up to four numbers) below it, any `/api/mobile` request is refused
before its route runs:

```json
HTTP 426
{ "success": false, "error": "This version of Blendn is no longer supported. Update the app to continue.", "errorCode": "UPDATE_REQUIRED" }
```

A missing header (every installed build, and the web), `unknown` or an
unparsable one is **never** refused; neither is a preflight. Unset: no minimum.
A `MOBILE_MIN_APP_VERSION` that is not a version enforces nothing and logs a warning once.

**Maintenance.** With `MAINTENANCE_MODE=1` (or `true`) every `/api/mobile`
request is refused before its route runs, whatever the version:

```json
HTTP 503   Retry-After: 300
{ "success": false, "error": "Blendn is down for maintenance. Try again shortly.", "errorCode": "MAINTENANCE", "retryAfter": 300 }
```

`MAINTENANCE_RETRY_AFTER_SECONDS` sets the wait (default 300, at most 3600; a
non-number or non-positive value is the default). Unset: off. `/api/health`
(Railway's healthcheck), the dashboard and the socket handshake are never
affected; they do not pass through the mobile gate. Both gates are in
`middleware.ts` through `lib/mobile-gate.ts`, and `X-App-Version` and `X-Channel-Set` are in
`Access-Control-Allow-Headers`.

**At the door.** Two refusals a person can fix now say so in `reasonCode`, with
`errorCode` and the sentence exactly as before: `reasonCode: "PROFILE_INCOMPLETE"`
beside `errorCode: "FORBIDDEN"` (onboarding unfinished and no adult age on file),
and `reasonCode: "AGE_UNKNOWN"` beside `errorCode: "AGE_RESTRICTED"` (an age that is
**not on file**; `GET /events/:eventId` never refused an unknown age, and still does
not). On check-in, Go Live, RSVP, favourite/interest and the board. A known age
below the line has no `reasonCode`. **`reasonCode` is on the event doors only**: the
messaging and friend routes (conversations, message requests, friend requests and
invites) answer the same unfinished-profile 403 with `FORBIDDEN` and no
`reasonCode`, and the regulars opt-in answers `AGE_RESTRICTED` with none; nothing
has been rolled out to them.


### Password reset

Mobile clients call the shared web endpoints; there is no `/api/mobile` twin.

| Method | Endpoint | Description | Rate Limit |
|--------|----------|-------------|------------|
| POST | `/api/auth/forgot-password` | Request a reset link | 5/15min per IP, 3/hr per address |
| POST | `/api/auth/reset-password` | Set a new password with the token. Answers `{ ok, audience, app }`: `audience` is `attendee` or `dashboard`; `app` is `{ deepLink, appStoreUrl, playStoreUrl }` for an attendee (the store URLs are null until `APP_STORE_LISTED` / `PLAY_LISTED` is `true`), null otherwise | 10/15min |
| GET | `/api/auth/reset-password?token=` | Does the link still work? `{ valid }`, plus `audience` (`attendee` or `dashboard`) on a live link only; consumes nothing; one answer for used, expired, tampered or erased (SCRUM-461) | 30/15min |

**The reset page's "done" depends on whose account it was (SV15).** An attendee's
account lives on the phone and the dashboard refuses it, so `/reset-password`
shows "Open Blend'n" (`blendn://`, with the App Store and Google Play listings
as the fallback once those are public) and does **not** send them to `/login`.
Every dashboard role (`app_admin`, `organizer`, `venue_owner`, `sponsor`) keeps
the sign-in link and the redirect.

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
      "timezone": "Asia/Kolkata",
      "venue_name": "The Humming Tree", "city": "Bengaluru",
      "attendedAt": "2026-08-14T18:04:00.000Z",
      "stay_minutes": null, "venue_id": null, "venue_type": null,
      "ratedAt": "2026-08-15T09:30:00.000Z" },
    { "id": "…", "kind": "venue_day", "slug": "…", "title": "Venue day · …",
      "cover_image_url": null, "start_time": "…", "end_time": "…",
      "timezone": "Asia/Kolkata",
      "venue_name": "Third Wave Coffee", "city": "Bengaluru",
      "attendedAt": "2026-09-28T16:20:00.000Z",
      "stay_minutes": 95, "venue_id": "…", "venue_type": "cafe", "ratedAt": null }
  ],
  "pagination": { "page": 1, "limit": 20, "totalCount": 7, "totalPages": 1, "hasMore": false, "nextCursor": null }
} }
```

Every row carries `timezone`, the event's own IANA zone (`events.timezone`, as
`GET /events/:eventId` sends it): format `start_time` and `end_time` in it, not
in the phone's zone. The same field is on the other event items that show a
time: `nextEvent` on `GET /venues`, and `tonight` and each `upcoming` item on
`GET /venues/:venueId` and `GET /venues/:venueId/upcoming`. Additive; an older
server omits it, so fall back to the venue's or the phone's zone when absent.

Each row also carries `categories`, `[{ id, name, slug, icon }]` as the
favourites list sends them (additive; `[]` for a `venue_day`), for the Past
row's category plate.

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

**`totalCount` plus `lockedCount` is the same figure as `stats.eventsAttended`**
on the profile, by construction: the list and the count share one predicate, so
they cannot disagree. Working an event as staff is not attending it, and
appears in neither.

**Your latest 3 ended nights are free; the older ended ones are Blendn+** where
it is gated (the city of your latest night). This list is what "night history"
means for Blendn+; a room's own messages follow the room's rules, not Plus.
"Ended" is `end_time < now`, the app's own "past". Without Plus there, `events`
is every night still running (tonight, never locked, never one of the 3) and
your latest 3 ended nights, newest first; the pages stop there (`totalCount` is
that number), and `lockedCount` is how many ended nights are older — show
"‹n› more nights with Blendn+". `lockedCount` is 0 whenever nothing is hidden,
including while 3 or fewer of your nights have ended. `totalCount +
lockedCount` stays `stats.eventsAttended`. (Before S-1, 2026-10-24, the 3 free
slots were the latest by check-in, so on a night out they were the nights still
running and the app, which lists only ended ones, showed none.)

An event the platform has since deleted is in neither the list nor the count,
so every page is full and `totalCount` is the number of events listed
(SCRUM-432).

**Places you went live at are in it too** (D-6), with `kind: "venue_day"`:
show them labelled as a place, by `venue_name`. A venue day's `title` is
bookkeeping ("Venue day · … · date") and is not for display.

**A visit says how long and where** (additive). Every row carries `stay_minutes`
and `venue_id`; both are `null` on an `event`. On a `venue_day`: `venue_id` is
the place's id (for its page), and `stay_minutes` is the length of your presence
there, in whole minutes — your presence sessions that day summed (going live
again the same day adds a stretch, never overwrites one), a session still open
counted to its last heartbeat. `null` when there is no session to measure, which
is unknown, not zero. Yours alone, like the rest of the route; one grouped read
serves the page, whatever its size.

**`venue_type`** is a visit's kind of place (`cafe`, `pub_bar`, … or null when the
venue has none; null on an `event`). **`ratedAt`** is when *you* last rated that
night, as `GET /events/:eventId/rating`'s `ratedAt`, so the list can say "Rate"
or "Rated": null if you have not, and always null for a place. One grouped read
for the page, never one per row.

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
      "status": "published", "visibility": "public",
      "venueName": "…", "address": "…", "city": "Bengaluru",
      "latitude": 12.97, "longitude": 77.59,
      "rsvpStatus": "waitlisted", "rsvpAt": "2026-09-20T10:12:00.000Z",
      "changedAt": null, "changedFields": [] }
  ],
  "pagination": { "page": 1, "limit": 20, "totalCount": 3, "totalPages": 1, "hasMore": false, "nextCursor": null }
} }
```

- **`/me` only**, like attendance: where somebody is going is the same
  correlation, in the future tense.
- **`categories`** (additive, 2026-10-24): each event's categories as
  `GET /users/:userId/favorites` sends them, `[{ id, name, slug, icon }]`, read
  in the same query. The app draws the row's category plate from `slug`.
  `GET /me/attendance` rows carry the same (`[]` for a `venue_day`).
- **`going` and `waitlisted`**, with `rsvpStatus` saying which, so a waitlisted
  place is never shown as a confirmed one. Not `maybe` or `not_going`.
- **`visibility`** is `public`, `unlisted` or `private`, so a card can say an
  event is unlisted (Flow 16). `GET /users/:userId/favorites` and `GET /events`
  carry it too; `GET /events` only lists public events.
- **`changedAt` and `changedFields`** are `GET /events/:eventId`'s, from the same
  helper (`changeForResponse`): when the time, venue or status last moved, and
  which (`time`, `venue`, `cancelled`, in that order). `null` and `[]` for an
  event that has not changed, and again when every change was put back. No
  `changedFrom` on a row; open the event for what it was. `GET
  /users/:userId/favorites` carries the same two on each event. Read from the
  rows already selected, so no query is added per row.
- **Upcoming only, soonest first.** An event is listed until its `endTime`.
  Cancelled events stay, with `status: "cancelled"`; drafts and deleted events
  do not appear.

## The rebuilt screens' server gaps (Flows 3, 6, 9)

**Everything here is added, nothing renamed.** An `errorCode` that existed keeps
its value and its sentence; the reason goes in `reasonCode` beside it
(`reasonCode ?? errorCode`). Every new response field is optional for a client
that does not know it.

### The event: what changed, the days, and why a link is refused (Flow 3)

`GET /events/:eventId` adds:

| Field | Shape | Meaning |
|---|---|---|
| `changedAt` | ISO string \| `null` | When the time, the venue or the status last moved under people who had heard of the event. `null` for an event that has not changed (almost all), and again when every change was put back |
| `changedFields` | `("time" \| "venue" \| "cancelled")[]` | What moved, in that order. `[]` when nothing did. Derived on read, so a time moved and put back is no change |
| `changedFrom` | `{ startTime?, endTime?, venueName?, address? } \| null` | What those were **before the first change still standing**, for the struck-through old time. Only fields that still differ appear; a cancel names none. The live values stay in `startTime`, `endTime`, `venueName` |
| `days` | `{ date, startTime, endTime, cancelled, cancelledAt }[]` | The days of the run, in order, at most 31 (`date` is the local `YYYY-MM-DD`). One entry for a one-day event. A day called off is `cancelled: true`: draw it struck through |
| `dayCount` | number | How many days the whole run has; `days.length < dayCount` means more exist than were sent |
| `daysFrom` | number | Which day of the run `days[0]` is, 1-based (1 unless the run is longer than the window) |
| `dayNumber` | number \| `null` | The 1-based position of `session`'s day: "Day 2 of 3". `null` when every day is cancelled |

`session`, `startTime`, `endTime` and the rest are exactly what they were.

A change is recorded (`events.changed_at`, `events.changed_from`) by the three
doors that can move one: the dashboard `PATCH /api/events/:id` (time and venue
live only there), the mobile `PATCH /events/:eventId` (title, description,
status: so only a cancel) and the admin status dropdown. Only a **published**
event records one, into published or cancelled; a draft has nobody going. The
first value of a field wins, so a time moved twice is struck from what people
were first told. No door writes a cancelled *day* (`event_occurrences.cancelled_at`
has no writer yet): `days[].cancelled` reads it when something does.

**The people who are going are told with `event_changed`** (a new
`notification_kind`), `data: { type: "event_changed", eventId, changed }` where
`changed` is the same words comma-joined (`"time,venue"`, `"cancelled"`), and
`reason` is the one that matters most (`cancelled`, `time`, `venue`), the same
`data.reason` an `event_update` carries (see Flow 9). Going
means `rsvp_status = going`. Maybe, waitlisted and saved keep `event_update`, as
before. A build that does not know the kind is sent `event_update` in its push
(see the channel set below), and reads the bell row as `event_update` too: the
stored row is `event_changed` for everyone going, and `GET /notifications` serves
it in the old kind and shape (`kind` and `data.type` `event_update`, the rest of
`data` unchanged) unless the request declares `X-Channel-Set: 2` or later (see
**Reading the bell as an older build** below).

**Why an event link is refused**, `reasonCode` beside the unchanged
`errorCode` and sentence:

| When | Status | `errorCode` | `reasonCode` |
|---|---|---|---|
| Event is age-restricted and the viewer's known age is below it | 403 | `AGE_RESTRICTED` | `AGE_RESTRICTED` |
| Taking part (RSVP, save, board, check-in) in one with no age on file | 403 | `AGE_RESTRICTED` | `AGE_UNKNOWN` |
| Taking part with an unfinished profile | 403 | `FORBIDDEN` | `PROFILE_INCOMPLETE` |
| The event was live and its organisation was suspended, and you are going (or maybe, or waitlisted) or are of the organisation | 404 | `NOT_FOUND` | `ORGANISER_SUSPENDED` |
| The same event, and you are a stranger or said `not_going` (public or private alike) | 404 | `NOT_FOUND` | none |
| The same event, on the door (`POST /events/:id/checkin`) and you have a stake in it | 400 | none | `ORGANISER_SUSPENDED` |
| The same event, on `GET /events/:id/checkins`, `/crews`, `/chat` (and `POST /chat` with no room yet) | 404 | `NOT_FOUND` | `ORGANISER_SUSPENDED` |
| The same event, on `POST /events/:id/chat` into a room that already exists | 403 | `FORBIDDEN` | `ORGANISER_SUSPENDED` |
| A draft nobody published, a private event you are not on, a deleted one | 404 | `NOT_FOUND` | none |

`ORGANISER_SUSPENDED` is the same on every route that refuses such an event, the
event's own page, RSVP, save, board, room preview, the door, the guest list, the crews and the
chat (`lib/event-access.ts`, `suspensionReasonFor`), and it is said to the same
people (a stake: going, maybe or waitlisted, or the organisation) and nobody else.
`errorCode` and the status are what each route always answered; read
`reasonCode ?? errorCode`. It is a stable code: the sentence beside it is ours to
change.

Viewing an age-restricted event with no age on file still opens (OAuth accounts
start without one), so `AGE_UNKNOWN` comes from the routes that take part.
`PROFILE_INCOMPLETE` now rides on **every** participation refusal (RSVP, save,
board, friends, DMs, message requests), not only the door.
**There is no "organiser removed" reason**: deleting an account deletes its
events, so the id is gone and answers like any unknown id.

### Profiles: photos pulled and badges (Flow 6)

`GET /profiles/:userId` adds, inside `profile`:

- **`photo_states`** (your own profile only): `{ url, pulled, pulled_at, was_main }[]`.
  First `photos`, in order, each `pulled: false`; then the photos moderation
  pulled in the last 7 days, newest first, `pulled: true`, with `was_main` saying it
  was the main one ("your next photo is your main photo now"). A pulled photo is
  gone from `photos` (the profile `PUT` drops it) and its object is withdrawn, so
  its **`url` is `null`**: a CDN that still held the old URL would keep serving the
  image. Draw a tile that says so. Stored as `photo_checks.pulled_at` and
  `pulled_was_main`; a pull from before this shipped is never listed.
- **`badges`**: `{ kind: "nights_out" | "shows_up", label }[]`, derived from check-ins by
  the rule a match card uses. Present (possibly `[]`) when `show_badges` is not
  off, for you and for anyone who can see who you are; **absent** when it is off,
  or for a viewer the profile is anonymous to. **With `show_badges` off the key is
  absent for the owner too**: the switch hides your badges from you as well as from
  everyone else, so Edit profile shows the switch and no badges while it is off.
  `regular_here` is never here: it is about the venue you both stand in.

### Notifications: preferences, row details, badge (Flow 9)

**`GET` / `PUT /me/notification-preferences`**: `{ matches, crew, night }`, all
booleans, all `true` by default. `PUT` takes any non-empty subset (a missing key is
left as it is; an unknown key or a non-boolean is a 400 `VALIDATION_FAILED`) and
answers all three. `GET` also says **`mutedRooms`**, an integer: how many rooms you
have silenced, exactly the ones `GET /me/muted-rooms` lists, counted up to **1000**
(show "999+" at 1000). `PUT` does not send it. The send path honours the switches, on
the single and the bulk sender:

| Switch | Stops the push of |
|---|---|
| `matches`, Matches and friends | `match`, `reveal_request`, `reveal`, `friend_request`, `friend_accepted`, `board_request`, `board_request_accepted` |
| `crew`, Your crew | `crew_invite`, `crew_here`, `blend` |
| `night`, After the night | `rating_request` |

They stop the **push only**; the bell row is written first, as for `push_enabled`
(the master, which is still on top of these). **Offers keep their own pair**,
`GET/PUT /me/offers` (`enabled`, `pushes`), and are *opt-in* by App Store rule:
`pushes` defaults off. A DM, a message request, a room reply (muted per room), an
event's change and a report's outcome have no switch here. Stored as
`profiles.push_matches`, `push_crew`, `push_night`.

**`GET /notifications`** items gain, all optional:

- **`display`** `{ title?, context?, visual? }`, only where the reader may already
  see the person or thing, resolved in one query per kind for the page:
  - `friend_request` while it waits: `title` "{first name} wants to be friends",
    `visual` `{ type: "photo", uri }`, the asker exactly as `GET /friends/requests`
    shows them to the same person.
  - `match`: `visual` `{ type: "creature", pseudonym }`, the other side's room
    pseudonym, and `context` the same pseudonym. Never a name or a photo.
  - `crew_invite`, `crew_here`: `visual` `{ type: "emblem", seed }`, the crew's
    `emblem_seed`; `blend`: the Blend's id as the seed.
  - `context` (S-2, 2026-10-24) names the counterpart by the name the reader
    sees it by in the app at that moment, so rows of one kind can be told
    apart, and only while they still may:
    - `match`: the other side's pseudonym (never a name, revealed or not),
      while the conversation is open and neither has blocked the other;
    - `blend`: the Blend room's own name ("A × B", or "A + 1" for one person),
      while the room's door admits the reader: open and on its clock, no side
      dissolved or hidden, no block across the sides;
    - `crew_invite`: the crew's name ("‹crew› asked you"), while the Crews
      screen would list the invite (open and not lapsed, the inviter still a
      member and your friend, nobody in the crew kept apart from you: the
      accept's own rule), or you are a member; and the crew neither dissolved
      nor hidden. A crew renamed after you left is never named to you, and a
      block is never told by a name appearing or not.
    Otherwise absent. The lock-screen push stays nameless.
  - `event_update`, `event_changed`, `announcement`, `waitlist_promoted`,
    `rating_request`: `visual` `{ type: "event", cover, badge, cancelled }`
    (`badge` `clock`, `map-pin` for a venue change, `megaphone`, `star`;
    `cancelled` when the event is cancelled or the reason is).
  - **Not sent:** `stack` (nothing aggregates rows yet), and `context` on event
    rows (the app already writes "{event} · {when}"). A row the server cannot resolve (the request
    is gone, the event deleted) carries no `display`: draw the kind's own tile.
- **`open`**, for `friend_request`, `crew_invite`, `message_request` and
  `board_request`: whether it is still the reader's to answer (a `crew_invite`:
  whether the Crews screen would list it, the same rule as its `context`). `false` once it is
  accepted, declined, dismissed, withdrawn or gone; absent on every other kind.
- **`data.reason`** on `event_update` and `event_changed`: `cancelled`, `time` or
  `venue`, the most important when several moved (`data.changed` has them all,
  comma-joined). A reminder ("starts in an hour") carries none.

**Reading the bell as an older build.** A build that does not know `event_changed`
has no tap for it, so the feed is served to it the way its push is (`channelSet`
above). A build that knows the kind declares it on the request, **`X-Channel-Set: 2`**
(the same number it posts with its push token; send it on every request, as
`X-App-Version`). With no header, or a value below 2 or that is not a whole number,
`GET /notifications` serves every `event_changed` row as `kind: "event_update"` with
`data.type: "event_update"`; `eventId`, `reason` and `changed` are untouched, and so
is the tile (`clock`). With `2` or later it is served as `event_changed`. Nothing is
rewritten in the database, so a phone that updates reads its old rows as
`event_changed` from then on. Every other kind reads the same either way.

**What one poll costs.** The feed, its decoration and both counts are at most 13
statements however long the page: the page, one read per kind present (friend
requests with their senders in two more, crew invites and memberships, message and
board requests, matches, events, crews), and two counts. Nothing runs per row.
`unreadCount` is served by `notifications (user_id, read_at)`, and `badgeCount`'s
unread conversations by the partial index `private_messages_unread_idx`
(`__tests__/integration/bell-cost.itest.ts` counts
the statements and reads the plan; a 50-row page took a median of 8 ms against a local
database).

The feed response gains **`badgeCount`**: `unreadCount` plus live conversations
with something unread from the other person (a thread, not a message; a hidden
message is never counted), the app icon's number.

**`clearKeepsRequests` is not sent.** `DELETE /notifications` clears every row,
waiting requests included, so the client's default (it clears them too) is right.

The push payload carries **`data.notificationId`**, the id of that recipient's bell
row, so a banner can open or mark it. The stored row's `data` does not hold it.

### Friends: reasons (Flow 6)

`reasonCode` beside the unchanged `errorCode`. **None says why somebody is out of
reach**: an unknown, reset or deleted link, a block either way and a pair who left
each other still answer the same body.

| Where | Status | `errorCode` | `reasonCode` |
|---|---|---|---|
| Any friends or DM route, unfinished profile | 403 | `FORBIDDEN` | `PROFILE_INCOMPLETE` |
| `POST /friends/requests` `{ userId }`, out of reach | 404 | `NOT_FOUND` | `PERSON_UNAVAILABLE` |
| `POST /friends/requests` `{ token }`, link does not work | 404 | `NOT_FOUND` | `INVITE_UNAVAILABLE` |
| `POST /friends/requests` to yourself | 400 | none | `CANNOT_ADD_SELF` |
| `GET /friends/invite/:token` and `/preview`, every way a link fails | 404 | `NOT_FOUND` | `INVITE_UNAVAILABLE` |
| `POST /friends/requests/:id`, gone, withdrawn, malformed or not yours | 404 | `NOT_FOUND` | `REQUEST_UNAVAILABLE` |

**`GET /me/muted-rooms?limit=&cursor=`** (read rate tier): the rooms you silenced,
Settings › Notifications › Muted rooms. Answers
`{ rooms: Row[], nextCursor: string | null, pagination: { limit, hasMore } }`.

- A **row is a `GET /chat/groups` row**, field for field, built by the same code
  (`lib/chat-group-rows.ts`): `kind` is `event` (a `groups` row, `event` block and all),
  `crew` or `blend` (a `rooms` row); `mute: { muted, until }` says until when
  (`until: null` is "until I turn it back on").
- **Which rooms**: your member rows (`active` or `muted`; a ban or a leave is a
  removal) with a mute in force now (a `muted_until` in the past is lapsed and an
  unreadable one reads as lapsed, as `mute` itself does), in a room the chat list would
  list for you: a live room (not archived, no draft or deleted event, a venue's room
  only while your Go Live is open) and, for a crew's or Blend's room, through its owner's
  door as it stands now (a dissolved crew, a closed Blend, a Blend across a block, a
  suspended crewmate are not listed). Unread counts and previews follow your blocks, as
  on the chat list.
- **Order and paging**: newest mute first, ties on the room id; a keyset on
  `(muted_at DESC, chat_group_id)` (`muted_at`: when you muted the room, written by `POST
  /chat/groups/:id/mute`; reading or posting in the room does not move it; a mute from
  before it falls back to the member row's last change), the cursor opaque. `limit` 1-100 (default 50; a
  non-number is the default, a number is clamped). A `cursor` an earlier answer did not
  give is a **400 `VALIDATION_FAILED`**. A page can hold fewer than `limit` rows with a
  `nextCursor` when the rooms between are not listed; stop when `nextCursor` is null.
- **Cost**: the read starts at the partial index `chat_group_members_muted_idx`
  (`user_id` where `notification_preferences->>'muted' = 'true'`), built `CONCURRENTLY`
  in its own migration; the `mutedRooms` count uses it too.

**Capped counts.** `unreadCount` on `GET /notifications` and on `POST
/notifications/read` stops at **1000** (the app shows "999+"), and so does the bell's
share of `badgeCount`: at most 1000 plus the unread conversations.

**The icon's number rides on every push.** Every push sets `badge` to the same
`badgeCount` the feed serves, counted when it is sent and after its own bell row is
written, so the number is right while the app is closed (SCRUM-740). A single send counts
the one person; a bulk send (an announcement, an event's change) counts everybody who has
a device in two statements in all (one `groupBy` over the bell rows, one over the unread
threads), never one per recipient. A caller that passes its own `badge` keeps it, and a
count that fails sends the push without one.

### Push: the channel, the token's `channelSet`, `report_actioned` (Flow 9)

`POST /notifications/token` accepts an optional **`channelSet`** (integer). A build
that creates Android channels `matches`, `crew` and `after-the-night` sends `2` with its token
(stored as `push_tokens.channel_set`). Every build before it sends none and is
treated as the old set.

- **No `channelSet`** (every build in the field): the channel and the payload are
  exactly what they were. `event_changed` is sent as `event_update`.
- **`channelSet: 2`**: each kind goes on one channel (`channelId` in the push):

| `channelId` | Kinds |
|---|---|
| `messages` | `private_message`, `message_request`, `message_request_response` |
| `rooms` | `group_message` |
| `matches` | `match`, `reveal_request`, `reveal`, `friend_request`, `friend_accepted`, `board_request`, `board_request_accepted` |
| `crew` | `crew_invite`, `crew_here`, `blend` |
| `events` | `event_update`, `event_changed`, `announcement`, `waitlist_promoted` |
| `after-the-night` | `rating_request` |
| `offers` | `venue_offer` |
| `default` | `report_actioned`, `event_checkin`, and a payload with no type |

**`report_actioned`** (a new `notification_kind`) tells the person who filed a
report that it led to action: `title` "We acted on your report", `body` "Thanks for
telling us. We took action on it.", `data: { type: "report_actioned" }`. Sent when
a moderator's decision is *resolved* (a message or post removed, an account
suspended, a listing delisted, a crew hidden or dissolved); **not** for a dismissal
or a reinstatement. It names no one and no thing, and it has no switch.

## Public share read (landing site, server to server)

Not for the app. The landing site's functions call these to draw `www.blendn.app/e/<id>`, `/v/<id>`
and `/event/<id>` and their link-preview cards. No auth, no CORS; `lib/share-public.ts`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/public/share/events/:eventId` | `{ available: true, event }`: `id`, `title`, `description`, `startsAt`, `endsAt`, `timezone`, `state` (`upcoming` / `cancelled` / `ended`), `indexable`, `minAge`, `place` `{ venue, name, address, area }`, `coverUrl`, `venueUpcoming` (at most 3 public events at its venue). Published, cancelled or completed events that are `public` or `unlisted`, host not suspended |
| GET | `/api/public/share/venues/:venueId` | `{ available: true, venue }`: `id`, `name`, `typeLabel`, `area`, `address`, `city`, `indexable`, `upcoming` (at most 5, public published future events only). An active venue; `indexable` is false for a claimed venue with Open on Blendn off |

- **An unlisted event** carries `place.area` only (no venue, address or description), an empty `venueUpcoming`, and `indexable: false`.
- **Unavailable is one answer.** Private, draft, deleted, suspended host, venue day, unknown and malformed ids: `404 {"available":false}`, the same bytes and headers as a 200 (`Cache-Control: public, s-maxage=60, stale-while-revalidate=60`). A failed read is `503 {"available":false,"retry":true}` with `no-store`, never that 404.
- **`coverUrl`** is only an object under `events/` on the public bucket, else null; the landing checks the host again before fetching it.
- **Rate limit:** 120 a minute per client network under the fixed key `share:<network>`; a 429 is `no-store`. The landing sends the visitor in `x-share-client` and proves itself with `x-share-proxy` (= `SHARE_PROXY_SECRET`, compared in constant time); without a matching secret the header is ignored and the caller is limited by its own address.

## Events

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/events` | List events (paginated, filterable) |
| GET | `/events/:eventId` | Get event details. Also carries `area` (the confirmed venue's area, else the city; null when neither is known), `doorPolicy`, `details` (or null) and `amenities`, none of which the list has. `chatGroup` is `{ id, name, status, member_count }` — snake_case — or null; `member_count` is `stats.hereCount`, in the room now (the column of that name only ever went up, and is not read). `categories[]` are the leaves as stored, `{ id, name, slug, description, icon }`, with no `parent`. `distance` is kilometres from `lat`/`lon`, and `null` (never absent) without them. `organizer.id` is null when the host is the platform. Also `changedAt`, `changedFields`, `changedFrom`, `days`, `dayCount` and `dayNumber` ([Flow 3](#the-event-what-changed-the-days-and-why-a-link-is-refused-flow-3)) |
| POST | `/events/:eventId/checkin` | Check in to event. 404 for a venue day's id: a venue's room is entered by going live (`POST /venues/:venueId/live`). `left` names the rooms it took you out of (see "One room at a time, and the switch") |
| GET | `/events/:eventId/people` | People from a night you attended, for the Recap — see below |
| POST | `/events/:eventId/checkout` | Check out of event |
| POST | `/events/:eventId/favorite` | Toggle favorite/interest |
| DELETE | `/events/:eventId/favorite` | Remove favorite |
| GET | `/events/:eventId/interested-users` | `{ interestedCount, users: [], pagination }` — a count. `users` is always empty: who favourited an event is not disclosed |
| GET | `/events/:eventId/rating` | Your own rating → `{ rating: 1..5 \| null, review, ratedAt }`; null when you have not rated. Nobody else's is ever returned. 404 `NOT_FOUND` for an unknown or deleted event |
| POST | `/events/:eventId/rating` | Rate an event — stars 1–5, optional review; anyone with a check-in row, **once it has ended** (attendance, not presence: leaving does not forfeit it — SCRUM-181); one row per person, rating again edits it. A refusal is `403 FORBIDDEN` with `reasonCode` `NOT_ATTENDED` (no check-in) or `NOT_ENDED` (still running). Answers `eventStats: { ratingCount }` and no average, and the event's `stats` carry none either: an attendee who can poll an average reads each new score from its change (SCRUM-437) |
| POST | `/events/:eventId/rsvp` | RSVP — waitlists when full |
| POST | `/events/:eventId/announce` | Send announcement |
| GET | `/events/:eventId/chat` | Get event chat group |
| GET | `/events/:eventId/peer-ratings` | Who you can still rate |
| POST | `/events/:eventId/peer-ratings` | Rate someone you met. A refusal is `403 FORBIDDEN` with `reasonCode` `NOT_ENDED` (the night is still running) or `NOT_CONNECTED` (not someone you connected with, already rated, or blocked) |
| GET | `/events/:eventId/matches` | Who else was in the room, ranked. 403 `USER_BANNED` for a member a host removed from the room (the chat's answer) |
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

**Matching v2 (plan v2 §8): `overlaps`, `sign`, `badges`.** "Rank on what
people chose and did; display what they are."

```json
{ "overlaps": [ { "kind": "ipl", "text": "Both CSK — in RCB country 💛" },
                { "kind": "language", "text": "You both speak Malayalam" } ],
  "sign": null,
  "badges": [ { "kind": "regular_here", "label": "Regular here" } ] }
```

- `overlaps` are display-only lines you share, as sentences, rarest in the
  room first: an IPL team (an interest leaf, so it also **ranks**, by rarity —
  two CSK fans in a room of RCB fans outrank two RCB fans), a this-or-that
  answer (`You both picked filter coffee over chai`), and **Tier B** — a
  language, a home state or a sign (`Both from Kerala`, `Both Leos ♌ — the
  stars approve`, `Leo and Simha — same sign, two calendars ♌`). Language,
  state, sign and this-or-that are **never scored**: the room ranks the same
  whatever they are. Before a reveal: at most two lines, **at most one Tier B
  fact per card, and none in a room below eight people**. The work field is
  Tier B too: a shared field competes for the slot (shown as `sharedWorkField`,
  not a line), and when no shared line took it their own `workField` does;
  only then the sign chip — so a card carries one of language / home state /
  sign / work field before a reveal, never two. The floor counts the people
  **inside now plus you**, not everyone who came. After a reveal
  (`visibleInRoom`), up to four, unbudgeted. Positive only: never a mismatch.
  "In RCB country" only in a room past the floor, when the leading team has at
  least three fans and more than twice the runner-up's; otherwise "Both CSK
  fans". **Your own** languages, home state, sign and work field count only if
  you set them before you checked in (`tier_b_changed_at`): editing them
  mid-event changes no card in that room.
- `sign` is their own sign, `"Leo ♌"` or `"Simha ♌"`, only if they chose to
  show one, and only when the card has Tier B left — never beside a Tier B
  line before a reveal, never below eight people.
- `badges` come from GPS check-ins, never typed: `Regular here` (3+ nights at
  this event's venue in 60 days, only at that venue), `Shows up` (80% of RSVPs
  in 90 days attended, at least 3 — only if they turned on `shows_up_badge`),
  `5+ nights this month` (a tier, never a count). Attendance facts, so empty
  below the eight-person floor, like `sharedEvents`; none for anyone who turned
  off `show_badges`. Computed for the page returned only.

`POST .../likes` takes `{ "userId": "<this event's room handle>" }` — the card's
own `userId` — and returns
`{ "mutual": false }` or `{ "mutual": true, "conversationId": "..." }`. A mutual
like opens the conversation directly: a message request exists to establish that
both people agreed to talk, and two likes are exactly that.

`PUT .../preferences` takes `{ intent?: ("dating"|"networking"|"friendship"|"just_here")[],
revealed?: boolean, remember?: boolean }`. Per event, because both change —
someone open to dating on a Friday is often only there for the talk on Tuesday.
`remember` also writes the profile default.

### A member a host banned from the room

A ban closes the room's people, not only its chat. To a member a host banned
from an event's room, every one of these answers as the chat does — 403
`USER_BANNED`, "The organiser has removed you from this room." — and opens
again when the ban is lifted:

`GET /events/:eventId/checkins`, `/matches`, `/people`, `/crews`,
`/peer-ratings`; `POST /events/:eventId/peer-ratings`, `/waves`,
`/matches/likes`; `PUT /events/:eventId/matches/preferences`; and, given one of
that room's handles, `GET /users/:handle`, `/profiles/:handle`,
`/profiles/:handle/interests` and `POST /message-requests`. A raw id carries no
room and is not asked about.

To everybody else a banned member is not in the room: a wave answers 403
`RECIPIENT_NOT_HERE` and a like 404 "User not found", the answers for anybody
not here — never which.

### GET /events/:eventId/people — people from tonight

The Recap's "People from tonight" row and its deck (Flow 4 · 4.5): who checked
in to a night you attended, as the room shows them, marked "Was here", with
Like (`POST /events/:eventId/matches/likes` takes the handle) and Message.

```
GET /events/:eventId/people?limit=30&cursor=rh_…
```

```json
{ "success": true, "data": {
  "open": true, "total": 5120, "nextCursor": "rh_…",
  "people": [
    { "userId": "rh_…", "displayName": "Cosmic Panda", "photo": null, "age": 27,
      "insideNow": false, "youLiked": false, "overlap": "You both picked chai over filter coffee" }
  ]
} }
```

- **As the room shows them.** `userId` is the person's handle in this room,
  never an account id; `displayName` is their pseudonym, or their name (with a
  `photo`) only where they revealed here — the roster's rule.
- **Never listed:** you; staff; anyone in a block with you, either way; anyone
  you closed a conversation with; **your friends**, whatever their "friends can
  see me in rooms" setting — friends never meet as stranger cards (owner,
  2026-10-22); Show online status off; a member a host banned from the room; a
  suspended or deleted account. `total` counts who may be listed.
- **Until the room's chat closes** (24 hours after the end). After that
  `{ open: false, total, people: [], nextCursor: null }` — the count only. A
  `total` of 0 means nobody to show: leave the row out.
- **Paged by cursor** for a concert-sized night: ordered by first arrival; send
  `nextCursor` (the last card's handle) back until it is null. `limit` 1–50,
  default 30. `overlap` is one sentence of what you share, and always null on a
  night under 8 people.

| Refusal | When |
|---|---|
| 404 | Unknown, draft or deleted event, or a venue's live room (its people are for whoever is live there now) |
| 403 | You never checked in to it |
| 403 `USER_BANNED` | A host removed you from the night's room: the chat's own answer and sentence. `GET /events/:eventId/matches` answers the same |
| 400 `INVALID_CURSOR` | A cursor that is not a card from this room (another room's, forged, or an id): start from the top |
| 429 `RATE_LIMITED` | 60 a minute per person |

### GET /events - Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| page | int | 1 | Page number |
| limit | int | 20 | Items per page (max 100) |
| search | string | - | Fuzzy match across title, description, venue, city. **Not a scope** — "Bengaluru" also matches an event *titled* "Bengaluru Meetup" held in Delhi. Trimmed; empty is no search. At most 100 characters, else `400 VALIDATION_FAILED` with `reasonCode: SEARCH_TOO_LONG`. One character is answered, filtered in date order (not ranked). From 2 characters, with the default `sortBy=start_time`, results are ranked by where the word is: title, then venue, then city, then only the description; by start time within each (S-6). Past 500 matches the search is in date order instead, with the true `totalCount` (never a capped one). `sortBy=distance` or `created_at` orders as asked |
| city | string | - | **Scope the list to one city.** Exact, case-insensitive. Values come from `GET /events/cities` |
| lat | float | - | Latitude — sorts and labels by distance, never excludes |
| lon | float | - | Longitude |
| radius | float | **none** | Hard limit in **km**. No default: sending coordinates alone no longer filters |
| categoryId | uuid | - | Filter by category. Parent-inclusive — picking a parent sweeps in its children |
| categorySlug | string | - | Same, by slug |
| startDate | ISO date | - | Events starting after |
| endDate | ISO date | - | Events ending before |
| featured | bool | false | `true`: only the featured events (published, public, within your age, not ended, in `city`), in the day's rotation, **at most 5** however large `limit` is; `sortBy` is ignored, and the response is always page 1 (`page=2` returns the same five, not a second five). Build the Featured section with this, not by filtering a page |
| status | string | published | Event status filter |
| sortBy | enum | start_time | `start_time`, `created_at`, `distance` |
| sortOrder | enum | asc | `asc`, `desc` |
| include | string | - | Comma-separated: `checkins,activeCheckins,profile` |

**`featured` on each event is `{ kind, rank, by }` or `null`.** `kind` is
`editorial` (Blendn's own pick, today's `isFeatured`, set by an admin; `by` is
`"blendn"`; drawn without a label) or `promoted` (a paid placement: always
labelled "Promoted"; `by` is the placing organisation). Nothing sells a
placement yet, so no event is `promoted`, but a client that switches on `kind`
should already handle it. `rank` is 1-based in the day's rotation among the featured
events in the same response, so with `featured=true` it is the order of the
section. The rotation is a hash of the UTC day and the city (`featuredSeed`,
`rotated` in `lib/featured.ts`): the same order for everyone in a city all
day, a different one tomorrow, so which five of a larger set lead is stable
and fair over time. It is not start-time order. `isFeatured` stays for older builds and is the same fact as
`featured !== null`. Computed by `featuredOf` in `lib/featured.ts`.

**"Here now" is `hereCount`, not `checkInCount`.** Each event (and the
detail's `stats`) carries both. `checkInCount` — and `currentCapacity`, the
same number — is everybody who checked in, left or not, so a night's headline
does not fall as people go home. `hereCount` is who is inside right now:
checked in, not checked out, guests only — the Room's and the room preview's
number. A live card that says "here now" reads `hereCount`.

**Each event carries `goingCount`**: RSVPs with status `going` — not
`waitlisted`, `maybe` or `not_going`. It is the number `GET /events/:eventId`
calls `stats.rsvpCount`, on the card so a list need not open every event to
show it.

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

**`days` is bounded** (the table above): at most 31 entries. Every day of an
ordinary event; for a longer run the stretch starting two days before today's
(`session`'s), so `dayCount`, the whole run, can exceed `days.length`, and
`daysFrom` says which day of the run `days[0]` is (the same "Day 3" the check-in
refusal below names). Each day also carries `cancelledAt` (when it was called
off, else null) beside `cancelled`. `daysFrom` and `cancelledAt` are additive.
Computed by `eventDays` in `lib/occurrences.ts`.

**A check-in refused on the clock names the day** on a multi-day event:
`Day 3 starts Tue 29 Sep, 12:45 AM.` (`EVENT_NOT_STARTED`), `Day 2 has been
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

The city picker's list — every city with upcoming events or listed places.
Cities with events come first, busiest first; then cities with places only, by
place count.

```json
{ "success": true, "data": { "cities": [
  { "city": "Bengaluru", "eventCount": 12, "placeCount": 1505, "centre": { "latitude": 12.9716, "longitude": 77.5946 } },
  { "city": "Mumbai", "eventCount": 0, "placeCount": 1206, "centre": { "latitude": 19.0612, "longitude": 72.8521 } }
] } }
```

Pass `city` straight back to `GET /events`, `GET /events/search` or
`GET /venues`. A city with `eventCount: 0` is still a city: its Places list is
full. `placeCount` uses the venues route's visibility, except that a venue an
event has taken over right now is still counted.

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
  "area": "Indiranagar", "areaSlug": "indiranagar",
  "tonight": { "opensAt": "18:00", "closesAt": "01:00" },
  "floors": 3,
  "distance": 1.4,
  "upcomingEventCount": 2,
  "liveNow": "quiet",
  "tier": "open",
  "nextEvent": {
    "id": "…", "title": "Friday session", "slug": "friday-session",
    "coverImageUrl": "https://…", "startTime": "…", "endTime": "…",
    "timezone": "America/New_York"
  }
}], "pagination": { "…": "…" } } }
```

| Parameter | Notes |
|---|---|
| `search` | Matches name, address, city **and area** (the neighbourhood), so "Indiranagar" finds its venues |
| `city` | Exact, case-insensitive. Venues with no city are unreachable this way, as with events |
| `lat` + `lon` | Enables `sortBy=distance` and populates `distance`. **Does not filter** |
| `radius` | km. **No default.** Only bites when you send it |
| `venueType` | One of the 35 slugs, or a comma list (`pub_bar,brewery`): a venue of any of them. An unknown slug is a 400. `venueTypes` is the same filter under its plural name; send both and a venue of either matches |
| `area` | A neighbourhood by `areaSlug` (`koramangala-1st-block`). A venue with no area is in none |
| `area` / `areaSlug` (on every item) | The neighbourhood a person would name, from Overture's own division polygons (`scripts/places/areas.sql`, set by `scripts/backfill-venue-areas.ts`); both `null` when unknown, never guessed: fall back to the address or city. The list of areas is `GET /venues/summary` |
| `tonight` (on every item) | `{ opensAt, closesAt }` (`HH:MM`, wall clock in the venue's own timezone) from `venues.hours` for the weekday of the venue's current day, or `null` when no hours are given for it. A close at or before the open runs past midnight. A day with two openings answers with the later one. `venues.hours` has no writer yet, so this is `null` everywhere until one exists |
| `sortBy` | `name` (default) or `distance` |
| `tier` (on every item) | `live`, `open` or `quiet`: the tier `order=live` ranks by, computed by the same rule whatever the order — `live` if `liveNow` is not `quiet`; `open` if open tonight (hours for the venue's current day, or its next public event starts before that day ends); else `quiet`. Under `order=live` it is read from the sets that ordered the page, so it can never disagree with the order; a caller whose `liveNow` is null is never shown `live` |
| `order` | `live`: three tiers — **live now** (`liveNow` not `quiet`), then **open tonight** (`venues.hours` has a row for the weekday of the venue's current day, or a public event starts before that day ends), then the rest. Each tier is in the chosen sort with the id as tiebreak, so pages never repeat or skip a venue; read until the first quiet venue and nothing open tonight is lost. A caller who may not go live (`liveNow` null) gets the last two tiers. The response echoes `pagination.order: "live"` when applied; without it the server did not honour the order. A venue can change tier (somebody goes live) between two page requests, so **de-duplicate by venue `id` across pages** |

`floors` is the 3D map's height override for the venue's building, set by its
owner or an admin on the dashboard (1–200): draw it `floors × 3.2` m tall,
the rule our building tiles are baked with (scripts/map-buildings). `null` means
the map's own height. The same field is on `GET /venues/:venueId`.

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

**A claimed venue its owner took off Blendn is not listed** (D-13, step 18).
The venue's owner (or an admin) can switch "Open on Blendn" off on the
dashboard; the venue then leaves this list, and so Places and the home map. Its
events are untouched: they stay on `GET /events` and still name the venue. An
unclaimed venue is always listed. `GET /venues/:id` and Go Live are unchanged.

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

### GET /venues/summary

Counts of places, never of people, for the Places screen: `?city=` (optional;
`lat` and `lon` are accepted and ignored).

```json
{ "success": true, "data": {
  "total": 1513, "liveCount": 4, "openTonightCount": 61,
  "types": [{ "venueType": "pub_bar", "label": "Pub or bar", "count": 640 }],
  "areas": [{ "slug": "indiranagar", "name": "Indiranagar", "count": 36, "liveCount": 1,
              "typeMix": ["pub_bar", "cafe", "restaurant", "brewery"] }]
} }
```

It counts exactly the venues `GET /venues` lists for you in that city (active,
not deleted, not taken off Blendn by its owner, not taken over by an event for
your age), so `total` is the list's `totalCount`. `liveCount` and
`openTonightCount` are venues, by the list's own reads (`liveNow` not `quiet`;
tier `open`), and `liveCount` is 0 for a caller who may not go live (their
`liveNow` is null). `types` is most first; an unclassified venue is in `total`
only. `areas` is live venues first, then places, at most 100; a venue with no
area is in none. The type and area split is one grouped query; the answer is
kept 60 s per city (and per your age and whether you may go live). 60 a minute
per person, then 429.

### GET /venues/:venueId

One venue, as the Go Live screen needs it. 404 for an unknown, archived or
deleted venue; 403 `FORBIDDEN` (`reasonCode` `PROFILE_INCOMPLETE`) for a profile not onboarded, `AGE_RESTRICTED`
(`reasonCode` `AGE_UNKNOWN` when no age is on file) for one without a known adult age (as at its door). 60 a minute per person, then
429.

```json
{ "success": true, "data": {
  "venue": { "id": "…", "name": "The Humming Tree", "address": "…", "city": "Bengaluru",
             "latitude": 12.97, "longitude": 77.64,
             "venueType": "live_music_venue", "venueTypeLabel": "Live music venue",
             "floors": null, "claimed": false,
             "capacity": 300, "dayResetHour": 6, "timezone": "Asia/Kolkata",
             "hours": [{ "day": 5, "open": "17:00", "close": "01:00" }],
             "description": null, "amenities": ["Live Music", "Outdoor Seating"],
             "upcoming": [{ "id": "…", "title": "Friday session", "slug": "…", "coverImageUrl": null,
                            "startTime": "…", "endTime": "…", "timezone": "Asia/Kolkata" }],
             "upcomingTotal": 12, "upcomingNextCursor": "eyJ0Ijoi…" },
  "live": { "open": true, "closedReason": null, "eventId": null,
            "liveNow": "quiet",
            "youAreLive": true, "expiresAt": "2026-10-02T21:20:00.000Z", "stay": false, "stayUntil": null,
            "venueDayId": "…", "chatGroupId": "…" },
  "tonight": { "id": "…", "title": "Friday session", "slug": "…", "coverImageUrl": null,
               "startTime": "…", "endTime": "…", "timezone": "Asia/Kolkata" },
  "claim": { "url": "https://dashboard.blendn.app/claim/venue/…" }
} }
```

| Field | Meaning |
|---|---|
| `live.open` | Whether going live here would be accepted now, the fence aside |
| `live.closedReason` | `event_live_here` (a real event has the venue: check in to `live.eventId`) or `no_check_in_area` (nobody drew this venue's area — judged against the same area as the door: today's copy once anybody went live) |
| `live.liveNow` | `quiet` (fewer than 5, none included), `5-9`, `10-19` or `20+`. **Never a number** (D-19, D-x2): a count that moved from 4 to 5 as you watched would tell you somebody just walked in. Guests only (not the venue's staff), never counting you, read at most once a minute per venue, and slow to fall (it drops a bucket only once one more person would not hold it) |
| `live.youAreLive` … `chatGroupId` | Your own window. Count down from `expiresAt`, never from the tap; open the room by `venueDayId` / `chatGroupId` |
| `live.stayUntil` | The furthest "stay" can carry your window (four hours from the first stay today); null until you chose stay |
| `venue.hours` | Opening hours, `[{ day: 0-6 (Sun-Sat), open: "HH:MM", close: "HH:MM" }]` in the venue's own timezone (a close at or before the open runs past midnight); null until given |
| `venue.description`, `venue.amenities` | Free text about the place (null) and amenity names from the shared vocabulary (`[]`) until given |
| `venue.capacity`, `venue.dayResetHour`, `venue.timezone` | The venue's capacity (null if unknown), the local hour its day starts (0-23) and the IANA timezone (`Asia/Kolkata`, `UTC`) that hour is in. Read the two together: the phone derives neither from a time such as `dayEndsAt`, which is wrong across timezones |
| `venue.upcoming` | Its next public events, at most 5, soonest first: the Places card's filter (published, public, not ended, link not disputed by the venue, within your age) — never its own live rooms |
| `venue.claimed` | False: the app may offer "Own this place? Claim it" |
| `claim` | `{ url }` for an unclaimed venue: the public claim page (`/claim/venue/:venueId`) on the dashboard host, built for the environment the app talks to — open it as given. Null once claimed. As `claim` on `GET /events/:eventId` |
| `tonight` | The next public event here before the venue's day resets (06:00 local by default), age-filtered for you, or null. Like each `upcoming` item it carries the event's own IANA `timezone` (`events.timezone`), which can differ from `venue.timezone` |

**Not on it:** the check-in area (no payload draws the boundary), and who is
live. People are the venue day's roster and grid
(`GET /events/:venueDayId/checkins`, `/matches`), which only somebody live
there may read — you see people only while you can be seen.


**`upcoming` is the first five; `upcomingTotal` is all of them** (every event
coming at the venue, whatever the page holds) and `upcomingNextCursor` resumes the
rest (null when `upcoming` is whole). Both are additive, so an installed client
that lists five is unchanged.

### GET /venues/:venueId/upcoming

"See all" for the venue page: every coming event, soonest first, a page at a
time. The same filter and age rule as `upcoming` (published, public, not ended,
link not disputed, within your age; never a venue's own live rooms), the same
gates and 404 as `GET /venues/:venueId`.

```json
{ "success": true, "data": {
  "events": [{ "id": "…", "title": "Friday session", "slug": "…", "coverImageUrl": null,
               "startTime": "…", "endTime": "…", "timezone": "Asia/Kolkata" }],
  "pagination": { "limit": 20, "hasMore": true, "nextCursor": "eyJ0Ijoi…", "totalCount": 12 } } }
```

`?limit=` 1-100 (default 20), `?cursor=` the previous `nextCursor` (not ours: 400).

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
  "revealSuggestion": false, "intentNeeded": false, "left": []
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
| 404 | Unknown, archived or deleted venue, or today's room there was deleted |
| 403 `FORBIDDEN` (`reasonCode` `PROFILE_INCOMPLETE`) / `AGE_RESTRICTED` (`reasonCode` `AGE_UNKNOWN` when no age is on file) | Not onboarded / no adult age (an unknown age is refused here) |
| 409 `EVENT_LIVE_HERE` | A public event at this venue (link confirmed, or its own area at the venue) is on, or starts within the hour. The body carries `eventId`: hand off to that event's check-in. Checked before the fence |
| 400 `GPS_TOO_VAGUE` | A fix worse than 150 m (`deviceInfo.gpsAccuracy`): a better fix where you stand, not directions |
| 400 `NO_CHECK_IN_AREA` | Nobody has drawn this venue's area: no position fixes it |
| 400 `OUT_OF_RANGE` | A position outside the area — "You're not at ‹venue› yet.", never a distance. Before step 5 this code also covered the two rows above; the event check-in still uses it for all three. A refusal writes nothing: no venue day is made for it |
| 403 `PLUS_REQUIRED` | `stay` where Blendn+ is gated in the venue's city and you hold neither Plus nor a live Night Pass — open the paywall. Asked last, so it only stands where "stay" would otherwise have worked. In a city's launch season "stay" is everyone's (see Blendn+, below) |
| 429 `RATE_LIMITED` | 20 a minute per person; ceilings per address and per venue |

```json
{ "success": false, "error": "Friday session is on here. Check in to it instead.",
  "errorCode": "EVENT_LIVE_HERE", "eventId": "…" }
```

### POST /checkins/inside — which places am I inside

The places whose door would admit you where you stand (SCRUM-704). Light the
disc and dock the pass from this alone: the phone's own "nearest pin within
100 m" disagreed with the doors, which judge the real fence.

```json
{ "latitude": 12.9784, "longitude": 77.6408, "deviceInfo": { "gpsAccuracy": 12 } }
```

```json
{ "success": true, "data": {
  "places": [
    { "kind": "event", "eventId": "…", "venueId": null, "name": "Neon Nights",
      "venueName": "Toit", "startTime": "…", "endTime": "…",
      "going": true, "saved": false, "checkedIn": false },
    { "kind": "venue", "eventId": null, "venueId": "…", "name": "Toit",
      "venueName": null, "startTime": null, "endTime": null,
      "going": false, "saved": false, "checkedIn": false }
  ],
  "total": 2,
  "current": { "eventId": "…", "kind": "event", "venueId": null, "name": "Fandom" }
} }
```

- **Judged as the doors judge:** the event's fence (or a venue's Go Live area,
  today's copy once somebody went live), the accuracy allowance, the event's
  day (a cancelled day or one not yet open is out), onboarding, the age rule,
  a private event's guest list, and a venue a linked event has taken over (the
  event is listed instead). A fix worse than 150 m is inside nothing.
- **Order** — the first is the one the pass docks: an event you're `going` to
  or `saved`; events before venues; the event whose day started first; the
  nearest. At most 10, with `total` ("2 here · Switch").
- **`current`** is the room you're in now, or null. Beside a place that is not
  `checkedIn`, say "Checking in here takes you out of {current.name}." before
  the hold — the switch is never silent (SCRUM-635).
- **A venue never carries an `eventId`**: its door is Go Live by `venueId`, and
  `checkedIn` is true there when your live day is at that venue.
- **No distance**, ever: a venue's area is shown to nobody. POST so the
  position never sits in a logged URL. 20 a minute per person (`429`).

### One room at a time, and the switch

You are checked in to one place at a time — the database holds it (one open
check-in per person, SCRUM-705), so two doors at once leave exactly one open:
the later one. Checking in somewhere else (an event's door or Go Live) takes
you out of where you were, and both doors now say so: their responses carry
`left`, the rooms the switch took you out of, for the toast "You left {name}."

```json
"left": [{ "eventId": "…", "kind": "event", "name": "Fandom" }]
```

`kind: "venue_day"` is a venue's room, and `name` is the venue's. Empty when
you were in nothing, when you checked in again where you already were, when a
Go Live you had there had already run out, or when it was an earlier day of the
same event (that day is over, and its room is this one). A venue's room also
gets `live:ended { reason: "switched_event" }` on your sockets, as before.

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
below; a board post's room is not listed. A board post gets its room on the
accept that brings its second asker in (`PATCH /board/requests/:id`
`accept`, step 10): the room and a member row for the author and every
accepted asker, under the event room's pseudonyms, in the accept's own
transaction; each later accept adds its asker, and a row somebody left or was
banned from is never put back. **Nobody is seated beside somebody they are kept
apart from** — a block either way or a closed conversation, between any two
people in it: in accept order, such an asker is accepted 1:1 as usual and
silently not seated. A suspended or erased asker is not seated. In a board
post's room the history, live delivery, typing and roster also leave out
anybody you closed a conversation with, as they do anybody in a block. In a board post's room the roster (`/participants`) lists only the
people its owner admits, an asker in a block with the author is out, writes
stop 12 hours after the event ends (`CHAT_CLOSED`), and a withdrawn or
taken-down post closes the room (404). To block or report somebody there, use
the board's own routes (by post or by ask): the user routes read a board
room's handle as an unknown id. In an event's room the roster (`/participants`) lists the
people **in the room now** — checked in to its event, as `hereCount` counts
them — and its hosts (`admin`, `moderator`) whether or not they are; a member
who checked out or whose window expired is not listed. Its `totalCount` is the
people listed, not the headcount: "show online status" off and friends are
counted in `hereCount` and listed nowhere here. In a crew's room people are named by **first
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
never in the chat). `lastMessage.type` (S-7, additive, on `groups` rows too) is
the message's kind: a crew's "liked … for the crew" line is `system`, so the
preview drops "You:" before it. Own list rather
than more `groups` rows because an installed app reads `event` off every
`groups` row, and these rooms have none. A hidden crew's chat stays listed to
its members — hiding takes a crew off every surface outside it, not its own
chat (C12) — while a Blend with a hidden side is gone for everyone.

**Nothing in a row comes from somebody in a block with you.** On every row,
`groups` and `rooms` alike, `lastMessage` and `unreadCount` leave out messages
from anybody you blocked or who blocked you — the same filter the room's
history applies — so a blocked person's line is never previewed, named or
counted. Your own messages are never unread. Reading a room's newest page
(`GET /chat/groups/:chatGroupId/messages` without `before`) marks it read, as
`GET /events/:eventId/chat` does for an event's room. On `rooms`, `lastMessageAt` is the time of the newest message you can
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

### Lists are paged (SCRUM-760)

Every list a person accumulates is a **cursor page with a total**, so a person
with thousands of friends or a busy inbox never costs a full read, and the app
never needs to hold the whole list:

| Route | Page size for a client that pages (default; 1-100) | Without `limit` or `cursor` (installed builds) | Rows |
|---|---|---|---|
| `GET /conversations` | 50 | up to 200 | `conversations` |
| `GET /friends` | 100 | up to 200 | `friends` (and `count`, the whole list) |
| `GET /friends/requests` | 50 each | up to 200 each | `incoming`, `outgoing` |
| `GET /users/blocked` | 100 | up to 200 | `users` |
| `GET /events/:eventId/board` | 100 | 100 (the same) | `posts` (it was cut at 100 with no way to the rest) |
| `GET /crews` | 50 | up to 200 | `invites` (of the newest 200 open ones), with `invitesPagination` |

**A request with neither `limit` nor `cursor` is a build that cannot page**, and
gets up to **200** (`LEGACY_PAGE`), which is what it always got in practice
without an unbounded read. Anything that names a `limit` or a `cursor` is a
client that pages: it gets the default in the table unless it says otherwise,
1-100. So a new client **must send `limit` on its first page**, or it is given
the 200 and a `pagination.limit` of 200; a cursor with no `limit` is the
default. `pagination.limit` always says what this page was sized to, and
`hasMore` / `nextCursor` say whether 200 was enough. The board has no legacy
page.

`?limit=` (1-100) and `?cursor=` (the previous page's `pagination.nextCursor`,
opaque). The answer carries `pagination: { limit, hasMore, nextCursor,
totalCount }`; `totalCount` is the whole list whatever page this is, and
`nextCursor` is null on the last. A cursor that is not one of ours is `400`.
`GET /friends/requests` has two lists, so its `pagination` is `{ incoming,
outgoing }`, each as above; ask for one alone with `?list=incoming` (or
`outgoing`) plus `cursor`, and only that array comes back (a cursor without
`list` is 400). The order is newest first and total: rows sharing an instant
(a bulk insert) are neither repeated nor lost at a page edge. In the inbox a
conversation with nothing said yet leads, as before, and each row's
`lastMessage` is the newest message the thread would show (a hidden or
moderated one never previews). All of it is additive.

**`GET /friends?q=`** keeps the friends a word of whose name starts with `q`,
case-insensitively (1-40 characters, trimmed; longer is `400`; blank is no
filter). It is `GET /events/:eventId/friends-here`'s rule over the name a friend
card shows (the profile's, else the account's), and it combines with `limit` and
`cursor`: `count` and `pagination.totalCount` are then the filtered total. `%`
and `_` are letters, not wildcards. Friends only, as ever: this searches your
own list, and nobody else can be looked up.

**`GET /crews` pages its invites**: `invites` are the newest 200 open invites an
accept would take, a page at a time (`?limit=`, default 50; `?cursor=`, from
`invitesPagination.nextCursor`), newest first with the invite id breaking ties.
`invitesPagination` is `{ limit, hasMore, nextCursor, totalCount }`, and
`totalCount` is the invites in that cap, the ones listed, so the number never
exceeds what paging shows. An installed build, with neither `limit` nor `cursor`,
gets up to 200 as before. `crews` is not paged.

**The Going lists page by page number or by cursor** (`GET /me/rsvps`,
`GET /users/:userId/favorites`, `GET /me/attendance`). `?page=` and `?limit=` mean
what they always did (a response with `page` is the old block, `totalPages` and
all) and now also carry `nextCursor`; `?cursor=` (the previous
`pagination.nextCursor`, opaque) pages by keyset instead, answering
`pagination: { limit, hasMore, nextCursor, totalCount }`. The order is total, so
a page edge neither repeats nor loses a row that shares an instant: RSVPs by
start time then RSVP id, saves newest first then id, nights newest first then
event id. A cursor that is not ours, or does not name a row id, is `400`. With
none of `page`, `limit` and `cursor` (an installed build), up to 200. Where
Blendn+ gates `/me/attendance`, the cursor pages the free nights (those still
running and the latest 3 ended) and stops at them (`lockedCount`, `totalCount`
as before).

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

**`status`** (S-12, additive) is the room's own state, `active`, `locked`
(the organiser's lock) or `archived`, the same for everybody in it. Read the lock from it,
not from `write.reason`: that is the caller's own answer, and names their
mute or ban before a lock.

**Before the room opens.** An event's room opens 24 hours before it starts. A
person entitled to it (RSVP `going`, or the event saved) who asks earlier — `GET`
or `POST /events/:eventId/chat` — gets a refusal that says when, so the app can
count down; it writes nothing (no membership):

```json
403 { "success": false, "error": "This chat opens 24 hours before the event starts.",
      "errorCode": "CHAT_CLOSED", "reasonCode": "NOT_OPEN_YET",
      "opensAt": "2026-08-15T18:00:00.000Z", "chatGroupId": "…" }
```

`opensAt` is the event's start minus 24 hours. `chatGroupId` is present only if the
room row already exists. Somebody **not** entitled gets the generic 403
(`FORBIDDEN`, no `opensAt`, no `chatGroupId`), so the start of an event they have
no stake in is not readable from here. Read `reasonCode ?? errorCode`.

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
`event.venueId` is the place ("Go live again" opens it). Its `hereCount` and
`memberCount` are **null**: an exact count of a venue's room, moving as people
go live and expire, is the differencing the venue's bucket exists to stop (D-19).

An event's room carries `hereCount`: how many are **in the room now**, the
Room's own number — checked in, attendees, not suspended (`hereCountFor`, the
same figure as `room-preview`, the events list, `GET /events/:id`'s
`stats.hereCount` and the sockets' `hereCount`). Never the room's members: a
member row outlives the check-in (a checkout or an expiry leaves it `active`),
so a count of members was everybody ever in who had not pressed Leave.
`memberCount` is the same number under its old name, for the apps installed
before `hereCount`.

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
{ "content": "string", "type": "text", "parentId": "uuid?", "clientId": "uuid?" }
```
**Words only (R9, SCRUM-626).** A room takes no media: `type` other than `text`, or any `metadata` at all, is `400 VALIDATION_FAILED` with `errors[].message` "Photos can only be sent in a direct message". Photos go in a DM (`POST /conversations/:id/messages`). `metadata` was `{ mediaUrl }` (SCRUM-426), and before that a free record an attendee could use to draw a message as a sponsored card; the server's own writers (sponsored messages, broadcasts) still set a message's `metadata` and `type`, and older image messages are still read back as they were. The same rules apply to `POST /events/:eventId/chat`.

**Moderation (pre-emit):** Messages go through a 3-layer pipeline **before** being broadcast to other users:
1. **Spam check** (sync) — burst rate, duplicate, link density → blocks with 429
2. **Keyword filter** (sync, <1ms) — slurs/profanity in 9 languages → saves as hidden, returns `moderation_hidden: true`
3. **OpenAI Moderation** (pre-emit, 1s timeout) — AI content analysis → hides before broadcast

If caught, response returns `{ moderation_hidden: true, content: null }`. The message is never emitted via socket.
If OpenAI times out (>1s), message is broadcast and moderation falls back to async (socket delete event).

**Error codes:** `USER_MUTED` (403), `USER_BANNED` (403), `CHAT_LOCKED` (403), `NOT_CHECKED_IN` (403), `LEFT_ROOM` (403), `NOT_LIVE` (403, a venue's room after your Go Live ended), `SPAM_BLOCKED` (429)

**`SPAM_BLOCKED` says when to try again** (SV13): a send refused for a burst (5 in
10 seconds) carries `retryAfter`, whole seconds until that window ends, in the
body and in `Retry-After`, as a `RATE_LIMITED` 429 does. A message refused for
too many links has none: sending it again would not pass. The same on the event
chat and DM sends (`docs/API.md`, *Direct messages*). `errorCode` is unchanged;
`retryAfter` is optional and an older client ignores it.

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
| GET | `/conversations` | List conversations, newest first, a page at a time: 50, `pagination.nextCursor`, `pagination.totalCount`; see *Lists are paged* |
| POST | `/conversations` | Open a conversation — **requires an accepted request**; a closed pair gets 409 "This conversation was closed and cannot be reopened", as the respond route answers (SCRUM-300) |
| GET | `/conversations/:id` | Get conversation |
| GET | `/conversations/:id/messages` | Get messages |
| POST | `/conversations/:id/messages` | Send message. See **Photos in a DM** below |
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
- **Photos in a DM (R9, SCRUM-626).** `{ "text?": "…", "mediaUrl?": "url", "mediaType?": "image" }`, text or a photo or both. A photo only, so `mediaType` is `image` or left out (`video` is `400`) and the row's `mediaType` is always `image`.
  - **Whose:** `mediaUrl` must be the sender's own chat upload (`POST /uploads/presigned-url` with `folder: "chat"`, so `chat/<yourId>/…` on our bucket), or `400` "Send photos through the app rather than linking to them" (SCRUM-426).
  - **When:** once both people are named to each other (both revealed, or a conversation that never had pseudonyms, such as an accepted message request) or are friends. Before that, `403` "You can send photos once you have both revealed who you are", and nothing is stored. Text is not gated.
  - **What is stored:** a copy of the upload nobody can write to (SCRUM-425), under `chat/sealed/<uuid>`, which names nobody (SCRUM-448), so `mediaUrl` comes back different from the one you sent. The copy is the picture with its metadata removed: EXIF (with its GPS position), XMP, comments and anything after the image's end. An upload that never arrived, is over 10 MB, or is not a JPEG, PNG or WebP (by its bytes, whatever it was uploaded as) is `400`.

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

Until they reveal, the other person is a stranger on every raw-id surface too
(SCRUM-752): `GET /profiles/:id` and `GET /users/:id` answer their `otherUser.id`
exactly as they answer anyone you may not see — `name: "Attendee"`, the blurred
photo, no bio or photos — and carry no `friend`. A mutual like alone no longer
identifies; their reveal does. A room-level reveal, a friend who turned on
`friends_see_me_in_rooms` and a conversation that never was pseudonymous still
identify as before.

**The other person's id in a DM is a handle until they reveal.** In `GET
/conversations`, `GET /conversations/:id`, `POST /conversations`, a message's
`senderId` / `sender.id` and the `private:*` socket events, the other person of
a match who has not revealed to you is an opaque `rh_…` handle scoped to that
conversation (the same one on every one of those surfaces, so a sender still
matches the other person). Your own id is always your real id. Once they reveal
the real id comes back, everywhere at once. The handle is accepted by `POST
/users/:id/block`, `POST /users/:id/report` and `POST /conversations`, and by no
profile or friend route (they answer it as an id nobody has): it names a person
only inside that DM. It exists because every other surface that carries an
account id also carries a name, so the id beside a pseudonym was a join key.
`private:message` is sent per recipient (their copy names the sender by the
handle; the sender's devices get their own id); `private:typing` and
`private:read` go to the other person alone while the sender is a pseudonym to
them. `private:revealed { conversationId }` goes to the other
person's `user:{id}` room when somebody reveals in a DM (the route, or a room
reveal carrying into it), and to both once both have revealed; nothing but the
id, so the app re-reads the conversation, and nothing at all for a closed pair.
A mutual like between two people who already know each other — any
conversation between them, a friendship, or a friend request waiting — is not a
match: the like is recorded and answers exactly as a like nobody returned
(`mutual: false`, no `room:match`), under the pair's lock. Opening one would
hand back the old DM or link this event's pseudonym to the first one's. A
conversation made with pseudonyms is pseudonymous on both sides: a side the room
never named is `Attendee`, never null (null reads as real names). A handle
carries no photo, ever: the stored blur is one URL for every room.

Like the room handles, a conversation handle is keyed to the server secret:
rotating `NEXTAUTH_SECRET` retires every one a client holds, and the next inbox
fetch hands back fresh ones (the DM itself is addressed by `conversationId`,
which does not change). Blocking by a handle severs the friendship with that
person, as `POST /users/:id/block` always has.

**A friend request between two people who are still pseudonyms is held.**
`POST /friends/requests` still answers `{ state: "requested" }`, but when the
pair's only conversation is a pseudonymous one (a match, a board post) not yet
revealed on both sides, no push goes out, it is absent from the recipient's
`incoming`, `friend.state` is `none` for the recipient, and accepting it is a
`404`. When both have revealed it is released: it appears in `incoming` and the
push goes out then (from the reveal route, or from a reveal in the room carrying
into the DM); two people who had each asked become friends at that moment. An
unmatch closes the pair as it always did. For such a pair that are already
friends, `GET /friends/:id` has `conversationId: null` and `POST
/friends/:id/conversation` answers `409` as for a closed pair (the app shows
"The conversation didn't open. Try again."); they keep talking in the inbox.
`friend_requests.held_at` (migration `20261022120000_friend_request_held`)
records it. A held request is shown only on a positive test — the pair's
conversation is open AND both sides have revealed — so a closed conversation
never releases anything, and an unmatch (or block) deletes what was held.
Asking again after a withdrawal while the pair is still pseudonymous is held
too. A released request is announced exactly once (the release clears `held_at`
in one statement and only what it cleared is pushed) and carries no `via`: it
may have come by invite link. Migration `20261022140000_pseudonym_and_held_backfills`
repaired existing rows (a conversation with one null pseudonym becomes
`Attendee`; requests between a pair still pseudonymous became held).

`GET /events/:id/peer-ratings` lists the people you matched with **at that
event** (conversations born of a mutual like there), each by the id the inbox
shows for them: a handle until they reveal, their id after. `POST` takes that
ref, or a handle from before they revealed; a raw id for somebody still a
pseudonym is `403`.

**A board ask between people who already have a link is silent.** The link is
`pairIsLinked`: a friendship, any conversation (open or closed), or any friend
request (including withdrawn and dismissed). The same question decides a
mutual like (`mutual: false`, no match) and a board ask, so they cannot drift.
`POST /events/:id/board/:postId/requests` for such a pair answers `201` and
`status: "pending"` exactly as for a stranger, and records the ask as declined
with `board_requests.silenced_at`: no push to the author, not in their lists,
not answerable (`PATCH /board/requests/:id` is `404`), no seat taken. If the pair
becomes linked between ask and accept, or has blocked, the accept (a `PATCH`) is
that same `404` and the ask is silenced; there is no `409` for a closed pair any
more. A real accept always returns the new `conversationId`.

`POST /message-requests` to somebody you matched with who has not revealed to
you answers the same synthetic `201` it gives a stranger, never the `409`: the
409 would say a request or DM exists for an id the pseudonym is hiding.

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

`GET /users/:id` also carries `badges` (top level, the same list and rule as
`profile.badges` on `GET /profiles/:id`: present when `show_badges` is on and
you may see who they are), so the app needs no second read for either.
`GET /conversations/:id`, `GET /profiles/:id` and `GET /users/:id` (for somebody
you may see, never yourself) carry **`friend: { state, canAdd }`**; the
`GET /conversations` LIST does not (it is per row of an unpaginated list and no
client reads it there) — whether to offer "add as
friend". `canAdd` is true only for a match (not a message request or a board
conversation) that is open, where **both** sides have revealed, and you are not
friends or waiting on them. `state` is `none | requested | incoming | friends`
from your side; `incoming` (they asked you) is still `canAdd: true`, because
asking back accepts. While the other person is still a pseudonym to you it is
always `{ state: "none", canAdd: false }`: any other answer would say which
pseudonym is already your friend. The button calls `POST /friends/requests`
with `{ userId }`.

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

## Friends in rooms

The owner's rule (2026-10-22): **two friends never meet as strangers in a
room.** A friend is never a card, a face, a row, an arrival, a wave, a like or a
message request to the other, whatever either switch says. To you, a friend who
is not in "Friends here" is exactly what someone with "Show online status" off
already is: counted in the headcount, listed nowhere.

- **Absent for a viewer's friends:** the match deck / Meet next / was here
  (`GET /events/:id/matches`), the roster page and its `pagination.totalCount`
  (`GET /events/:id/checkins`), the room preview's taste count, an event room's
  participants list (`GET /chat/groups/:id/participants`; that list also now
  honours "Show online status" off, as the roster does — crew and Blend rooms are
  unchanged), and the live arrival (`event:room:checkin` is not sent to the
  arriver's friends). On `event:checkin` and `event:checkout` a friend's copy has
  no `userId` (the count only).
- **Refusals that must look like an unlisted stranger's:** a like at a friend is
  `200 { mutual: false }` and writes nothing; a wave is `403 RECIPIENT_NOT_HERE`
  (the show-online-off body); a message request is the synthetic `201` with
  nothing written, even when no friend DM exists yet.
- **Likes between friends go inert for good:** becoming friends deletes the
  `event_likes` between them, so an unfriend cannot resurrect a match.
- **Friends here:** `GET /events/:id/friends-here?order=recent|name&limit&cursor&q`
  → `{ friends: [{ userId, name, photo }], total, nextCursor }`. Your friends
  checked in at the event who turned on "Friends can see I'm here"
  (`friends_see_me_in_rooms`) and have "Show online status" on, by REAL id (open
  the DM with `POST /friends/:userId/conversation`). Not reciprocal (it is the
  friend's consent). Not listed: staff, suspended, checked out, a match still
  pseudonymous. `recent` (default, `limit` 8, max 50): the friend you last talked
  to first, then the newest arrival. `name`: A-Z, `cursor` is opaque, `q` filters
  (1-40 chars, a word prefix). `total` is every friend listed for you, never the
  page. No event, room or arrival time in the payload. 403 `NOT_CHECKED_IN` when
  you are not checked in. The socket event `room:friends { eventId }` says "refetch".
- **An ended friendship keeps the pair apart for 24 hours** (table
  `ended_friendships`, migration `20261023120000_ended_friendships`): an unfriend
  is silent, and without this the ex-friend's stranger card would appear in the
  other's deck at that moment. For 24 h the pair stay off each other's deck,
  roster and arrivals, and the like/wave/message-request refusals above apply.
  Re-friending deletes the row; a block writes none (it already hides both ways).
- The helpers are `lib/room-people.ts` (`notStrangersTo`, `knownToEachOther`,
  `strangersApartBetween`); a guard test fails the build when a people surface
  does not use them.

## Friends

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/friends` | My friends, newest first, a page at a time, and `count` (the whole list). `?limit=` (100), `?cursor=`, `?q=` (a word-prefix search of their names; `count` is then the filtered total); see *Lists are paged* |
| GET | `/friends/:userId` | A friend's profile (404 for anyone else). Carries the about line as `GET /users/:userId` sends it to somebody who may see who this is: `work_field`, `expertise`, `languages`, `homeState`, `sign` (labels), and `badges` unless they turned `show_badges` off (additive, 2026-10-24) |
| DELETE | `/friends/:userId` | Unfriend — silent, leaves any DM alone |
| POST | `/friends/:userId/conversation` | Open (or find) a DM with a friend → `{ conversationId }` |
| GET | `/friends/invite` | My invite link `{ token, url }`, made on first ask |
| POST | `/friends/invite` | Reset it — the old link stops working |
| GET | `/friends/invite/:token` | Who sent this link → `{ person, state }` |
| GET | `/friends/invite/:token/preview` | **No auth.** Signed-out invite screen → `{ name, photoUrl }` — first name only. Per-IP limit (20/min). Same 404 |
| GET | `/friends/requests` | `{ incoming, outgoing, pagination }` — 50 of each; `?list=incoming\|outgoing&cursor=` pages one alone |
| POST | `/friends/requests` | Ask: `{ token }`, or `{ userId }` for a revealed match → `{ state: "requested" \| "friends" }`. 404, plus `reasonCode` `NOT_A_REVEALED_MATCH` for a match not yet revealed on both sides |
| POST | `/friends/requests/:id` | `{ action: "accept" \| "dismiss" }` — recipient only |
| DELETE | `/friends/requests/:id` | Withdraw — sender only. Kept as withdrawn: asking again later neither re-notifies nor undoes a "Not now" |

**Nobody can be looked up.** There is no search. A request reaches someone only
through their invite link (`https://www.blendn.app/f/<token>`, 128 random bits,
resettable) or, by `userId`, a **revealed match** (owner, 2026-10-22: "if users
have matched and they have revealed themselves we can then give an option to add
as friend"). `revealedMatch(me, other)` in `lib/friends.ts` is true only when
there is an open (`closed_at` null) conversation between the two, it came from a
match (`cameFromMatch`: not a message request, not a board conversation), **both**
sides have revealed, and `mayConnect` passes (not deleted, not blocked, not
closed). A room-level reveal, `friends_see_me_in_rooms` and an accepted message
request no longer open this path. A room handle still resolves, but one its room
keeps anonymous is refused as unknown even for a revealed match: a 200 would say
which pseudonym in that room is them.

Every refusal a stranger could reach answers with the **same 404**: an unknown,
malformed or reset token, a deleted account, a block either way, a pair who
left each other, an id you have no relationship with. The one addition is
`reasonCode: "NOT_A_REVEALED_MATCH"` on that 404 (`errorCode` stays
`NOT_FOUND`), said only to someone in an open match with that person who has
**already revealed to them** and where you have not revealed back — they know who
it is. Where the other person is still a pseudonym to you, the 404 is plain: the
code would say who the pseudonym is, to anyone holding an id or a handle for them. A request made
this way notifies with `data.via = "match"` (so the app can say "from your
match"), and never names an event or room. The invite-link path is unchanged.
`GET /profiles/:id` also carries `friend` (same shape as above) for somebody you
may see, and never for yourself or a stranger.

A pair whose conversation began as an accepted message request or a board post
is never on this path: only a conversation born of a mutual like counts, however
well they know each other. They can still become friends by invite link.

Opening a link, asking and accepting all need a finished profile (the
participation gate, SCRUM-331). Ask, accept and block take a lock on the pair,
so two people asking each other at once become friends once, and an accept
racing a block never leaves a blocked person on the list. Refusals cost the
same work as a link that never existed, so timing tells a caller nothing either.

**Why a send, an accept or an invite open was refused.** An unfinished profile
is `403` `errorCode: "FORBIDDEN"` with `reasonCode: "PROFILE_INCOMPLETE"`; a
rate limit is `429` `errorCode: "RATE_LIMITED"` with `reasonCode:
"RATE_LIMITED"` and `retryAfter` (seconds; also the `Retry-After` header) —
on `POST /friends/requests`, `POST /friends/requests/:id`, `GET
/friends/invite/:token` (and the friend DM's profile gate). The `errorCode`s are
unchanged; read `reasonCode ?? errorCode`.

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
| GET | `/crews` | My crews `{ crews, invites, invitesPagination }` — open invites waiting for me that an accept would take, by the inviting friend's first name, a page at a time (`?limit=`, `?cursor=`; see *Lists are paged*) |
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
| POST | `/chat/groups/:chatGroupId/members/:userId/report` | Report a person in a crew's or Blend's room by the handle that room showed you, `{ reason, description? }` → 201 `{ reported: true }`. Members of that room only; 404 for any other room, a foreign or forged handle, or somebody not in it; 400 for yourself. Same admin queue as `POST /users/:id/report` |
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

**Card fields.** `GET /crews` and `GET /crews/:id` carry `hidden` (a moderator hid
it) and `apart` (somebody in the crew is missing from `members` because **you**
blocked them — never because they blocked you or a conversation closed, which
would say a crewmate hides from you). An invite carries `invitedByPhoto`, the
sender's first photo, shown to exactly who is shown their name. A crew name or
bio refused for its words answers 400 with `field: "name" | "bio"` (and the same
in `errors`).

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
reveals would single out the ones who stayed anonymous). Matching v2 adds
`overlaps` and `badges`: up to two lines of what the crew **holds** (at least
two of its active members and a third of the crew — members, not only those
here, so a line does not change as each one walks in) in common with your crew here or, alone,
with you — `Both crews are into Techno`, `Two RCB crews ❤️`, `This crew picks
chai over filter coffee, like you` — never a member and never a count;
languages and home states only between crews of four or more here in a room of
eight or more, one line at most. `badges` is `N nights out together` (nights
two or more members checked in at the same occurrence, since they joined) from
2. Ranked from your side: crew-held interests by rarity across the crews here,
plus shared intent, damped by half when one crew is more than twice the
other's size here (crew ↔ crew only); then most here, then by id; `limit` 30
by default, at most 50, `offset`, with `total` and `hasMore`. Hidden from you: a hidden crew, and any crew with a member kept
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

**What `GET /blends` adds for the reveal sheet.** There is deliberately no room
size: any figure for "everyone a reveal reaches" would count people who turned
"show online" off. Per side: `revealedCount` / `privateCount` (the same numbers as
`revealed` / `keptPrivate`: their side only, null on yours) and `crewRevealed`
(yours only, null on theirs): whether anybody on your side has tapped reveal
here. It is stored per side when the tap happens (`blends.a_revealed_at` /
`b_revealed_at`), whoever consented, so it never depends on which crewmate said
yes or no — one bit about the tap, never which member and never a count.

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
| `languages` | up to five slugs from `GET /profile-options` (besides English; `kannada_learning` is "Learning Kannada") | as a shared line on a card (Tier B); the labels to whoever can see who you are |
| `home_state` | a state / union territory slug, or `abroad` | the same |
| `sun_sign` + `sign_system` | opt-in: a sign slug and `western` or `rashi`, **both or neither** (400 otherwise; `profiles_sign_shape` in the table). Null both to take it off | the same, plus your own `sign` chip on cards |
| `shows_up_badge` | boolean, default false | turns on the "Shows up" badge |
| `show_badges` | boolean, default true | off: no badges on your card at all |

**Changing them is limited.** A real change to `languages`, `home_state`,
`sun_sign`/`sign_system` or `work_field` (once onboarded) is allowed three
times a day — the fourth is 429 `RATE_LIMITED`, "You can change your languages,
home state, sign or field of work three times a day. Try again tomorrow." —
and stamps `tier_b_changed_at`: in a room you checked into before the change,
your new values print no shared line. Otherwise a viewer could edit their own
facts and read which cards light up, learning every card's Tier B one edit at
a time.

**Display only, never ranked (plan v2 §8.1).** Languages, home state and sign
are printed when two people share them and never enter a score: ranking by
origin would sort a room by region, and by sign, by stars. Your own profile
returns the slugs plus `suggested_sun_sign` — the Western sign of your birth
date, for the editor to prefill, never stored until you pick it. Nothing on the
profile is, or will become, caste, community, religion, kundli or veg /
non-veg (`__tests__/never-build-fields.test.ts`).

`GET /profile-options` serves the vocabulary (languages, home states, the
twelve signs with Western and rashi names, the this-or-that questions).
`GET /me/this-or-that` returns `{ answers: { [question]: "a" | "b" } }`;
`PUT /me/this-or-that` takes `{ answers: { [question]: "a" | "b" | null } }` —
a choice sets, `null` takes back, an unknown question or choice refuses the
whole request (400), 409 `PROFILE_REQUIRED` before a profile exists.

**Interest leaves.** The ten IPL teams are leaves under `IPL` (`ipl-csk` …,
named by code) and food-and-drink loves (Cafe hopping, Street food, Desserts,
Bakeries, Italian, Pan-Asian — ways of going out, never a named dish, a diet or
alcohol) under `Food & Drink`. They are ordinary interests: picked through
`/profiles/:id/interests`, ranked by rarity, filterable as event categories.
The dashboard refuses to create or rename a category into a diet, faith,
caste, community, income, height, college or neighbourhood word
(`lib/never-build.ts`).

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

**A `poll` message carries `pollId`** in `GET /chat/groups/:id/messages`,
`GET /events/:eventId/chat` and the `chat:message` socket payload (`message.pollId`):
the id to read and vote on above. It is absent on every other type, and `null`
on a poll message that moderation hid. An older client ignores it.

**Every vote refusal is a 409 `CONFLICT` with its reason in `reasonCode`**, the
sentence in `error` unchanged: `POLL_CLOSED` ("This poll has closed"),
`ROOM_CLOSED` ("The chatroom is not open"), `NOT_IN_ROOM` ("You are not in this
chatroom"), `NOT_AN_OPTION` ("That is not an option on this poll"), `NOT_LIVE`
(a venue day's room, after Go Live ended). A banned member reading the results
back is a 403 with the room's ban sentence.

**Why a result is hidden**: beside `suppressed` and `suppressedLabel`, a poll's
results carry `suppressedReason` (`hidden_until_close`: open, results not published until it
closes, label "Results appear when the poll closes"; `few_votes`: a count under
the floor or one that would give a hidden one away; null when nothing is
withheld), so the app can draw the two differently. Optional and additive.

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
  door, and it refuses an unknown age as well as one below the line. An age that
  is not on file adds `reasonCode: "AGE_UNKNOWN"` (same `errorCode`, same sentence): the one the person can fix.
- **The events list and search omit the event** for anyone whose stated age is
  below it. An unknown age does **not** hide restricted events: OAuth accounts
  have no age, and hiding them all would empty the feed to punish a missing
  field. Discovery is permissive, the door is not.
- **`GET /events/:eventId` returns `minAge`**, so the detail screen can say
  "18+" — a shared link reaches that screen whatever the listing did. For a
  viewer whose derived age is **below** the line it returns 403
  `AGE_RESTRICTED` instead, like the door; an unknown age is shown the event.
- **RSVP, favourite/interest and the board (`/rsvp`, `/favorite`, `/interest`,
  `/board`, `/board/:postId/requests`) refuse 403 `AGE_RESTRICTED`** (with `reasonCode` `AGE_UNKNOWN` when no age is on file) for an under-age
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
not other attendees' business. `show_online` is honoured by the three surfaces where another attendee can
see that you are in a room: `GET /events/:eventId/checkins` (the roster),
`GET /events/:eventId/matches` (the grid), and the live arrival on the socket —
no `event:room:checkin` is sent for you (SCRUM-620). With it off you are **counted and
not listed** — the room's numbers include you, nobody is offered your card, and
nobody can like you. Chat is unaffected: posting a message is its own choice to
be seen.

---

## Users & Profiles

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/users/:userId` | Get user profile. `:userId` may be a room handle, echoed back as `id`, and is then answered in that room's terms — see Room handles. When `identityVisible` is true it also carries `connection: { conversationId, request: "sent" \| "received" \| null, youRevealed, theyRevealed }` — your open conversation, any pending message request between you, and who has revealed in it as `GET /conversations/:id` says (both false with no open conversation; additive, for the one-sided copy); absent otherwise, so the side that has not been revealed to learns nothing |
| POST | `/users/:userId/block` | Block/unblock user (`DELETE` to unblock) |
| GET | `/users/blocked` | The people you blocked. `blocked_id` is an **opaque ref to the block** (`bk_…`), not their account id — somebody blocked by their board post or room handle was never shown one, and this list must not be where it arrives. Send it back to `DELETE /users/:userId/block` to unblock; only a block you made is removed. A raw id still unblocks, for older clients, on your own block only. Name and photo appear only where the identity rules allow |
| GET | `/users/:userId/favorites` | Get your saved events, each with `visibility` — your own id only (403 otherwise); drafts are dropped, cancelled ones stay with `status` set (SCRUM-176); also `changedAt`/`changedFields`, as on `GET /me/rsvps` |
| GET | `/profiles/:userId` | Get a profile. Your own carries `email` and the whole `profile` row except `date_of_birth` (`age` derived) — `name`, `gender`, `interested_in`, `intent_default`, `reveal_by_default`, `blur_photo`, `interests`, `created_at`, `updated_at` included, and `expertise` as slugs. Anybody else's `profile` is `id, age, onboarded, location, interests, work_field, expertise` (labels), plus `bio, occupation, education, photos` if you can see who they are, else `blurPhoto`; no `email`, and `image` only if you can see who they are |
| PUT | `/profiles/:userId` | Update profile |
| GET | `/profiles/:userId/interests` | Get category interests — 404 when either of you has blocked the other, as the profile answers (SCRUM-299); empty through a room handle for somebody that room keeps anonymous |
| PUT | `/profiles/:userId/interests` | Update interests |
| POST | `/profiles/:userId/interests` | Add interests (`categoryIds`, at most 10 held, `TOO_MANY_INTERESTS`). Leaves only: a category with children is a group heading and is refused, `400 VALIDATION_FAILED` with a `categoryIds` field error and `reasonCode: CATEGORY_IS_A_GROUP`, storing nothing (S-9). A top-level category with no children is its own option |

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
get back (`photos`, a DM's `mediaUrl`) is the copy's,
not the `publicUrl` you sent.

**`profile` and `chat` take photos only: JPEG, PNG or WebP, up to 10 MB**
(SCRUM-626). GIF, video and audio are `400` here. The copy is the picture
without its metadata (EXIF and its GPS position, XMP, comments), so a photo
never says where it was taken; the app also re-encodes before uploading.

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

**A taken-down post is told to its author** (SV9). When a moderator removes a
post, or the automatic check takes one down, its author gets a
`board_post_removed` push ("Your board post was taken down", no words of the
post), a bell row of that kind (`data: { type, eventId, postId }`), and
`board:postRemoved` `{ eventId, postId }` on their own `user:` room (see
`docs/SOCKET_EVENTS.md`). Only when that action is what took the post down: their
own withdrawal tells nobody, and a post already withdrawn that a moderator then
marks removed tells nobody either. `GET /events/:eventId/board` carries
`takenDown`: `[{ id, kind, body, createdAt, takenDownAt }]`, the caller's own
removed or hidden posts (at most 20, newest first, never anybody else's), so the
app can show the state. Additive and optional.

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
| POST | `/checkins/inside` | Which places am I inside — see "POST /checkins/inside" under Venues |
| GET | `/checkins/active` | Get user's active check-ins. Each carries `kind` (`venue_day` is a Go Live: label it by `event.venueName`), `venueId` (the venue a Go Live is at, to extend or go again; null at an event), `expiresAt` (a Go Live's end; null at an event) and `stay`. A Go Live past its end is never listed, swept or not |
| POST | `/notifications/token` | Register push token. Optional `channelSet` (2: the build has the `matches`, `crew` and `after-the-night` channels) |
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
| An event you RSVP'd to or saved changes time or place, is cancelled, or starts in an hour | Going (`event_changed`: time, place, cancel), and maybe, waitlisted and saved (`event_update`) | `event:{eventId}`, replaced in place: only the latest state is true |
| An event you are checked in to is cancelled (SV7) | Everyone who was checked in at that moment, once, in batches of 500: `data: { type: "event_cancelled", eventId }`, "This event has been cancelled. You are no longer checked in." Their check-in is already cancelled and their presence closed. They are not sent the going/saved line above as well, so somebody inside and going hears it once. A build that has not declared channel set 2 is sent `event_update` instead (it opens the event), push and bell row alike, as for `event_changed` | `event:{eventId}` on `events`, replaced in place; one bell row of kind `event_cancelled` |
| An organiser announcement | Everyone in the room | Stacked with its event, never replaced |
| Friend request / accepted, match, reveal, board, message request | The person it is about, immediately | One each |
| A crew invite | The friend invited (`crew_invite`, `crewId`), naming nobody | One each |
| "We're here" | Every other crew member who has not muted the crew chat or blocked the tapper (`crew_here`, `crewId`, `chatGroupId`), once per person per night; no name, no place | One each |
| A Blend | Everyone the Blend room lets in, but the person whose like made it (`blend`, `blendId`, `chatGroupId`); no name, nothing about who liked first | One each |
| An event you checked in to ends | Everyone with a check-in row, once per event, within ~5 minutes of the end (only events that ended in the last 6 hours). `data: { type: "rating_request", eventId }` → the app opens `/rate/[eventId]`. People with a mutual like to rate (blocks excluded) get "rate the people you met"; the rest "rate the night"; somebody who already rated and has nobody to rate is skipped | `rate:{eventId}` on `events`, replaced in place |

A room you muted (`POST /chat/groups/:id/mute`) sends you neither the reply push
nor announcements.

Every push carries an Android `channelId` the app creates — `messages`,
`rooms`, `events` or `offers` ("Offers from venues", a venue's offer only) —
so each can be silenced in system settings, and an iOS
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

**Body (optional):** `{ "appleAuthorizationCode": "<code>" }`. For an account
that signed in with Apple, the app sends a fresh `authorizationCode` from Sign
in with Apple; after the erasure the server exchanges it at
`appleid.apple.com/auth/token` and revokes the grant at `/auth/revoke` (App
Store 5.1.1(v)). Best effort: with no code, no key configured
(`APPLE_TEAM_ID`/`APPLE_KEY_ID`/`APPLE_PRIVATE_KEY`) or Apple failing, the
account is still deleted, a warning is logged and an `account.apple_revoke`
audit row records the outcome (`revoked`, `skipped`, `failed`). The code must
belong to the account: the `sub` of the `id_token` Apple returns is checked
against the account's linked Apple user id, and a code for a different Apple ID
revokes nothing (`skipped` / `different_apple_id`). The code, tokens and Apple
ids are never stored or logged. `GET /auth/session`'s `appleLinked` says when to
send it. A body that is not exactly this shape (not JSON,
a wrong type, an unknown key) is a 400 `VALIDATION_FAILED`, before anything is
erased: the default action here is erasure. No body, or `{}`, deletes.

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

---

## Blendn+ (step 11)

Blendn+ is bought in the App Store or Google Play through RevenueCat — never
Razorpay, never in a web view. The app passes **our user id** to
`Purchases.logIn` at sign-in (and `logOut` at sign-out), and RevenueCat's
webhook (`POST /api/webhooks/revenuecat`, server to server, not part of this
API) is the only thing that grants it. The app saying "bought" unlocks nothing:
after a purchase or restore, poll `GET /me/plus` until `active`.

What Plus is: staying live while you're here (Go Live `stay`), your full night
history (`/me/attendance` beyond the latest 3), partner perks and crew extras
(not built yet). A Night Pass is Plus for 24 hours (a second one starts when
the first ends). Never sold: who liked you, more than the caps allow, seeing a
venue without going live, a reveal bypass, boosting.

Where: Blendn+ is gated per city. A city that is not gated is in its launch
season and every Plus feature is everyone's — "stay" simply works. The first
time a gated city's gate would stop somebody whose account was here, and out,
in the 90 days before that city flipped,
they get a 14-day trial instead (once per account); and three new people who
joined through your invite link and have each been to a different event with
others there earn a month (each friend counts once; at most 3 a year).

### GET /me/plus

```json
{ "success": true, "data": {
  "active": true,
  "gated": true,
  "product": "plus",
  "source": "apple",
  "expiresAt": "2026-11-10T09:00:00.000Z"
} }
```

**`state` and `grant` are optional, and omitted when the data does not say.**
`state` is where a store subscription or Night Pass stands, read from the newest
RevenueCat delivery about that purchase and the clock: `active`; `cancelled`
(auto-renew off, access runs to `expiresAt`); `grace` (a billing issue, inside
the store's grace period); `hold` (Google's account hold: a billing issue with no
grace period, not live); `paused` (a scheduled pause: the store has paused the subscription from the next renewal, and access runs to `expiresAt` — `active` can still be `true`); `expired`; `refunded` (a store refund ended
it). It is also sent when nothing is live (`active: false`, `state: "expired"` or
`"refunded"`), for the latest store purchase. `grant` is `trial` or `referral`
when the live access is one of our free months (our `plus-trial:` and
`plus-referral:` rows); a grant has no `state`, and a store purchase has no
`grant`. Neither is guessed: a purchase with no delivery on record, a delivery
that says nothing (`TEST`, a transfer) and an account with no purchase send
neither field.

`gated` says whether Blendn+ is for sale to this person at all: gated in the
city of their latest night (where they are checked in now counts as that). When it is false
(a launch season) the app sells nothing and says Plus is free there; plans
show only after `PLUS_REQUIRED`, a `lockedCount`, or `gated: true`.
`product` is `plus` or `night_pass`; `source` is `apple`, `google` or `grant`
(the trial, a referral month). `expiresAt` is when the row that lasts longest
ends. `no-store`: never cache it; 60 a minute per person (the paywall polls every 3 s for a minute at most). It is not a gate — every Plus feature is
checked on the server.

### POST /me/plus/paywall-events

```json
{ "event": "shown", "trigger": "go_live_expiry" }
```

`event`: `shown`, `dismissed`, `purchase_started`, `purchased`, `restored`.
`trigger`: `go_live_expiry`, `second_event`, `first_match`, `recap`, `perk`,
`profile`. Measurement only (`product_events`, one row per person, day, step and
trigger). The cooldowns are the app's: at most one automatic paywall a session,
never during onboarding, check-in or chat. 400 for anything off these lists.


## Regulars, offers and the door pass (step 12)

A venue on Venue Pro can send an offer — "First drink on the house, Thu–Sun
before 10" — to its **regulars**: people who came on 3 or more nights in the
last 30, counted from the venue's claim on (a host's event there or its own
live room; staff never count; accounts under 30 days old and anyone with
"Offers from places" not on never are; it is off by default). The venue picks the words; we pick who,
and the venue never learns who. It is told how many each offer reached as a
band (5–9, 10–24, 25–49, 50+), and how many were opened and redeemed only as
totals across its offers, published once a week, each held back when it or
the rest is under 5. An audience under 5 is refused with one fixed sentence.

The push says **"You have a new offer" / "Open Blendn to see it."** — no
place, no words. Its `data` is `{ type: "venue_offer", offerId }`, on the
Android channel `offers`; the bell stores the same two lines. Open the offer
with `GET /offers/:offerId`. **The push goes only to someone who said yes to
offer notifications** (`PUT /me/offers { "pushes": true }`, SCRUM-628): an
offer is a promotion, and App Store guideline 4.5.4 allows its push only after
a yes given in the app. Without it the offer still arrives — the bell line and
`GET /offers` — with no push.

### GET /offers

```json
{ "success": true, "data": { "offers": [ {
  "id": "…", "venue": { "id": "…", "name": "Toit" },
  "text": "First drink on the house, Thu–Sun before 10",
  "sentAt": "2026-10-11T12:00:00.000Z", "redeemedAt": null, "endsAt": "2026-10-18T12:00:00.000Z",
  "state": "live"
} ] } }
```

Newest first, at most 50. `state`: `live` (the pass can be shown), `redeemed`,
`ended` (past its end, ended by an admin, or the venue was retired or changed
hands). Reading the list opens nothing.

### GET /offers/:offerId — the offer and its door pass

The first call is what the venue's "opened" counts. While `live`, `pass` is
`{ code, rotatesAt }`: six characters that change every 30 seconds. Draw the
pass live around it, ask again before `rotatesAt` while it is on screen, and
hide the code if no fresh answer has come by then. Staff type the code on the
dashboard's door screen and tap "Redeemed"; the next answer says `redeemed`.
A screenshot's code stops working within a minute, and a pass redeems once.
`used_tonight`: another of this venue's passes was redeemed tonight (one a
night). 404 for an offer you were not sent, the same as for none. `no-store`.

### POST /offers/:offerId/report

`{ "reason": "offensive" | "misleading" | "spam" | "unsafe" | "other", "description"?: "…" }`
— into the reports queue with the offer's words as they read. 404 for an offer
you were not sent; 409 `CONFLICT` while your earlier report is pending.

### GET / PUT /venues/:venueId/regular — your choices about a venue

```json
{ "known": true }
{ "offersMuted": true }
```

Answers `{ known, offersMuted, ownerName, regulars: { active, eligible } }`. `known` is "Let this venue know
I'm a regular", given to the organisation that runs it now (`ownerName`): it
sees your first name and your nights there in the last 30, and can greet you;
off, it sees nothing of you again, from the next request. A new owner sees
none of an earlier owner's yeses. `regulars.active` is whether the venue has the regulars feature on: **false for every venue** until its dashboard toggle exists, so show no regulars UI. `regulars.eligible` is whether you would count as a regular now (3+ nights here in the last 30, counted from the venue's claim): your own nights only. `offersMuted`: no offers from this venue,
kept across a change of owner. Each field must be a real boolean, at least one
per PUT; a missing one is left as it is, so "Maybe later" sends nothing. None
of these choices is written to the audit log. `known: true` — 409
`VENUE_UNCLAIMED` while nobody runs the venue on Blendn, 403 `AGE_RESTRICTED`
without an adult age on file. 404 for no such venue.

### GET / PUT /me/offers — "Offers from places" and offer notifications

`{ "enabled": false, "pushes": false, "regulars": { "active": false } }` for an account made since S-5.

- `regulars.active` (additive, 2026-10-24) — whether the regulars feature is on
  anywhere for this person. **False everywhere** until a venue or organiser can
  switch it on (the owner deferred the feature, 2026-10-17); the app shows
  "Offers from places" only when it is true. The same answer as a venue's
  `regulars.active` on `GET /venues/:venueId/regular` (`regularsActive`), and
  the gate on sending: the dashboard's `sendOffer` refuses every send while it
  is false (`reasonCode: REGULARS_INACTIVE`), so nobody gets an offer before the
  app shows them the switch to turn offers off.

- `enabled` — one switch for every venue: off, no venue's offer reaches you.
  **Off until turned on** (S-5, 2026-10-24: promotional consent is opt-in;
  `profiles.offers_from_places` defaults false). Accounts made before then
  keep the `true` they were given; changing that is a product decision.
- `pushes` — offer notifications. **Off until you say yes** (SCRUM-628), for
  every account: ask in context, the first time an offer exists for the
  person, never in onboarding. Off, offers still arrive with no push. The yes
  is stored with when it was first given (`profiles.offer_push_consent_at`; a
  second yes keeps it); a no clears it. Independent of `enabled`.

PUT changes what it is given and answers both: each must be a real boolean, at
least one per PUT (`{}` is 400), so "Not now" sends nothing.
