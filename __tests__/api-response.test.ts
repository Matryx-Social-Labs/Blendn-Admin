// Mock the media-response module to avoid complex dependencies
jest.mock("@/lib/media-response", () => ({
  resolveMediaFields: jest.fn((data: unknown) => Promise.resolve(data)),
}))

import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
  conflictResponse,
  ErrorCode,
} from "@/lib/api-response"
import { ZodError, ZodIssueCode } from "zod"

describe("successResponse", () => {
  it("returns 200 with success: true", async () => {
    const res = await successResponse({ foo: "bar" })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toEqual({ foo: "bar" })
  })

  it("accepts custom status", async () => {
    const res = await successResponse({ id: 1 }, 201)
    expect(res.status).toBe(201)
  })
})

describe("errorResponse", () => {
  it("returns 400 by default", () => {
    const res = errorResponse("Bad input")
    expect(res.status).toBe(400)
  })

  it("includes errorCode when provided", async () => {
    const res = errorResponse("Event full", 400, ErrorCode.EVENT_FULL)
    const body = await res.json()
    expect(body.errorCode).toBe("EVENT_FULL")
    expect(body.success).toBe(false)
  })
})

describe("validationErrorResponse", () => {
  it("returns 400 with field errors", async () => {
    const zodError = new ZodError([
      {
        code: ZodIssueCode.invalid_type,
        expected: "string",
        received: "undefined",
        path: ["email"],
        message: "Required",
      },
    ])
    const res = validationErrorResponse(zodError)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.errorCode).toBe("VALIDATION_FAILED")
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0].field).toBe("email")
  })
})

describe("status code responses", () => {
  it("unauthorizedResponse returns 401", async () => {
    const res = unauthorizedResponse()
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.errorCode).toBe("UNAUTHORIZED")
  })

  it("forbiddenResponse returns 403", async () => {
    const res = forbiddenResponse()
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.errorCode).toBe("FORBIDDEN")
  })

  it("notFoundResponse returns 404", async () => {
    const res = notFoundResponse()
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.errorCode).toBe("NOT_FOUND")
  })

  it("serverErrorResponse returns 500", async () => {
    const res = serverErrorResponse()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.errorCode).toBe("SERVER_ERROR")
  })

  it("conflictResponse returns 409", async () => {
    const res = conflictResponse()
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.errorCode).toBe("CONFLICT")
  })
})
