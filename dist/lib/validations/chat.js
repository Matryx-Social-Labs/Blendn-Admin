"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatQuerySchema = exports.sendMessageSchema = void 0;
const zod_1 = require("zod");
exports.sendMessageSchema = zod_1.z.object({
    content: zod_1.z.string().min(1, "Message cannot be empty").max(2000, "Message is too long"),
    type: zod_1.z.enum(["text", "image", "video"]).default("text"),
    parentId: zod_1.z.string().uuid().optional(), // For replies
    metadata: zod_1.z.record(zod_1.z.unknown()).optional(),
});
exports.chatQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(50),
    before: zod_1.z.string().datetime().optional(), // Get messages before this timestamp
    after: zod_1.z.string().datetime().optional(), // Get messages after this timestamp
});
