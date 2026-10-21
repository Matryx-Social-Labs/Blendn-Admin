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
    "account's password from many addresses. 403 `ACCOUNT_SUSPENDED` or `ACCOUNT_STAFF` (with the sentence " +
    "to show), checked after the password. A deleted account is the generic 401 `UNAUTHORIZED`: a password " +
    "sign-in never confirms an account existed.",
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
  description:
    "Authenticate using a Google ID token. Creates account if new. Rate limited: 10 requests per 15 minutes. " +
    "403 `ACCOUNT_SUSPENDED` / `ACCOUNT_STAFF`; 401 `ACCOUNT_DELETED` (\"Account not found\"). The Apple route answers the same.",
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
  description:
    "Exchange a refresh token for a new access/refresh token pair. Rate limited: 20 requests per 15 minutes. " +
    "403 with a sentence to show when the account is suspended (`ACCOUNT_SUSPENDED`) or is a staff account " +
    "(`ACCOUNT_STAFF`) — for a suspension, also for the token the suspension revoked (signed by us, unexpired). " +
    "Any other refused token is a 401 whose `errorCode` is the reason when we know it, always with the sentence " +
    "\"Invalid or expired refresh token\": `ACCOUNT_DELETED` (a signed, unexpired token of a deleted account), " +
    "`PASSWORD_RESET` (its session was ended by a password reset or change), `SESSION_REVOKED_ELSEWHERE` (ended by " +
    "sign-out-everywhere), else `UNAUTHORIZED`. A forged or expired token learns nothing.",
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
  description:
    "Returns the authenticated user's profile and session info, and `signInMethod`. 403 `ACCOUNT_SUSPENDED` / " +
    "`ACCOUNT_STAFF` with the sentence to show; 404 `ACCOUNT_DELETED` (\"User not found\"). An account " +
    "suspended, deleted or signed out in the last twenty minutes is turned away earlier, as a bare 401 \"Invalid or " +
    "expired token\"; the refresh then says why.",
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
  description:
    "Revoke the current refresh token. Optionally pass a specific refresh token to revoke. With none, every phone " +
    "session of the account ends (refresh tokens, push tokens, earlier access tokens, live sockets) and the other " +
    "phones' next refresh answers 401 `SESSION_REVOKED_ELSEWHERE`.",
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
