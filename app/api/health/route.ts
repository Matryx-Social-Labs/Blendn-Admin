import { logger } from "@/lib/logger"
import { NextResponse } from "next/server"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"

/**
 * Health check endpoint for Railway deployment
 * Checks database connectivity and returns service status
 */
export async function GET() {
  const health = {
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "blendn-admin",
    version: process.env.npm_package_version || "0.1.0",
    database: "unknown",
  }

  try {
    // Test database connection
    await db.$queryRaw`SELECT 1`
    health.database = "connected"
  } catch (error) {
    health.status = "degraded"
    health.database = "disconnected"
    logger.error("Health check - Database error", { error: error instanceof Error ? error.message : String(error) })
  }

  const statusCode = health.status === "ok" ? 200 : 503

  return NextResponse.json(health, { status: statusCode })
}
