import { z } from "zod"
import { registry } from "@/lib/openapi/registry"

// Standard success response wrapper
export const SuccessResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.unknown(),
  })
  .openapi("SuccessResponse")

// Standard error response
export const ErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string(),
    errorCode: z.string().optional(),
  })
  .openapi("ErrorResponse")

// Validation error response
export const ValidationErrorSchema = z
  .object({
    success: z.literal(false),
    error: z.literal("Validation failed"),
    errorCode: z.literal("VALIDATION_FAILED"),
    errors: z.array(
      z.object({
        field: z.string(),
        message: z.string(),
      })
    ),
  })
  .openapi("ValidationErrorResponse")

// Rate limit error response
export const RateLimitErrorSchema = z
  .object({
    success: z.literal(false),
    error: z.string(),
    errorCode: z.literal("RATE_LIMITED"),
  })
  .openapi("RateLimitErrorResponse")

// Offset-based pagination meta
export const PaginationMetaSchema = z
  .object({
    page: z.number().int(),
    limit: z.number().int(),
    totalCount: z.number().int(),
    totalPages: z.number().int(),
    hasMore: z.boolean(),
  })
  .openapi("PaginationMeta")

// Cursor-based pagination meta
export const CursorPaginationMetaSchema = z
  .object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().optional(),
  })
  .openapi("CursorPaginationMeta")

/**
 * A person as a room names them (SCRUM-371, `lib/room-handle.ts`).
 *
 * The caller's own real id when it is them; anybody else's room handle for
 * that event — `rh_` + an opaque url-safe string, the same for one person on
 * every surface and socket event of one event, and unrelated at the next.
 */
export const RoomUserRefSchema = z.string().openapi({
  description:
    "The caller's own user id when it is the caller; otherwise that person's room handle for this event (`rh_…`, SCRUM-371) — stable for the event, different at every event. Never another person's real id. Accepted anywhere a user id is.",
  example: "rh_q2V0bHlXb3JkcyBhcmUgb3BhcXVl",
})

/** A user id a client sends: a raw id, or a room handle from any room surface. */
export const UserRefParamSchema = z.string().min(1).openapi({
  description:
    "A user id or a room handle (`rh_…`) taken from a room surface (SCRUM-371). A handle that does not verify is answered exactly as an unknown id.",
})

// Device info (reused across auth endpoints)
export const DeviceInfoSchema = z
  .object({
    platform: z.string().optional(),
    device: z.string().optional(),
    appVersion: z.string().optional(),
  })
  .openapi("DeviceInfo")

// Register all schemas
registry.register("SuccessResponse", SuccessResponseSchema)
registry.register("ErrorResponse", ErrorResponseSchema)
registry.register("ValidationErrorResponse", ValidationErrorSchema)
registry.register("RateLimitErrorResponse", RateLimitErrorSchema)
registry.register("PaginationMeta", PaginationMetaSchema)
registry.register("CursorPaginationMeta", CursorPaginationMetaSchema)
registry.register("DeviceInfo", DeviceInfoSchema)

// Reusable error responses for path definitions
/**
 * The participation gate (SCRUM-331), for every endpoint that asks it:
 * RSVP, favourite, board, check-in, and starting or sending a DM.
 */
export const PARTICIPATION_GATE =
  "403 `FORBIDDEN` \"Finish setting up your profile first. Blend'n is for people 18 and over.\" when the " +
  "profile has neither finished onboarding nor an adult age on file (SCRUM-331). "

export const standardErrors = {
  400: {
    description: "Validation error",
    content: {
      "application/json": { schema: ValidationErrorSchema },
    },
  },
  401: {
    description: "Unauthorized",
    content: {
      "application/json": { schema: ErrorResponseSchema },
    },
  },
  403: {
    description: "Forbidden",
    content: {
      "application/json": { schema: ErrorResponseSchema },
    },
  },
  404: {
    description: "Not found",
    content: {
      "application/json": { schema: ErrorResponseSchema },
    },
  },
  429: {
    description: "Rate limited",
    content: {
      "application/json": { schema: RateLimitErrorSchema },
    },
  },
  500: {
    description: "Internal server error",
    content: {
      "application/json": { schema: ErrorResponseSchema },
    },
  },
} as const
