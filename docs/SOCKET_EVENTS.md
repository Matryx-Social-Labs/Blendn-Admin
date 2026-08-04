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
| `ping` | — | Connection health check |

> **Chat messages are not sent over the socket.** There is no inbound
> `chat:message` handler. Messages are POSTed to the REST API
> (`/api/mobile/chat/groups/{id}/messages`), which moderates them and then
> broadcasts `chat:message` to the room. Sending `chat:message` over the socket
> does nothing.

`chat:startTyping`/`chat:stopTyping` are silently dropped for members who are
`muted` or `banned`, so a member banned mid-session stops broadcasting typing
state without being disconnected.

## Server → Client Events

### Chat Events (room: `chat:{chatGroupId}`)

| Event | Payload | Description |
|-------|---------|-------------|
| `chat:message` | `{ id, chatGroupId, userId, userName, userImage, content, type, parentId, createdAt }` | New message in chat |
| `chat:typing` | `{ chatGroupId, userId, userName, isTyping }` | Typing state changed. `userName` is the sender's anonymous name, never their real identity. |
| `chat:reaction` | `{ chatGroupId, messageId, userId, emoji, action }` | Reaction added/removed |
| `chat:messageDeleted` | `{ chatGroupId, messageId, moderation?, userId? }` | Message deleted. When `moderation: true`, it was auto-hidden by moderation — `userId` identifies the sender so the client can show a placeholder to them instead of removing. |
| `chat:memberBanned` | `{ chatGroupId, userId, banned }` | Member ban status changed |
| `chat:memberMuted` | `{ chatGroupId, userId, muted, reason? }` | Member mute status changed. `muted: true` = auto-muted (3+ violations in 1hr) or admin-muted. `muted: false` = auto-unmute expired or admin-unmuted. |

### Event Events (room: `event:{eventId}`)

| Event | Payload | Description |
|-------|---------|-------------|
| `event:checkin` | `{ eventId, userId, userName, userImage?, checkInTime }` | Someone checked in |
| `event:checkout` | `{ eventId, userId }` | Someone checked out |
| `event:interestUpdate` | `{ eventId, userId, interested, favoriteCount }` | Interest toggled |

### Private Message Events

| Event | Room | Payload |
|-------|------|---------|
| `private:message` | `conversation:{id}` & `user:{recipientId}` | `{ id, conversationId, senderId, senderName, senderImage, messageText, mediaUrl, mediaType, createdAt }` |
| `private:typing` | `conversation:{id}` | `{ conversationId, userId, userName }` |
| `private:read` | `conversation:{id}` | `{ conversationId, userId }` |

### User Events (room: `user:{userId}`)

| Event | Payload | Description |
|-------|---------|-------------|
| `private:message` | Same as above | Notification when not in conversation room |
| Custom events via `emitToUser()` | Varies | Server-initiated user notifications |
