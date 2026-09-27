import { z } from "zod"
import { MIN_PASSWORD_LENGTH } from "@/lib/password"
import { ACCOUNT_MIN_AGE, ADULTS_ONLY } from "@/lib/age"

export const signupSchema = z.object({
  // Lowercased: one address is one account whatever its case (SCRUM-328).
  email: z.string().trim().toLowerCase().email("Invalid email address"),
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
   * Required, 18 or over: Blend'n is 18+ (SCRUM-330).
   *
   * The app has sent it since the field shipped, but labelled it optional, so
   * a build that is already installed can still post a sign-up without one.
   * That person gets this sentence as the form's error — the app shows the
   * first field message it is given — and types their age. A 400 that says
   * what to do, rather than an account nobody has checked the age of.
   *
   * Coerced, so a blank or missing age arrives as NaN and takes the
   * invalid-type message; `min` catches everyone under the floor.
   */
  age: z.coerce
    .number({ error: `Enter your age. ${ADULTS_ONLY}` })
    .int()
    .min(ACCOUNT_MIN_AGE, ADULTS_ONLY)
    .max(120),
  deviceInfo: z
    .object({
      platform: z.string().optional(),
      device: z.string().optional(),
      appVersion: z.string().optional(),
    })
    .optional(),
})

export const signinSchema = z.object({
  // Lowercased: one address is one account whatever its case (SCRUM-328).
  email: z.string().trim().toLowerCase().email("Invalid email address"),
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
