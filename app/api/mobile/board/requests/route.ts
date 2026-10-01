import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"

import {
  asTheAskerSees,
  boardPseudonyms,
  isLiveRequest,
  isLiveToTheAsker,
  liveRequest,
  outstandingAsk,
} from "@/lib/board-access"
import { blockCounterparties } from "@/lib/conversations"
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
      asker_withdrawn_at: true,
      from_user_id: true,
      to_user_id: true,
      event_id: true,
      event: { select: { id: true, title: true, start_time: true, end_time: true } },
      post: { select: { id: true, kind: true, body: true, deleted_at: true } },
    } as const

    /*
     * One clock for the page. Calling `new Date()` per row would let the top of
     * a list and the bottom of it answer differently about an event ending
     * mid-render — rare, and the kind of rare that is impossible to reproduce.
     */
    const now = new Date()
    const blockedIds = await blockCounterparties(user.userId)
    const blocked = new Set(blockedIds)
    const newest = { created_at: "desc" as const }

    /*
     * Each direction in three slices, so the page cannot be filled by history.
     *
     * One page ordered "pending first" put every lapsed ask — pending for ever,
     * because nothing closes one when its night ends — ahead of the accepted
     * ones, and fifty of those pushed the asks with conversations behind them
     * off the page. So: what still needs somebody (live), then what was
     * settled, then what lapsed. The live slice is small by construction — the
     * cap bounds an asker's, and an author answers theirs.
     */
    const [liveIn, settledIn, lapsedIn, liveOut, settledOut, lapsedOut] = await Promise.all([
      // An ask from somebody blocked either way is not shown: the block is the
      // answer, and accepting is refused on it anyway.
      db.board_requests.findMany({
        where: { to_user_id: user.userId, from_user_id: { notIn: blockedIds }, ...liveRequest(now) },
        orderBy: newest,
        take: PAGE,
        select,
      }),
      db.board_requests.findMany({
        where: { to_user_id: user.userId, from_user_id: { notIn: blockedIds }, status: { not: "pending" } },
        orderBy: [{ status: "asc" }, newest],
        take: PAGE,
        select,
      }),
      db.board_requests.findMany({
        where: {
          to_user_id: user.userId,
          from_user_id: { notIn: blockedIds },
          status: "pending",
          OR: [{ event: { end_time: { lte: now } } }, { post: { deleted_at: { not: null } } }],
        },
        orderBy: newest,
        take: PAGE,
        select,
      }),
      /*
       * The asker's own. A declined ask is shown to them as pending
       * (`asTheAskerSees`) and has to sort as one: ordered on the stored enum
       * it would sit after the accepted ones — a "pending" row sorted among the
       * answered is the decline, delivered by position instead of by word.
       */
      db.board_requests.findMany({
        where: { from_user_id: user.userId, ...outstandingAsk(now, blockedIds) },
        orderBy: newest,
        take: PAGE,
        select,
      }),
      db.board_requests.findMany({
        where: {
          from_user_id: user.userId,
          OR: [
            { status: { in: ["accepted", "withdrawn"] } },
            { status: "declined", asker_withdrawn_at: { not: null } },
          ],
        },
        orderBy: newest,
        take: PAGE,
        select,
      }),
      db.board_requests.findMany({
        where: {
          from_user_id: user.userId,
          status: { in: ["pending", "declined"] },
          asker_withdrawn_at: null,
          OR: [
            { event: { end_time: { lte: now } } },
            { post: { deleted_at: { not: null } } },
            { to_user_id: { in: blockedIds } },
          ],
        },
        orderBy: newest,
        take: PAGE,
        select,
      }),
    ])
    const incoming = [...liveIn, ...settledIn, ...lapsedIn].slice(0, PAGE)
    // Settled: accepted first (those have a conversation), then withdrawn —
    // stably, so each stays newest first.
    const settledOutSeen = settledOut
      .map(asTheAskerSees)
      .sort((a, b) => Number(a.status !== "accepted") - Number(b.status !== "accepted"))
    const outgoing = [...liveOut.map(asTheAskerSees), ...settledOutSeen, ...lapsedOut.map(asTheAskerSees)].slice(
      0,
      PAGE
    )

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

    const shape = (r: (typeof rows)[number]) => {
      const mine = r.from_user_id === user.userId
      const counterpart = mine ? r.to_user_id : r.from_user_id
      // To the asker, an ask to somebody blocked either way reads as an ask on a
      // withdrawn post: no words, not live (see `outstandingAsk`).
      const postGone = r.post.deleted_at !== null || (mine && blocked.has(r.to_user_id))
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
         * happened. To the asker a declined ask is still pending and lapses
         * here like any other, which is the same answer the reveal flow
         * gives: no verdict is delivered, because both mean move on.
         */
        live: mine ? isLiveToTheAsker(r, blocked, now) : isLiveRequest(r, now),
        /** The pseudonym, never the name. Accepting is what exchanges those. */
        counterpart: resolved.get(r.event_id)?.get(counterpart) ?? "Attendee",
        event: { id: r.event.id, title: r.event.title, startTime: r.event.start_time },
        // A withdrawn or removed post's words leave with it (SCRUM-301).
        post: { id: r.post.id, kind: r.post.kind, body: postGone ? null : r.post.body },
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
