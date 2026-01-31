import { Server as HttpServer } from "http"
import { Server, Socket } from "socket.io"
import { verifyAccessToken } from "./mobile-auth"

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

    // Typing indicators
    authSocket.on("chat:startTyping", (chatGroupId) => {
      authSocket.to(`chat:${chatGroupId}`).emit("chat:typing", {
        chatGroupId,
        userId: authSocket.data.userId,
        userName: authSocket.data.email.split("@")[0], // Simplified, would get from DB in production
        isTyping: true,
      })
    })

    authSocket.on("chat:stopTyping", (chatGroupId) => {
      authSocket.to(`chat:${chatGroupId}`).emit("chat:typing", {
        chatGroupId,
        userId: authSocket.data.userId,
        userName: authSocket.data.email.split("@")[0],
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
 * Send a message to a specific user
 */
export function emitToUser(
  userId: string,
  event: keyof ServerToClientEvents,
  data: any
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
