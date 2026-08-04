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
