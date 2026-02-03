"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initSocketServer = initSocketServer;
exports.getIO = getIO;
exports.emitEventCheckIn = emitEventCheckIn;
exports.emitEventCheckOut = emitEventCheckOut;
exports.emitEventInterestUpdate = emitEventInterestUpdate;
exports.emitChatMessage = emitChatMessage;
exports.emitChatReaction = emitChatReaction;
exports.emitToUser = emitToUser;
exports.emitPrivateMessage = emitPrivateMessage;
const socket_io_1 = require("socket.io");
const mobile_auth_1 = require("./mobile-auth");
// Socket.io server instance
let io = null;
/**
 * Initialize Socket.io server
 */
function initSocketServer(httpServer) {
    io = new socket_io_1.Server(httpServer, {
        cors: {
            origin: "*", // In production, restrict this to your mobile app domain
            methods: ["GET", "POST"],
        },
        pingTimeout: 60000,
        pingInterval: 25000,
    });
    // Authentication middleware
    io.use(async (socket, next) => {
        var _a;
        try {
            const token = socket.handshake.auth.token || ((_a = socket.handshake.headers.authorization) === null || _a === void 0 ? void 0 : _a.replace("Bearer ", ""));
            if (!token) {
                return next(new Error("Authentication required"));
            }
            const decoded = (0, mobile_auth_1.verifyAccessToken)(token);
            if (!decoded) {
                return next(new Error("Invalid or expired token"));
            }
            // Attach user data to socket
            socket.data.userId = decoded.userId;
            socket.data.email = decoded.email;
            next();
        }
        catch (error) {
            console.error("Socket auth error:", error);
            next(new Error("Authentication failed"));
        }
    });
    // Connection handler
    io.on("connection", (socket) => {
        const authSocket = socket;
        console.log(`Socket connected: ${authSocket.id} (user: ${authSocket.data.userId})`);
        // Send connection confirmation
        authSocket.emit("connected", { userId: authSocket.data.userId });
        // Join user's personal room for direct notifications
        authSocket.join(`user:${authSocket.data.userId}`);
        // Event room handlers
        authSocket.on("join:event", (eventId) => {
            const room = `event:${eventId}`;
            authSocket.join(room);
            console.log(`User ${authSocket.data.userId} joined ${room}`);
        });
        authSocket.on("leave:event", (eventId) => {
            const room = `event:${eventId}`;
            authSocket.leave(room);
            console.log(`User ${authSocket.data.userId} left ${room}`);
        });
        // Chat room handlers
        authSocket.on("join:chat", (chatGroupId) => {
            const room = `chat:${chatGroupId}`;
            authSocket.join(room);
            console.log(`User ${authSocket.data.userId} joined ${room}`);
        });
        authSocket.on("leave:chat", (chatGroupId) => {
            const room = `chat:${chatGroupId}`;
            authSocket.leave(room);
            console.log(`User ${authSocket.data.userId} left ${room}`);
        });
        // Typing indicators
        authSocket.on("chat:startTyping", (chatGroupId) => {
            authSocket.to(`chat:${chatGroupId}`).emit("chat:typing", {
                chatGroupId,
                userId: authSocket.data.userId,
                userName: authSocket.data.email.split("@")[0], // Simplified, would get from DB in production
                isTyping: true,
            });
        });
        authSocket.on("chat:stopTyping", (chatGroupId) => {
            authSocket.to(`chat:${chatGroupId}`).emit("chat:typing", {
                chatGroupId,
                userId: authSocket.data.userId,
                userName: authSocket.data.email.split("@")[0],
                isTyping: false,
            });
        });
        // Private conversation room handlers
        authSocket.on("join:conversation", (conversationId) => {
            const room = `conversation:${conversationId}`;
            authSocket.join(room);
            console.log(`User ${authSocket.data.userId} joined ${room}`);
        });
        authSocket.on("leave:conversation", (conversationId) => {
            const room = `conversation:${conversationId}`;
            authSocket.leave(room);
            console.log(`User ${authSocket.data.userId} left ${room}`);
        });
        // Private messaging typing indicators
        authSocket.on("private:startTyping", (conversationId) => {
            authSocket.to(`conversation:${conversationId}`).emit("private:typing", {
                conversationId,
                userId: authSocket.data.userId,
                userName: authSocket.data.email.split("@")[0],
                isTyping: true,
            });
        });
        authSocket.on("private:stopTyping", (conversationId) => {
            authSocket.to(`conversation:${conversationId}`).emit("private:typing", {
                conversationId,
                userId: authSocket.data.userId,
                userName: authSocket.data.email.split("@")[0],
                isTyping: false,
            });
        });
        authSocket.on("private:markRead", (conversationId, messageIds) => {
            authSocket.to(`conversation:${conversationId}`).emit("private:read", {
                conversationId,
                messageIds,
                readBy: authSocket.data.userId,
            });
        });
        // Ping handler for connection health
        authSocket.on("ping", () => {
            // Socket.io handles pong automatically
        });
        // Disconnect handler
        authSocket.on("disconnect", (reason) => {
            console.log(`Socket disconnected: ${authSocket.id} (user: ${authSocket.data.userId}), reason: ${reason}`);
        });
        // Error handler
        authSocket.on("error", (error) => {
            console.error(`Socket error for ${authSocket.id}:`, error);
        });
    });
    console.log("Socket.io server initialized");
    return io;
}
/**
 * Get the Socket.io server instance
 */
function getIO() {
    return io;
}
/**
 * Emit an event check-in update to all users in the event room
 */
function emitEventCheckIn(eventId, userId, userName, userImage) {
    if (!io)
        return;
    io.to(`event:${eventId}`).emit("event:checkin", {
        eventId,
        userId,
        userName,
        userImage,
        checkInTime: new Date().toISOString(),
    });
}
/**
 * Emit an event checkout update
 */
function emitEventCheckOut(eventId, userId) {
    if (!io)
        return;
    io.to(`event:${eventId}`).emit("event:checkout", {
        eventId,
        userId,
        checkOutTime: new Date().toISOString(),
    });
}
/**
 * Emit an interest update for an event
 */
function emitEventInterestUpdate(eventId, userId, interested, interestCount) {
    if (!io)
        return;
    io.to(`event:${eventId}`).emit("event:interestUpdate", {
        eventId,
        userId,
        interested,
        interestCount,
    });
}
/**
 * Emit a new chat message
 */
function emitChatMessage(chatGroupId, message) {
    if (!io)
        return;
    io.to(`chat:${chatGroupId}`).emit("chat:message", {
        chatGroupId,
        message,
    });
}
/**
 * Emit a message reaction update
 */
function emitChatReaction(chatGroupId, messageId, userId, emoji, action) {
    if (!io)
        return;
    io.to(`chat:${chatGroupId}`).emit("chat:reaction", {
        chatGroupId,
        messageId,
        userId,
        emoji,
        action,
    });
}
/**
 * Send a message to a specific user
 */
function emitToUser(userId, event, data) {
    if (!io)
        return;
    io.to(`user:${userId}`).emit(event, data);
}
/**
 * Emit a private message to conversation participants
 */
function emitPrivateMessage(conversationId, recipientId, message) {
    if (!io)
        return;
    // Emit to conversation room (for active viewers)
    io.to(`conversation:${conversationId}`).emit("private:message", {
        conversationId,
        message,
    });
    // Also emit to recipient's personal room (for notification if not in conversation)
    io.to(`user:${recipientId}`).emit("private:message", {
        conversationId,
        message,
    });
}
