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
  const givenBytes = Buffer.from(given)
  const expectedBytes = Buffer.from(expected ?? "")
  // Byte length, not string length: timingSafeEqual throws on unequal byte lengths (SCRUM-941).
  const ok = Boolean(expected) && givenBytes.length === expectedBytes.length && timingSafeEqual(givenBytes, expectedBytes)
  if (!ok) return notFoundResponse("Not found")
  throw new Error(`sentry-probe: deliberate unhandled error (${req.nextUrl.searchParams.get("run") ?? "no run id"})`)
}
