import { z } from "zod"

/**
 * Environment variable validation schema
 * Validates required environment variables at startup
 */
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_URL: z.string().optional(),

  // NextAuth
  NEXTAUTH_URL: z.string().url("NEXTAUTH_URL must be a valid URL"),
  NEXTAUTH_SECRET: z.string().min(32, "NEXTAUTH_SECRET must be at least 32 characters"),

  // Mobile API
  MOBILE_JWT_SECRET: z.string().min(32, "MOBILE_JWT_SECRET must be at least 32 characters"),

  // AWS S3 (optional)
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_S3_BUCKET: z.string().optional(),

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
    console.error("❌ Invalid environment variables:")
    console.error(parsed.error.flatten().fieldErrors)
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
