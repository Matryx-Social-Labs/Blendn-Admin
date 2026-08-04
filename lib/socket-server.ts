import { Server as HttpServer } from "http"
import { Server, Socket } from "socket.io"
import { verifyAccessToken } from "./mobile-auth"
import { db } from "./db"
import { canJoinChat, canJoinConversation, canJoinEvent } from "./socket-auth"
import { logger } from "./logger"

// Socket.io server instance
let io: Server | null = null

// Kept in sync with ALLOWED_ORIGINS in middleware.ts
const ALLOWED_ORIGINS = [
  "https://api.blendn.app",
  "https://blendn.app",
  process.env.NEXTAUTH_URL,
].filter(Boolean) as string[]

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
  "chat:messageDeleted": (data: { chatGroupId: string; messageId: string; moderation?: boolean; userId?: string }) => void
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
 * Join `room` only if `check` authorizes it, otherwise tell the client.
 *
 * Fails closed: a throwing check (malformed UUID from a hostile client, DB
 * blip) denies the join rather than leaking the room.
 */
export async function guardJoin(
  socket: AuthenticatedSocket,
  room: string,
  denyMessage: string,
  check: () => Promise<boolean>
): Promise<void> {
  try {
    if (await check()) {
      socket.join(room)
      logger.debug("Socket joined room", { room, userId: socket.data.userId })
      return
    }
  } catch (error) {
    // Room IDs are `@db.Uuid`, so a malformed one from a hostile client makes
    // Prisma throw. Socket.io does not await listeners, so an escaping rejection
    // would take down the process — deny instead.
    logger.warn("Socket join authorization check failed", {
      room,
      userId: socket.data.userId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  socket.emit("error", { message: denyMessage, code: "FORBIDDEN" })
}

/**
 * Broadcast a typing indicator to a chat room, under the sender's anonymous name.
 *
 * No-ops for muted or banned members. The join guard can't cover this on its
 * own: a member banned *after* joining stays in the room until they disconnect.
 */
export async function emitChatTyping(
  socket: AuthenticatedSocket,
  chatGroupId: string,
  isTyping: boolean
): Promise<void> {
  try {
    const membership = await db.chat_group_members.findUnique({
      where: {
        chat_group_id_user_id: {
          chat_group_id: chatGroupId,
          user_id: socket.data.userId,
        },
      },
      select: { anonymous_name: true, status: true },
    })

    if (!membership || membership.status !== "active") return

    socket.to(`chat:${chatGroupId}`).emit("chat:typing", {
      chatGroupId,
      userId: socket.data.userId,
      userName: membership.anonymous_name || "Someone",
      isTyping,
    })
  } catch (error) {
    // Same fail-safe as guardJoin: chat_group_id is `@db.Uuid`, and an
    // escaping rejection from this listener would take down the process.
    logger.warn("Typing indicator lookup failed", {
      chatGroupId,
      userId: socket.data.userId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Broadcast a typing indicator into a private conversation.
 *
 * `socket.to(room)` broadcasts to a room the sender does not have to be in, so
 * joining is not enough of a gate here — without this participant check any
 * authenticated user who guessed a conversation id could spoof typing state
 * into someone else's DM.
 */
export async function emitPrivateTyping(
  socket: AuthenticatedSocket,
  conversationId: string,
  isTyping: boolean
): Promise<void> {
  try {
    if (!(await canJoinConversation(socket.data.userId, conversationId))) return

    const profile = await db.profiles.findUnique({
      where: { id: socket.data.userId },
      select: { name: true },
    })

    socket.to(`conversation:${conversationId}`).emit("private:typing", {
      conversationId,
      userId: socket.data.userId,
      // Read the display name, never the email local part.
      userName: profile?.name || "Someone",
      isTyping,
    })
  } catch (error) {
    logger.warn("Private typing indicator failed", {
      conversationId,
      userId: socket.data.userId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Relay a read receipt into a private conversation. Same participant gate as
 * `emitPrivateTyping` — read receipts are only meaningful between the two
 * participants, and must not be forgeable by a third party.
 */
export async function emitPrivateRead(
  socket: AuthenticatedSocket,
  conversationId: string,
  messageIds: string[]
): Promise<void> {
  try {
    if (!(await canJoinConversation(socket.data.userId, conversationId))) return

    socket.to(`conversation:${conversationId}`).emit("private:read", {
      conversationId,
      messageIds,
      readBy: socket.data.userId,
    })
  } catch (error) {
    logger.warn("Private read receipt failed", {
      conversationId,
      userId: socket.data.userId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Initialize Socket.io server
 */
export function initSocketServer(httpServer: HttpServer): Server {
  io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: {
      // Native mobile clients (Expo/React Native WebSocket) don't send an Origin
      // header, so `origin` is undefined for them and always allowed. Browser
      // clients (e.g. the admin dashboard) are restricted to the same allow-list
      // middleware.ts uses for HTTP CORS.
      origin: (origin, callback) => {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
          callback(null, true)
        } else {
          callback(new Error("Not allowed by CORS"))
        }
      },
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
    authSocket.on("join:event", async (eventId) => {
      await guardJoin(
        authSocket,
        `event:${eventId}`,
        "Not authorized to join this event",
        () => canJoinEvent(authSocket.data.userId, eventId)
      )
    })

    authSocket.on("leave:event", (eventId) => {
      const room = `event:${eventId}`
      authSocket.leave(room)
      console.log(`User ${authSocket.data.userId} left ${room}`)
    })

    // Chat room handlers
    authSocket.on("join:chat", async (chatGroupId) => {
      await guardJoin(
        authSocket,
        `chat:${chatGroupId}`,
        "Not authorized to join this chat",
        () => canJoinChat(authSocket.data.userId, chatGroupId)
      )
    })

    authSocket.on("leave:chat", (chatGroupId) => {
      const room = `chat:${chatGroupId}`
      authSocket.leave(room)
      console.log(`User ${authSocket.data.userId} left ${room}`)
    })

    // Typing indicators (use anonymous names)
    authSocket.on("chat:startTyping", (chatGroupId) =>
      void emitChatTyping(authSocket, chatGroupId, true)
    )
    authSocket.on("chat:stopTyping", (chatGroupId) =>
      void emitChatTyping(authSocket, chatGroupId, false)
    )

    // Private conversation room handlers
    authSocket.on("join:conversation", async (conversationId) => {
      await guardJoin(
        authSocket,
        `conversation:${conversationId}`,
        "Not authorized to join this conversation",
        () => canJoinConversation(authSocket.data.userId, conversationId)
      )
    })

    authSocket.on("leave:conversation", (conversationId) => {
      const room = `conversation:${conversationId}`
      authSocket.leave(room)
      console.log(`User ${authSocket.data.userId} left ${room}`)
    })

    // Private messaging typing indicators
    authSocket.on("private:startTyping", (conversationId) =>
      void emitPrivateTyping(authSocket, conversationId, true)
    )

    authSocket.on("private:stopTyping", (conversationId) =>
      void emitPrivateTyping(authSocket, conversationId, false)
    )

    authSocket.on("private:markRead", (conversationId, messageIds) =>
      void emitPrivateRead(authSocket, conversationId, messageIds)
    )

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
 * Emit a message hidden event (moderation auto-hide).
 * Includes userId and moderation flag so the client can show a
 * "message removed" placeholder to the sender instead of just deleting it.
 */
export function emitChatMessageHidden(chatGroupId: string, messageId: string, userId: string): void {
  if (!io) return
  io.to(`chat:${chatGroupId}`).emit("chat:messageDeleted", {
    chatGroupId,
    messageId,
    moderation: true,
    userId,
  })
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
