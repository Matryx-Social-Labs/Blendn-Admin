import { monitorEventLoopDelay } from "node:perf_hooks"
import { logger } from "@/lib/logger"
import { NextResponse } from "next/server"
import { db, poolStats } from "@/lib/db"

export const dynamic = "force-dynamic"

/*
 * How late the event loop ran over the last full minute (SCRUM-1221). The one
 * process saturating is what breaks first under a full room, and `SELECT 1`
 * never shows it; ops/07 alerts on `p99 > 100` and on `pool.waiting`.
 *
 * A fixed window rotated by this module, never reset by a read: the endpoint is
 * public, so a read that reset it would let any caller (or a second monitor)
 * wipe a spike before the alerting probe saw it. Zeros until the first minute
 * after this module loads (the first /api/health request) has passed.
 */
const LOOP_WINDOW_MS = 60_000
const NS_PER_MS = 1e6
const ms = (ns: number) => Math.round(ns / NS_PER_MS)

const loopDelay = monitorEventLoopDelay()
loopDelay.enable()
let lastLoopWindow = { p50: 0, p99: 0, max: 0 }
setInterval(() => {
  lastLoopWindow = { p50: ms(loopDelay.percentile(50)), p99: ms(loopDelay.percentile(99)), max: ms(loopDelay.max) }
  loopDelay.reset()
}, LOOP_WINDOW_MS).unref()

/**
 * Health check endpoint for Railway deployment
 * Checks database connectivity and returns service status
 *
 * ## Two kinds of health, deliberately separated
 *
 * `status` is **infrastructure only**, because Railway gates deploys on this
 * endpoint: a 503 here stops the rollout. Matching coverage being poor is a
 * product problem, not a reason to refuse to deploy the fix for it. It was
 * under `matching` here until SCRUM-946: this endpoint is public, unlimited and
 * uncached, so product metrics moved to `/api/health/matching` (app admins).
 *
 * ## Why matching coverage exists at all
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
 *
 * ## Counts only
 *
 * `pool`, `eventLoopDelayMs` and `sockets` are numbers about this process,
 * nothing about a person; they are what ops/07 alerts on.
 */
export async function GET() {
  const health: Record<string, unknown> = {
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "blendn-admin",
    version: process.env.npm_package_version || "0.1.0",
    database: "unknown",
    pool: null,
    eventLoopDelayMs: lastLoopWindow,
    sockets: globalThis.__blendnSocketIo?.engine.clientsCount ?? null,
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

  // After the query, so the pool exists on a fresh process.
  health.pool = poolStats()

  const statusCode = health.status === "ok" ? 200 : 503

  return NextResponse.json(health, { status: statusCode })
}
