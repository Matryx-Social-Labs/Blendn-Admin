import { timingSafeEqual } from "crypto"
import { NextRequest } from "next/server"

import { notFoundResponse } from "@/lib/api-response"

export const dynamic = "force-dynamic"

/**
 * Proves an unhandled server error reaches Sentry (SCRUM-649). Off unless
 * `SENTRY_PROBE_TOKEN` is set (it is not set on production): the route then
 * 404s like any unknown path. With it set, a request carrying the token in
 * `x-probe-token` throws on purpose, which is exactly what a real unhandled 500
 * does, so Next hands it to `onRequestError`.
 */
export async function GET(req: NextRequest) {
  const expected = process.env.SENTRY_PROBE_TOKEN
  const given = req.headers.get("x-probe-token") ?? ""
  const ok = Boolean(expected) && given.length === expected!.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected!))
  if (!ok) return notFoundResponse("Not found")
  throw new Error(`sentry-probe: deliberate unhandled error (${req.nextUrl.searchParams.get("run") ?? "no run id"})`)
}
