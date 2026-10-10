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
  // Private documents (claim evidence). Defaults to `${TIGRIS_BUCKET}-private`;
  // created on boot if missing. See lib/tigris.ts.
  TIGRIS_PRIVATE_BUCKET: z.string().optional(),
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
  /**
   * Comma-separated ISO country codes the address search is restricted to, or
   * empty for no restriction. Defaults to India, which is where the product
   * launches.
   *
   * The restriction was hardcoded as `countrycodes=in` with nothing naming it,
   * and it fails in the least helpful way available: an organiser outside India
   * types their venue, gets **no results and no explanation**, and cannot fall
   * back to typing coordinates because the form derives those from the pin. A
   * product constraint no other file states, enforced silently by a query
   * parameter.
   *
   * Note the asymmetry it creates, which is now deliberate rather than
   * accidental: reverse geocoding (pin to address) has never been restricted,
   * so dropping a pin abroad resolves fine while searching for it does not.
   */
  GEOCODE_COUNTRY_CODES: z.string().default("in"),
  /** Nominatim's base URL for /api/geocode. Unset in production; CI's e2e points it at a stub (SCRUM-357). */
  GEOCODE_UPSTREAM: z.string().url().optional(),
  /** Overpass interpreter URL for /api/footprint. Unset in production (main + mirror); CI's e2e stubs it. */
  FOOTPRINT_UPSTREAM: z.string().url().optional(),
  DASHBOARD_HOST: z.string().optional(),
  API_HOST: z.string().optional(),
  /**
   * Where Blendn+ is gated (`plusGatedIn`). Unset or `false`: launch season
   * everywhere, everything unlocked. `true`: gated everywhere. Otherwise a
   * comma-separated list of cities, matched case-insensitively against a
   * venue's or event's `city` (`Bengaluru,Mumbai`).
   */
  PLUS_GATING: z.string().optional(),

  /**
   * RevenueCat (plan v2 §5). The value the RevenueCat dashboard sends as the
   * webhook's `Authorization` header is `Bearer <this>`. We choose it, so 32
   * or more. Unset: the webhook refuses everything and nothing grants Blendn+
   * from a store — the feature is off.
   */
  REVENUECAT_WEBHOOK_SECRET: z.string().min(32, "REVENUECAT_WEBHOOK_SECRET must be at least 32 characters").optional(),

  /**
   * Razorpay (plan v2 §9.2). All optional: unset, the Plan page says payments
   * are off and the webhook refuses everything. A key id names its mode
   * (`rzp_test_…` / `rzp_live_…`), and the refinement below holds each mode to
   * its environment, so a live key cannot charge real money from staging and a
   * test key cannot hand out free Analytics in production.
   */
  RAZORPAY_KEY_ID: z.string().regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, "RAZORPAY_KEY_ID must look like rzp_test_… or rzp_live_…").optional(),
  /** Razorpay generates this one (24 characters today), so the floor is theirs, not 32. */
  RAZORPAY_KEY_SECRET: z.string().min(16, "RAZORPAY_KEY_SECRET is shorter than any Razorpay key secret").optional(),
  /** We choose this one, in the Razorpay dashboard: a shared HMAC secret, so 32 or more. */
  RAZORPAY_WEBHOOK_SECRET: z.string().min(32, "RAZORPAY_WEBHOOK_SECRET must be at least 32 characters").optional(),
  /** Railway's name for the environment; "production" is the only one where a live key belongs. */
  RAILWAY_ENVIRONMENT_NAME: z.string().optional(),

  // Application
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.string().default("3000"),
})

/**
 * Why this Razorpay key id does not belong in this environment, or null.
 *
 * Pure, so `lib/razorpay.ts` refuses the same thing at the moment of a call —
 * a script or a route that never ran `validateEnv` is still held to it.
 */
export function razorpayKeyModeProblem(
  keyId: string | undefined,
  environmentName: string | undefined
): string | null {
  if (!keyId) return null
  const production = environmentName === "production"
  if (production && !keyId.startsWith("rzp_live_")) {
    return "RAZORPAY_KEY_ID is a test key in production: payments would grant Analytics for test money"
  }
  if (!production && !keyId.startsWith("rzp_test_")) {
    return `RAZORPAY_KEY_ID is a live key outside production (${environmentName ?? "no Railway environment"}): it would charge real money`
  }
  return null
}

const refinedEnvSchema = envSchema.superRefine((env, ctx) => {
  const mode = razorpayKeyModeProblem(env.RAZORPAY_KEY_ID, env.RAILWAY_ENVIRONMENT_NAME)
  if (mode) ctx.addIssue({ code: "custom", path: ["RAZORPAY_KEY_ID"], message: mode })
  // Half a key pair is a mistake, not a policy: checkout would fail on the
  // first click with nothing at boot to say why.
  if (Boolean(env.RAZORPAY_KEY_ID) !== Boolean(env.RAZORPAY_KEY_SECRET)) {
    ctx.addIssue({
      code: "custom",
      path: ["RAZORPAY_KEY_SECRET"],
      message: "set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET together, or neither",
    })
  }
  // Keys without the webhook secret take money and grant nothing: the
  // entitlement is written only by the signed webhook.
  if (env.RAZORPAY_KEY_ID && !env.RAZORPAY_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: "custom",
      path: ["RAZORPAY_WEBHOOK_SECRET"],
      message: "RAZORPAY_WEBHOOK_SECRET is required once RAZORPAY_KEY_ID is set: without it a payment is taken and never granted",
    })
  }
})

export interface RazorpayKeys {
  keyId: string
  keySecret: string
}

/**
 * The Razorpay API keys, or null when payments are off here. Off includes
 * "keys set, webhook secret missing", for the reason above. Throws on a key in
 * the wrong mode, so a script or route that never ran `validateEnv` is still
 * held to it. The one reader of these variables (with the secret below).
 */
export function razorpayKeys(): RazorpayKeys | null {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim()
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim()
  if (!keyId || !keySecret || !razorpayWebhookSecret()) return null
  const problem = razorpayKeyModeProblem(keyId, process.env.RAILWAY_ENVIRONMENT_NAME)
  if (problem) throw new Error(problem)
  return { keyId, keySecret }
}

/** The webhook's shared secret, or null when the webhook is off (unset or too short to be ours). */
export function razorpayWebhookSecret(): string | null {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim()
  return secret && secret.length >= 32 ? secret : null
}

export type Env = z.infer<typeof envSchema>

/**
 * Validate environment variables
 * Call this at application startup
 */
export function validateEnv(): Env {
  const parsed = refinedEnvSchema.safeParse(process.env)

  if (!parsed.success) {
    logger.error("Invalid environment variables", {
      fieldErrors: parsed.error.flatten().fieldErrors,
    })
    throw new Error("Invalid environment variables")
  }

  return parsed.data
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
 * Is Blendn+ gated in this city (`PLUS_GATING`)? A city not gated is in its
 * launch season: every Plus feature is everyone's (plan v2 §9.3). Cities are
 * compared trimmed and lower-cased, the way `cityKey` groups them; a place
 * with no city is gated only when everywhere is.
 */
export function plusGatedIn(city: string | null | undefined): boolean {
  const raw = process.env.PLUS_GATING?.trim().toLowerCase()
  if (!raw || raw === "false") return false
  if (raw === "true") return true
  const key = city?.trim().toLowerCase()
  return Boolean(key) && raw.split(",").some((c) => c.trim() === key)
}

/** Is Blendn+ gated anywhere at all? False in a launch season everywhere, so a gate can skip its queries. */
export function plusGatedAnywhere(): boolean {
  const raw = process.env.PLUS_GATING?.trim().toLowerCase()
  return Boolean(raw) && raw !== "false"
}

/** The RevenueCat webhook's shared secret, or null when the webhook is off (unset or too short to be ours). */
export function revenuecatWebhookSecret(): string | null {
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET?.trim()
  return secret && secret.length >= 32 ? secret : null
}

/**
 * The store environment whose purchases grant Blendn+ here: real money in
 * production, sandbox everywhere else. The other one is recorded and never
 * granted, so a sandbox purchase cannot hand out Plus in production and a real
 * one cannot on staging (test plan MN-U05). Same rule as the Razorpay key mode.
 */
export function storeEnvironment(): "PRODUCTION" | "SANDBOX" {
  return process.env.RAILWAY_ENVIRONMENT_NAME === "production" ? "PRODUCTION" : "SANDBOX"
}

/**
 * The dashboard's own host when the host split is on (`DASHBOARD_HOST`, bare:
 * no scheme), else null. `middleware.ts` reads the variable itself because it
 * runs on the Edge; everything else reads it here.
 */
export function dashboardHost(): string | null {
  // Bare by contract; a scheme or a trailing slash pasted in is forgiven here,
  // so a link built from it is never "https://https://…" (step 5 review).
  const host = process.env.DASHBOARD_HOST?.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "")
  return host ? host : null
}
