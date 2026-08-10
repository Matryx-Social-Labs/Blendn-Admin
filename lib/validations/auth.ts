import { z } from "zod"
import { MIN_PASSWORD_LENGTH } from "@/lib/password"

export const signupSchema = z.object({
  email: z.string().email("Invalid email address"),
  /*
   * The same floor the reset form enforces, imported rather than retyped.
   *
   * This was `.min(8)` while `lib/password.ts` required 12 and was never called
   * on the mobile path. The two rules disagreeing is not a cosmetic
   * inconsistency: a user could sign up with an eight-character password and
   * then be permanently unable to reset to anything like it, because
   * `/api/auth/reset-password` runs `checkPassword` and would refuse every
   * replacement. One constant, one rule.
   */
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(100, "Password must be at most 100 characters"),
  name: z.string().min(1, "Name is required").max(100, "Name is too long").optional(),
  deviceInfo: z
    .object({
      platform: z.string().optional(),
      device: z.string().optional(),
      appVersion: z.string().optional(),
    })
    .optional(),
})

export const signinSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
  deviceInfo: z
    .object({
      platform: z.string().optional(),
      device: z.string().optional(),
      appVersion: z.string().optional(),
    })
    .optional(),
})

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
})

export type SignupInput = z.infer<typeof signupSchema>
export type SigninInput = z.infer<typeof signinSchema>
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>
