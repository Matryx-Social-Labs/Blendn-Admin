// Relative imports throughout — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
import { ageFrom } from "./age"
import { preferredPseudonymFor } from "./anonymous-names"
import {
  mayPostToBoard,
  type BoardEntitlement,
  type BoardWriteDenial,
} from "./board"
import { BOARD } from "./constants"
import { db } from "./db"

/**
 * The database half of the board's gates.
 *
 * `lib/board.ts` is the rules and is pure. This is what the rules need to be
 * asked, and it lives here rather than in a route because four routes ask the
 * same three questions — the board, the request send, the request list and the
 * decision — and four copies of a gate is how the same gate ends up with four
 * answers. That is the finding this whole audit is about; the board is new
 * enough to not have it yet.
 */

/** What the viewer has done about this event. Both gates read it. */
export async function entitlementFor(
  eventId: string,
  userId: string
): Promise<BoardEntitlement> {
  const [rsvp, favourite] = await Promise.all([
    db.event_rsvps.findFirst({
      where: { event_id: eventId, user_id: userId },
      select: { status: true },
    }),
    db.event_favorites.findFirst({
      where: { event_id: eventId, user_id: userId },
      select: { id: true },
    }),
  ])
  return {
    rsvp: (rsvp?.status as BoardEntitlement["rsvp"]) ?? null,
    favourited: favourite !== null,
  }
}

/**
 * May they put something on this board — a post, or a request?
 *
 * One function for both, deliberately. Posting an offer and asking somebody
 * for a seat are the same commitment from the board's point of view: you are
 * going, we know enough about you to describe you, and you are not spraying.
 * Splitting them would invite the caps to be applied to one and not the other,
 * which is how a cap gets defeated.
 */
export async function boardWriteDenial(
  eventId: string,
  userId: string
): Promise<BoardWriteDenial | null> {
  const [entitlement, profile, interests, outstanding, thisWeek] = await Promise.all([
    entitlementFor(eventId, userId),
    db.profiles.findUnique({
      where: { id: userId },
      select: { name: true, age: true, date_of_birth: true, intent_default: true },
    }),
    db.user_interests.count({ where: { user_id: userId } }),
    db.board_requests.count({ where: { from_user_id: userId, status: "pending" } }),
    db.board_requests.count({
      where: {
        from_user_id: userId,
        created_at: {
          gte: new Date(Date.now() - BOARD.REQUEST_WEEK_DAYS * 24 * 60 * 60 * 1000),
        },
      },
    }),
  ])

  return mayPostToBoard(
    entitlement,
    {
      name: profile?.name ?? null,
      // Derived, never the stored column — see lib/age.ts.
      age: ageFrom(profile ?? null),
      interestCount: interests,
      intentCount: profile?.intent_default?.length ?? 0,
    },
    { outstandingRequests: outstanding, requestsThisWeek: thisWeek }
  )
}

/**
 * Everyone's handle at this event, for the ids asked about.
 *
 * The room's `anonymous_name` where one exists, and `preferredPseudonymFor`
 * where it does not — which before doors is everybody, because the room handle
 * is minted at check-in and the board is what happens before check-in.
 *
 * **It previously fell back to the literal string "Attendee".** That was
 * written for the room, where a missing handle is a bug and degrading to the
 * real name would turn that bug into a disclosure. On the board it is not a
 * bug, it is the ordinary state, so every post before doors rendered as
 * "Attendee" — a wall of one name, on the surface whose entire job is letting
 * people tell each other apart well enough to agree to travel together.
 *
 * Check-in prefers the same handle when it is free, so the name someone
 * answered on the board is the name they carry into the room.
 */
export async function boardPseudonyms(
  eventId: string,
  userIds: readonly string[]
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)]
  if (ids.length === 0) return new Map()

  const members = await db.chat_group_members.findMany({
    where: { chat_group: { event_id: eventId }, user_id: { in: ids } },
    select: { user_id: true, anonymous_name: true },
  })
  const roomName = new Map(
    members
      .filter((m) => m.anonymous_name)
      .map((m) => [m.user_id, m.anonymous_name as string])
  )

  return new Map(ids.map((id) => [id, roomName.get(id) ?? preferredPseudonymFor(eventId, id)]))
}
