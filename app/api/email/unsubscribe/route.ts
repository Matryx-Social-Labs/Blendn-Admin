import { NextResponse, type NextRequest } from "next/server"

import { logger } from "@/lib/logger"
import { rateLimit } from "@/lib/rate-limit"
import { unsubscribe } from "@/lib/unsubscribe"

/**
 * /api/email/unsubscribe?t=<token> — the List-Unsubscribe URL of lifecycle mail (SCRUM-1282, RFC 8058).
 *
 * POST unsubscribes: a mail provider's one-click (`List-Unsubscribe=One-Click` in the body, which is not read: the
 * token is the whole request) or the confirm page's form (`&from=page`, sent back to that page either way). A token
 * that is not ours is a 400 and writes nothing. Rate-limited here, not in `middleware.ts`, which is Edge and cannot
 * reach Redis; generously, because one-click POSTs come from a mail provider's shared addresses.
 *
 * GET never writes: link scanners and previews GET every link in a mail. It sends a person to `/unsubscribe`, which
 * shows one button that POSTs here.
 *
 * Outside `/api/mobile` and the middleware matcher, like the webhooks: no session, no CORS.
 */

export const dynamic = "force-dynamic"

const LIMIT = { windowMs: 60_000, maxRequests: 120 }

/** A relative Location: the host the person came in on, whatever the proxy calls itself. */
const seeOther = (location: string) => new Response(null, { status: 303, headers: { Location: location } })

export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, LIMIT)
  if (limited) return limited
  const token = req.nextUrl.searchParams.get("t")
  const fromPage = req.nextUrl.searchParams.get("from") === "page"
  let done: boolean
  try {
    done = await unsubscribe(token)
  } catch (error) {
    // A 5xx, so a mail provider's one-click is retried.
    logger.error("Unsubscribe failed", { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: "Could not unsubscribe. Try again in a moment." }, { status: 500 })
  }
  if (!done) {
    return fromPage ? seeOther(`/unsubscribe?t=${encodeURIComponent(token ?? "")}`) : NextResponse.json({ error: "This unsubscribe link is not valid." }, { status: 400 })
  }
  logger.info("Unsubscribed from lifecycle mail")
  return fromPage ? seeOther("/unsubscribe?done=1") : NextResponse.json({ unsubscribed: true })
}

export function GET(req: NextRequest) {
  return seeOther(`/unsubscribe?t=${encodeURIComponent(req.nextUrl.searchParams.get("t") ?? "")}`)
}
