import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { MIN_PASSWORD_LENGTH } from "@/lib/password"
import { DeviceInfoSchema } from "./common"

/*
 * These duplicate `lib/validations/auth.ts` by hand, and they have to.
 *
 * `zod-to-openapi` patches the zod instance it is handed; Next gives the two
 * modules separate copies, so `.openapi()` does not exist on anything built in
 * `lib/validations`. Importing the validator here breaks the build while jest
 * stays green — that has bitten this repo twice.
 *
 * A plain constant crosses that boundary safely, so at least the number cannot
 * drift. `__tests__/openapi-coverage.test.ts` pins the rest field by field.
 */

// Request schemas (extending existing validations with OpenAPI metadata)
export const SignupRequestSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(MIN_PASSWORD_LENGTH).max(100),
    name: z.string().min(1).max(100),
    // Optional for one release only. The shipped app does not send it yet, and
    // requiring it before an app build ships would 400 every new signup.
    age: z.number().int().min(13).max(120).optional(),
    deviceInfo: DeviceInfoSchema.optional(),
  })
  .openapi("SignupRequest")

export const SigninRequestSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
    deviceInfo: DeviceInfoSchema.optional(),
  })
  .openapi("SigninRequest")

export const GoogleAuthRequestSchema = z
  .object({
    idToken: z.string(),
    deviceInfo: DeviceInfoSchema.optional(),
  })
  .openapi("GoogleAuthRequest")

export const RefreshTokenRequestSchema = z
  .object({
    refreshToken: z.string().min(1),
  })
  .openapi("RefreshTokenRequest")

export const SignoutRequestSchema = z
  .object({
    refreshToken: z.string().optional(),
  })
  .openapi("SignoutRequest")

// Response schemas
const UserProfileSchema = z.object({
  id: z.string().uuid(),
  phone: z.string().nullable(),
  age: z.number().nullable(),
  location: z.string().nullable(),
  bio: z.string().nullable(),
  occupation: z.string().nullable(),
  education: z.string().nullable(),
  photos: z.array(z.string()).nullable(),
  onboarded: z.boolean(),
})

export const AuthUserSchema = z
  .object({
    id: z.string(),
    email: z.string().email(),
    name: z.string(),
    image: z.string().nullable().optional(),
    emailVerified: z.boolean().optional(),
    createdAt: z.string().datetime().optional(),
    profile: UserProfileSchema.nullable().optional(),
  })
  .openapi("AuthUser")

export const AuthTokenResponseSchema = z
  .object({
    user: AuthUserSchema,
    accessToken: z.string(),
    refreshToken: z.string(),
  })
  .openapi("AuthTokenResponse")

export const GoogleAuthResponseSchema = z
  .object({
    user: AuthUserSchema,
    accessToken: z.string(),
    refreshToken: z.string(),
    isNewUser: z.boolean(),
  })
  .openapi("GoogleAuthResponse")

export const RefreshTokenResponseSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
  })
  .openapi("RefreshTokenResponse")

export const SessionResponseSchema = z
  .object({
    id: z.string(),
    email: z.string().email(),
    name: z.string(),
    emailVerified: z.boolean(),
    image: z.string().nullable(),
    createdAt: z.string().datetime(),
    profile: UserProfileSchema.nullable(),
  })
  .openapi("SessionResponse")

export const MessageResponseSchema = z
  .object({
    message: z.string(),
  })
  .openapi("MessageResponse")

// Register all
registry.register("SignupRequest", SignupRequestSchema)
registry.register("SigninRequest", SigninRequestSchema)
registry.register("GoogleAuthRequest", GoogleAuthRequestSchema)
registry.register("RefreshTokenRequest", RefreshTokenRequestSchema)
registry.register("SignoutRequest", SignoutRequestSchema)
registry.register("AuthUser", AuthUserSchema)
registry.register("AuthTokenResponse", AuthTokenResponseSchema)
registry.register("GoogleAuthResponse", GoogleAuthResponseSchema)
registry.register("RefreshTokenResponse", RefreshTokenResponseSchema)
registry.register("SessionResponse", SessionResponseSchema)
registry.register("MessageResponse", MessageResponseSchema)
