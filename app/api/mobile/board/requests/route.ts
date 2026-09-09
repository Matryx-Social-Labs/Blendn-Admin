import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"

import { boardPseudonyms, isLiveRequest } from "@/lib/board-access"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"

/**
 * Both directions of one person's board requests.
 *
 * ## Why one endpoint and not two
 *
 * "Who is waiting on me" and "what am I waiting on" are the same screen: the
 * only useful thing to do with an outstanding ask is see it beside the answers
 * you owe. Two endpoints would also mean two pseudonym resolutions of the same
 * people at the same events, which is how one person acquires two names.
 *
 * Not scoped to an event, deliberately. A request is answered from a
 * notification days after the board was last opened, and the event it belongs
 * to is a thing to render rather than a thing to ask for.
 */

/** One page. A person with more outstanding asks than this has a cap problem. */
const PAGE = 50

// GET /api/mobile/board/requests
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const select = {
      id: true,
      status: true,
      message: true,
      created_at: true,
      decided_at: true,
      from_user_id: true,
      to_user_id: true,
      event_id: true,
      event: { select: { id: true, title: true, start_time: true, end_time: true } },
      post: { select: { id: true, kind: true, body: true, deleted_at: true } },
    } as const

    const [incoming, outgoing] = await Promise.all([
      db.board_requests.findMany({
        where: { to_user_id: user.userId },
        /*
         * Pending first, then newest. A decided request is history and an
         * undecided one is a person waiting for an answer, so ordering by time
         * alone buries the only rows that need an action behind the ones that
         * do not.
         */
        orderBy: [{ status: "asc" }, { created_at: "desc" }],
        take: PAGE,
        select,
      }),
      db.board_requests.findMany({
        where: { from_user_id: user.userId },
        orderBy: [{ status: "asc" }, { created_at: "desc" }],
        take: PAGE,
        select,
      }),
    ])

    /*
     * One pseudonym resolution for the whole page, grouped by event.
     *
     * A handle is per event, so the same person is a different name on two
     * boards — which is the point. Resolving per row would be a query per
     * request, and resolving without the event would be one identity across
     * events, which is the cross-event correlation the pseudonyms exist to
     * prevent.
     */
    const rows = [...incoming, ...outgoing]
    const byEvent = new Map<string, Set<string>>()
    for (const r of rows) {
      const counterpart = r.from_user_id === user.userId ? r.to_user_id : r.from_user_id
      const set = byEvent.get(r.event_id) ?? new Set<string>()
      set.add(counterpart)
      byEvent.set(r.event_id, set)
    }
    const resolved = new Map<string, Map<string, string>>()
    await Promise.all(
      [...byEvent].map(async ([eventId, ids]) =>
        resolved.set(eventId, await boardPseudonyms(eventId, [...ids]))
      )
    )

    /*
     * One clock for the page. Calling `new Date()` per row would let the top of
     * a list and the bottom of it answer differently about an event ending
     * mid-render — rare, and the kind of rare that is impossible to reproduce.
     */
    const now = new Date()

    const shape = (r: (typeof rows)[number]) => {
      const counterpart = r.from_user_id === user.userId ? r.to_user_id : r.from_user_id
      return {
        id: r.id,
        status: r.status,
        message: r.message,
        createdAt: r.created_at,
        decidedAt: r.decided_at,
        /*
         * Whether there is still anything to answer. `pending` outlives its
         * event — nothing closes a request at the end of the night — so a card
         * rendered on `status` alone waits for ever on an evening that already
         * happened. A declined ask and a lapsed one both stop being pending
         * here, quietly, which is the same answer the reveal flow gives: no
         * verdict is delivered, because both mean move on.
         */
        live: isLiveRequest(r, now),
        /** The pseudonym, never the name. Accepting is what exchanges those. */
        counterpart: resolved.get(r.event_id)?.get(counterpart) ?? "Attendee",
        event: { id: r.event.id, title: r.event.title, startTime: r.event.start_time },
        post: { id: r.post.id, kind: r.post.kind, body: r.post.body },
      }
    }

    return successResponse({
      /** Waiting on you. */
      incoming: incoming.map(shape),
      /** Waiting on them. */
      outgoing: outgoing.map(shape),
    })
  } catch (error) {
    logger.error("Board requests list error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to load your requests")
  }
}
