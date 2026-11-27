# Blendn Socket.io Events

Connection URL: Same as API server
Auth: Pass `token` (access token) in handshake auth, or send it as
`Authorization: Bearer <token>`. The dashboard sends neither: it connects with
its session cookie, and its sockets are dashboard sessions (the `principal`
below).

## Connection

```js
const socket = io(SERVER_URL, { auth: { token: accessToken } })
```

On connect, server emits:
- `connected` → `{ userId: string }`

A socket may send at most 120 events per 10 seconds. Events past that are
dropped without a reply.

## Rooms

- `user:{userId}` — personal room, auto-joined on connect
- `user:{userId}:{principal}` — auto-joined on connect, `principal` being `mobile` or `dashboard`. Nothing is emitted to it: it lets the server disconnect one kind of session and leave the other
- `chat:{chatGroupId}` — chat rooms of every kind (joined via `join:chat`): an event's room, a Lobby post's, a crew's and a Blend's (chat group kind `blend`)
- `event:{eventId}` — event-level updates (joined via `join:event`)
- `event:room:{eventId}` — the roster room, checked-in attendees only (joined via `join:event:room`)
- `event:{eventId}:ops` and `event:{eventId}:ops:venue` — the dashboard's Live tab, host and venue copies (joined via `join:eventOps`; dashboard sessions only)
- `conversation:{conversationId}` — private conversations (joined via `join:conversation`)

Only the two `user:` rooms are automatic. Every other room requires an explicit
join, and every join is authorization-checked server-side — see below.

## Room authorization

A valid JWT gets you a connection, not a room. Each `join:*` is checked against
the database before the socket is added to the room (`lib/socket-auth.ts`):

| Room | Who may join |
|------|--------------|
| `chat:{chatGroupId}` | Members of the chat group, excluding `banned` and anyone who left by choice — **and** whoever the room's owner admits (`lib/room-kind.ts`, step 7). An event's room: as before. A Lobby post's: its author, or an asker the author accepted and not in a block with the author either way; a member row alone is not enough. Closed with its post, its event, and a day after the event ends, with the event's room. A crew's: its members now — not suspended, the crew not dissolved; a member who leaves or is removed is taken out at once. A Blend's: the people checked in on either side when it matched (its member rows, a snapshot — a late arrival has none) still on their side, or the matched person — never somebody kept apart (a block or a closed conversation) from anyone on the other side: that pair is taken out at once and the room goes on for the rest; closed 12 h after the occurrence ends, or early when a side's crew dissolves or is hidden, which empties its sockets. Names: first names in a crew's room, tonight's event-room pseudonyms in a Blend's (`namesInRoom`). An unknown kind or a missing owner: nobody |
| `conversation:{conversationId}` | The two participants only |
| `event:{eventId}` | Anyone, for `public`/`unlisted` events. For `private`: the organizer, staff who may operate the event, or a user whose RSVP is `going` or `maybe`. Never a draft, and never a dashboard session |
| `event:room:{eventId}` | Somebody checked in at the event (not a draft); for a venue day, only while their Go Live is open |
| `event:{eventId}:ops` / `event:{eventId}:ops:venue` | Dashboard sessions only, for someone who may operate the event. Whoever may edit it gets `:ops` (exact figures); a venue owner who may not gets `:ops:venue` (ranges). The server picks the room: the client sends only the event id |

Public events stay open so a client can subscribe to live check-in counts from
an event detail screen without checking in first.

**A venue's live room (a venue day) is for the people live in it.**
`chat:{chatGroupId}`, `event:room:{venueDayId}` and `event:{venueDayId}` admit
only somebody whose Go Live window is open now (`liveInVenueDay`,
`inRoomWhere`). The counter room is closed too: its exact `hereCount` would let
a watcher read each arrival off the number, and the venue's public count is the
bucket on `GET /venues/:venueId`. When a window ends — expiry, a switch, a
checkout, an event starting there — the person's sockets get `live:ended` and
are taken out of all three rooms; a rejoin is refused. The end is scheduled at
the window's second (`lib/live-timers.ts`, with a 30 s backstop), and every
emit to those rooms goes only to members still live, so a socket the eviction
has not reached yet hears nothing either. Across replicas the eviction needs
the Redis adapter (`SOCKET_REDIS_ADAPTER=1`; `REDIS_URL` alone no longer attaches it).

On refusal the server emits `error` and the socket is **not** added to the room:

```js
socket.on("error", ({ message, code }) => { /* code === "FORBIDDEN"; "OPS_FORBIDDEN" for join:eventOps */ })
```

Refusals are deliberately indistinguishable: a room that does not exist, a
malformed ID, and a room you simply lack access to all return the same
`FORBIDDEN`, so the events cannot be used to enumerate valid IDs.

**A join the server could not check is not a refusal** (SCRUM-1402). When the
access read itself fails (the database pool is saturated: a connection wait past
5 s, or a statement cancelled at 8 s) the socket stays out of the room and is
told to try again, with the same code on every join including `join:eventOps`:

```js
socket.on("error", ({ message, code }) => { /* code === "SERVER_ERROR": ask again later */ })
```

The server does not retry. The dashboard's Live tab asks again on its 20 s quiet
timer; the attendee app logs it and rejoins on its next reconnect.

Authorization is re-checked on every join, including the automatic rejoins the
client performs after a reconnect.

**A room that is not an event's is re-checked on every delivery, too** (step 7).
Every `chat:*` event into such a room asks the owner again for each recipient:
whoever it no longer admits (the post withdrawn or taken down, the ask undone,
a block with the author) gets nothing and is taken out of the room. And every
writer that closes one — withdraw, moderation takedown, account erasure, the
12-hour sweep — empties the room at once (`lib/room-close.ts`). A rejoin meets
the door. An event's room is unchanged: its door is the join.

## Client → Server Events

| Event | Payload | Description |
|-------|---------|-------------|
| `join:event` | `eventId: string` | Join an event room (authorized; refused to a dashboard session) |
| `leave:event` | `eventId: string` | Leave an event room |
| `join:event:room` | `eventId: string` | Join the roster room `event:room:{eventId}` (authorized: checked in) |
| `leave:event:room` | `eventId: string` | Leave the roster room |
| `join:eventOps` | `eventId: string` | Dashboard only. Join the Live tab's room for the event; the server answers with an `ops:snapshot` at once (when it can read one), then one every 5 s. Refused with `OPS_FORBIDDEN` (not a uuid, not a dashboard session, or no access) |
| `leave:eventOps` | `eventId: string` | Leave the Live tab's room, either copy |
| `join:chat` | `chatGroupId: string` | Join a chat room of any kind (authorized per kind — see above) |
| `leave:chat` | `chatGroupId: string` | Leave a chat room |
| `join:conversation` | `conversationId: string` | Join a private conversation (authorized) |
| `leave:conversation` | `conversationId: string` | Leave a private conversation |
| `chat:startTyping` | `chatGroupId: string` | Signal typing started |
| `chat:stopTyping` | `chatGroupId: string` | Signal typing stopped |
| `private:startTyping` | `conversationId: string` | Typing in private conversation |
| `private:stopTyping` | `conversationId: string` | Stop typing in private conversation |
| `private:markRead` | `conversationId: string, messageIds: string[]` | Mark messages as read (at most 200 ids are used) |
| `private:delivered` | `conversationId: string, messageIds: string[]` | Ack messages this app received (sets `delivered_at`; only messages sent to you, not yet delivered; at most 200 ids are used) |

> **Chat messages are not sent over the socket.** There is no inbound
> `chat:message` handler. Messages are POSTed to the REST API
> (`/api/mobile/chat/groups/{id}/messages`), which moderates them and then
> broadcasts `chat:message` to the room. Sending `chat:message` over the socket
> does nothing.

**Typing is gated per socket** (2026-11-24): a start within 2 seconds of the last
one let through for that room or conversation is silently dropped, and a stop is
relayed only when it ends a start that was. Send one start per burst of typing.

**Above 50 sockets in a room, typing has no names** (SCRUM-1309): when more than
50 sockets are in `chat:{chatGroupId}`, a start reads nothing and the room gets
one `typing:several` (`{ chatGroupId }`: no name, no count, no ids) at most once
every 5 seconds, whoever is typing, to everyone in the room but the typist's own
devices. No stop is sent: show "Several people are typing" for a few seconds and
let it expire. A stop in such a room is dropped. Nothing is read for it, so a
muted member's typing counts too (a ban takes their sockets out of the room). At
50 or fewer, `chat:typing` is unchanged. Both are sent volatile: a client that
cannot take one at that moment loses it rather than receiving it late, so
expire a named typer on your own too (the app does after 3 s). An app that does
not know `typing:several` ignores it.

A typing start or stop counts only from a socket that has joined the room
(`join:chat`); from any other it is dropped before anything is read.

`chat:startTyping`/`chat:stopTyping` are silently dropped for members who are
`muted` or `banned`, so a member banned mid-session stops broadcasting typing
state without being disconnected. They also never reach anyone the typist has
blocked or been blocked by. That is the same exclusion `chat:message` applies
(SCRUM-338). The same goes for `event:room:checkin`, the roster's live "just
arrived" event, which the push for that arrival and `GET …/participants`
already left out.

## Server → Client Events

### Ids in room payloads: yours real, everyone else's a room handle

Every `userId` / `otherUserId` / `fromUserId` on a `chat:*`, `event:*` or
`room:*` event is **your own real id** when it is you, and otherwise that
person's **room handle** for the event: `rh_` + an opaque string
(`lib/room-handle.ts`, SCRUM-371). Field names and shapes are unchanged.

- A handle is stable for one person in one room, so the roster, the match
  deck, chat history and these events all use the same string for them.
  The same person at another event has a different, unrelated handle.
- **A handle belongs to one room, of one kind** (step 7). An event's room is
  scoped by its event, exactly as before, so every handle a client already
  holds still resolves. A room of another kind (a Lobby post's, a crew's or a
  Blend's) is scoped by its own id and its kind, so a handle from it is
  refused in every other room, an event's included, and names nobody on the
  profile, friend or block routes. Treat it as opaque, as now.
- Compare with your own id exactly as before: your bubbles, your own check-in
  and your own typing still arrive under your real id.
- Every REST endpoint that takes a user id accepts a handle (see `docs/API.md`,
  "Room handles"), so a handle from a socket event can be used to like, wave,
  block, report or open a message request. Likes and waves take **only** that
  event's handles — not a raw id, not another event's handle.

Because the payload now differs per reader, room events are sent **per socket**
(`fetchSockets()` on the room, then one emit each) rather than as one broadcast.
`private:*` events are not sent per socket. In a pseudonymous conversation (a
match's or a Lobby post's), the ones that name somebody (`private:message`,
`private:typing`, `private:read`) name the other person by that conversation's
own handle and go to `user:` rooms, not the conversation room; otherwise they
carry real ids.

### Chat Events (room: `chat:{chatGroupId}`)

| Event | Payload | Description |
|-------|---------|-------------|
| `chat:message` | `{ chatGroupId, message: { id, content, type, kind?, pollId?, userId, userName, userImage?, createdAt, parentId?, metadata? } }` | New message in chat; the message is nested under `message`, not flat. `message.kind: "sponsored"` marks a sponsored send (its `type` stays the media kind); `message.pollId` is on a `type: "poll"` message. `message.userImage` only in a crew's room. `message.metadata` on a crew chat's `type: "system"` line only, as the history has it (`crew_waved`, `crew_here`, `crew_plan`, `crew_like`, `crew_wave`; SCRUM-1110). A `crew_waved` from a crew is not sent to a member who hid that crew. |
| `chat:typing` | `{ chatGroupId, userId, userName, isTyping }` | Typing state changed. `userName` is the name the room uses: the sender's pseudonym in an event's room and a Blend's, their first name in a crew's. |
| `typing:several` | `{ chatGroupId }` | Somebody is typing in a room of more than 50 sockets; at most one per 5 s per room, never a stop. See "Above 50 sockets" above. |
| `chat:reaction` | `{ chatGroupId, messageId, tally: [{ emoji, count }] }` | Reactions changed on a message. **Counts only — never who reacted**, which the room must not disclose. The whole tally rather than a delta, so two reactions in the same tick cannot race and a dropped packet self-corrects. `mine` is per-viewer and absent by design: a client knows its own reaction from its own request. |
| `chat:messageDeleted` | `{ chatGroupId, messageId, moderation?, userId? }` | Message deleted. When `moderation: true`, it was auto-hidden by moderation — `userId` identifies the sender (their real id to them, a handle to everyone else) so the sender's client can show a placeholder instead of removing. |
| `chat:memberBanned` | `{ chatGroupId, userId, banned }` | Member ban status changed. Also sent to the member's own `user:{id}` room, so an unban reaches somebody a ban took out of the room. The member receives it under their own id; on a ban their sockets then leave the room. |
| `chat:memberLeft` | `{ chatGroupId, userId }` | Somebody left the room themselves (`POST /chat/groups/:id/leave`) — drop them from the roster. `userId` is their handle in this event; the leaver's own sockets get their real id, then leave the room. Not sent to anyone in a block with the leaver. |
| `chat:memberMuted` | `{ chatGroupId, userId, muted, reason? }` | Member mute status changed. `muted: true` = auto-muted (3+ hidden abusive messages in 1hr; contact-detail and swear-word hides do not count) or admin-muted. `muted: false` = auto-unmute expired or admin-unmuted. |

### Event Events (room: `event:{eventId}`, joinable by anyone who can open the event; `event:cancelled` also goes to `event:room:{eventId}`)

| Event | Payload | Description |
|-------|---------|-------------|
| `event:checkin` | `{ eventId, userId?, checkInTime, hereCount?, hereConfirmed? }` | Someone checked in. No name: this room is open to anyone viewing the event. `userId` is their room handle, **absent on the copy of anyone whose roster leaves the arriver out — a friend, anyone in a block with them either way, anyone they closed a conversation with, anyone who reported them (`viewersHiddenFromMany`, SCRUM-1386) — and on every copy but the arriver's own when the arriver has "Show online status" off** (SCRUM-905: an unlisted arrival carries no handle to anyone else; a friend knows which pseudonym is theirs, so the handle beside a chat line timed to this arrival would name it); the count still moves. `event:checkout` is the same. |
| `event:checkout` | `{ eventId, userId?, checkOutTime, hereCount?, hereConfirmed? }` | Someone checked out. `userId` is absent on the copies `event:checkin`'s is (anyone whose roster leaves the leaver out, or every other copy for a leaver with "Show online status" off); the count still moves. |
| `event:interestUpdate` | `{ eventId, userId, interested, interestCount }` | Interest toggled |
| `event:rsvpUpdate` | `{ eventId, rsvpCount }` | The going count after an RSVP or a withdrawal (`POST`/`DELETE /events/:eventId/rsvp`). A count only: no person (SCRUM-1095) |
| `event:cancelled` | `{ eventId }` | The event was cancelled. One emit to `event:{eventId}` and `event:room:{eventId}`, never one per person, so it reaches whoever is in either room; carries nothing but the id. Everyone checked in has been checked out (their check-in is `cancelled`, their presence closed `ended`) and gets an `event_cancelled` push (`docs/API.md`, *What pushes, and when*). Not sent when nobody was inside |

### Dashboard Ops Events (rooms: `event:{eventId}:ops`, `event:{eventId}:ops:venue`; dashboard sessions only)

| Event | Payload | Description |
|-------|---------|-------------|
| `ops:snapshot` | `LiveSnapshot` (host, `view: "host"`) or `VenueLiveSnapshot` (venue, `view: "venue"`), both defined in `lib/live-metrics.ts`: read the fields there | The Live tab: one on `join:eventOps`, then every 5 s while somebody watches. Aggregates only, never a person. `view` says which copy arrived. Whoever may edit the event gets exact figures; a venue gets every count of people as a range (SCRUM-516). Only the host's copy carries `social` ("Meeting tonight") and `topics` ("Talking about"); both copies carry `alerts`. |

The Door tab (gate 13, `app/dashboard/events/[id]/door`) joins the same room and takes each `ops:snapshot` as its cue to re-ask the `readDoor` server action (counts by method, the code arrivals as pseudonyms, the pause), which re-checks `canOperate` every time. The snapshot's payload is not read and nothing was added to it; no guest-facing event carries how anyone checked in (`event:room:checkin` is unchanged).

### Roster Events (room: `event:room:{eventId}`, checked-in attendees only)

| Event | Payload | Description |
|-------|---------|-------------|
| `event:room:checkin` | `{ eventId, userId, userName, revealed, userImage?, checkInTime, hereCount?, hereConfirmed? }` | Who arrived, by pseudonym; `revealed: true` when `userName` is their first name instead (the deck's `revealed`, SCRUM-1067). Never sent to anybody whose roster leaves the arriver out (a block either way, a closed conversation, somebody who reported them, a friend: SCRUM-1386), and not sent at all for an arriver with "Show online status" off — the roster leaves them out, so only `event:checkin` (no name) moves the count (SCRUM-620). Nor to the arriver's **friends**, whatever their switch: friends never meet as strangers in a room. |

### Room Events (room: `user:{userId}`)

| Event | Payload | Description |
|-------|---------|-------------|
| `room:friends` | `{ eventId }` | Your **Friends here** changed: refetch `GET /events/:id/friends-here`. Content-free, to `user:{id}` rooms only (never the room): sent to a person's friends who are checked in at the same event when an opted-in friend checks in or out, flips "Friends can see I'm here" or "Show online status", or when a friendship is made or ended. A hidden friend's movements fire nothing. |
| `room:match` | `{ eventId, otherUserId, conversationId, name }` | Two waves (or a wave and a like) became mutual: "You both waved". `otherUserId` is the other person's handle in `eventId` — the same string the roster and deck show. |
| `room:crew_wave` | `{ eventId, fromCrewId, fromName }` | A crew here waved at you (crews 5-A, `POST /events/:id/waves` with `asCrewId`). `fromName` is the crew's name; who tapped is never said. Only when stored and not mutual (a Blend is its own push). Its own event, so a build reading `room:wave` as a person never draws a crew. Recorded on `GET /events/:eventId/waves` → `crewWaves`. |
| `room:wave` | `{ eventId, fromUserId, fromName }` | Somebody waved at you (recorded, SCRUM-1042). `fromUserId` is their handle in `eventId`; `fromName` the roster's name. Also sent for a wave back after either of you left the room. Not sent on a mutual: `room:match` is. The wave stays on `GET /events/:eventId/waves`, so a missed ping is not a missed wave. Folding a burst into one toast (L-B) is the client's. |

### Private Message Events

| Event | Room | Payload |
|-------|------|---------|
| `private:message` | `conversation:{id}`, `user:{recipientId}` and `user:{senderId}` (the sender's other devices) in one emit; in a pseudonymous conversation (one that began with pseudonyms, as a match's or a Lobby post's does), `user:{recipientId}` and `user:{senderId}` only, each with its own copy | `{ conversationId, message: { id, conversationId, senderId, sender: { id, name, image }, text, mediaUrl, mediaType, isRead, deliveredAt, replyTo, clientId, createdAt } }`: the message is nested under `message`, not flat, the same object `POST /conversations/:id/messages` returns as its `data`. In a pseudonymous conversation `senderId` and `sender.id` on the recipient's copy are the sender's handle in that conversation (`rh_…`), revealed or not; `mediaUrl` is signed when the media is private |
| `private:typing` | `conversation:{id}`, except the typing socket itself (the typist's other devices in the room get it); in a pseudonymous conversation the other participant's `user:{id}` only | `{ conversationId, userId, userName, isTyping }` |
| `private:read` | `conversation:{id}`; in a pseudonymous conversation the other participant's `user:{id}` only | `{ conversationId, messageIds, readBy }`. From the reader's socket, opening the thread (messages GET) or Mark all read; not sent when the reader has read receipts off (then the newly delivered ids go out as `private:delivered`). A read also sets `delivered_at`. Outside a pseudonymous conversation `readBy` is the reader's id, and the read reaches the reader's own other devices in the room: the app's thread screen drops it when `readBy` is the signed-in user (`app/private-chat/[conversationId].tsx`), not `lib/socketClient.ts`, which forwards it to every subscriber. In a pseudonymous conversation only the other person gets it, and `readBy` is the reader's handle in that conversation (`rh_…`), so it never matches the receiving user's own id |
| `private:delivered` | `conversation:{id}` | `{ conversationId, messageIds }`. The recipient's app has these messages (✓✓ delivered). Sent whatever the read-receipt setting |

### User Events (room: `user:{userId}`)

| Event | Payload | Description |
|-------|---------|-------------|
| `private:message` | Same as above | Notification when not in conversation room |
| `board:postRemoved` | `{ eventId, postId }` | Your Lobby post was taken down by a moderator or the automatic check. To the author's own `user:{id}` only, never to anybody else, and never the post's words; goes with a `board_post_removed` push and bell row |
| `private:revealed` | `{ conversationId }` | The Swap names state of one of your DMs moved: re-read `GET /conversations/:id`. To `user:{id}` rooms only, never the conversation room; content-free (the id both sides already hold, so no name, photo or handle). A first tap (`POST /conversations/:id/reveal`) or a tap taken back (`DELETE`) tells the other side; the tap that completes the swap tells both. A room reveal no longer carries into DMs. A closed conversation (unmatch or block) sends nothing. The push still goes out on a tap; this is the live half for a screen already open |
| `notification:new` | `{ kind }` | A row landed in the notifications bell; the app refreshes its badge. Never sent for messages, which write no row |
| `live:ended` | `{ eventId, reason }` | Your Go Live at a venue ended and your sockets left its rooms. `eventId` is the venue day; `reason` is `expired` (the window ran out, or the venue's day reset), `event_started` (a real event took the venue over; the push names it), `switched_event`, `manual`, `left_area`, or `occurrence_ended` (still checked in when the occurrence ended) |
