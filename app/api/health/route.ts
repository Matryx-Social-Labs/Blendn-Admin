import { logger } from "@/lib/logger"
import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { MIN_INTERESTS_TO_RANK, interestCoverage } from "@/lib/interest-coverage"

export const dynamic = "force-dynamic"

/**
 * Health check endpoint for Railway deployment
 * Checks database connectivity and returns service status
 *
 * ## Two kinds of health, deliberately separated
 *
 * `status` is **infrastructure only**, because Railway gates deploys on this
 * endpoint: a 503 here stops the rollout. Matching coverage being poor is a
 * product problem, not a reason to refuse to deploy the fix for it, so it lives
 * under `matching` and never changes the status code.
 *
 * ## Why matching coverage is here at all
 *
 * `user_interests` has been empty in production while every test stayed green,
 * so every match card returned "no shared interests" for everyone and nobody
 * noticed for weeks. The ranking degrades honestly and silently, which is the
 * worst combination: nothing errors, so nothing tells you.
 *
 * A row count would not have caught it either -- one power user with one
 * interest turns a count non-zero while the room stays unmatchable. What
 * matters is the share of people who actually turned up who have enough
 * structured interests to be ranked at all.
 */
export async function GET() {
  const health: Record<string, unknown> = {
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

  if (health.database === "connected") {
    try {
      health.matching = await interestCoverage()
    } catch (error) {
      // Never let this break the health check. A deploy must not fail because
      // a diagnostic query did.
      health.matching = { status: "unknown", minInterestsToRank: MIN_INTERESTS_TO_RANK }
      logger.warn("Health check - interest coverage query failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const statusCode = health.status === "ok" ? 200 : 503

  return NextResponse.json(health, { status: statusCode })
}
