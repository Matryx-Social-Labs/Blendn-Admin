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

Users are auto-joined to rooms based on their state:
- `user:{userId}` — personal room for direct notifications
- `chat:{chatGroupId}` — event chat rooms (joined via `chat:join`)
- `event:{eventId}` — event-level updates
- `conversation:{conversationId}` — private conversations

## Client → Server Events

| Event | Payload | Description |
|-------|---------|-------------|
| `chat:join` | `{ chatGroupId: string }` | Join an event chat room |
| `chat:leave` | `{ chatGroupId: string }` | Leave a chat room |
| `chat:message` | `{ chatGroupId, content, type?, parentId? }` | Send a chat message |
| `chat:typing` | `{ chatGroupId: string }` | Signal typing started |
| `chat:stopTyping` | `{ chatGroupId: string }` | Signal typing stopped |
| `conversation:join` | `{ conversationId: string }` | Join a private conversation |
| `conversation:leave` | `{ conversationId: string }` | Leave a private conversation |
| `private:typing` | `{ conversationId: string }` | Typing in private conversation |
| `private:stopTyping` | `{ conversationId: string }` | Stop typing in private conversation |
| `private:read` | `{ conversationId: string }` | Mark conversation as read |

## Server → Client Events

### Chat Events (room: `chat:{chatGroupId}`)

| Event | Payload | Description |
|-------|---------|-------------|
| `chat:message` | `{ id, chatGroupId, userId, userName, userImage, content, type, parentId, createdAt }` | New message in chat |
| `chat:typing` | `{ chatGroupId, userId, userName }` | User is typing |
| `chat:reaction` | `{ chatGroupId, messageId, userId, emoji, action }` | Reaction added/removed |
| `chat:messageDeleted` | `{ chatGroupId, messageId, moderation?, userId? }` | Message deleted. When `moderation: true`, it was auto-hidden by moderation — `userId` identifies the sender so the client can show a placeholder to them instead of removing. |
| `chat:memberBanned` | `{ chatGroupId, userId, banned }` | Member ban status changed |
| `chat:memberMuted` | `{ chatGroupId, userId, muted, reason? }` | Member mute status changed. `muted: true` = auto-muted (3+ violations in 1hr) or admin-muted. `muted: false` = auto-unmute expired or admin-unmuted. |

### Event Events (room: `event:{eventId}`)

| Event | Payload | Description |
|-------|---------|-------------|
| `event:checkin` | `{ eventId, userId, userName, userImage, checkInId, currentCapacity }` | Someone checked in |
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
