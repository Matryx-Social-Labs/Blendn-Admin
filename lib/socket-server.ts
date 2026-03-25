import { Server as HttpServer } from "http"
import { Server, Socket } from "socket.io"
import { verifyAccessToken } from "./mobile-auth"
import { db } from "./db"

// Socket.io server instance
let io: Server | null = null

// Room types for organizing subscriptions
export type RoomType = "event" | "chat" | "user"

// Socket events
export interface ServerToClientEvents {
  // Event-related
  "event:checkin": (data: {
    eventId: string
    userId: string
    userName: string
    userImage?: string
    checkInTime: string
  }) => void
  "event:checkout": (data: {
    eventId: string
    userId: string
    checkOutTime: string
  }) => void
  "event:interestUpdate": (data: {
    eventId: string
    interested: boolean
    interestCount: number
    userId: string
  }) => void

  // Chat-related
  "chat:message": (data: {
    chatGroupId: string
    message: {
      id: string
      content: string
      type: string
      userId: string
      userName: string
      userImage?: string
      createdAt: string
      parentId?: string
    }
  }) => void
  "chat:typing": (data: {
    chatGroupId: string
    userId: string
    userName: string
    isTyping: boolean
  }) => void
  "chat:reaction": (data: {
    chatGroupId: string
    messageId: string
    userId: string
    emoji: string
    action: "add" | "remove"
  }) => void

  // Private messaging
  "private:message": (data: {
    conversationId: string
    message: {
      id: string
      conversationId: string
      senderId: string
      sender: { id: string; name: string | null; image: string | null }
      text: string | null
      mediaUrl: string | null
      mediaType: string | null
      isRead: boolean
      createdAt: Date
    }
  }) => void
  "private:typing": (data: {
    conversationId: string
    userId: string
    userName: string
    isTyping: boolean
  }) => void
  "private:read": (data: {
    conversationId: string
    messageIds: string[]
    readBy: string
  }) => void

  // Moderation events
  "chat:messageDeleted": (data: { chatGroupId: string; messageId: string }) => void
  "chat:messageHidden": (data: { chatGroupId: string; messageId: string; reason: string }) => void
  "chat:memberBanned": (data: { chatGroupId: string; userId: string; banned: boolean }) => void
  "chat:memberMuted": (data: { chatGroupId: string; userId: string; muted: boolean; reason?: string }) => void

  // System events
  error: (data: { message: string; code?: string }) => void
  connected: (data: { userId: string }) => void
}

export interface ClientToServerEvents {
  // Join/leave rooms
  "join:event": (eventId: string) => void
  "leave:event": (eventId: string) => void
  "join:chat": (chatGroupId: string) => void
  "leave:chat": (chatGroupId: string) => void
  "join:conversation": (conversationId: string) => void
  "leave:conversation": (conversationId: string) => void

  // Chat actions
  "chat:startTyping": (chatGroupId: string) => void
  "chat:stopTyping": (chatGroupId: string) => void

  // Private messaging actions
  "private:startTyping": (conversationId: string) => void
  "private:stopTyping": (conversationId: string) => void
  "private:markRead": (conversationId: string, messageIds: string[]) => void

  // Ping for connection health
  ping: () => void
}

interface SocketData {
  userId: string
  email: string
}

// Authenticated socket type
export type AuthenticatedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>

// ── Sponsored Message Scheduler ───────────────────────────────────────────────

interface SponsoredMessageRecord {
  id: string
  event_id: string
  content: string
  interval_minutes: number
  organizer_id: string
  chat_group_id: string
}

class SponsoredMessageScheduler {
  private timers = new Map<string, ReturnType<typeof setInterval>>()

  /** Send one sponsored message into the chatroom and update last_sent_at */
  private async send(msg: SponsoredMessageRecord): Promise<void> {
    try {
      const chatContent = `📣 [Sponsored]\n${msg.content}`

      const created = await db.chat_messages.create({
        data: {
          chat_group_id: msg.chat_group_id,
          user_id: msg.organizer_id,
          type: "text",
          content: chatContent,
          metadata: { sponsored_message_id: msg.id },
        },
      })

      await db.chat_groups.update({
        where: { id: msg.chat_group_id },
        data: { last_message_at: created.created_at },
      })

      await db.event_sponsored_messages.update({
        where: { id: msg.id },
        data: { last_sent_at: created.created_at },
      })

      emitChatMessage(msg.chat_group_id, {
        id: created.id,
        content: created.content,
        type: "text",
        userId: msg.organizer_id,
        userName: "Sponsored",
        createdAt: created.created_at.toISOString(),
      })
    } catch (err) {
      console.error(`[Scheduler] Failed to send sponsored message ${msg.id}:`, err)
    }
  }

  /** Start periodic sending for a message */
  start(msg: SponsoredMessageRecord): void {
    this.stop(msg.id) // clear any existing timer
    const ms = msg.interval_minutes * 60 * 1000
    const timer = setInterval(() => void this.send(msg), ms)
    this.timers.set(msg.id, timer)
    console.log(`[Scheduler] Started sponsored message ${msg.id} (every ${msg.interval_minutes} min)`)
  }

  /** Stop a specific timer */
  stop(messageId: string): void {
    const timer = this.timers.get(messageId)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(messageId)
      console.log(`[Scheduler] Stopped sponsored message ${messageId}`)
    }
  }

  /** Load all active sponsored messages from DB and start their timers */
  async loadAll(): Promise<void> {
    try {
      const messages = await db.event_sponsored_messages.findMany({
        where: { is_active: true },
        include: {
          event: {
            select: {
              organizer_id: true,
              chat_group: { select: { id: true } },
            },
          },
        },
      })

      for (const msg of messages) {
        if (!msg.event.chat_group) continue
        this.start({
          id: msg.id,
          event_id: msg.event_id,
          content: msg.content,
          interval_minutes: msg.interval_minutes,
          organizer_id: msg.event.organizer_id,
          chat_group_id: msg.event.chat_group.id,
        })
      }
      console.log(`[Scheduler] Loaded ${messages.length} active sponsored messages`)
    } catch (err) {
      console.error("[Scheduler] Failed to load sponsored messages:", err)
    }
  }
}

export const sponsoredMessageScheduler = new SponsoredMessageScheduler()

/**
 * Initialize Socket.io server
 */
export function initSocketServer(httpServer: HttpServer): Server {
  io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: {
      origin: "*", // In production, restrict this to your mobile app domain
      methods: ["GET", "POST"],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  })

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace("Bearer ", "")

      if (!token) {
        return next(new Error("Authentication required"))
      }

      const decoded = verifyAccessToken(token)
      if (!decoded) {
        return next(new Error("Invalid or expired token"))
      }

      // Attach user data to socket
      socket.data.userId = decoded.userId
      socket.data.email = decoded.email

      next()
    } catch (error) {
      console.error("Socket auth error:", error)
      next(new Error("Authentication failed"))
    }
  })

  // Connection handler
  io.on("connection", (socket) => {
    const authSocket = socket as AuthenticatedSocket
    console.log(`Socket connected: ${authSocket.id} (user: ${authSocket.data.userId})`)

    // Send connection confirmation
    authSocket.emit("connected", { userId: authSocket.data.userId })

    // Join user's personal room for direct notifications
    authSocket.join(`user:${authSocket.data.userId}`)

    // Event room handlers
    authSocket.on("join:event", (eventId) => {
      const room = `event:${eventId}`
      authSocket.join(room)
      console.log(`User ${authSocket.data.userId} joined ${room}`)
    })

    authSocket.on("leave:event", (eventId) => {
      const room = `event:${eventId}`
      authSocket.leave(room)
      console.log(`User ${authSocket.data.userId} left ${room}`)
    })

    // Chat room handlers
    authSocket.on("join:chat", (chatGroupId) => {
      const room = `chat:${chatGroupId}`
      authSocket.join(room)
      console.log(`User ${authSocket.data.userId} joined ${room}`)
    })

    authSocket.on("leave:chat", (chatGroupId) => {
      const room = `chat:${chatGroupId}`
      authSocket.leave(room)
      console.log(`User ${authSocket.data.userId} left ${room}`)
    })

    // Typing indicators (use anonymous names)
    authSocket.on("chat:startTyping", async (chatGroupId) => {
      const membership = await db.chat_group_members.findUnique({
        where: {
          chat_group_id_user_id: {
            chat_group_id: chatGroupId,
            user_id: authSocket.data.userId,
          },
        },
        select: { anonymous_name: true },
      })
      authSocket.to(`chat:${chatGroupId}`).emit("chat:typing", {
        chatGroupId,
        userId: authSocket.data.userId,
        userName: membership?.anonymous_name || "Someone",
        isTyping: true,
      })
    })

    authSocket.on("chat:stopTyping", async (chatGroupId) => {
      const membership = await db.chat_group_members.findUnique({
        where: {
          chat_group_id_user_id: {
            chat_group_id: chatGroupId,
            user_id: authSocket.data.userId,
          },
        },
        select: { anonymous_name: true },
      })
      authSocket.to(`chat:${chatGroupId}`).emit("chat:typing", {
        chatGroupId,
        userId: authSocket.data.userId,
        userName: membership?.anonymous_name || "Someone",
        isTyping: false,
      })
    })

    // Private conversation room handlers
    authSocket.on("join:conversation", (conversationId) => {
      const room = `conversation:${conversationId}`
      authSocket.join(room)
      console.log(`User ${authSocket.data.userId} joined ${room}`)
    })

    authSocket.on("leave:conversation", (conversationId) => {
      const room = `conversation:${conversationId}`
      authSocket.leave(room)
      console.log(`User ${authSocket.data.userId} left ${room}`)
    })

    // Private messaging typing indicators
    authSocket.on("private:startTyping", (conversationId) => {
      authSocket.to(`conversation:${conversationId}`).emit("private:typing", {
        conversationId,
        userId: authSocket.data.userId,
        userName: authSocket.data.email.split("@")[0],
        isTyping: true,
      })
    })

    authSocket.on("private:stopTyping", (conversationId) => {
      authSocket.to(`conversation:${conversationId}`).emit("private:typing", {
        conversationId,
        userId: authSocket.data.userId,
        userName: authSocket.data.email.split("@")[0],
        isTyping: false,
      })
    })

    authSocket.on("private:markRead", (conversationId, messageIds) => {
      authSocket.to(`conversation:${conversationId}`).emit("private:read", {
        conversationId,
        messageIds,
        readBy: authSocket.data.userId,
      })
    })

    // Ping handler for connection health
    authSocket.on("ping", () => {
      // Socket.io handles pong automatically
    })

    // Disconnect handler
    authSocket.on("disconnect", (reason) => {
      console.log(`Socket disconnected: ${authSocket.id} (user: ${authSocket.data.userId}), reason: ${reason}`)
    })

    // Error handler
    authSocket.on("error", (error) => {
      console.error(`Socket error for ${authSocket.id}:`, error)
    })
  })

  // Load and start all active sponsored message timers
  void sponsoredMessageScheduler.loadAll()

  console.log("Socket.io server initialized")
  return io
}

/**
 * Get the Socket.io server instance
 */
export function getIO(): Server | null {
  return io
}

/**
 * Emit an event check-in update to all users in the event room
 */
export function emitEventCheckIn(
  eventId: string,
  userId: string,
  userName: string,
  userImage?: string
): void {
  if (!io) return

  io.to(`event:${eventId}`).emit("event:checkin", {
    eventId,
    userId,
    userName,
    userImage,
    checkInTime: new Date().toISOString(),
  })
}

/**
 * Emit an event checkout update
 */
export function emitEventCheckOut(eventId: string, userId: string): void {
  if (!io) return

  io.to(`event:${eventId}`).emit("event:checkout", {
    eventId,
    userId,
    checkOutTime: new Date().toISOString(),
  })
}

/**
 * Emit an interest update for an event
 */
export function emitEventInterestUpdate(
  eventId: string,
  userId: string,
  interested: boolean,
  interestCount: number
): void {
  if (!io) return

  io.to(`event:${eventId}`).emit("event:interestUpdate", {
    eventId,
    userId,
    interested,
    interestCount,
  })
}

/**
 * Emit a new chat message
 */
export function emitChatMessage(
  chatGroupId: string,
  message: {
    id: string
    content: string
    type: string
    userId: string
    userName: string
    userImage?: string
    createdAt: string
    parentId?: string
  }
): void {
  if (!io) return

  io.to(`chat:${chatGroupId}`).emit("chat:message", {
    chatGroupId,
    message,
  })
}

/**
 * Emit a message reaction update
 */
export function emitChatReaction(
  chatGroupId: string,
  messageId: string,
  userId: string,
  emoji: string,
  action: "add" | "remove"
): void {
  if (!io) return

  io.to(`chat:${chatGroupId}`).emit("chat:reaction", {
    chatGroupId,
    messageId,
    userId,
    emoji,
    action,
  })
}

/**
 * Emit a message deletion to the chat room
 */
export function emitChatMessageDeleted(chatGroupId: string, messageId: string): void {
  if (!io) return
  io.to(`chat:${chatGroupId}`).emit("chat:messageDeleted", { chatGroupId, messageId })
}

/**
 * Emit a message hidden event (moderation auto-hide)
 */
export function emitChatMessageHidden(chatGroupId: string, messageId: string, reason: string): void {
  if (!io) return
  // Emit as "chat:messageDeleted" to match the client's expected event name
  io.to(`chat:${chatGroupId}`).emit("chat:messageDeleted", { chatGroupId, messageId, reason })
}

/**
 * Emit a member ban/unban to the chat room
 */
export function emitChatMemberBanned(chatGroupId: string, userId: string, banned: boolean): void {
  if (!io) return
  io.to(`chat:${chatGroupId}`).emit("chat:memberBanned", { chatGroupId, userId, banned })
}

/**
 * Emit a member mute/unmute to the chat room
 */
export function emitChatMemberMuted(chatGroupId: string, userId: string, muted: boolean, reason?: string): void {
  if (!io) return
  io.to(`chat:${chatGroupId}`).emit("chat:memberMuted", { chatGroupId, userId, muted, reason })
}

/**
 * Send a message to a specific user
 */
export function emitToUser(
  userId: string,
  event: keyof ServerToClientEvents,
  data: unknown
): void {
  if (!io) return

  io.to(`user:${userId}`).emit(event, data)
}

/**
 * Emit a private message to conversation participants
 */
export function emitPrivateMessage(
  conversationId: string,
  recipientId: string,
  message: {
    id: string
    conversationId: string
    senderId: string
    sender: { id: string; name: string | null; image: string | null }
    text: string | null
    mediaUrl: string | null
    mediaType: string | null
    isRead: boolean
    createdAt: Date
  }
): void {
  if (!io) return

  // Emit to conversation room (for active viewers)
  io.to(`conversation:${conversationId}`).emit("private:message", {
    conversationId,
    message,
  })

  // Also emit to recipient's personal room (for notification if not in conversation)
  io.to(`user:${recipientId}`).emit("private:message", {
    conversationId,
    message,
  })
}
