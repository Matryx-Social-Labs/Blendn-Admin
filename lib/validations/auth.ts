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
  /*
   * Required, matching the app, which has always demanded it
   * (`app/sign-in.tsx`). The server permitting it was the only path that could
   * produce an account the moderation queue can identify by nothing but an
   * email address — and a pseudonymous room only works if a real person sits
   * behind the pseudonym server-side.
   */
  name: z.string().min(1, "Name is required").max(100, "Name is too long"),
  /*
   * Accepted, deliberately NOT required yet.
   *
   * The shipped app does not send it. Making it required the moment this
   * deploys would 400 every new password signup in production, because the
   * server reaches staging before an app build does. It becomes required in
   * the PR after the app ships the field — accept first, require second.
   *
   * The floor is 13 here and the dating gate is 18 elsewhere: a 16-year-old
   * may use the app, and may not be in the dating pool.
   */
  age: z.coerce.number().int().min(13, "You must be at least 13").max(120).optional(),
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
