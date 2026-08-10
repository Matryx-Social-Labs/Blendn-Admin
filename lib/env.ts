import { logger } from "./logger"
import { z } from "zod"

/**
 * Environment variable validation schema
 * Validates required environment variables at startup
 */
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // NextAuth
  NEXTAUTH_URL: z.string().url("NEXTAUTH_URL must be a valid URL"),
  NEXTAUTH_SECRET: z.string().min(32, "NEXTAUTH_SECRET must be at least 32 characters"),

  // Mobile API
  MOBILE_JWT_SECRET: z.string().min(32, "MOBILE_JWT_SECRET must be at least 32 characters"),

  // Tigris object storage (optional — uploads are disabled without it).
  // These names must match what lib/tigris.ts actually reads; they were
  // previously documented as AWS_* here and in DEPLOYMENT.md, which meant a
  // deployment configured from the docs got uploads silently switched off.
  TIGRIS_ENDPOINT: z.string().optional(),
  TIGRIS_ACCESS_KEY: z.string().optional(),
  TIGRIS_SECRET_KEY: z.string().optional(),
  TIGRIS_BUCKET: z.string().default("blendn-media"),
  TIGRIS_REGION: z.string().default("auto"),

  // OpenAI (optional — moderation degrades to keyword-only if absent)
  OPENAI_API_KEY: z.string().optional(),

  // Landing-page lead ingest. Optional because an environment that does not
  // serve organizers.blendn.app is a valid environment — but validated when
  // present, because a short shared secret is worse than an obvious absence.
  //
  // Comma-separated to make rotation two deploys instead of a flag day. The
  // length check applies to the whole list, which is deliberately loose: the
  // real guarantee is constant-time comparison in lib/leads.ts, not this.
  LANDING_INGEST_TOKEN: z
    .string()
    .min(32, "LANDING_INGEST_TOKEN must be at least 32 characters")
    .optional(),
  /// Where a new demo request is announced. Both optional and both free —
  /// set either, both, or neither. Nothing set means no notification and an
  /// info log, never a throw.
  LEADS_NOTIFY_EMAIL: z.string().email().optional(),
  /// A Slack (or Discord-compatible) incoming webhook. This is a bearer
  /// secret: anyone holding the URL can post to that channel.
  LEADS_SLACK_WEBHOOK_URL: z.string().url().optional(),

  // Two names for one deployment: the dashboard is served on one host and the
  // mobile API on the other. Both optional, and the rule only applies when
  // BOTH are set — half-configured is a mistake, not a policy, and enforcing
  // half of it would break one surface for no stated reason. Unset everywhere
  // means everything serves everywhere, which is right for local development.
  DASHBOARD_HOST: z.string().optional(),
  API_HOST: z.string().optional(),

  // Application
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.string().default("3000"),
})

export type Env = z.infer<typeof envSchema>

/**
 * Validate environment variables
 * Call this at application startup
 */
export function validateEnv(): Env {
  const parsed = envSchema.safeParse(process.env)

  if (!parsed.success) {
    logger.error("Invalid environment variables", {
      fieldErrors: parsed.error.flatten().fieldErrors,
    })
    throw new Error("Invalid environment variables")
  }

  return parsed.data
}

/**
 * Get validated environment variables
 * Use this instead of process.env directly
 */
export function getEnv(): Env {
  return envSchema.parse(process.env)
}

/**
 * Why Google sign-in is about to fail, or null if the config is coherent.
 *
 * This exists because it already happened. Production ran with only
 * `GOOGLE_IOS_CLIENT_ID` set, and `@react-native-google-signin/google-signin`
 * asks Google to audience the id token to the **web** ("server") client id --
 * so `verifyGoogleIdToken` rejected every real sign-in on `aud`, and the only
 * trace was a `Google token audience mismatch` warning that reads like an
 * attacker rather than like our own misconfiguration.
 *
 * Nothing failed loudly: the health check was green, the server booted, and
 * email sign-in worked. A config that breaks one auth path and nothing else is
 * exactly the config that survives unnoticed, so it has to announce itself at
 * boot.
 *
 * Deliberately a warning and not a throw. An environment that offers only
 * email sign-in is legitimate, and refusing to boot over it would turn a
 * degraded login into an outage.
 */
export function googleSignInConfigWarning(
  // The three values, not `process.env`. This repo's `ProcessEnv` is a closed
  // type with no index signature, so neither a default nor a whole-env
  // parameter typechecks without a cast — and a cast here would defeat the
  // point of a function whose whole job is catching a config mistake.
  env: {
    GOOGLE_WEB_CLIENT_ID?: string
    GOOGLE_IOS_CLIENT_ID?: string
    GOOGLE_ANDROID_CLIENT_ID?: string
  }
): string | null {
  const web = env.GOOGLE_WEB_CLIENT_ID
  const native = env.GOOGLE_IOS_CLIENT_ID || env.GOOGLE_ANDROID_CLIENT_ID

  if (!web && !native) {
    return "no GOOGLE_*_CLIENT_ID set — every Google sign-in will be rejected (email sign-in is unaffected)"
  }
  if (!web) {
    return "GOOGLE_WEB_CLIENT_ID unset while a native client id is set — the mobile SDK audiences its id token to the *web* client, so every Google sign-in will fail on `aud`"
  }
  return null
}

/**
 * Check if running in production
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production"
}

/**
 * Check if running in development
 */
export function isDevelopment(): boolean {
  return process.env.NODE_ENV === "development"
}
