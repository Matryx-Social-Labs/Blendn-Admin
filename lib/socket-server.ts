import { logger } from "./logger"
import { Server as HttpServer } from "http"
import { Server, Socket } from "socket.io"
import { verifyAccessToken, accountBlockReason } from "./mobile-auth"
import { db } from "./db"
import { CHAT_WINDOW_HOURS, chatWindowState } from "./chat-window"
import { displayNameInConversation } from "./conversation-identity"
import { canJoinChat, canJoinConversation, canJoinEvent } from "./socket-auth"
import { authenticateDashboardSocket, canJoinEventOps } from "./socket-ops-auth"
import { buildLiveSnapshot } from "./live-snapshot"
import { startChatLifecycleSweeper } from "./chat-lifecycle"
import { startPresenceSweeper } from "./presence-sweeper"
import { startSentimentSweeper } from "./sentiment-sweeper"
import type { LiveSnapshot } from "./live-metrics"
import type { user_role } from "@prisma/client"

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

  /** Live operations aggregate. Dashboard-only; carries no attendee rows. */
  "ops:snapshot": (data: LiveSnapshot) => void
}

export interface ClientToServerEvents {
  // Join/leave rooms
  "join:event": (eventId: string) => void
  "leave:event": (eventId: string) => void
  /** Dashboard-only live operations room. */
  "join:eventOps": (eventId: string) => void
  "leave:eventOps": (eventId: string) => void
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
  /**
   * Which scheme authenticated this socket. Dashboard sockets are the only
   * ones allowed into `:ops` rooms, and attendee sockets must never be —
   * the two carry completely different payloads.
   */
  principal: "mobile" | "dashboard"
  /** Present only for dashboard principals. */
  role?: user_role
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
      /*
       * The room has to still be open. This was the THIRD write path into
       * `chat_messages` that did not consult `chatWindowState`, and the only
       * one with no human behind it: a `setInterval` armed once, never checked
       * `chat_groups.status` or `events.end_time`, and `loadAll()` re-armed
       * every `is_active` row on every boot with no end-time filter.
       *
       * So an archived room that no human could post to still received a
       * sponsored message every `interval_minutes`, forever, re-armed by each
       * deploy — 96 a day at the 15-minute setting.
       *
       * Stop the timer rather than just skipping the send: a closed room never
       * reopens, so there is nothing left for this timer to do.
       */
      const group = await db.chat_groups.findUnique({
        where: { id: msg.chat_group_id },
        select: {
          status: true,
          event: { select: { start_time: true, end_time: true } },
        },
      })

      if (!group?.event) {
        this.stop(msg.id)
        return
      }

      const window = chatWindowState(group.event, group)
      if (!window.open) {
        logger.info("Stopping sponsored message: room closed", {
          messageId: msg.id,
          chatGroupId: msg.chat_group_id,
          reason: window.reason,
        })
        this.stop(msg.id)
        await db.event_sponsored_messages.update({
          where: { id: msg.id },
          data: { is_active: false },
        })
        return
      }

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
      logger.error("Failed to send sponsored message", { messageId: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Start periodic sending for a message */
  start(msg: SponsoredMessageRecord): void {
    this.stop(msg.id) // clear any existing timer
    const ms = msg.interval_minutes * 60 * 1000
    const timer = setInterval(() => void this.send(msg), ms)
    this.timers.set(msg.id, timer)
    logger.info("Started sponsored message schedule", { messageId: msg.id, intervalMinutes: msg.interval_minutes })
  }

  /** Stop a specific timer */
  stop(messageId: string): void {
    const timer = this.timers.get(messageId)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(messageId)
      logger.info("Stopped sponsored message schedule", { messageId })
    }
  }

  /** Clear every timer. Called from the server's shutdown handler. */
  stopAll(): void {
    const count = this.timers.size
    for (const timer of this.timers.values()) {
      clearInterval(timer)
    }
    this.timers.clear()
    if (count > 0) {
      logger.info("Stopped all sponsored message schedules", { count })
    }
  }

  /** Load all active sponsored messages from DB and start their timers */
  async loadAll(): Promise<void> {
    try {
      /*
       * Only events whose room could still be open.
       *
       * Without the end-time bound this re-armed a timer on every boot for
       * every `is_active` row ever created, including events that finished
       * months ago — so a deploy resurrected campaigns into archived rooms.
       * `send()` now stops those on their first tick, but not arming them at
       * all is cheaper and means a deploy does not briefly recreate the bug.
       */
      const windowOpensAfter = new Date(Date.now() - CHAT_WINDOW_HOURS * 60 * 60 * 1000)
      const messages = await db.event_sponsored_messages.findMany({
        where: {
          is_active: true,
          event: { end_time: { gte: windowOpensAfter } },
        },
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
      logger.info("Loaded active sponsored messages", { count: messages.length })
    } catch (err) {
      logger.error("[Scheduler] Failed to load sponsored messages", { error: err instanceof Error ? err.message : String(err) })
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
/*
 * Per-event snapshot broadcasting.
 *
 * A timer runs only while someone is watching that event, and stops itself
 * when the last watcher leaves. The alternative — one global tick over every
 * live event — burns queries for rooms nobody has open, which at 5-second
 * granularity is most of them most of the time.
 */
const opsTimers = new Map<string, NodeJS.Timeout>()
const OPS_INTERVAL_MS = 5000

export function startOpsBroadcast(eventId: string): void {
  if (!io || opsTimers.has(eventId)) return

  const timer = setInterval(() => {
    void (async () => {
      const room = `event:${eventId}:ops`
      const watchers = io ? await io.in(room).fetchSockets() : []
      if (watchers.length === 0) {
        stopOpsBroadcast(eventId)
        return
      }
      try {
        const snapshot = await buildLiveSnapshot(eventId)
        if (snapshot) io?.to(room).emit("ops:snapshot", snapshot)
      } catch (error) {
        // A failed snapshot must not kill the timer or the process — the next
        // tick may well succeed, and a dead timer is a silently frozen screen.
        logger.warn("Live snapshot failed", {
          eventId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  }, OPS_INTERVAL_MS)

  opsTimers.set(eventId, timer)
}

export function stopOpsBroadcast(eventId: string): void {
  const timer = opsTimers.get(eventId)
  if (timer) {
    clearInterval(timer)
    opsTimers.delete(eventId)
  }
}

/** Used by tests and by shutdown so a process can exit cleanly. */
export function stopAllOpsBroadcasts(): void {
  for (const eventId of Array.from(opsTimers.keys())) stopOpsBroadcast(eventId)
}

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

    /*
     * Resolved through the conversation, not read straight off the profile.
     *
     * This emitted `profiles.name` unconditionally, to the other participant,
     * on every keystroke -- so a DM that shows a pseudonym everywhere else
     * would announce the real name the moment somebody started typing. The
     * pseudonym would have survived until the first character.
     *
     * `displayNameInConversation` returns the real name for conversations that
     * were never pseudonymous (accepted message requests) and for anyone who
     * has revealed, so nothing visible changes for existing conversations.
     */
    const [conversation, profile] = await Promise.all([
      db.private_conversations.findUnique({
        where: { id: conversationId },
        select: {
          user1_id: true,
          user2_id: true,
          user1_pseudonym: true,
          user2_pseudonym: true,
          user1_revealed: true,
          user2_revealed: true,
        },
      }),
      db.profiles.findUnique({
        where: { id: socket.data.userId },
        select: { name: true },
      }),
    ])
    if (!conversation) return

    socket.to(`conversation:${conversationId}`).emit("private:typing", {
      conversationId,
      userId: socket.data.userId,
      userName: displayNameInConversation(conversation, socket.data.userId, profile?.name),
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

  /*
   * Cross-replica message delivery.
   *
   * Without an adapter every replica keeps its own room membership, so a
   * message emitted on replica A never reaches a client connected to replica
   * B — chat silently half-works rather than failing loudly. That has not
   * bitten because railway.json sets no replica count and the app runs as one
   * instance; dashboard sockets are long-lived and bring that ceiling closer.
   *
   * Opt-in on REDIS_URL. With no Redis provisioned this is a no-op and the
   * default in-memory adapter stands, which is correct for one replica.
   * **Do not raise the replica count until REDIS_URL is set** — that is the
   * moment this stops being precautionary.
   */
  const redisUrl = process.env.REDIS_URL
  if (redisUrl) {
    void (async () => {
      try {
        const { createClient } = await import("redis")
        const { createAdapter } = await import("@socket.io/redis-adapter")
        const pubClient = createClient({ url: redisUrl })
        const subClient = pubClient.duplicate()
        await Promise.all([pubClient.connect(), subClient.connect()])
        io?.adapter(createAdapter(pubClient, subClient))
        logger.info("Socket.io Redis adapter attached")
      } catch (error) {
        // Falling back to in-memory is correct at one replica and wrong at
        // several, so this is an error rather than a warning even though the
        // process keeps serving.
        logger.error("Socket.io Redis adapter failed to attach", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  }

  /*
   * Authentication middleware — two schemes, mobile first.
   *
   * The mobile path is byte-for-byte what it was: every phone in the field
   * depends on this handshake, so a dashboard client must not be able to
   * change how a mobile token is judged. Only when there is no mobile token,
   * or it fails, does the dashboard cookie get a look.
   */
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace("Bearer ", "")

      if (token) {
        const decoded = verifyAccessToken(token)
        if (!decoded) {
          return next(new Error("Invalid or expired token"))
        }

        /*
         * A valid token is not enough: it has to still belong to a live
         * account.
         *
         * Suspending revokes refresh tokens, but an access token already in a
         * pocket stays valid for its full fifteen minutes -- and a socket
         * opened with it outlives the token entirely, because nothing
         * re-checks after the handshake. So a suspended person could hold a
         * live realtime connection well past the moment they were stopped.
         *
         * `authenticateDashboardSocket` has re-read this per connection since
         * it shipped; the attendee path was the one left on the claim alone.
         * One primary-key lookup per connection, which is what the dashboard
         * path has been paying all along.
         */
        const account = await db.user.findUnique({
          where: { id: decoded.userId },
          select: { deletedAt: true, suspended_at: true },
        })
        if (accountBlockReason(account)) {
          return next(new Error("Authentication required"))
        }

        // Attach user data to socket
        socket.data.userId = decoded.userId
        socket.data.email = decoded.email
        socket.data.principal = "mobile"

        return next()
      }

      const dashboard = await authenticateDashboardSocket(socket.handshake.headers.cookie)
      if (!dashboard) {
        return next(new Error("Authentication required"))
      }

      socket.data.userId = dashboard.userId
      socket.data.email = dashboard.email
      socket.data.role = dashboard.role
      socket.data.principal = "dashboard"

      next()
    } catch (error) {
      logger.error("Socket auth error", { error: error instanceof Error ? error.message : String(error) })
      next(new Error("Authentication failed"))
    }
  })

  // Connection handler
  io.on("connection", (socket) => {
    const authSocket = socket as AuthenticatedSocket
    logger.debug("Socket connected", { socketId: authSocket.id, userId: authSocket.data.userId })

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
      logger.debug("Socket left room", { room, userId: authSocket.data.userId })
    })

    /*
     * Live operations room. Deliberately separate from `event:{id}` — that room
     * carries attendee-facing traffic including check-in names, and a host must
     * not receive it. This one carries aggregates only.
     */
    authSocket.on("join:eventOps", async (eventId) => {
      if (authSocket.data.principal !== "dashboard" || !authSocket.data.role) {
        // An attendee token must never reach ops aggregates, even if the user
        // behind it also happens to hold a dashboard role.
        authSocket.emit("error", { message: "Not authorized", code: "OPS_FORBIDDEN" })
        return
      }
      const principal = {
        userId: authSocket.data.userId,
        email: authSocket.data.email,
        role: authSocket.data.role,
      }
      await guardJoin(
        authSocket,
        `event:${eventId}:ops`,
        "Not authorized to watch this event",
        () => canJoinEventOps(principal, eventId)
      )
      // Send one snapshot immediately so the screen is populated on open
      // rather than blank until the first tick.
      if (authSocket.rooms.has(`event:${eventId}:ops`)) {
        const snapshot = await buildLiveSnapshot(eventId).catch(() => null)
        if (snapshot) authSocket.emit("ops:snapshot", snapshot)
        startOpsBroadcast(eventId)
      }
    })

    authSocket.on("leave:eventOps", (eventId) => {
      authSocket.leave(`event:${eventId}:ops`)
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
      logger.debug("Socket left room", { room, userId: authSocket.data.userId })
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
      logger.debug("Socket left room", { room, userId: authSocket.data.userId })
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
      logger.debug("Socket disconnected", { socketId: authSocket.id, userId: authSocket.data.userId, reason })
    })

    // Error handler
    authSocket.on("error", (error) => {
      logger.error("Socket error", { socketId: authSocket.id, error: error instanceof Error ? error.message : String(error) })
    })
  })

  // Load and start all active sponsored message timers
  void sponsoredMessageScheduler.loadAll()

  // Chat rooms close themselves. No external cron to configure — and the
  // immediate pass on boot is the important one, since deploys restart this
  // process often enough that boot is when any backlog gets cleared.
  startChatLifecycleSweeper()
  // Same place, same reason: one entry point that starts every background loop.
  startPresenceSweeper()
  // Classifies chatroom messages into event_feedback, which is what the live
  // screen's mood and category panels have always read and never had.
  startSentimentSweeper()

  logger.info("Socket.io server initialized")
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
 * Evict everyone from a conversation room, because it has ended.
 *
 * `canJoinConversation` refuses closed conversations, but that gates *new*
 * joins only. Anyone already subscribed to `conversation:${id}` keeps their
 * socket in that room until they disconnect, so without this they would go on
 * receiving typing indicators and read receipts from a conversation the other
 * person has left — the exact live channel that leaving is meant to sever.
 *
 * `socketsLeave` is the server-side counterpart to `socket.leave()` and applies
 * across the Redis adapter, so it reaches sockets held by other instances too.
 */
export function closeConversationRoom(conversationId: string): void {
  if (!io) return
  io.in(`conversation:${conversationId}`).socketsLeave(`conversation:${conversationId}`)
}

/**
 * Emit a new chat message to the room, minus anyone who should not receive it.
 *
 * `blocked_users` was consulted **nowhere** in group chat: not when listing
 * history, not here, and not when sending push. So blocking someone removed
 * your ability to DM them and nothing else — walk into their event room and
 * their messages arrived over the socket and lit up your lock screen. In a
 * pseudonymous room you could not even tell which "Cosmic Panda" they were.
 *
 * **Filtered here rather than on the client**, which was the other option and is
 * the wrong one. The block list is on the device, so the client *could* drop the
 * message — but then the platform has still delivered it, and any client bug
 * re-exposes it. A block is a safety promise, not a mute, and the same rule the
 * photo work follows applies: never send what the viewer has not earned.
 *
 * `except()` takes room names, and every socket joins `user:${userId}` on
 * connect, so this reaches sockets held by other instances through the Redis
 * adapter rather than only the one that handled the request.
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
  },
  excludeUserIds: readonly string[] = []
): void {
  if (!io) return

  const room = io.to(`chat:${chatGroupId}`)
  const scoped = excludeUserIds.length
    ? room.except(excludeUserIds.map((id) => `user:${id}`))
    : room

  scoped.emit("chat:message", {
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
