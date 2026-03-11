import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { standardErrors } from "@/lib/openapi/schemas/common"
import { PresignedUrlRequestSchema, PresignedUrlResponseSchema } from "@/lib/openapi/schemas/profile"

const sessionAuth = [{ SessionAuth: [] }]
const wrap = (schema: z.ZodTypeAny) => z.object({ success: z.literal(true), data: schema })

// GET /api/events
registry.registerPath({
  method: "get",
  path: "/api/events",
  tags: ["Dashboard Events"],
  summary: "List all events (dashboard)",
  description: "Returns events for the authenticated dashboard user. Admin sees all, organizers see their own.",
  security: sessionAuth,
  responses: {
    200: { description: "Events", content: { "application/json": { schema: wrap(z.array(z.unknown())) } } },
    ...standardErrors,
  },
})

// POST /api/events
registry.registerPath({
  method: "post",
  path: "/api/events",
  tags: ["Dashboard Events"],
  summary: "Create event (dashboard)",
  security: sessionAuth,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            title: z.string(),
            description: z.string().optional(),
            shortDescription: z.string().optional(),
            startTime: z.string().datetime(),
            endTime: z.string().datetime(),
            timezone: z.string().optional(),
            venueName: z.string().optional(),
            address: z.string().optional(),
            city: z.string().optional(),
            state: z.string().optional(),
            country: z.string().optional(),
            latitude: z.number().optional(),
            longitude: z.number().optional(),
            maxCapacity: z.number().optional(),
            checkInRadius: z.number().optional(),
            visibility: z.string().optional(),
            categoryIds: z.array(z.string().uuid()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Created event", content: { "application/json": { schema: wrap(z.unknown()) } } },
    ...standardErrors,
  },
})

// === Chat Moderation ===

// GET /api/events/{id}/chat/moderation
registry.registerPath({
  method: "get",
  path: "/api/events/{id}/chat/moderation",
  tags: ["Dashboard Chat Moderation"],
  summary: "List moderation flags for event chat",
  description: "Paginated list of flagged messages with moderation stats. Requires moderator/organizer/admin role.",
  security: sessionAuth,
  request: {
    params: z.object({ id: z.string().uuid() }),
    query: z.object({
      status: z.enum(["pending", "approved", "rejected", "all"]).optional().openapi({ description: "Filter by flag status (default: pending)" }),
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
  },
  responses: {
    200: {
      description: "Moderation flags with stats",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              flags: z.array(
                z.object({
                  id: z.string().uuid(),
                  messageId: z.string().uuid(),
                  userId: z.string(),
                  userName: z.string(),
                  userEmail: z.string(),
                  source: z.enum(["auto_text", "auto_image", "auto_spam", "auto_keyword", "user_report", "manual"]),
                  status: z.enum(["pending", "approved", "rejected"]),
                  categories: z.unknown().openapi({ description: "Category scores, e.g. { hate: 0.92, sexual: 0.1 }" }),
                  confidence: z.number(),
                  autoAction: z.string().nullable(),
                  reviewedBy: z.string().nullable(),
                  reviewedAt: z.string().datetime().nullable(),
                  reviewNotes: z.string().nullable(),
                  createdAt: z.string().datetime(),
                  message: z.object({
                    id: z.string().uuid(),
                    content: z.string(),
                    type: z.string(),
                    createdAt: z.string().datetime(),
                    isDeleted: z.boolean(),
                  }),
                })
              ),
              stats: z.object({
                pending: z.number(),
                autoHidden: z.number(),
                total: z.number(),
              }),
              pagination: z.object({
                page: z.number(),
                limit: z.number(),
                total: z.number(),
                totalPages: z.number(),
              }),
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

// PATCH /api/events/{id}/chat/moderation/{flagId}
registry.registerPath({
  method: "patch",
  path: "/api/events/{id}/chat/moderation/{flagId}",
  tags: ["Dashboard Chat Moderation"],
  summary: "Review a moderation flag",
  description: "Approve (restore message) or reject (keep hidden). Requires moderator/organizer/admin role.",
  security: sessionAuth,
  request: {
    params: z.object({
      id: z.string().uuid(),
      flagId: z.string().uuid(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            action: z.enum(["approve", "reject"]).openapi({ description: "approve = restore message (false positive), reject = keep hidden" }),
            notes: z.string().optional().openapi({ description: "Optional reviewer notes" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Flag reviewed",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              flagId: z.string().uuid(),
              action: z.enum(["approve", "reject"]),
              reviewedBy: z.string(),
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

// === Event Detail (Dashboard) ===

// GET /api/events/{id}
registry.registerPath({
  method: "get",
  path: "/api/events/{id}",
  tags: ["Dashboard Events"],
  summary: "Get event by ID (dashboard)",
  security: sessionAuth,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "Event object", content: { "application/json": { schema: z.unknown() } } },
    ...standardErrors,
  },
})

// PATCH /api/events/{id}
registry.registerPath({
  method: "patch",
  path: "/api/events/{id}",
  tags: ["Dashboard Events"],
  summary: "Update event (dashboard)",
  description: "Full event update including details, categories, and media. Requires organizer/admin role. Cancelling an event auto-cancels active check-ins.",
  security: sessionAuth,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            title: z.string().optional(),
            description: z.string().optional(),
            short_description: z.string().optional(),
            venue_name: z.string().optional(),
            address: z.string().optional(),
            city: z.string().optional(),
            state: z.string().optional(),
            country: z.string().optional(),
            postal_code: z.string().optional(),
            start_time: z.string().datetime().optional(),
            end_time: z.string().datetime().optional(),
            timezone: z.string().optional(),
            status: z.string().optional(),
            visibility: z.string().optional(),
            max_capacity: z.number().int().min(1).max(100000).optional(),
            current_capacity: z.number().min(0).optional(),
            latitude: z.number().optional(),
            longitude: z.number().optional(),
            cover_image_url: z.string().optional(),
            external_link: z.string().optional(),
            is_featured: z.boolean().optional(),
            is_recurring: z.boolean().optional(),
            check_in_radius: z.number().optional(),
            full_description: z.string().optional(),
            house_rules: z.string().optional(),
            cancellation_policy: z.string().optional(),
            additional_info: z.unknown().optional(),
            faq: z.unknown().optional(),
            accessibility_info: z.unknown().optional(),
            covid_guidelines: z.string().optional(),
            category_ids: z.array(z.string().uuid()).optional(),
            primary_category_id: z.string().uuid().optional(),
            media_items: z.array(z.object({
              type: z.enum(["image", "video", "document"]),
              url: z.string(),
              thumbnail_url: z.string().optional(),
              title: z.string().optional(),
              description: z.string().optional(),
              order: z.number().optional(),
            })).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated event", content: { "application/json": { schema: z.unknown() } } },
    ...standardErrors,
  },
})

// DELETE /api/events/{id}
registry.registerPath({
  method: "delete",
  path: "/api/events/{id}",
  tags: ["Dashboard Events"],
  summary: "Soft-delete event (dashboard)",
  security: sessionAuth,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    204: { description: "Deleted" },
    ...standardErrors,
  },
})

// === Announcements ===

// GET /api/events/{id}/announcements
registry.registerPath({
  method: "get",
  path: "/api/events/{id}/announcements",
  tags: ["Dashboard Announcements"],
  summary: "List event announcements",
  security: sessionAuth,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "Announcements",
      content: {
        "application/json": {
          schema: z.array(z.object({
            id: z.string().uuid(),
            event_id: z.string().uuid(),
            content: z.string(),
            sent_by: z.string(),
            created_at: z.string().datetime(),
            sender: z.object({ name: z.string(), email: z.string() }),
          })),
        },
      },
    },
    ...standardErrors,
  },
})

// POST /api/events/{id}/announcements
registry.registerPath({
  method: "post",
  path: "/api/events/{id}/announcements",
  tags: ["Dashboard Announcements"],
  summary: "Send announcement",
  description: "Creates an announcement, posts it as a chat message, and sends push notifications to chat members.",
  security: sessionAuth,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ content: z.string().min(1) }),
        },
      },
    },
  },
  responses: {
    201: { description: "Announcement created", content: { "application/json": { schema: z.unknown() } } },
    ...standardErrors,
  },
})

// === Chat Member Management ===

// PATCH /api/events/{id}/chat/members/{userId}
registry.registerPath({
  method: "patch",
  path: "/api/events/{id}/chat/members/{userId}",
  tags: ["Dashboard Chat Moderation"],
  summary: "Ban or unban a chat member",
  description: "Ban removes user from chat and emits a socket event. Requires moderator/organizer/admin role.",
  security: sessionAuth,
  request: {
    params: z.object({ id: z.string().uuid(), userId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            action: z.enum(["ban", "unban"]),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Ban status updated",
      content: { "application/json": { schema: z.object({ success: z.literal(true), banned: z.boolean() }) } },
    },
    ...standardErrors,
  },
})

// === Chat Messages (Dashboard) ===

// GET /api/events/{id}/chat/messages
registry.registerPath({
  method: "get",
  path: "/api/events/{id}/chat/messages",
  tags: ["Dashboard Chat Moderation"],
  summary: "Get chat messages with member info (dashboard)",
  description: "Returns messages with real user identity and anonymous names. Includes member list with ban status.",
  security: sessionAuth,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "Messages and members",
      content: {
        "application/json": {
          schema: z.object({
            chatGroupId: z.string().uuid(),
            messages: z.array(z.object({
              id: z.string().uuid(),
              content: z.string(),
              type: z.string(),
              createdAt: z.string().datetime(),
              user: z.object({
                id: z.string(),
                name: z.string(),
                email: z.string(),
                image: z.string().nullable(),
                anonymousName: z.string().nullable(),
              }),
            })),
            members: z.array(z.object({
              userId: z.string(),
              anonymousName: z.string().nullable(),
              status: z.string(),
              bannedAt: z.string().datetime().nullable(),
            })),
          }),
        },
      },
    },
    ...standardErrors,
  },
})

// DELETE /api/events/{id}/chat/messages/{messageId}
registry.registerPath({
  method: "delete",
  path: "/api/events/{id}/chat/messages/{messageId}",
  tags: ["Dashboard Chat Moderation"],
  summary: "Delete a chat message",
  description: "Soft-deletes a message and emits a socket event. Requires moderator/organizer/admin role.",
  security: sessionAuth,
  request: {
    params: z.object({ id: z.string().uuid(), messageId: z.string().uuid() }),
  },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: z.object({ success: z.literal(true) }) } } },
    ...standardErrors,
  },
})

// === Sponsored Messages ===

// GET /api/events/{id}/sponsored-messages
registry.registerPath({
  method: "get",
  path: "/api/events/{id}/sponsored-messages",
  tags: ["Dashboard Sponsored Messages"],
  summary: "List sponsored messages",
  security: sessionAuth,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "Sponsored messages",
      content: {
        "application/json": {
          schema: z.array(z.object({
            id: z.string().uuid(),
            event_id: z.string().uuid(),
            content: z.string(),
            interval_minutes: z.number(),
            is_active: z.boolean(),
            created_at: z.string().datetime(),
            updated_at: z.string().datetime(),
          })),
        },
      },
    },
    ...standardErrors,
  },
})

// POST /api/events/{id}/sponsored-messages
registry.registerPath({
  method: "post",
  path: "/api/events/{id}/sponsored-messages",
  tags: ["Dashboard Sponsored Messages"],
  summary: "Create sponsored message",
  description: "Creates a recurring message that will be posted to the event chat at the specified interval.",
  security: sessionAuth,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            content: z.string().min(1),
            interval_minutes: z.enum(["10", "15", "30", "60"]).or(z.number()).openapi({ description: "Must be 10, 15, 30, or 60" }),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.unknown() } } },
    ...standardErrors,
  },
})

// PATCH /api/events/{id}/sponsored-messages/{msgId}
registry.registerPath({
  method: "patch",
  path: "/api/events/{id}/sponsored-messages/{msgId}",
  tags: ["Dashboard Sponsored Messages"],
  summary: "Update sponsored message",
  description: "Update content, interval, or active status. Toggling is_active starts/stops the scheduler.",
  security: sessionAuth,
  request: {
    params: z.object({ id: z.string().uuid(), msgId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            content: z.string().optional(),
            interval_minutes: z.number().optional(),
            is_active: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: z.unknown() } } },
    ...standardErrors,
  },
})

// DELETE /api/events/{id}/sponsored-messages/{msgId}
registry.registerPath({
  method: "delete",
  path: "/api/events/{id}/sponsored-messages/{msgId}",
  tags: ["Dashboard Sponsored Messages"],
  summary: "Delete sponsored message",
  description: "Stops the scheduler and permanently deletes the message.",
  security: sessionAuth,
  request: {
    params: z.object({ id: z.string().uuid(), msgId: z.string().uuid() }),
  },
  responses: {
    204: { description: "Deleted" },
    ...standardErrors,
  },
})

// POST /api/uploads/presigned-url
registry.registerPath({
  method: "post",
  path: "/api/uploads/presigned-url",
  tags: ["Dashboard Uploads"],
  summary: "Get presigned upload URL (dashboard)",
  description: "Presigned URL for dashboard file uploads. Requires admin/organizer/venue_owner role.",
  security: sessionAuth,
  request: {
    body: {
      content: {
        "application/json": {
          schema: PresignedUrlRequestSchema.extend({
            folder: z.enum(["profile", "chat", "events"]).default("events"),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Presigned URL", content: { "application/json": { schema: wrap(PresignedUrlResponseSchema) } } },
    ...standardErrors,
  },
})
