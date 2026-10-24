import { z } from "zod"
import { registry } from "@/lib/openapi/registry"

// Standard success response wrapper
export const SuccessResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.unknown(),
  })
  .openapi("SuccessResponse")

/**
 * Whether to offer "add as friend" for a person you are looking at. Present on a
 * DM (detail and inbox) and on `GET /profiles/{userId}` for somebody you may see;
 * never on a stranger. See lib/friend-offer.ts.
 */
export const FriendOfferSchema = z
  .object({
    state: z
      .enum(["none", "requested", "incoming", "friends"])
      .describe("From your side. `incoming`: they asked you. Always `none` while their name is still a pseudonym to you."),
    canAdd: z
      .boolean()
      .describe(
        "Show the add button. True only when you matched and BOTH of you have revealed, the conversation is open, " +
          "nobody has blocked anybody, the account exists, and `state` is `none` or `incoming` (adding somebody who asked you " +
          "accepts). False for `requested` and `friends`, and for every pair that is not a revealed match. " +
          "Call `POST /friends/requests` with `{ userId }`."
      ),
  })
  .openapi("FriendOffer")

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
          "`NOT_A_REVEALED_MATCH` (404 on `POST /friends/requests`), `RATE_LIMITED` (429 on the friend routes, with `retryAfter`). " +
          "Read `reasonCode ?? errorCode`."
      ),
    retryAfter: z
      .number()
      .int()
      .optional()
      .describe(
        "Seconds to wait before trying again (also the `Retry-After` header), on a 429 `RATE_LIMITED`, on a 429 `SPAM_BLOCKED` for a burst " +
          "(absent when waiting would not help, as for too many links), on the 503 `MAINTENANCE`, and on the 503 `MODERATION_UNAVAILABLE`."
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
/**
 * The `pagination` block of a list paged by cursor (`lib/pagination.ts`
 * `ListPagination`): the inbox, friends, friend requests, blocked people and
 * the board. `totalCount` is the whole list, whatever page this is.
 */
export const ListPaginationSchema = z
  .object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable().describe("Send as `?cursor=` for the next page. Opaque. Null on the last page."),
    totalCount: z.number().int().describe("How many there are in all, not on this page."),
  })
  .openapi("ListPagination")

/** `?limit=&cursor=` on a list paged by cursor. */
export const ListQuerySchema = z.object({
  limit: z
    .number()
    .int()
    .optional()
    .describe(
      "A page's size, 1-100; each list has its own default. A request with neither `limit` nor `cursor` (an installed build, which cannot page) is answered up to 200 on the inbox, friends, friend requests and blocked lists; the board is 100 either way. A new client sends `limit` on its first page."
    ),
  cursor: z.string().optional().describe("The previous page's `pagination.nextCursor`. A cursor that is not ours is 400."),
})

/**
 * `?page=&limit=&cursor=` on a list that pages both ways (`/me/rsvps`,
 * `/me/attendance`, `/users/{userId}/favorites`): page numbers as installed
 * builds send them, or a keyset `cursor`.
 */
export const PageOrCursorQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().describe("Page number, as installed builds send it. Ignored when `cursor` is sent."),
  limit: z.coerce.number().int().min(1).max(100).optional().describe("A page's size, 1-100; default 20. With none of `page`, `limit` and `cursor`: up to 200."),
  cursor: z.string().optional().describe("The previous page's `pagination.nextCursor`: pages by keyset (the id breaks ties). A cursor that is not ours is 400."),
})

/** `pagination` of a list that pages both ways: the page block on `?page=`, the cursor block on `?cursor=`, `nextCursor` on both. */
export const PagedPaginationSchema = z
  .object({
    page: z.number().int().optional().describe("Only on a `page` read."),
    limit: z.number().int(),
    totalCount: z.number().int().describe("The whole list, whatever the page."),
    totalPages: z.number().int().optional().describe("Only on a `page` read."),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable().describe("Send as `?cursor=` for the next page. Opaque. Null on the last page."),
  })
  .openapi("PagedPagination")

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

/** The 503 a big room's send can answer while the moderation vendor is down (both send routes). */
export const moderationUnavailableError = errorBody("Moderation unavailable in a busy room; nothing was written")

export const MODERATION_UNAVAILABLE_NOTE =
  "**While OpenAI moderation is down:** a room with more than 200 people inside refuses the send instead of delivering an unchecked line — " +
  "`503 MODERATION_UNAVAILABLE` with `retryAfter: 5` (also `Retry-After`) and the sentence \"This room is busy and messages can’t be checked right now. Try again in a few seconds.\" " +
  "Nothing is written or emitted; resend the same `clientId`. Rooms of 200 or fewer, and every non-event room, still deliver and are re-checked by a sweeper once the vendor is back, oldest first, up to 64 x 20 messages a minute."

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
