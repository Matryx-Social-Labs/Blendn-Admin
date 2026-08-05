import { NextRequest, NextResponse } from "next/server"

import { logger } from "@/lib/logger"
import { sweepExpiredChats } from "@/lib/chat-lifecycle"

/**
 * Manual trigger for the chat lifecycle sweep.
 *
 * The sweep normally runs inside the server process on a timer
 * (`startChatLifecycleSweeper`), so nothing needs to call this on a schedule.
 * It stays for the cases where you want to force a pass — after a long outage,
 * or to verify behaviour on staging — and delegates to the same function, so
 * there is one implementation rather than two that can drift.
 *
 * Safe to call while the timer is also running: the sweep is idempotent.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET

  // Fails closed: with no secret configured this is unreachable rather than
  // open, which is the mistake the event-reminders cron made once.
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const result = await sweepExpiredChats()
    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    logger.error("Manual chat sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: "Archive failed" }, { status: 500 })
  }
}
