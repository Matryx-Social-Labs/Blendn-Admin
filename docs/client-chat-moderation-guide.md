# Client-Side Chat Moderation — Frontend Implementation Guide

This document explains the backend moderation signals available to the Blendn mobile app and how the frontend should handle them to show proper warnings to users instead of generic "Failed to send message" errors.

---

## Current Problem

When a user is muted or banned, the app shows "Failed to send message" because it treats the API error as a generic failure. The backend now returns **specific error codes** and **real-time socket events** that the client should use to show meaningful warnings.

---

## 1. API Error Codes

When a message send fails (`POST /api/mobile/chat/groups/{chatGroupId}/messages` or `POST /api/mobile/events/{eventId}/chat`), the response body always has this shape:

```json
{
  "success": false,
  "error": "Human-readable message",
  "errorCode": "SPECIFIC_ERROR_CODE"
}
```

### Error codes the client must handle:

| errorCode | HTTP Status | Meaning | Suggested UX |
|-----------|-------------|---------|--------------|
| `USER_MUTED` | 403 | User was auto-muted (3+ violations in 1 hour) | Show a persistent banner: "You've been muted for policy violations. You can still read messages." Disable the message input. |
| `USER_BANNED` | 403 | User was banned by admin or auto-system | Show a full-screen overlay or modal: "You've been removed from this chat." Hide the input, optionally navigate back. |
| `CHAT_LOCKED` | 403 | Organiser locked the chat | Show a banner: "Chat has been locked by the organiser." Disable input. |
| `NOT_CHECKED_IN` | 403 | User checked out or never checked in | Show: "Check in to the event to send messages." |
| `SPAM_BLOCKED` | 429 | Sending too fast or duplicate messages | Show a brief toast: "Slow down — you're sending messages too quickly." |
| `FORBIDDEN` | 403 | Generic (not a member, etc.) | Show: "You don't have access to this chat." |

### Implementation in `apiClient.ts` → `sendChatMessage()`

The current `sendMessage()` in `app/chat/[id].tsx` catches errors generically:

```typescript
// CURRENT (bad) — shows "Failed to send message" for everything
catch {
  showTray('Error', 'Failed to send message.')
}
```

**Change to:**

```typescript
const result = await apiClient.sendChatMessage(chatRoomId as string, messageText, 'text')

if (!result.success) {
  // Remove optimistic message
  if (optimistic) setMessages(prev => prev.filter(m => m.message_id !== optimistic!.message_id))
  setNewMessage(messageText)

  switch (result.errorCode) {
    case 'USER_MUTED':
      setIsMuted(true) // new state variable
      showTray('Muted', 'You have been muted for violating chat guidelines. You can still read messages.')
      break
    case 'USER_BANNED':
      setIsBanned(true) // new state variable
      showTray('Banned', 'You have been removed from this chat due to repeated violations.', [{
        label: 'OK',
        variant: 'primary',
        onPress: () => { closeTray(); router.back() },
      }])
      break
    case 'CHAT_LOCKED':
      setChatLocked(true)
      showTray('Chat Locked', 'This chat has been locked by the organiser.')
      break
    case 'NOT_CHECKED_IN':
      showTray('Not Checked In', 'You must be checked in to the event to send messages.')
      break
    case 'SPAM_BLOCKED':
      showTray('Slow Down', result.error || 'You are sending messages too quickly.')
      break
    default:
      showTray('Error', result.error || 'Failed to send message.')
  }
  return
}
```

### Accessing `errorCode` from the API response

The `ApiResponse` type in `lib/apiClient.ts` needs an `errorCode` field:

```typescript
interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  errorCode?: string  // ← ADD THIS
}
```

Make sure `queuedRequest` parses and returns `errorCode` from the JSON response.

---

## 2. Real-Time Socket Events

The backend emits socket events when moderation actions happen. The client should listen for these to update the UI **immediately** — don't wait for the next API call to fail.

### Events to subscribe to:

#### `chat:messageDeleted`
**Already implemented.** Fires when a message is auto-hidden by moderation or manually deleted by admin.

```typescript
// Already in socketClient.ts
sock.on("chat:messageDeleted", (data) => {
  // data: { chatGroupId: string, messageId: string }
  // Remove message from UI
})
```

#### `chat:memberBanned`
**Already implemented** but only shows a tray when the current user is banned. Keep this.

```typescript
// Already handled in chat/[id].tsx
const handleBanned: ChatMemberBannedCallback = (data) => {
  if (data.userId === currentUser?.id && data.banned) {
    showTray('Removed', 'You have been removed from this chat by the organiser.')
  }
}
```

#### `chat:memberMuted` ← NEW — must add to client

Fires when a user is auto-muted (3+ violations in 1 hour) or manually muted by admin.

**Step 1:** Add the event type in `lib/socketClient.ts`:

```typescript
// In ServerToClientEvents interface, add:
"chat:memberMuted": (data: {
  chatGroupId: string
  userId: string
  muted: boolean
  reason?: string
}) => void
```

**Step 2:** Add the callback type:

```typescript
type ChatMemberMutedCallback = (data: ServerToClientEvents["chat:memberMuted"] extends (data: infer D) => void ? D : never) => void
```

**Step 3:** Register the listener in the socket setup:

```typescript
sock.on("chat:memberMuted", (data) => {
  const callbacks = chatModerationSubscriptions.get(data.chatGroupId)
  callbacks?.forEach((cb) => (cb as ChatMemberMutedCallback)(data))
})
```

**Step 4:** Handle in `app/chat/[id].tsx`:

```typescript
const handleMuted: ChatMemberMutedCallback = (data) => {
  if (data.userId === currentUser?.id) {
    if (data.muted) {
      setIsMuted(true)
      showTray('Muted', 'You have been muted for violating chat guidelines. You can still read messages but cannot send new ones.')
    } else {
      setIsMuted(false)
      // Optionally show: "You have been unmuted"
    }
  }
}

// Subscribe alongside existing moderation subscriptions
const u6 = subscribeToChatModeration(String(chatRoomId), handleMuted)
```

---

## 3. UI States to Implement

### State variables to add in `app/chat/[id].tsx`:

```typescript
const [isMuted, setIsMuted] = useState(false)
const [isBanned, setIsBanned] = useState(false)
const [chatLocked, setChatLocked] = useState(false)
```

### Message Input Area — conditional rendering:

```tsx
{/* Replace the current message input with: */}
{isBanned ? (
  <View style={styles.restrictedBanner}>
    <IconBan color={APP_COLORS.error} size={20} />
    <Text style={styles.restrictedText}>
      You have been removed from this chat
    </Text>
  </View>
) : isMuted ? (
  <View style={styles.restrictedBanner}>
    <IconVolume3 color={APP_COLORS.warning} size={20} />
    <Text style={styles.restrictedText}>
      You are muted for violating chat guidelines
    </Text>
    <Text style={styles.restrictedSubtext}>
      You can still read messages
    </Text>
  </View>
) : chatLocked ? (
  <View style={styles.restrictedBanner}>
    <IconLock color={APP_COLORS.textSecondary} size={20} />
    <Text style={styles.restrictedText}>
      Chat has been locked by the organiser
    </Text>
  </View>
) : (
  // Normal message input
  <MessageInput ... />
)}
```

### Banner styles:

```typescript
restrictedBanner: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 8,
  paddingHorizontal: 16,
  paddingVertical: 14,
  backgroundColor: 'rgba(255,59,48,0.08)', // red tint for banned, yellow for muted
  borderTopWidth: 1,
  borderTopColor: 'rgba(255,255,255,0.06)',
},
restrictedText: {
  color: APP_COLORS.textSecondary,
  fontSize: 14,
  fontWeight: '500',
},
restrictedSubtext: {
  color: APP_COLORS.textTertiary,
  fontSize: 12,
  marginTop: 2,
},
```

---

## 4. Check Status on Chat Load

When the chat screen opens, check the user's membership status to set the initial state. The current `getEventChat` or `getChatMessages` response includes member data.

**Option A — Check on first message send failure:**
The simplest approach. If the first `sendChatMessage` fails with `USER_MUTED` or `USER_BANNED`, set the state. This is already covered by the error handling in Section 1.

**Option B — Check membership status upfront (recommended):**
Add a membership status field to the chat group response. The `GET /api/mobile/events/{eventId}/chat` endpoint already returns messages — you can check the membership in the response:

```typescript
// After fetching chat data on screen load:
const chatData = await apiClient.getEventChat(eventId)
if (chatData.success && chatData.data) {
  // The backend filters out deleted messages, but if the user is muted
  // they can still read. Check their status:
  // Currently the endpoint auto-joins users, but muted/banned users now
  // get error responses before reaching the message list.
  // So if the GET succeeds, the user is active.
  // If it fails with USER_MUTED or USER_BANNED, show the appropriate state.
}
```

Since muted users CAN still read messages but not send, the GET endpoint lets them through. The block only happens on POST. So:

- GET succeeds → user can read. Check POST on first send attempt.
- GET fails with `USER_BANNED` → show banned state immediately (banned users are fully blocked from the chat).

---

## 5. "This message was removed" — Placeholder for Moderated Messages

When moderation hides a message, the sender should see a **placeholder** ("This message was removed") instead of the message just vanishing. Other users should not see it at all.

### How it works (backend changes already done):

1. **Socket event `chat:messageDeleted`** now includes two new fields:
   - `moderation: true` — distinguishes moderation-hidden from admin-deleted
   - `userId` — the sender's ID, so the client knows whose message it was

2. **GET messages endpoints** now return moderation-hidden messages **only to the sender** with:
   - `content: null` (redacted)
   - `moderation_hidden: true` flag

This means on page reload, the sender still sees their removed messages as placeholders.

### 5a. Handle `chat:messageDeleted` — show placeholder instead of removing

Update the `handleDeleted` callback in `app/chat/[id].tsx`:

```typescript
// Update the event type to include new fields
type ChatMessageDeletedData = {
  chatGroupId: string
  messageId: string
  moderation?: boolean  // true when auto-hidden by moderation
  userId?: string       // sender of the hidden message
}

const handleDeleted = (data: ChatMessageDeletedData) => {
  if (data.moderation && data.userId === currentUser?.id) {
    // OWN message was moderation-hidden → show placeholder, don't remove
    setMessages(prev => prev.map(m =>
      m.message_id === data.messageId
        ? { ...m, message_text: null, moderation_hidden: true }
        : m
    ))
    showTray(
      'Message Removed',
      'Your message was removed for violating chat guidelines. Repeated violations may result in being muted.',
      [{ label: 'OK', variant: 'primary', onPress: closeTray }]
    )
  } else {
    // Someone else's message or admin deletion → remove entirely
    setMessages(prev => prev.filter(m => m.message_id !== data.messageId))
  }
}
```

### 5b. Render the placeholder in the message list

In the message bubble component:

```tsx
// In the message rendering logic:
{msg.moderation_hidden ? (
  <View style={styles.moderatedMessage}>
    <IconAlertCircle size={14} color={APP_COLORS.textTertiary} />
    <Text style={styles.moderatedText}>
      This message was removed for violating chat guidelines
    </Text>
  </View>
) : (
  <Text style={styles.messageText}>{msg.message_text}</Text>
)}
```

Styles:
```typescript
moderatedMessage: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 6,
  paddingVertical: 6,
  paddingHorizontal: 10,
  backgroundColor: 'rgba(255,59,48,0.06)',
  borderRadius: 8,
  borderWidth: 1,
  borderColor: 'rgba(255,59,48,0.1)',
},
moderatedText: {
  color: APP_COLORS.textTertiary,
  fontSize: 13,
  fontStyle: 'italic',
  flex: 1,
},
```

### 5c. Handle `moderation_hidden` from GET response on page load

When fetching messages via API, the response now includes `moderation_hidden: true` for the sender's hidden messages. Map this into your Message type:

```typescript
// In the message mapping from API response:
interface Message {
  message_id: string
  sender_id: string
  sender_name: string
  message_text: string | null  // null when moderation_hidden
  message_type: string
  moderation_hidden?: boolean  // ADD THIS
  // ... other fields
}

// When mapping API response to Message objects:
const mapMessage = (m: ApiMessage): Message => ({
  message_id: m.id,
  sender_id: m.user.id,
  sender_name: m.user.name,
  message_text: m.content,          // will be null if moderation_hidden
  message_type: m.type,
  moderation_hidden: m.moderation_hidden ?? false,
  // ...
})
```

### 5d. What each user sees

| Scenario | Sender sees | Other users see |
|----------|-------------|-----------------|
| Message auto-hidden by moderation | "This message was removed for violating chat guidelines" (grey placeholder) | Nothing — message not visible |
| Message deleted by admin | Message disappears | Message disappears |
| Page reload after moderation hide | Placeholder persists (API returns it) | Nothing |

---

## 6. Complete Event Flow Summary

### Auto-moderation (keyword/AI detection):
```
User sends "offensive word"
  → Message saved to DB & shown via socket (optimistic)
  → Backend runs async moderation (~50-200ms)
  → Keyword filter matches → confidence 0.9 → auto-hide
  → DB: message.moderation_status = "hidden", message.deleted_at = now()
  → Socket emits "chat:messageDeleted" with { moderation: true, userId }
  → OTHER users: message removed from UI (they never see the content)
  → SENDER: message replaced with "This message was removed" placeholder + toast
  → If 3+ hidden messages in 1 hour → auto-mute
  → Socket emits "chat:memberMuted" → client disables input for that user
  → Next send attempt returns errorCode: "USER_MUTED"
```

### Admin ban from dashboard:
```
Admin clicks "Ban" on dashboard
  → PATCH /api/events/{id}/chat/members/{userId} { action: "ban" }
  → DB: member.status = "banned"
  → Socket emits "chat:memberBanned" → client shows banned overlay
  → Next send attempt returns errorCode: "USER_BANNED"
```

### Admin mute from dashboard:
```
Admin clicks "Mute" on dashboard
  → PATCH /api/events/{id}/chat/members/{userId} { action: "mute" }
  → DB: member.status = "muted"
  → Socket emits "chat:memberMuted" → client disables input
  → Next send attempt returns errorCode: "USER_MUTED"
```

---

## 7. Error Code Reference

All error codes are defined in `lib/api-response.ts`:

```typescript
export const ErrorCode = {
  // ... existing codes ...
  USER_MUTED: "USER_MUTED",       // User muted in chat (auto or admin)
  USER_BANNED: "USER_BANNED",     // User banned from chat
  CHAT_LOCKED: "CHAT_LOCKED",     // Chat locked by organiser
  NOT_CHECKED_IN: "NOT_CHECKED_IN", // User not checked in to event
  SPAM_BLOCKED: "SPAM_BLOCKED",   // Rate limit / duplicate detection
}
```

## 8. Socket Events Reference

| Event | Payload | When | Client Action |
|-------|---------|------|---------------|
| `chat:messageDeleted` | `{ chatGroupId, messageId, moderation?, userId? }` | Message auto-hidden by moderation (`moderation: true`) or admin-deleted (`moderation` absent) | If `moderation && userId === self`: replace with placeholder. Otherwise: remove from UI. |
| `chat:memberBanned` | `{ chatGroupId, userId, banned }` | Admin bans/unbans user | If self: show banned overlay / restore access |
| `chat:memberMuted` | `{ chatGroupId, userId, muted, reason? }` | Auto-mute or admin mute/unmute | If self: disable/enable input, show mute banner |

---

## 9. Files to Modify in Blendn Client

| File | Change |
|------|--------|
| `lib/apiClient.ts` | Add `errorCode` to `ApiResponse` type |
| `lib/socketClient.ts` | Add `chat:memberMuted` event type, callback type, and listener. Update `chat:messageDeleted` type to include `moderation?` and `userId?` fields. |
| `app/chat/[id].tsx` | Handle error codes in sendMessage, add muted/banned/locked states, subscribe to `chat:memberMuted`. Update `handleDeleted` to show placeholder for own moderation-hidden messages. Add `moderation_hidden` to Message interface. |
| `app/chat/[id].tsx` styles | Add `restrictedBanner`, `restrictedText`, `moderatedMessage`, `moderatedText` styles |
| Message bubble component | Render "This message was removed" placeholder when `moderation_hidden` is true |

---

## 10. Testing Checklist

- [ ] Send a message with a slur (e.g. "test nigga test") — sender should see the message replaced with "This message was removed for violating chat guidelines" placeholder + toast warning
- [ ] Verify other users do NOT see the moderated message at all
- [ ] Close and reopen the chat — the "message removed" placeholder should still appear for the sender (persisted via API)
- [ ] Send 3+ slur messages within 1 hour — user should get muted, input disabled, mute banner shown
- [ ] Try sending a message while muted — should show "You are muted" error with explanation, not generic "Failed to send"
- [ ] Have admin ban a user from dashboard — user should see banned overlay in real-time via socket
- [ ] Have admin mute a user from dashboard — user should see muted banner in real-time via socket
- [ ] Have admin unmute a user — input should re-enable
- [ ] Send 5+ messages in 10 seconds — should show "Slow down" toast
- [ ] Check out of event then try to send — should show "Check in to send messages"
- [ ] Admin deletes a message (not moderation) — message should disappear entirely for everyone, no placeholder
