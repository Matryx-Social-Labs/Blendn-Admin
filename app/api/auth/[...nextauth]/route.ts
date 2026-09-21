import type { NextRequest } from "next/server"
import NextAuth from "next-auth"

import { authOptions } from "@/lib/auth"
import { createAuthRateLimit, rateLimit } from "@/lib/rate-limit"

const handler = NextAuth(authOptions)

/**
 * The dashboard sign-in limit lives HERE, in the Node runtime, not in the
 * middleware.
 *
 * It used to be in `middleware.ts`, which Next 16 still runs on the Edge
 * runtime. There the Redis client cannot load ("Cannot find module
 * 'node:crypto'"), the store falls back to an in-process Map, and an edge
 * isolate does not keep a Map between invocations — so on staging, with five
 * attempts per fifteen minutes configured, one request in six was refused and
 * the rest were checked against the password (SCRUM-194). The route-level
 * limiters, this one included now, log "Rate limiting backed by Redis".
 *
 * Same config and the same 429 body: the login page already reads either as
 * "Too many sign-in attempts from this network".
 */
async function POST(req: NextRequest, ctx: { params: Promise<{ nextauth: string[] }> }) {
  if (req.nextUrl.pathname === "/api/auth/callback/credentials") {
    const limited = await rateLimit(req, createAuthRateLimit("dashboard-signin"))
    if (limited) return limited
  }
  return handler(req, ctx)
}

export { handler as GET, POST }
