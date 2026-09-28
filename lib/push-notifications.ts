import { logger } from "./logger"
/**
 * Push Notification Service using Expo Push Notifications
 * https://docs.expo.dev/push-notifications/sending-notifications/
 */

import { Expo, ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk"
import { db } from "./db"
import { hit } from "./rate-limit-store"

// Create a new Expo SDK client
const expo = new Expo()

// Types for notification payloads
export interface NotificationData {
  type: "private_message" | "group_message" | "event_checkin" | "event_update" | "announcement" | "message_request" | "message_request_response" | "waitlist_promoted" | "match" | "reveal_request" | "reveal" | "board_request" | "board_request_accepted" | "friend_request" | "friend_accepted"
  conversationId?: string
  chatGroupId?: string
  eventId?: string
  senderId?: string
  requestId?: string
  [key: string]: string | undefined
}

interface SendNotificationOptions {
  userId: string
  title: string
  body: string
  data?: NotificationData
  badge?: number
  sound?: "default" | null
}

interface SendBulkNotificationOptions {
  userIds: string[]
  title: string
  body: string
  data?: NotificationData
  badge?: number
  sound?: "default" | null
}

/**
 * Where a notification lands on the phone, decided by what it is rather than
 * by each caller.
 *
 * ## Channels
 *
 * Android files every notification under a channel the app created, and people
 * silence a channel in system settings. The app created one, `default`, at the
 * highest importance — and this file sent DMs, friend requests and matches on
 * `messages`, which did not exist, so Android put them in "Miscellaneous" at
 * normal importance while room chatter rode `default` as a heads-up. The
 * things that were about you were quieter than the things that were not.
 *
 * Three, because there are three things a person might want to silence
 * separately: people (`messages`), the room (`rooms`), and events (`events`).
 * The app creates exactly these; `default` is only for a payload with no type.
 *
 * ## Replaced in place, or stacked
 *
 * `threadId` stacks a conversation's notifications together on iOS.
 * `collapseId` (iOS, and in-transit on Android) and `tag` (already on screen,
 * Android) *replace* the previous one — so a conversation is one notification
 * that updates, not a column of them. An event's changes collapse too, because
 * only its latest state is true. Announcements stack but never replace: "doors
 * moved to the side entrance" must survive "raffle at nine".
 */
export function deliveryFor(
  data?: NotificationData
): Pick<ExpoPushMessage, "channelId" | "threadId" | "collapseId" | "tag"> {
  if (!data) return { channelId: "default" }
  switch (data.type) {
    case "private_message":
      return replaced("messages", data.conversationId && `dm:${data.conversationId}`)
    case "group_message":
      return replaced("rooms", data.chatGroupId && `room:${data.chatGroupId}`)
    case "event_update":
      return replaced("events", data.eventId && `event:${data.eventId}`)
    case "announcement":
    case "waitlist_promoted":
      return data.eventId
        ? { channelId: "events", threadId: `event:${data.eventId}` }
        : { channelId: "events" }
    default:
      return { channelId: "messages" }
  }
}

function replaced(
  channelId: string,
  key: string | undefined
): Pick<ExpoPushMessage, "channelId" | "threadId" | "collapseId" | "tag"> {
  return key ? { channelId, threadId: key, collapseId: key, tag: key } : { channelId }
}

/**
 * Kinds the bell does not show.
 *
 * Messages have an inbox — the Banter list and the Room badge both count what
 * is unread — so a bell row per message was the same fact a second time, and
 * it buried what only the bell carries: a friend request, a cancelled event.
 * Every messaging product draws this line (Instagram's activity feed, LinkedIn's
 * notifications and Discord's inbox all leave DMs out).
 *
 * `event_checkin` is here for the rows written before its push was removed.
 * Nothing writes any of these any more; the feed filters on the list so the
 * rows already in the table disappear today rather than when retention reaches
 * them.
 */
export const NOT_IN_THE_BELL: NotificationData["type"][] = [
  "private_message",
  "group_message",
  "event_checkin",
]

/**
 * How long a burst stays quiet.
 *
 * A DM rings when the conversation goes from read to unread. While it stays
 * unread, it rings again at most once per window, with the count — so twenty
 * messages in a minute is one alert, and a conversation you have not opened
 * for ten minutes still reminds you it is there.
 */
export const DM_PUSH_WINDOW_MS = 5 * 60 * 1000

/** At most one "somebody replied to you" per room in this long. */
export const ROOM_REPLY_PUSH_WINDOW_MS = 3 * 60 * 1000

/**
 * True the first time a key is seen in its window.
 *
 * ponytail: the counters live in `rate-limit-store` — Redis when `REDIS_URL` is
 * set, this process otherwise. Without Redis a deploy or a second replica
 * forgets the window, and the cost of forgetting is one extra alert. Move this
 * to a table if that ever matters.
 */
async function firstInWindow(key: string, windowMs: number): Promise<boolean> {
  const { count } = await hit(key, windowMs)
  return count === 1
}

/**
 * Tokens belonging to people who have not turned notifications off.
 *
 * `profiles.push_enabled` is stored, returned by `GET /profiles/:userId`, and
 * rendered as a switch in the app's settings — and **nothing had ever read it
 * on the send path**. This function selected by `user_id` alone, so did its
 * bulk sibling, and so did every caller. Turning notifications off changed
 * exactly nothing: message notifications, message requests and check-in pings
 * all kept arriving.
 *
 * The filter belongs here rather than at each call site so that every existing
 * sender is covered by one change and no future one can forget.
 *
 * ## Why this excludes rather than includes
 *
 * The obvious spelling is `user: { profile: { push_enabled: true } }`, and it
 * is wrong: `User.profile` is optional (`profiles?` in the schema) and
 * `push_enabled` is `@default(true)`. An inclusive filter therefore drops
 * everyone who has no `profiles` row at all, silently turning a bug fix into a
 * wider outage. Excluding the explicit opt-out reproduces the column's own
 * default — a null profile does not match `push_enabled: false`, so it stays.
 */
const NOT_OPTED_OUT = {
  NOT: { user: { profile: { is: { push_enabled: false } } } },
} as const

async function getUserPushTokens(userId: string): Promise<string[]> {
  const tokens = await db.push_tokens.findMany({
    where: { user_id: userId, ...NOT_OPTED_OUT },
    select: { token: true },
    orderBy: { updated_at: "desc" },
    take: 5, // Limit to 5 most recent tokens per user
  })

  return tokens.map((t) => t.token)
}

/**
 * Get push tokens for multiple users
 */
async function getBulkUserPushTokens(userIds: string[]): Promise<Map<string, string[]>> {
  const tokens = await db.push_tokens.findMany({
    where: {
      user_id: { in: userIds },
      // Same opt-out rule as the single-user path. This one matters more:
      // an announcement to a full room is the loudest sender in the product,
      // so a preference that works everywhere except here would look broken.
      ...NOT_OPTED_OUT,
    },
    select: { user_id: true, token: true },
    orderBy: { updated_at: "desc" },
  })

  const tokenMap = new Map<string, string[]>()
  for (const token of tokens) {
    const existing = tokenMap.get(token.user_id) || []
    if (existing.length < 5) {
      // Limit to 5 tokens per user
      existing.push(token.token)
      tokenMap.set(token.user_id, existing)
    }
  }

  return tokenMap
}

/**
 * Send a push notification to a single user (all their devices)
 */
/**
 * Record one line in the notifications centre.
 *
 * ## Before the token lookup, deliberately
 *
 * A push does not arrive for three reasons that have nothing to do with the
 * notification being real: the person turned notifications off in settings,
 * they have not registered a device yet, and their token expired. All three
 * return early from `sendPushNotification`. Writing the row after that point
 * would mean the centre only holds what already reached the phone — which is
 * the exact opposite of what a centre is for. It is where you look for what you
 * **missed**, and "my phone was off" is the case it has to cover.
 *
 * ## Never throws
 *
 * Callers are the `notify*` helpers, and every one of them is
 * fire-and-forget: the send is not allowed to fail the request that triggered
 * it. A failed insert is logged and swallowed for the same reason — nobody
 * should lose a check-in because the notifications table was busy.
 *
 * The `kind` cast is safe by construction and guarded by a test:
 * `NotificationData["type"]` and the `notification_kind` enum are the same
 * strings, and `__tests__/notifications.test.ts` fails if they diverge.
 */
/**
 * Kinds whose push body is a copy of something a person wrote.
 *
 * These three are the only ones that carry user content. Every other kind has a
 * fixed string for a body — "Someone you liked has liked you back." — and can be
 * stored verbatim without keeping anybody's words.
 */
const CONTENT_BEARING: ReadonlySet<string> = new Set([
  "private_message",
  "group_message",
  "announcement",
])

/**
 * What the notifications table stores, as opposed to what the push carries.
 *
 * The push body is a preview, and it should be: it renders on a lock screen for
 * a few seconds and then it is gone. `notifications.body` is a different thing
 * — a permanent, unencrypted, unpruned row — and it was being handed the same
 * string. That made this table a durable second copy of every DM in the
 * product, sitting outside every access control that guards `private_messages`,
 * with no retention policy at all.
 *
 * The row does not need the words. Tapping it deep-links to the conversation,
 * where the real message lives behind the real gate. So the stored body says
 * what happened and the message stays in one place.
 *
 * Deliberately not applied to the push itself: changing what renders on a lock
 * screen is a product decision, and this is a storage bug.
 */
export function storedBodyFor(kind: string, body: string): string {
  if (!CONTENT_BEARING.has(kind)) return body
  switch (kind) {
    case "private_message":
      return "Sent you a message"
    case "group_message":
      return "New message in the room"
    default:
      return "Posted an announcement"
  }
}

type BellSocket = { to(rooms: string[]): { emit(event: "notification:new", payload: { kind: string }): void } }

/**
 * A bell row landed: tell the app, if it is open, so the badge moves now rather
 * than when the Pulse next comes into focus. The kind and nothing else — the
 * app reads the row through `GET /notifications`, like any other.
 *
 * The `globalThis` instance every emitter in `lib/socket-server.ts` reads
 * (see the note at its top), rather than an import that would pull socket.io
 * into every sender for one emit. No server attached means nobody to tell.
 */
function announceToBell(userIds: string[], kind: string): void {
  const io = (globalThis as { __blendnSocketIo?: BellSocket | null }).__blendnSocketIo
  if (!io || userIds.length === 0) return
  io.to(userIds.map((id) => `user:${id}`)).emit("notification:new", { kind })
}

async function recordNotification(
  userId: string,
  title: string,
  body: string,
  data?: NotificationData
): Promise<void> {
  /*
   * No `data.type` means no row, rather than a row under a guessed kind.
   *
   * Everything routed through the `notify*` helpers sets it. A caller that does
   * not is sending something the centre has no category for, and inventing one
   * would put a mislabelled line in somebody's feed forever.
   */
  if (!data?.type) {
    logger.debug("Notification not recorded: no type on payload", { userId })
    return
  }
  if (NOT_IN_THE_BELL.includes(data.type)) return

  try {
    await db.notifications.create({
      data: {
        user_id: userId,
        kind: data.type as never,
        title,
        body: storedBodyFor(data.type, body),
        data: data as object,
      },
    })
    announceToBell([userId], data.type)
  } catch (error) {
    logger.warn("Failed to record notification", { userId, error: String(error) })
  }
}

export async function sendPushNotification(options: SendNotificationOptions): Promise<boolean> {
  const { userId, title, body, data, badge, sound = "default" } = options

  // First, and outside the try: the centre records what was *sent*, not what
  // was successfully delivered. See `recordNotification`.
  await recordNotification(userId, title, body, data)

  try {
    const pushTokens = await getUserPushTokens(userId)

    if (pushTokens.length === 0) {
      logger.debug("No push tokens for user", { userId })
      return false
    }

    const messages: ExpoPushMessage[] = []

    for (const pushToken of pushTokens) {
      // Check if it's a valid Expo push token
      if (!Expo.isExpoPushToken(pushToken)) {
        // isExpoPushToken is a type guard, so pushToken narrows to never here.
        logger.warn("Invalid Expo push token", {
          tokenPrefix: String(pushToken).slice(0, 12),
        })
        continue
      }

      messages.push({
        to: pushToken,
        sound,
        title,
        body,
        data: data as Record<string, unknown>,
        badge,
        priority: "high",
        ...deliveryFor(data),
      })
    }

    if (messages.length === 0) {
      return false
    }

    const chunks = expo.chunkPushNotifications(messages)
    const tickets: ExpoPushTicket[] = []

    for (const chunk of chunks) {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk)
      tickets.push(...ticketChunk)
    }

    // Check for errors
    let hasSuccess = false
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i]
      if (ticket.status === "error") {
        logger.warn("Push notification rejected", { reason: ticket.message })
        if (ticket.details?.error === "DeviceNotRegistered") {
          // Remove invalid token from database
          const invalidToken = messages[i]?.to as string
          if (invalidToken) {
            await removeInvalidPushToken(invalidToken)
          }
        }
      } else {
        hasSuccess = true
      }
    }

    if (hasSuccess) {
      logger.debug("Push notification sent", { userId })
    }
    return hasSuccess
  } catch (error) {
    logger.error("Failed to send push notification", { error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

/**
 * Send push notifications to multiple users
 */
export async function sendBulkPushNotifications(
  options: SendBulkNotificationOptions
): Promise<{ sent: number; failed: number }> {
  const { userIds, title, body, data, badge, sound = "default" } = options

  /*
   * Every recipient gets a row, not just the ones with a device.
   *
   * `getBulkUserPushTokens` returns a map keyed only by users who have a token
   * *and* have not turned notifications off — so recording inside the loop
   * below would silently drop everybody else. An organiser's announcement is
   * precisely the thing somebody opens the bell to find, and "I had no device
   * registered that evening" is not a reason to have never been told.
   *
   * `createMany` rather than a create per user: an announcement to a full event
   * is one statement instead of several hundred round trips. Swallowed for the
   * same reason the single sender's is — a failed insert must not fail the
   * announcement.
   */
  if (data?.type && !NOT_IN_THE_BELL.includes(data.type) && userIds.length > 0) {
    await db.notifications
      .createMany({
        data: userIds.map((userId) => ({
          user_id: userId,
          kind: data.type as never,
          title,
          body: storedBodyFor(data.type, body),
          data: data as object,
        })),
      })
      .then(() => announceToBell(userIds, data.type))
      .catch((error) => {
        logger.warn("Failed to record bulk notifications", {
          count: userIds.length,
          error: String(error),
        })
      })
  }

  const tokenMap = await getBulkUserPushTokens(userIds)
  const messages: ExpoPushMessage[] = []

  for (const [userId, pushTokens] of tokenMap) {
    for (const pushToken of pushTokens) {
      if (Expo.isExpoPushToken(pushToken)) {
        messages.push({
          to: pushToken,
          sound,
          title,
          body,
          data: { ...data, userId } as Record<string, unknown>,
          badge,
          priority: "high",
          ...deliveryFor(data),
        })
      }
    }
  }

  if (messages.length === 0) {
    return { sent: 0, failed: userIds.length }
  }

  const chunks = expo.chunkPushNotifications(messages)
  let sent = 0
  let failed = 0

  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk)

      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i]
        if (ticket.status === "ok") {
          sent++
        } else {
          failed++
          logger.warn("Push notification rejected", { reason: ticket.message })
          if (ticket.details?.error === "DeviceNotRegistered") {
            const invalidToken = chunk[i]?.to as string
            if (invalidToken) {
              await removeInvalidPushToken(invalidToken)
            }
          }
        }
      }
    } catch (error) {
      logger.error("Failed to send push notification chunk", { error: error instanceof Error ? error.message : String(error) })
      failed += chunk.length
    }
  }

  logger.info("Bulk push notifications complete", { sent, failed })
  return { sent, failed }
}

/**
 * Remove an invalid push token from the database
 */
async function removeInvalidPushToken(token: string): Promise<void> {
  try {
    await db.push_tokens.deleteMany({
      where: { token },
    })
    logger.debug("Removed invalid push token", { tokenPrefix: token.slice(0, 12) })
  } catch (error) {
    logger.error("Failed to remove invalid push token", { error: error instanceof Error ? error.message : String(error) })
  }
}

// ============================================
// Convenience functions for specific notifications
// ============================================

/**
 * The three moments in a match that happen while the app is closed.
 *
 * ## No name on any of them, not even a pseudonym
 *
 * A lock screen is not an authenticated surface. The design doc names Indian
 * venues and women in the room as the sensitive case, and shared or borrowed
 * phones are part of that same picture — a dating match visible to whoever
 * picks the phone up is a real-world safety problem, not a UX preference.
 *
 * Two lesser reasons that point the same way. A body carrying a name would have
 * to branch on reveal state to stay correct, pseudonym here and real name
 * there, and the branch that leaks is the one that ships. And a body with no
 * name cannot go stale: it is true before and after any reveal, so nothing has
 * to be rewritten when identity changes underneath it.
 *
 * The app shows everything on open. `conversationId` in `data` is what gets
 * them there in one tap.
 *
 * Existing senders are deliberately untouched. `notifyPrivateMessage` uses the
 * *resolved* display name (see `lib/conversation-identity.ts`), which is a
 * pseudonym until someone reveals; changing it to carry nothing at all is a
 * separate call.
 */

/** A mutual like. Sent to the EARLIER liker only — see below. */
export async function notifyMatch(
  recipientId: string,
  conversationId: string
): Promise<boolean> {
  return sendPushNotification({
    userId: recipientId,
    title: "You have a new match",
    body: "Someone you liked has liked you back.",
    data: { type: "match", conversationId },
  })
}

/** Somebody asked to see who you are. There is no decline to send back. */
export async function notifyRevealRequest(
  recipientId: string,
  conversationId: string
): Promise<boolean> {
  return sendPushNotification({
    userId: recipientId,
    title: "A match wants to know you",
    body: "Someone you matched with wants to see who you are.",
    data: { type: "reveal_request", conversationId },
  })
}

/** The other person showed you their name and photos. */
export async function notifyReveal(
  recipientId: string,
  conversationId: string
): Promise<boolean> {
  return sendPushNotification({
    userId: recipientId,
    title: "A match revealed",
    body: "Someone you matched with showed you who they are.",
    data: { type: "reveal", conversationId },
  })
}

/**
 * Somebody answered your board post and wants to come with you.
 *
 * Carries neither the pseudonym nor a word of what they wrote, which is
 * deliberate and matches `notifyMatch` rather than `notifyPrivateMessage`. A
 * board request is the one message in this product sent to somebody who has
 * not agreed to hear from the sender at all, and the whole of it renders on a
 * lock screen that other people can see. The finding this avoids is already in
 * the register: DM and group pushes carry verbatim text at 100 and 80
 * characters, in a product whose match copy was stripped of even a pseudonym
 * for exactly this reason.
 *
 * So the push says that something happened and the board says what.
 */
export async function notifyBoardRequest(
  recipientId: string,
  eventId: string,
  requestId: string
): Promise<boolean> {
  return sendPushNotification({
    userId: recipientId,
    title: "Someone answered your post",
    body: "Open the board to see who is asking.",
    data: { type: "board_request", eventId, requestId },
  })
}

/** They said yes. There is a conversation now, and no decline to send back. */
export async function notifyBoardRequestAccepted(
  recipientId: string,
  conversationId: string
): Promise<boolean> {
  return sendPushNotification({
    userId: recipientId,
    title: "Your ask was accepted",
    body: "You can message them now.",
    data: { type: "board_request_accepted", conversationId },
  })
}

function clip(text: string, max: number): string {
  return text.length > max ? text.substring(0, max - 3) + "..." : text
}

/**
 * A DM, once per burst.
 *
 * `unread` is how many of the sender's messages in this conversation the
 * recipient has not read, **this one included** — the caller counts it with
 * `VISIBLE_DM`, because a hidden message is never marked read and would
 * otherwise keep every conversation it is in permanently "unread".
 *
 * One unread means the conversation just went from read to unread, and that
 * always rings: reading resets it, with no hook to forget. More than one is a
 * burst, and it rings only when the window has passed, saying how many. Every
 * push carries the conversation's `collapseId`, so the lock screen shows one
 * notification for it, updated, rather than a column.
 *
 * The body is still the message on the first alert. Whether a lock screen
 * should carry what somebody wrote is a product decision this does not make.
 *
 * ponytail: two sends committing within the same few milliseconds can each
 * count one unread and both ring; they share a `collapseId`, so the phone shows
 * one. A short dedupe key on the first alert closes it if it is ever seen.
 */
export async function notifyPrivateMessage(dm: {
  recipientId: string
  senderName: string
  preview: string
  conversationId: string
  unread: number
}): Promise<boolean> {
  const fresh = await firstInWindow(`push:dm:${dm.conversationId}:${dm.recipientId}`, DM_PUSH_WINDOW_MS)
  if (dm.unread > 1 && !fresh) return false

  return sendPushNotification({
    userId: dm.recipientId,
    title: dm.senderName,
    body: dm.unread > 1 ? `${dm.unread} new messages` : clip(dm.preview, 100),
    data: { type: "private_message", conversationId: dm.conversationId },
  })
}

/**
 * Somebody replied to you in a room. The only room message that pushes.
 *
 * A room is a few hundred strangers, and it pushed every message to all of
 * them — members who had gone home included, because membership is attendance
 * and lasts the whole window. Large group products default to "replies and
 * mentions only" for exactly this reason (Discord's large servers, Slack's
 * channels). A reply is the one message that is about you.
 *
 * At most one per room per window: a thread that turns into a conversation
 * would otherwise be a DM burst with none of the DM's throttle.
 *
 * `senderHandle` is what the payload carries as `senderId`: the sender's handle
 * in this event's room (SCRUM-371). A real id here was the room's
 * pseudonym-to-person map arriving by push.
 */
export async function notifyRoomReply(reply: {
  recipientId: string
  senderName: string
  groupName: string
  preview: string
  chatGroupId: string
  senderHandle: string
}): Promise<boolean> {
  const fresh = await firstInWindow(
    `push:room-reply:${reply.chatGroupId}:${reply.recipientId}`,
    ROOM_REPLY_PUSH_WINDOW_MS
  )
  if (!fresh) return false

  return sendPushNotification({
    userId: reply.recipientId,
    title: reply.groupName,
    body: `${reply.senderName} replied: ${clip(reply.preview, 80)}`,
    data: { type: "group_message", chatGroupId: reply.chatGroupId, senderId: reply.senderHandle },
  })
}

/**
 * Send announcement notification to all active members of a chat group
 */
export async function notifyAnnouncement(
  chatGroupId: string,
  eventTitle: string,
  announcementText: string,
  eventId: string,
  senderId: string
): Promise<{ sent: number; failed: number }> {
  const members = await db.chat_group_members.findMany({
    where: { chat_group_id: chatGroupId, status: "active" },
    select: { user_id: true },
  })

  const userIds = members
    .map((m) => m.user_id)
    .filter((id) => id !== senderId)

  if (userIds.length === 0) return { sent: 0, failed: 0 }

  const preview = announcementText.length > 100
    ? announcementText.substring(0, 97) + "..."
    : announcementText

  return sendBulkPushNotifications({
    userIds,
    title: `📢 ${eventTitle}`,
    body: preview,
    data: { type: "announcement", chatGroupId, eventId },
  })
}

/**
 * Send notification for event updates (time change, cancellation, etc.)
 */
export async function notifyEventUpdate(
  recipientIds: string[],
  eventName: string,
  updateMessage: string,
  eventId: string
): Promise<{ sent: number; failed: number }> {
  return sendBulkPushNotifications({
    userIds: recipientIds,
    title: eventName,
    body: updateMessage,
    data: {
      type: "event_update",
      eventId,
    },
  })
}
