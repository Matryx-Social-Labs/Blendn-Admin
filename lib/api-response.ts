import { NextResponse } from "next/server"
import { ZodError } from "zod"
import { resolveMediaFields } from "@/lib/media-response"

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  errorCode?: string
  /**
   * Why, for a client that knows how to read it, beside an `errorCode` that
   * stays exactly what installed builds already match on (Flow 15):
   * `ACCOUNT_*`, `SESSION_REVOKED_ELSEWHERE`, `PASSWORD_RESET`, `AGE_UNKNOWN`,
   * `PROFILE_INCOMPLETE`. Read `reasonCode ?? errorCode`.
   */
  reasonCode?: string
  errors?: Array<{ field: string; message: string }>
}

export const ErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  SERVER_ERROR: "SERVER_ERROR",
  EVENT_FULL: "EVENT_FULL",
  EVENT_NOT_STARTED: "EVENT_NOT_STARTED",
  EVENT_ENDED: "EVENT_ENDED",
  OUT_OF_RANGE: "OUT_OF_RANGE",
  /**
   * Too young for this event, or no age on file.
   *
   * Distinct from `FORBIDDEN` because the client's response differs: this is
   * the one refusal the user can sometimes fix themselves, by adding their age.
   */
  AGE_RESTRICTED: "AGE_RESTRICTED",
  ALREADY_CHECKED_IN: "ALREADY_CHECKED_IN",
  STORAGE_UNAVAILABLE: "STORAGE_UNAVAILABLE",
  USER_MUTED: "USER_MUTED",
  USER_BANNED: "USER_BANNED",
  CHAT_LOCKED: "CHAT_LOCKED",
  /** Window closed: the event ended more than CHAT_WINDOW_HOURS ago. */
  CHAT_CLOSED: "CHAT_CLOSED",
  NOT_CHECKED_IN: "NOT_CHECKED_IN",
  SPAM_BLOCKED: "SPAM_BLOCKED",
  /**
   * The person you waved at is not in the room — or is, and one of you has
   * blocked the other. One code for both on purpose: a distinct answer for the
   * block would be a way to find out who blocked you.
   */
  RECIPIENT_NOT_HERE: "RECIPIENT_NOT_HERE",
  /** You waved at this person less than ten minutes ago. */
  WAVE_TOO_SOON: "WAVE_TOO_SOON",
  /**
   * You left this room yourself. Distinct from `FORBIDDEN` because the remedy
   * is yours: check in again, or `DELETE /chat/groups/:id/leave` to rejoin.
   */
  LEFT_ROOM: "LEFT_ROOM",
  /**
   * A venue day's room, and your Go Live there has ended (`liveInVenueDay`).
   * The remedy is yours: go live again.
   */
  NOT_LIVE: "NOT_LIVE",
  /**
   * Go Live refused because a real event is on at this venue, or starts within
   * the hour: check in to that instead. The body carries its `eventId`.
   */
  EVENT_LIVE_HERE: "EVENT_LIVE_HERE",
  /** "Stay" is Blendn+ once `PLUS_GATING` is on. */
  PLUS_REQUIRED: "PLUS_REQUIRED",
  /**
   * Go Live at a venue nobody has drawn an area for. Not `OUT_OF_RANGE`: no
   * position fixes it, so the app must not offer directions (step 5).
   */
  NO_CHECK_IN_AREA: "NO_CHECK_IN_AREA",
  /**
   * Go Live with a fix too vague to place anybody (`MAX_GPS_ACCURACY_METERS`).
   * The remedy is a better fix where you stand, not walking anywhere.
   */
  GPS_TOO_VAGUE: "GPS_TOO_VAGUE",
  /**
   * "Let this venue know I'm a regular" at a venue nobody runs on Blendn yet:
   * there is nobody to tell (step 12). Not `NOT_FOUND`: the venue is there.
   */
  VENUE_UNCLAIMED: "VENUE_UNCLAIMED",
  /**
   * Why an account was refused or a session ended (Flow 15). Where a response
   * already carried an `errorCode` installed builds match on (`FORBIDDEN`,
   * `AGE_RESTRICTED`, `NOT_FOUND`), that stays and these go in `reasonCode`
   * beside it; where it carried only the default 401, the code is both.
   */
  ACCOUNT_SUSPENDED: "ACCOUNT_SUSPENDED",
  /** An organiser, venue owner, sponsor or admin in the attendee app. */
  ACCOUNT_STAFF: "ACCOUNT_STAFF",
  /** The account was deleted. Never sent at sign-in with a password, which would confirm it existed. */
  ACCOUNT_DELETED: "ACCOUNT_DELETED",
  /** Refresh: every phone was signed out (Settings, or another device). */
  SESSION_REVOKED_ELSEWHERE: "SESSION_REVOKED_ELSEWHERE",
  /** Refresh: the password was reset or changed. */
  PASSWORD_RESET: "PASSWORD_RESET",
  /** 426, from `middleware.ts`: a build below `MOBILE_MIN_APP_VERSION`. */
  UPDATE_REQUIRED: "UPDATE_REQUIRED",
  /** 503, from `middleware.ts`: `MAINTENANCE_MODE` is on. Carries `retryAfter`. */
  MAINTENANCE: "MAINTENANCE",
  /** The age rule refused somebody whose age is not on file: the one case they can fix by adding it. */
  AGE_UNKNOWN: "AGE_UNKNOWN",
  /** Onboarding is unfinished, and no adult age on file stands in for it. */
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
} as const

/**
 * Create a success response
 */
export function successResponse<T>(
  data: T,
  status: number = 200
): Promise<NextResponse<ApiResponse<T>>> {
  return resolveMediaFields(data).then((resolvedData) =>
    NextResponse.json(
      {
        success: true,
        data: resolvedData,
      },
      { status }
    )
  )
}

/**
 * The code a bare status stands for, when the caller named none (SCRUM-324).
 *
 * The documented envelope promises an `errorCode` on every error, and a bare
 * `errorResponse(msg, 401)` left it off — the Google and Apple sign-in
 * refusals among them. Only statuses with one meaning get a default: a bare
 * 400 or 422 covers everything from a missing field to "only an offer has
 * spaces", and `VALIDATION_FAILED` promises field errors it would not carry.
 */
const CODE_FOR_STATUS: Partial<Record<number, string>> = {
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  429: ErrorCode.RATE_LIMITED,
}

function defaultErrorCode(status: number): string | undefined {
  return status >= 500 ? ErrorCode.SERVER_ERROR : CODE_FOR_STATUS[status]
}

export function errorResponse(
  message: string,
  status: number = 400,
  errorCode?: string,
  /** The reason, in `reasonCode`, when `errorCode` must stay what it was. */
  reasonCode?: string
): NextResponse<ApiResponse> {
  const code = errorCode ?? defaultErrorCode(status)
  return NextResponse.json(
    {
      success: false,
      error: message,
      ...(code && { errorCode: code }),
      ...(reasonCode && { reasonCode }),
    },
    { status }
  )
}

/**
 * Create a validation error response from Zod errors
 */
export function validationErrorResponse(
  error: ZodError
): NextResponse<ApiResponse> {
  // `.issues` not `.errors`: ZodError.errors is removed in zod 4, and both
  // exist on the zod 3 we're on today. Every mobile route funnels validation
  // failures through here, so on `.errors` a zod upgrade turns all 26 of them
  // from a 400 into a 500 raised inside the error handler itself.
  const errors = error.issues.map((e) => ({
    field: e.path.join("."),
    message: e.message,
  }))

  return NextResponse.json(
    {
      success: false,
      error: "Validation failed",
      errorCode: ErrorCode.VALIDATION_FAILED,
      errors,
    },
    { status: 400 }
  )
}

export const unauthorizedResponse = (message = "Unauthorized") => errorResponse(message, 401)
export const forbiddenResponse = (message = "Forbidden") => errorResponse(message, 403)
export const notFoundResponse = (message = "Not found") => errorResponse(message, 404)
export const serverErrorResponse = (message = "Internal server error") => errorResponse(message, 500)
/** e.g. a duplicate resource. */
export const conflictResponse = (message = "Resource already exists") => errorResponse(message, 409)
