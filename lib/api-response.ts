import { NextResponse } from "next/server"
import { ZodError } from "zod"
import { resolveMediaFields } from "@/lib/media-response"

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  errorCode?: string
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
 * Create an error response
 */
export function errorResponse(
  message: string,
  status: number = 400,
  errorCode?: string
): NextResponse<ApiResponse> {
  return NextResponse.json(
    {
      success: false,
      error: message,
      ...(errorCode && { errorCode }),
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

/**
 * Create an unauthorized response
 */
export function unauthorizedResponse(
  message: string = "Unauthorized"
): NextResponse<ApiResponse> {
  return NextResponse.json(
    {
      success: false,
      error: message,
      errorCode: ErrorCode.UNAUTHORIZED,
    },
    { status: 401 }
  )
}

/**
 * Create a forbidden response
 */
export function forbiddenResponse(
  message: string = "Forbidden"
): NextResponse<ApiResponse> {
  return NextResponse.json(
    {
      success: false,
      error: message,
      errorCode: ErrorCode.FORBIDDEN,
    },
    { status: 403 }
  )
}

/**
 * Create a not found response
 */
export function notFoundResponse(
  message: string = "Not found"
): NextResponse<ApiResponse> {
  return NextResponse.json(
    {
      success: false,
      error: message,
      errorCode: ErrorCode.NOT_FOUND,
    },
    { status: 404 }
  )
}

/**
 * Create a server error response
 */
export function serverErrorResponse(
  message: string = "Internal server error"
): NextResponse<ApiResponse> {
  return NextResponse.json(
    {
      success: false,
      error: message,
      errorCode: ErrorCode.SERVER_ERROR,
    },
    { status: 500 }
  )
}

/**
 * Create a conflict response (e.g., duplicate resource)
 */
export function conflictResponse(
  message: string = "Resource already exists"
): NextResponse<ApiResponse> {
  return NextResponse.json(
    {
      success: false,
      error: message,
      errorCode: ErrorCode.CONFLICT,
    },
    { status: 409 }
  )
}
