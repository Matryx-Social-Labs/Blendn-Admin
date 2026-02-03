"use strict";
/**
 * Push Notification Service using Expo Push Notifications
 * https://docs.expo.dev/push-notifications/sending-notifications/
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendPushNotification = sendPushNotification;
exports.sendBulkPushNotifications = sendBulkPushNotifications;
exports.notifyPrivateMessage = notifyPrivateMessage;
exports.notifyGroupMessage = notifyGroupMessage;
exports.notifyEventCheckIn = notifyEventCheckIn;
exports.notifyEventUpdate = notifyEventUpdate;
const expo_server_sdk_1 = require("expo-server-sdk");
const db_1 = require("./db");
// Create a new Expo SDK client
const expo = new expo_server_sdk_1.Expo();
/**
 * Get push tokens for a user from the database (supports multiple devices)
 */
async function getUserPushTokens(userId) {
    const tokens = await db_1.db.push_tokens.findMany({
        where: { user_id: userId },
        select: { token: true },
        orderBy: { updated_at: "desc" },
        take: 5, // Limit to 5 most recent tokens per user
    });
    return tokens.map((t) => t.token);
}
/**
 * Get push tokens for multiple users
 */
async function getBulkUserPushTokens(userIds) {
    const tokens = await db_1.db.push_tokens.findMany({
        where: {
            user_id: { in: userIds },
        },
        select: { user_id: true, token: true },
        orderBy: { updated_at: "desc" },
    });
    const tokenMap = new Map();
    for (const token of tokens) {
        const existing = tokenMap.get(token.user_id) || [];
        if (existing.length < 5) {
            // Limit to 5 tokens per user
            existing.push(token.token);
            tokenMap.set(token.user_id, existing);
        }
    }
    return tokenMap;
}
/**
 * Send a push notification to a single user (all their devices)
 */
async function sendPushNotification(options) {
    var _a, _b;
    const { userId, title, body, data, badge, sound = "default" } = options;
    try {
        const pushTokens = await getUserPushTokens(userId);
        if (pushTokens.length === 0) {
            console.log(`No push tokens for user ${userId}`);
            return false;
        }
        const messages = [];
        for (const pushToken of pushTokens) {
            // Check if it's a valid Expo push token
            if (!expo_server_sdk_1.Expo.isExpoPushToken(pushToken)) {
                console.error(`Invalid Expo push token: ${pushToken}`);
                continue;
            }
            messages.push({
                to: pushToken,
                sound,
                title,
                body,
                data: data,
                badge,
                // Android-specific
                channelId: options.channelId || "default",
                // iOS-specific
                priority: "high",
            });
        }
        if (messages.length === 0) {
            return false;
        }
        const chunks = expo.chunkPushNotifications(messages);
        const tickets = [];
        for (const chunk of chunks) {
            const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
            tickets.push(...ticketChunk);
        }
        // Check for errors
        let hasSuccess = false;
        for (let i = 0; i < tickets.length; i++) {
            const ticket = tickets[i];
            if (ticket.status === "error") {
                console.error(`Push notification error: ${ticket.message}`);
                if (((_a = ticket.details) === null || _a === void 0 ? void 0 : _a.error) === "DeviceNotRegistered") {
                    // Remove invalid token from database
                    const invalidToken = (_b = messages[i]) === null || _b === void 0 ? void 0 : _b.to;
                    if (invalidToken) {
                        await removeInvalidPushToken(invalidToken);
                    }
                }
            }
            else {
                hasSuccess = true;
            }
        }
        if (hasSuccess) {
            console.log(`Push notification sent to user ${userId}`);
        }
        return hasSuccess;
    }
    catch (error) {
        console.error("Failed to send push notification:", error);
        return false;
    }
}
/**
 * Send push notifications to multiple users
 */
async function sendBulkPushNotifications(options) {
    var _a, _b;
    const { userIds, title, body, data, badge, sound = "default" } = options;
    const tokenMap = await getBulkUserPushTokens(userIds);
    const messages = [];
    for (const [userId, pushTokens] of tokenMap) {
        for (const pushToken of pushTokens) {
            if (expo_server_sdk_1.Expo.isExpoPushToken(pushToken)) {
                messages.push({
                    to: pushToken,
                    sound,
                    title,
                    body,
                    data: Object.assign(Object.assign({}, data), { userId }),
                    badge,
                    priority: "high",
                });
            }
        }
    }
    if (messages.length === 0) {
        return { sent: 0, failed: userIds.length };
    }
    const chunks = expo.chunkPushNotifications(messages);
    let sent = 0;
    let failed = 0;
    for (const chunk of chunks) {
        try {
            const tickets = await expo.sendPushNotificationsAsync(chunk);
            for (let i = 0; i < tickets.length; i++) {
                const ticket = tickets[i];
                if (ticket.status === "ok") {
                    sent++;
                }
                else {
                    failed++;
                    console.error(`Push notification error: ${ticket.message}`);
                    if (((_a = ticket.details) === null || _a === void 0 ? void 0 : _a.error) === "DeviceNotRegistered") {
                        const invalidToken = (_b = chunk[i]) === null || _b === void 0 ? void 0 : _b.to;
                        if (invalidToken) {
                            await removeInvalidPushToken(invalidToken);
                        }
                    }
                }
            }
        }
        catch (error) {
            console.error("Failed to send push notification chunk:", error);
            failed += chunk.length;
        }
    }
    console.log(`Bulk push notifications: ${sent} sent, ${failed} failed`);
    return { sent, failed };
}
/**
 * Remove an invalid push token from the database
 */
async function removeInvalidPushToken(token) {
    try {
        await db_1.db.push_tokens.deleteMany({
            where: { token },
        });
        console.log(`Removed invalid push token: ${token.substring(0, 20)}...`);
    }
    catch (error) {
        console.error("Failed to remove invalid push token:", error);
    }
}
// ============================================
// Convenience functions for specific notifications
// ============================================
/**
 * Send notification for a new private message
 */
async function notifyPrivateMessage(recipientId, senderName, messagePreview, conversationId) {
    return sendPushNotification({
        userId: recipientId,
        title: senderName,
        body: messagePreview.length > 100 ? messagePreview.substring(0, 97) + "..." : messagePreview,
        data: {
            type: "private_message",
            conversationId,
        },
        channelId: "messages",
    });
}
/**
 * Send notification for a new group chat message
 */
async function notifyGroupMessage(recipientIds, senderName, groupName, messagePreview, chatGroupId, senderId) {
    // Exclude the sender from notifications
    const filteredRecipients = recipientIds.filter((id) => id !== senderId);
    if (filteredRecipients.length === 0) {
        return { sent: 0, failed: 0 };
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
    });
}
/**
 * Send notification when someone checks in to an event
 */
async function notifyEventCheckIn(recipientIds, userName, eventName, eventId, checkInUserId) {
    // Exclude the user who checked in
    const filteredRecipients = recipientIds.filter((id) => id !== checkInUserId);
    if (filteredRecipients.length === 0) {
        return { sent: 0, failed: 0 };
    }
    return sendBulkPushNotifications({
        userIds: filteredRecipients,
        title: eventName,
        body: `${userName} just checked in!`,
        data: {
            type: "event_checkin",
            eventId,
        },
    });
}
/**
 * Send notification for event updates (time change, cancellation, etc.)
 */
async function notifyEventUpdate(recipientIds, eventName, updateMessage, eventId) {
    return sendBulkPushNotifications({
        userIds: recipientIds,
        title: eventName,
        body: updateMessage,
        data: {
            type: "event_update",
            eventId,
        },
    });
}
