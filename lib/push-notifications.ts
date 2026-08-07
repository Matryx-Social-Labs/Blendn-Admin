import { logger } from "./logger"
/**
 * Push Notification Service using Expo Push Notifications
 * https://docs.expo.dev/push-notifications/sending-notifications/
 */

import { Expo, ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk"
import { db } from "./db"

// Create a new Expo SDK client
const expo = new Expo()

// Types for notification payloads
export interface NotificationData {
  type: "private_message" | "group_message" | "event_checkin" | "event_update" | "announcement" | "message_request" | "message_request_response" | "waitlist_promoted"
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
  channelId?: string
}

interface SendBulkNotificationOptions {
  userIds: string[]
  title: string
  body: string
  data?: NotificationData
  badge?: number
  sound?: "default" | null
  channelId?: string
}

/**
 * Get push tokens for a user from the database (supports multiple devices)
 */
async function getUserPushTokens(userId: string): Promise<string[]> {
  const tokens = await db.push_tokens.findMany({
    where: { user_id: userId },
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
export async function sendPushNotification(options: SendNotificationOptions): Promise<boolean> {
  const { userId, title, body, data, badge, sound = "default" } = options

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
        // Android-specific
        channelId: options.channelId || "default",
        // iOS-specific
        priority: "high",
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
  const { userIds, title, body, data, badge, sound = "default", channelId = "default" } = options

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
          channelId,
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
 * Send notification for a new private message
 */
export async function notifyPrivateMessage(
  recipientId: string,
  senderName: string,
  messagePreview: string,
  conversationId: string
): Promise<boolean> {
  return sendPushNotification({
    userId: recipientId,
    title: senderName,
    body: messagePreview.length > 100 ? messagePreview.substring(0, 97) + "..." : messagePreview,
    data: {
      type: "private_message",
      conversationId,
    },
    channelId: "messages",
  })
}

/**
 * Send notification for a new group chat message
 */
export async function notifyGroupMessage(
  recipientIds: string[],
  senderName: string,
  groupName: string,
  messagePreview: string,
  chatGroupId: string,
  senderId: string
): Promise<{ sent: number; failed: number }> {
  // Exclude the sender from notifications
  const filteredRecipients = recipientIds.filter((id) => id !== senderId)

  if (filteredRecipients.length === 0) {
    return { sent: 0, failed: 0 }
  }

  return sendBulkPushNotifications({
    userIds: filteredRecipients,
    title: groupName,
    body: `${senderName}: ${messagePreview.length > 80 ? messagePreview.substring(0, 77) + "..." : messagePreview}`,
    data: {
      type: "group_message",
      chatGroupId,
      senderId,
    },
  })
}

/**
 * Send notification when someone checks in to an event
 */
export async function notifyEventCheckIn(
  recipientIds: string[],
  userName: string,
  eventName: string,
  eventId: string,
  checkInUserId: string
): Promise<{ sent: number; failed: number }> {
  // Exclude the user who checked in
  const filteredRecipients = recipientIds.filter((id) => id !== checkInUserId)

  if (filteredRecipients.length === 0) {
    return { sent: 0, failed: 0 }
  }

  return sendBulkPushNotifications({
    userIds: filteredRecipients,
    title: eventName,
    body: `${userName} just checked in!`,
    data: {
      type: "event_checkin",
      eventId,
    },
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
    channelId: "announcements",
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
