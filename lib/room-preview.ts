import { hereCountFor } from "@/lib/attendee-counts"
import { blockCounterparties } from "@/lib/conversations"
import { db } from "@/lib/db"
import { expandInterests, interestParents } from "@/lib/matches"

/**
 * Below this many people, the Room preview says how many are here but not how
 * many share your taste.
 *
 * A count is an identity when the room is small enough. "1 person here shares
 * your interests" in a room of two names the other person's interests exactly,
 * and the preview is readable by anyone who can open the event — no check-in,
 * no pseudonym, no reveal. Three is the floor below which the number stops
 * being a crowd.
 */
export const MIN_ROOM_FOR_TASTE_COUNT = 3

export interface RoomPreview {
  hereCount: number
  /** `null` below `MIN_ROOM_FOR_TASTE_COUNT` — see there. */
  tasteMatchCount: number | null
}

/**
 * What the Room looks like from the door: how many are here, and how many of
 * them share at least one interest with you.
 *
 * `hereCount` is `hereCountFor` — the same number as the socket's
 * `hereCount`, so the preview never disagrees with the Room it opens.
 *
 * `tasteMatchCount` is over the people **inside now** and visible to you, with
 * the roster's exclusions (`GET /events/:id/checkins`), because it is a
 * statement about that roster: not you, nobody in a block relationship with
 * you either way, nobody with "show online status" off (in the room, counted in
 * `hereCount`, never singled out), and no suspended account. "Share" is the
 * match deck's rule — parent-expanded, via `expandInterests` — so this number
 * and the deck agree about who has something in common.
 *
 * The floor is on `hereCount`, which is the people inside now (you included),
 * so it is a floor on the same population the count is drawn from.
 */
export async function roomPreview(eventId: string, viewerId: string): Promise<RoomPreview> {
  const hereCount = await hereCountFor(eventId)
  if (hereCount < MIN_ROOM_FOR_TASTE_COUNT) return { hereCount, tasteMatchCount: null }

  const [hidden, viewerInterests, inside] = await Promise.all([
    blockCounterparties(viewerId),
    db.user_interests.findMany({ where: { user_id: viewerId }, select: { category_id: true } }),
    db.event_check_ins.findMany({
      where: {
        event_id: eventId,
        status: "checked_in",
        kind: "attendee",
        user_id: { not: viewerId },
        // `is: null` spelled out, as on the roster: a relation filter alone
        // reads a missing profile row as false and would drop that person.
        user: {
          suspended_at: null,
          OR: [{ profile: { is: null } }, { profile: { show_online: true } }],
        },
      },
      select: { user_id: true, user: { select: { user_interests: { select: { category_id: true } } } } },
    }),
  ])

  // One person per id: a multi-day event can hold more than one live row.
  const hiddenSet = new Set(hidden)
  const people = new Map<string, string[]>()
  for (const row of inside) {
    if (hiddenSet.has(row.user_id)) continue
    people.set(row.user_id, row.user.user_interests.map((i) => i.category_id))
  }
  // No interests of your own means nothing can be shared — a true zero, not a
  // reason to hide the number.
  if (viewerInterests.length === 0) return { hereCount, tasteMatchCount: 0 }

  const parentOf = await interestParents()
  const mine = new Set(expandInterests(viewerInterests.map((i) => i.category_id), parentOf))
  let tasteMatchCount = 0
  for (const ids of people.values()) {
    if (expandInterests(ids, parentOf).some((id) => mine.has(id))) tasteMatchCount += 1
  }
  return { hereCount, tasteMatchCount }
}
