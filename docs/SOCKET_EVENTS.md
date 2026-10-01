# Blendn Socket.io Events

Connection URL: Same as API server
Auth: Pass `token` (access token) in handshake auth

## Connection

```js
const socket = io(SERVER_URL, { auth: { token: accessToken } })
```

On connect, server emits:
- `connected` → `{ userId: string }`

## Rooms

- `user:{userId}` — personal room, auto-joined on connect
- `chat:{chatGroupId}` — event chat rooms (joined via `join:chat`)
- `event:{eventId}` — event-level updates (joined via `join:event`)
- `conversation:{conversationId}` — private conversations (joined via `join:conversation`)

Only `user:{userId}` is automatic. The other three require an explicit join,
and every join is authorization-checked server-side — see below.

## Room authorization

A valid JWT gets you a connection, not a room. Each `join:*` is checked against
the database before the socket is added to the room (`lib/socket-auth.ts`):

| Room | Who may join |
|------|--------------|
| `chat:{chatGroupId}` | Members of the chat group, excluding `banned` |
| `conversation:{conversationId}` | The two participants only |
| `event:{eventId}` | Anyone, for `public`/`unlisted` events. For `private`: the organizer, or a user with an RSVP |

Public events stay open so a client can subscribe to live check-in counts from
an event detail screen without checking in first.

**A venue's live room (a venue day) is for the people live in it.**
`chat:{chatGroupId}`, `event:room:{venueDayId}` and `event:{venueDayId}` admit
only somebody whose Go Live window is open now (`liveInVenueDay`,
`inRoomWhere`). The counter room is closed too: its exact `hereCount` would let
a watcher read each arrival off the number, and the venue's public count is the
bucket on `GET /venues/:venueId`. When a window ends — expiry, a switch, a
checkout, an event starting there — the person's sockets get `live:ended` and
are taken out of all three rooms; a rejoin is refused.

On refusal the server emits `error` and the socket is **not** added to the room:

```js
socket.on("error", ({ message, code }) => { /* code === "FORBIDDEN" */ })
```

Refusals are deliberately indistinguishable: a room that does not exist, a
malformed ID, and a room you simply lack access to all return the same
`FORBIDDEN`, so the events cannot be used to enumerate valid IDs.

Authorization is re-checked on every join, including the automatic rejoins the
client performs after a reconnect.

## Client → Server Events

| Event | Payload | Description |
|-------|---------|-------------|
| `join:event` | `eventId: string` | Join an event room (authorized) |
| `leave:event` | `eventId: string` | Leave an event room |
| `join:chat` | `chatGroupId: string` | Join an event chat room (authorized) |
| `leave:chat` | `chatGroupId: string` | Leave a chat room |
| `join:conversation` | `conversationId: string` | Join a private conversation (authorized) |
| `leave:conversation` | `conversationId: string` | Leave a private conversation |
| `chat:startTyping` | `chatGroupId: string` | Signal typing started |
| `chat:stopTyping` | `chatGroupId: string` | Signal typing stopped |
| `private:startTyping` | `conversationId: string` | Typing in private conversation |
| `private:stopTyping` | `conversationId: string` | Stop typing in private conversation |
| `private:markRead` | `conversationId: string, messageIds: string[]` | Mark messages as read |
| `private:delivered` | `conversationId: string, messageIds: string[]` | Ack messages this app received (sets `delivered_at`; only messages sent to you, not yet delivered) |
| `ping` | — | Connection health check |

> **Chat messages are not sent over the socket.** There is no inbound
> `chat:message` handler. Messages are POSTed to the REST API
> (`/api/mobile/chat/groups/{id}/messages`), which moderates them and then
> broadcasts `chat:message` to the room. Sending `chat:message` over the socket
> does nothing.

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

- A handle is stable for one person in one event, so the roster, the match
  deck, chat history and these events all use the same string for them.
  The same person at another event has a different, unrelated handle.
- Compare with your own id exactly as before: your bubbles, your own check-in
  and your own typing still arrive under your real id.
- Every REST endpoint that takes a user id accepts a handle (see `docs/API.md`,
  "Room handles"), so a handle from a socket event can be used to like, wave,
  block, report or open a message request. Likes and waves take **only** that
  event's handles — not a raw id, not another event's handle.

Because the payload now differs per reader, room events are sent **per socket**
(`fetchSockets()` on the room, then one emit each) rather than as one broadcast.
`private:*` events are unchanged: a conversation is between two people who
already know each other's ids.

### Chat Events (room: `chat:{chatGroupId}`)

| Event | Payload | Description |
|-------|---------|-------------|
| `chat:message` | `{ id, chatGroupId, userId, userName, userImage, content, type, parentId, createdAt }` | New message in chat |
| `chat:typing` | `{ chatGroupId, userId, userName, isTyping }` | Typing state changed. `userName` is the sender's anonymous name, never their real identity. |
| `chat:reaction` | `{ chatGroupId, messageId, tally: [{ emoji, count }] }` | Reactions changed on a message. **Counts only — never who reacted**, which the room must not disclose. The whole tally rather than a delta, so two reactions in the same tick cannot race and a dropped packet self-corrects. `mine` is per-viewer and absent by design: a client knows its own reaction from its own request. |
| `chat:messageDeleted` | `{ chatGroupId, messageId, moderation?, userId? }` | Message deleted. When `moderation: true`, it was auto-hidden by moderation — `userId` identifies the sender (their real id to them, a handle to everyone else) so the sender's client can show a placeholder instead of removing. |
| `chat:memberBanned` | `{ chatGroupId, userId, banned }` | Member ban status changed. The banned person receives it under their own id, then their sockets leave the room. |
| `chat:memberLeft` | `{ chatGroupId, userId }` | Somebody left the room themselves (`POST /chat/groups/:id/leave`) — drop them from the roster. `userId` is their handle in this event; the leaver's own sockets get their real id, then leave the room. Not sent to anyone in a block with the leaver. |
| `chat:memberMuted` | `{ chatGroupId, userId, muted, reason? }` | Member mute status changed. `muted: true` = auto-muted (3+ violations in 1hr) or admin-muted. `muted: false` = auto-unmute expired or admin-unmuted. |

### Event Events (room: `event:{eventId}`, joinable by anyone who can open the event)

| Event | Payload | Description |
|-------|---------|-------------|
| `event:checkin` | `{ eventId, userId, checkInTime, hereCount? }` | Someone checked in. No name: this room is open to anyone viewing the event. |
| `event:checkout` | `{ eventId, userId, checkOutTime, hereCount? }` | Someone checked out |
| `event:interestUpdate` | `{ eventId, userId, interested, interestCount }` | Interest toggled |

### Roster Events (room: `event:room:{eventId}`, checked-in attendees only)

| Event | Payload | Description |
|-------|---------|-------------|
| `event:room:checkin` | `{ eventId, userId, userName, userImage?, checkInTime, hereCount? }` | Who arrived, by pseudonym. Never sent to the arriver's block counterparties. |

### Room Events (room: `user:{userId}`)

| Event | Payload | Description |
|-------|---------|-------------|
| `room:match` | `{ eventId, otherUserId, conversationId, name }` | A like became mutual. `otherUserId` is the other person's handle in `eventId` — the same string the roster and deck show. |
| `room:wave` | `{ eventId, fromUserId, fromName }` | Somebody in the room waved. `fromUserId` is their handle in `eventId`. |

### Private Message Events

| Event | Room | Payload |
|-------|------|---------|
| `private:message` | `conversation:{id}` & `user:{recipientId}` | `{ id, conversationId, senderId, senderName, senderImage, messageText, mediaUrl, mediaType, createdAt }` |
| `private:typing` | `conversation:{id}` | `{ conversationId, userId, userName }` |
| `private:read` | `conversation:{id}` | `{ conversationId, userId }` |
| `private:delivered` | `conversation:{id}` | `{ conversationId, messageIds }`. The recipient's app has these messages (✓✓ delivered). Sent whatever the read-receipt setting |

### User Events (room: `user:{userId}`)

| Event | Payload | Description |
|-------|---------|-------------|
| `private:message` | Same as above | Notification when not in conversation room |
| `notification:new` | `{ kind }` | A row landed in the notifications bell; the app refreshes its badge. Never sent for messages, which write no row |
| `live:ended` | `{ eventId, reason }` | Your Go Live at a venue ended and your sockets left its rooms. `eventId` is the venue day; `reason` is `expired` (the window ran out, or the venue's day reset), `event_started` (a real event took the venue over; the push names it), `switched_event`, `manual`, or `left_area` |
