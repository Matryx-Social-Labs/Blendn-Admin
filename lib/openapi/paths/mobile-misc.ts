import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { standardErrors } from "@/lib/openapi/schemas/common"
import {
  UserPublicProfileSchema,
  UserFavoritesResponseSchema,
  MessageRequestCreateSchema,
  MessageRequestRespondSchema,
  MessageRequestSchema,
  MessageRequestListResponseSchema,
  MessageRequestRespondResponseSchema,
  PresignedUrlRequestSchema,
  PresignedUrlResponseSchema,
  DeleteUploadRequestSchema,
  NotificationTokenRequestSchema,
  CategorySchema,
  ActiveCheckinSchema,
} from "@/lib/openapi/schemas/profile"
import { MessageResponseSchema } from "@/lib/openapi/schemas/auth"

const bearerAuth = [{ BearerAuth: [] }]
const wrap = (schema: z.ZodTypeAny) => z.object({ success: z.literal(true), data: schema })

// === Categories ===

registry.registerPath({
  method: "get",
  path: "/api/mobile/categories",
  tags: ["Mobile Categories"],
  summary: "List all categories",
  description: "Returns hierarchical category tree with event and interest counts.",
  security: bearerAuth,
  responses: {
    200: { description: "Categories", content: { "application/json": { schema: wrap(z.array(CategorySchema)) } } },
    ...standardErrors,
  },
})

// === Users ===

registry.registerPath({
  method: "get",
  path: "/api/mobile/users/{userId}",
  tags: ["Mobile Users"],
  summary: "Get user public profile",
  security: bearerAuth,
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: {
    200: { description: "User profile", content: { "application/json": { schema: wrap(UserPublicProfileSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/users/{userId}/favorites",
  tags: ["Mobile Users"],
  summary: "Get user's favorite events",
  security: bearerAuth,
  request: {
    params: z.object({ userId: z.string().uuid() }),
    query: z.object({
      page: z.number().optional(),
      limit: z.number().optional(),
      timeFilter: z.enum(["upcoming", "past"]).optional(),
      lat: z.number().optional(),
      lon: z.number().optional(),
    }),
  },
  responses: {
    200: { description: "Favorites", content: { "application/json": { schema: wrap(UserFavoritesResponseSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/users/{userId}/block",
  tags: ["Mobile Users"],
  summary: "Block user",
  security: bearerAuth,
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: {
    200: { description: "Blocked", content: { "application/json": { schema: wrap(z.object({ blocked: z.literal(true) })) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "delete",
  path: "/api/mobile/users/{userId}/block",
  tags: ["Mobile Users"],
  summary: "Unblock user",
  security: bearerAuth,
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: {
    200: { description: "Unblocked", content: { "application/json": { schema: wrap(z.object({ blocked: z.literal(false) })) } } },
    ...standardErrors,
  },
})

// === Message Requests ===

registry.registerPath({
  method: "post",
  path: "/api/mobile/message-requests",
  tags: ["Mobile Message Requests"],
  summary: "Send message request",
  security: bearerAuth,
  request: {
    body: { content: { "application/json": { schema: MessageRequestCreateSchema } } },
  },
  responses: {
    201: { description: "Request sent", content: { "application/json": { schema: wrap(z.object({ request: MessageRequestSchema })) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/message-requests",
  tags: ["Mobile Message Requests"],
  summary: "List received message requests",
  security: bearerAuth,
  request: {
    query: z.object({
      status: z.enum(["pending", "accepted", "declined", "blocked"]).optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    }),
  },
  responses: {
    200: { description: "Requests", content: { "application/json": { schema: wrap(MessageRequestListResponseSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/message-requests/{requestId}/respond",
  tags: ["Mobile Message Requests"],
  summary: "Respond to message request",
  security: bearerAuth,
  request: {
    params: z.object({ requestId: z.string().uuid() }),
    body: { content: { "application/json": { schema: MessageRequestRespondSchema } } },
  },
  responses: {
    200: { description: "Response recorded", content: { "application/json": { schema: wrap(MessageRequestRespondResponseSchema) } } },
    ...standardErrors,
  },
})

// === Uploads ===

registry.registerPath({
  method: "post",
  path: "/api/mobile/uploads/presigned-url",
  tags: ["Mobile Uploads"],
  summary: "Get presigned upload URL",
  description: "Returns a presigned URL for direct file upload to S3/Tigris. URL expires in 15 minutes.",
  security: bearerAuth,
  request: {
    body: { content: { "application/json": { schema: PresignedUrlRequestSchema } } },
  },
  responses: {
    200: { description: "Presigned URL", content: { "application/json": { schema: wrap(PresignedUrlResponseSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "delete",
  path: "/api/mobile/uploads/delete",
  tags: ["Mobile Uploads"],
  summary: "Delete uploaded file",
  security: bearerAuth,
  request: {
    body: { content: { "application/json": { schema: DeleteUploadRequestSchema } } },
  },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: wrap(z.object({ deleted: z.literal(true) })) } } },
    ...standardErrors,
  },
})

// === Notifications ===

registry.registerPath({
  method: "post",
  path: "/api/mobile/notifications/token",
  tags: ["Mobile Notifications"],
  summary: "Register push notification token",
  security: bearerAuth,
  request: {
    body: { content: { "application/json": { schema: NotificationTokenRequestSchema } } },
  },
  responses: {
    200: { description: "Token registered", content: { "application/json": { schema: wrap(MessageResponseSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "delete",
  path: "/api/mobile/notifications/token",
  tags: ["Mobile Notifications"],
  summary: "Unregister push notification token",
  security: bearerAuth,
  request: {
    query: z.object({ token: z.string() }),
  },
  responses: {
    200: { description: "Token removed", content: { "application/json": { schema: wrap(MessageResponseSchema) } } },
    ...standardErrors,
  },
})

// === Active Checkins ===

registry.registerPath({
  method: "get",
  path: "/api/mobile/checkins/active",
  tags: ["Mobile Checkins"],
  summary: "Get active check-ins",
  description: "Returns all events the user is currently checked into.",
  security: bearerAuth,
  responses: {
    200: { description: "Active check-ins", content: { "application/json": { schema: wrap(z.object({ checkIns: z.array(ActiveCheckinSchema) })) } } },
    ...standardErrors,
  },
})
