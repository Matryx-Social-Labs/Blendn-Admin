import { NextResponse, type NextRequest } from "next/server"

import { logger } from "@/lib/logger"
import { rateLimit } from "@/lib/rate-limit"
import { unsubscribe } from "@/lib/unsubscribe"

/**
 * /api/email/unsubscribe?t=<token> — the List-Unsubscribe URL of lifecycle mail (SCRUM-1282, RFC 8058).
 *
 * POST unsubscribes: a mail provider's one-click (`List-Unsubscribe=One-Click` in the body, which is not read: the
 * token is the whole request) or the confirm page's form (`&from=page`, sent back to that page). A token that is not
 * ours is a 400 and writes nothing. Rate-limited here, not in `middleware.ts`, which is Edge and cannot reach Redis.
 *
 * GET never writes: link scanners and previews GET every link in a mail. It sends a person to `/unsubscribe`, which
 * shows one button that POSTs here.
 *
 * Outside `/api/mobile` and the middleware matcher, like the webhooks: no session, no CORS.
 */

export const dynamic = "force-dynamic"

const LIMIT = { windowMs: 60_000, maxRequests: 20 }

export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, LIMIT)
  if (limited) return limited
  const token = req.nextUrl.searchParams.get("t")
  if (!(await unsubscribe(token))) return NextResponse.json({ error: "This unsubscribe link is not valid." }, { status: 400 })
  logger.info("Unsubscribed from lifecycle mail")
  // A relative Location: the host the person came in on, whatever the proxy calls itself.
  if (req.nextUrl.searchParams.get("from") === "page") return new Response(null, { status: 303, headers: { Location: "/unsubscribe?done=1" } })
  return NextResponse.json({ unsubscribed: true })
}

export function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t") ?? ""
  return new Response(null, { status: 303, headers: { Location: `/unsubscribe?t=${encodeURIComponent(token)}` } })
}
