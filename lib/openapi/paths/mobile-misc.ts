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

// === Work fields ===

registry.registerPath({
  method: "get",
  path: "/api/mobile/work-fields",
  tags: ["Mobile Categories"],
  summary: "List the coarse fields of work",
  description:
    "The eighteen buckets `profiles.work_field` accepts, as `{ slug, label }`. Served rather " +
    "than hardcoded in the client: a hardcoded copy cannot show a bucket added after the build " +
    "shipped, and free text is the mistake `profiles.interests` made — 'Software' and 'software " +
    "engineering' never match. Identical for every caller and safe to cache for an hour.",
  security: bearerAuth,
  responses: {
    200: {
      description: "Work fields",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              workFields: z.array(z.object({ slug: z.string(), label: z.string() })),
            })
          ),
        },
      },
    },
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

/*
 * === Trust & safety, account, Apple sign-in ===
 *
 * These five endpoints shipped without spec entries — found by
 * __tests__/openapi-coverage.test.ts rather than by anyone noticing. Three of
 * them are the safety surface (report a message, report a user, list who you
 * have blocked), which is precisely the part a client developer must not have
 * to reverse-engineer from the source.
 */

registry.registerPath({
  method: "post",
  path: "/api/mobile/auth/apple",
  tags: ["Mobile Auth"],
  summary: "Sign in with Apple",
  description:
    "Exchanges an Apple identity token for Blend'n access and refresh tokens. `fullName` is only supplied by Apple on the very first authorisation, so persist it then — it is not sent again.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            identityToken: z.string().min(1),
            fullName: z
              .object({
                givenName: z.string().nullable().optional(),
                familyName: z.string().nullable().optional(),
              })
              .optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Authenticated",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              accessToken: z.string(),
              refreshToken: z.string(),
              user: z.object({
                id: z.string(),
                email: z.string(),
                name: z.string().nullable(),
              }),
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/messages/{messageId}/report",
  tags: ["Mobile Safety"],
  summary: "Report a message",
  description:
    "Reports a group or private message. `messageType` is required because the two live in different tables and the id alone is ambiguous.",
  security: bearerAuth,
  request: {
    params: z.object({ messageId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            messageType: z.enum(["group", "private"]),
            reason: z.string().min(1),
            description: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Report filed", content: { "application/json": { schema: wrap(MessageResponseSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/users/{userId}/report",
  tags: ["Mobile Safety"],
  summary: "Report a user",
  security: bearerAuth,
  request: {
    params: z.object({ userId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            reason: z.string().min(1),
            description: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Report filed", content: { "application/json": { schema: wrap(MessageResponseSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/users/blocked",
  tags: ["Mobile Safety"],
  summary: "List blocked users",
  security: bearerAuth,
  responses: {
    200: {
      description: "Blocked users",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              users: z.array(
                z.object({
                  blocked_id: z.string(),
                  blocked_user_name: z.string().nullable(),
                  blocked_user_photo: z.string().nullable(),
                  reason: z.string().nullable(),
                  blocked_at: z.string().datetime(),
                })
              ),
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "delete",
  path: "/api/mobile/account",
  tags: ["Mobile Profile"],
  summary: "Delete your own account",
  description:
    "Anonymises the account rather than hard-deleting the row. Events, chat messages and check-ins cascade from User, so a real delete would destroy other people's event history and conversations along with yours.",
  security: bearerAuth,
  responses: {
    200: { description: "Account deleted", content: { "application/json": { schema: wrap(MessageResponseSchema) } } },
    ...standardErrors,
  },
})
