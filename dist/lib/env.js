"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEnv = validateEnv;
exports.getEnv = getEnv;
exports.isProduction = isProduction;
exports.isDevelopment = isDevelopment;
const zod_1 = require("zod");
/**
 * Environment variable validation schema
 * Validates required environment variables at startup
 */
const envSchema = zod_1.z.object({
    // Database
    DATABASE_URL: zod_1.z.string().min(1, "DATABASE_URL is required"),
    DIRECT_URL: zod_1.z.string().optional(),
    // NextAuth
    NEXTAUTH_URL: zod_1.z.string().url("NEXTAUTH_URL must be a valid URL"),
    NEXTAUTH_SECRET: zod_1.z.string().min(32, "NEXTAUTH_SECRET must be at least 32 characters"),
    // Mobile API
    MOBILE_JWT_SECRET: zod_1.z.string().min(32, "MOBILE_JWT_SECRET must be at least 32 characters"),
    // AWS S3 (optional)
    AWS_ACCESS_KEY_ID: zod_1.z.string().optional(),
    AWS_SECRET_ACCESS_KEY: zod_1.z.string().optional(),
    AWS_REGION: zod_1.z.string().default("us-east-1"),
    AWS_S3_BUCKET: zod_1.z.string().optional(),
    // Application
    NODE_ENV: zod_1.z.enum(["development", "production", "test"]).default("development"),
    PORT: zod_1.z.string().default("3000"),
});
/**
 * Validate environment variables
 * Call this at application startup
 */
function validateEnv() {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
        console.error("❌ Invalid environment variables:");
        console.error(parsed.error.flatten().fieldErrors);
        throw new Error("Invalid environment variables");
    }
    return parsed.data;
}
/**
 * Get validated environment variables
 * Use this instead of process.env directly
 */
function getEnv() {
    return envSchema.parse(process.env);
}
/**
 * Check if running in production
 */
function isProduction() {
    return process.env.NODE_ENV === "production";
}
/**
 * Check if running in development
 */
function isDevelopment() {
    return process.env.NODE_ENV === "development";
}
