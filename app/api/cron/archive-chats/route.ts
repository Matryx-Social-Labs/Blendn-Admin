import { NextRequest, NextResponse } from "next/server"

import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { CHAT_WINDOW_HOURS } from "@/lib/chat-window"

/**
 * Close chatrooms whose feedback window has expired.
 *
 * This used to happen opportunistically inside `GET /api/mobile/chat/groups` —
 * archiving fired only when somebody happened to list their chat groups, so a
 * room nobody opened stayed `active` indefinitely. Combined with a write path
 * that only rejected `locked`, that is how people were still posting into
 * events from months ago.
 *
 * Archiving is now a job that runs on a schedule and does the same thing every
 * time, whether or not anyone opens the app.
 *
 * Note the write gate does **not** depend on this job having run:
 * `chatWindowState` also compares against the event's own `end_time`, so a room
 * this job has not reached yet is still closed to writes. The job exists to
 * make the state visible and to release members, not to be the only thing
 * standing between a stale membership and a message.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET

  // Fails closed: with no secret configured this endpoint is unreachable
  // rather than open, which is the mistake the event-reminders cron made once.
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const cutoff = new Date(Date.now() - CHAT_WINDOW_HOURS * 60 * 60 * 1000)

  try {
    const expired = await db.chat_groups.findMany({
      where: {
        status: "active",
        event: { end_time: { lt: cutoff } },
      },
      select: { id: true },
      // Bounded so one run cannot lock the table for an unbounded period; the
      // next run picks up the remainder.
      take: 500,
    })

    if (expired.length === 0) {
      return NextResponse.json({ success: true, archived: 0, released: 0 })
    }

    const ids = expired.map((group) => group.id)

    const [, released] = await db.$transaction([
      db.chat_groups.updateMany({
        where: { id: { in: ids } },
        data: { status: "archived" },
      }),
      /*
       * Members are marked `left`, not deleted.
       *
       * `anonymous_name` lives on the membership row, and every historical
       * message resolves its pseudonym through it. Deleting the rows would
       * strip the names off the whole transcript — which does not anonymise
       * anyone, it just blanks them, and it breaks the post-event feedback
       * digest that the window exists to feed.
       *
       * Banned members keep that status: a ban is a moderation record and
       * should survive the room closing.
       */
      db.chat_group_members.updateMany({
        where: { chat_group_id: { in: ids }, status: { in: ["active", "muted"] } },
        data: { status: "left" },
      }),
    ])

    logger.info("Archived expired chat groups", {
      archived: ids.length,
      released: released.count,
    })

    return NextResponse.json({
      success: true,
      archived: ids.length,
      released: released.count,
      hasMore: expired.length === 500,
    })
  } catch (error) {
    logger.error("Chat archive cron failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: "Archive failed" }, { status: 500 })
  }
}
