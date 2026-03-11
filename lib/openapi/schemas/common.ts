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
