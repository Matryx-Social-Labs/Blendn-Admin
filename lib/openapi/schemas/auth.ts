import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { DeviceInfoSchema } from "./common"

// Request schemas (extending existing validations with OpenAPI metadata)
export const SignupRequestSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8).max(100),
    name: z.string().min(1).max(100).optional(),
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
