import { timingSafeEqual } from "node:crypto"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { logger } from "@/lib/logger"
import { NextResponse } from "next/server"
import { db, poolStats } from "@/lib/db"
import { healthMetricsToken } from "@/lib/env"
import { staleLoops } from "@/lib/heartbeat"

export const dynamic = "force-dynamic"

/*
 * How late the event loop ran over the last full minute (SCRUM-1221). The one
 * process saturating is what breaks first under a full room, and `SELECT 1`
 * never shows it; ops/07 alerts on `p99 > 100` and on `pool.waiting`.
 *
 * A fixed window rotated by this module, never reset by a read: the endpoint is
 * public, so a read that reset it would let any caller (or a second monitor)
 * wipe a spike before the alerting probe saw it. `null` until the first minute
 * after this module loads (the first /api/health request) has passed.
 */
const LOOP_WINDOW_MS = 60_000
const NS_PER_MS = 1e6
const ms = (ns: number) => Math.round(ns / NS_PER_MS)

const loopDelay = monitorEventLoopDelay()
loopDelay.enable()
let lastLoopWindow: { p50: number; p99: number; max: number } | null = null
setInterval(() => {
  lastLoopWindow = { p50: ms(loopDelay.percentile(50)), p99: ms(loopDelay.percentile(99)), max: ms(loopDelay.max) }
  loopDelay.reset()
}, LOOP_WINDOW_MS).unref()

/*
 * The gauges are for the monitor, not the public: a live socket count is how
 * many people use Blendn right now, and `pool.waiting` with the loop delay is a
 * free feedback signal for anyone tuning a burst. They need
 * `Authorization: Bearer $HEALTH_METRICS_TOKEN`; without it the plain payload
 * still answers 200, so Railway's healthcheck is unchanged. With no token
 * configured they are omitted on Railway production and shown elsewhere.
 */
function mayReadGauges(request?: Request): boolean {
  const token = healthMetricsToken()
  if (!token) return process.env.RAILWAY_ENVIRONMENT_NAME !== "production"
  const want = Buffer.from(`Bearer ${token}`)
  const have = Buffer.from(request?.headers.get("authorization") ?? "")
  // Length first: timingSafeEqual throws on a mismatch, and the length is not the secret.
  return have.length === want.length && timingSafeEqual(have, want)
}

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
 * ## Process gauges, for the monitor only
 *
 * `pool`, `eventLoopDelayMs`, `sockets` and `loops.stale` are about this process,
 * nothing about a person, behind a token (`mayReadGauges`); they are what
 * ops/07 alerts on.
 */
export async function GET(request?: Request) {
  const health: Record<string, unknown> = {
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "blendn-admin",
    // The deployed commit, set by Railway on a GitHub-triggered deploy (SCRUM-1218); the package version anywhere else.
    version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || process.env.npm_package_version || "0.1.0",
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

  // After the query, so the pool exists on a fresh process; reported when the query failed too, which is when it matters.
  if (mayReadGauges(request)) {
    health.pool = poolStats()
    health.eventLoopDelayMs = lastLoopWindow
    health.sockets = globalThis.__blendnSocketIo?.engine.clientsCount ?? null
    // Loops quiet for three of their intervals (lib/heartbeat.ts). Never in the status: a redeploy is the fix, not a restart loop.
    health.loops = { stale: staleLoops() }
  }

  const statusCode = health.status === "ok" ? 200 : 503

  return NextResponse.json(health, { status: statusCode })
}
