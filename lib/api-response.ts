import { NextResponse } from "next/server"
import { ZodError } from "zod"

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  errors?: Array<{ field: string; message: string }>
}

/**
 * Create a success response
 */
export function successResponse<T>(
  data: T,
  status: number = 200
): NextResponse<ApiResponse<T>> {
  return NextResponse.json(
    {
      success: true,
      data,
    },
    { status }
  )
}

/**
 * Create an error response
 */
export function errorResponse(
  message: string,
  status: number = 400
): NextResponse<ApiResponse> {
  return NextResponse.json(
    {
      success: false,
      error: message,
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
  const errors = error.errors.map((e) => ({
    field: e.path.join("."),
    message: e.message,
  }))

  return NextResponse.json(
    {
      success: false,
      error: "Validation failed",
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
    },
    { status: 409 }
  )
}
