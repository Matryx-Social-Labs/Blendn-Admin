import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { standardErrors } from "@/lib/openapi/schemas/common"
import {
  SignupRequestSchema,
  SigninRequestSchema,
  GoogleAuthRequestSchema,
  RefreshTokenRequestSchema,
  SignoutRequestSchema,
  AuthTokenResponseSchema,
  GoogleAuthResponseSchema,
  RefreshTokenResponseSchema,
  SessionResponseSchema,
  MessageResponseSchema,
} from "@/lib/openapi/schemas/auth"

registry.registerPath({
  method: "post",
  path: "/api/mobile/auth/signup",
  tags: ["Mobile Auth"],
  summary: "Create a new account",
  description:
    "Register a new user with email and password. The password must be at least 12 characters " +
    "and is additionally checked against obvious choices and against the local part of the " +
    "address — the same rule `/api/auth/reset-password` enforces, so a password accepted here " +
    "can always be reset to something similar. Returns the created profile alongside the user. " +
    "Rate limited: 3 requests per hour.",
  request: {
    body: {
      content: { "application/json": { schema: SignupRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Account created successfully",
      content: {
        "application/json": {
          schema: z.object({ success: z.literal(true), data: AuthTokenResponseSchema }),
        },
      },
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/auth/signin",
  tags: ["Mobile Auth"],
  summary: "Sign in with email and password",
  description:
    "Authenticate with credentials. Rate limited twice: 5 requests per 15 minutes per IP, and " +
    "10 per 15 minutes per email address — the second stops a distributed attempt walking one " +
    "account's password from many addresses.",
  request: {
    body: {
      content: { "application/json": { schema: SigninRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Signed in successfully",
      content: {
        "application/json": {
          schema: z.object({ success: z.literal(true), data: AuthTokenResponseSchema }),
        },
      },
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/auth/google",
  tags: ["Mobile Auth"],
  summary: "Sign in or register with Google",
  description: "Authenticate using a Google ID token. Creates account if new. Rate limited: 10 requests per 15 minutes.",
  request: {
    body: {
      content: { "application/json": { schema: GoogleAuthRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Signed in successfully (existing user)",
      content: {
        "application/json": {
          schema: z.object({ success: z.literal(true), data: GoogleAuthResponseSchema }),
        },
      },
    },
    201: {
      description: "Account created successfully (new user)",
      content: {
        "application/json": {
          schema: z.object({ success: z.literal(true), data: GoogleAuthResponseSchema }),
        },
      },
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/auth/refresh",
  tags: ["Mobile Auth"],
  summary: "Refresh access token",
  description: "Exchange a refresh token for a new access/refresh token pair. Rate limited: 20 requests per 15 minutes.",
  request: {
    body: {
      content: { "application/json": { schema: RefreshTokenRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Tokens refreshed",
      content: {
        "application/json": {
          schema: z.object({ success: z.literal(true), data: RefreshTokenResponseSchema }),
        },
      },
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/auth/session",
  tags: ["Mobile Auth"],
  summary: "Get current session",
  description: "Returns the authenticated user's profile and session info.",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: "Session data",
      content: {
        "application/json": {
          schema: z.object({ success: z.literal(true), data: SessionResponseSchema }),
        },
      },
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/auth/signout",
  tags: ["Mobile Auth"],
  summary: "Sign out",
  description: "Revoke the current refresh token. Optionally pass a specific refresh token to revoke.",
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: SignoutRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Signed out successfully",
      content: {
        "application/json": {
          schema: z.object({ success: z.literal(true), data: MessageResponseSchema }),
        },
      },
    },
    ...standardErrors,
  },
})
