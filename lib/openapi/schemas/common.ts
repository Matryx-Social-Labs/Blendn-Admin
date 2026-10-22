import { z } from "zod"
import { registry } from "@/lib/openapi/registry"

// Standard success response wrapper
export const SuccessResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.unknown(),
  })
  .openapi("SuccessResponse")

/** The success envelope around one route's `data`. */
export const wrap = (schema: z.ZodTypeAny) => z.object({ success: z.literal(true), data: schema })

/** Security requirements, naming the schemes `registry.ts` registers. */
export const bearerAuth = [{ BearerAuth: [] }]
export const sessionAuth = [{ SessionAuth: [] }]

// Standard error response
export const ErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string(),
    errorCode: z.string().optional(),
    reasonCode: z
      .string()
      .optional()
      .describe(
        "Why, beside an `errorCode` that keeps the value installed builds match on: `ACCOUNT_SUSPENDED`, " +
          "`ACCOUNT_STAFF`, `ACCOUNT_DELETED`, `SESSION_REVOKED_ELSEWHERE`, `PASSWORD_RESET`, `AGE_UNKNOWN`, " +
          "`PROFILE_INCOMPLETE`, and on events and friends: `AGE_RESTRICTED` (a known age below the line), " +
          "`ORGANISER_SUSPENDED` (an event hidden by its organisation's suspension, on every route that refuses it), `INVITE_UNAVAILABLE`, `PERSON_UNAVAILABLE`, " +
          "`REQUEST_UNAVAILABLE` (one reason for every way something is out of reach), `CANNOT_ADD_SELF`. " +
          "Read `reasonCode ?? errorCode`."
      ),
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
/** Every event-scoped people read and write refuses a member a host banned from the room, as the chat does. */
export const ROOM_BAN_GATE =
  "403 `USER_BANNED` (\"The organiser has removed you from this room.\") when a host banned the caller from the " +
  "event's room — the chat's own answer; for a route taking a room handle, the room that handle came from. "

export const PARTICIPATION_GATE =
  "403 \"Finish setting up your profile first. Blend'n is for people 18 and over.\" when the " +
  "profile has neither finished onboarding nor an adult age on file (SCRUM-331) — `errorCode` stays " +
  "`FORBIDDEN`; the event, check-in and Go Live routes add `reasonCode` `PROFILE_INCOMPLETE`. "

const errorBody = (description: string, schema: z.ZodTypeAny = ErrorResponseSchema) => ({
  description,
  content: { "application/json": { schema } },
})

export const standardErrors = {
  400: errorBody("Validation error", ValidationErrorSchema),
  401: errorBody("Unauthorized"),
  403: errorBody("Forbidden"),
  404: errorBody("Not found"),
  429: errorBody("Rate limited", RateLimitErrorSchema),
  500: errorBody("Internal server error"),
} as const

/**
 * A display-only line two people (or two crews) share — matching v2, plan v2
 * §8 (`lib/overlaps.ts`). A sentence ready to print; `kind` picks the icon.
 * Never scored. Tier B kinds (`language`, `home_state`, `sign`) only in rooms
 * of eight or more before a reveal, one per card.
 */
export const OverlapSchema = z
  .object({
    kind: z.enum(["interest", "ipl", "this_or_that", "language", "home_state", "sign"]),
    text: z.string().describe("e.g. \"Both CSK — in RCB country 💛\", \"You both picked filter coffee over chai\", \"Both from Kerala\""),
  })
  .openapi("Overlap")

/** A badge earned by GPS check-ins, never typed or bought (plan v2 §8.6). */
export const BadgeSchema = z
  .object({
    kind: z.enum(["regular_here", "shows_up", "nights_out", "nights_together"]),
    label: z.string().describe("\"Regular here\", \"Shows up\", \"5+ nights this month\", \"6 nights out together\""),
  })
  .openapi("Badge")
