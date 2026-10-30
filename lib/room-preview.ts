import { notStrangersTo } from "@/lib/room-people"
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

/**
 * `tasteMatchCount` is never the count. It is the floor of the bucket the count
 * falls in (SCRUM-914): `3` for three to nine people, `10` for ten or more, and
 * `null` under three. The exact figure could be differenced: two reads around
 * one person's join, or a viewer swapping their own interests between reads,
 * read out a person's overlap at any room size, and a floor on the room cannot
 * stop that. A bucket moves only at its two edges.
 *
 * Ceiling, deliberately left: when a join crosses an edge (the third sharer,
 * the tenth) a sole joiner's overlap with the viewer is read out. A reader does
 * not know they are at an edge but can walk their own interests to one. Closing
 * that is a per-viewer stability window or a rate limit; neither was chosen.
 *
 * Installed clients print the number as "N people here share your taste", so
 * they show "3 people" for three to nine and "10 people" for ten or more: true
 * as a floor, understated above it. A client that knows can print "3+" / "10+".
 */
export const TASTE_MATCH_BUCKET_FLOORS = [MIN_ROOM_FOR_TASTE_COUNT, 10] as const

export function tasteMatchBucket(count: number): number | null {
  return TASTE_MATCH_BUCKET_FLOORS.reduce<number | null>((bucket, floor) => (count >= floor ? floor : bucket), null)
}

export interface RoomPreview {
  hereCount: number
  /** A bucket's floor or `null`, never the count — see `TASTE_MATCH_BUCKET_FLOORS`. */
  tasteMatchCount: number | null
}

/**
 * What the Room looks like from the door: how many are here, and how many of
 * them share at least one interest with you.
 *
 * `hereCount` is `hereCountFor` — the same number as the socket's
 * `hereCount`, so the preview never disagrees with the Room it opens.
 *
 * `tasteMatchCount` is a bucket of the people **inside now** and visible to you, with
 * the roster's exclusions (`GET /events/:id/checkins`), because it is a
 * statement about that roster: not you, nobody in a block relationship with
 * you either way, nobody with "show online status" off (in the room, counted in
 * `hereCount`, never singled out), and no suspended account. "Share" is the
 * match deck's rule — parent-expanded, via `expandInterests` — so this number
 * and the deck agree about who has something in common.
 *
 * The floor is on the people the count is drawn from, you included if you are
 * inside (SCRUM-671):
 * `hereCount` alone counts people the count leaves out (show-online off,
 * blocked, friends, suspended), so a room of you, one hidden person and one
 * visible person passes it and the number becomes that one person's overlap
 * with you. `hereCount` stays as a cheap first check, since the visible people
 * can only be fewer.
 */
export async function roomPreview(eventId: string, viewerId: string): Promise<RoomPreview> {
  const hereCount = await hereCountFor(eventId)
  if (hereCount < MIN_ROOM_FOR_TASTE_COUNT) return { hereCount, tasteMatchCount: null }

  const [hidden, friends, viewerInterests, viewerInside, inside] = await Promise.all([
    blockCounterparties(viewerId),
    // Friends are never strangers (lib/room-people.ts): not in the count either.
    notStrangersTo(viewerId),
    db.user_interests.findMany({ where: { user_id: viewerId }, select: { category_id: true } }),
    // The preview needs no check-in, so the viewer may or may not be one of `hereCount`.
    db.event_check_ins.findFirst({
      where: { event_id: eventId, user_id: viewerId, status: "checked_in", kind: "attendee" },
      select: { id: true },
    }),
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
  const hiddenSet = new Set([...hidden, ...friends])
  const people = new Map<string, string[]>()
  for (const row of inside) {
    if (hiddenSet.has(row.user_id)) continue
    people.set(row.user_id, row.user.user_interests.map((i) => i.category_id))
  }
  if (people.size + (viewerInside ? 1 : 0) < MIN_ROOM_FOR_TASTE_COUNT) return { hereCount, tasteMatchCount: null }
  // No interests of your own means nothing can be shared: no sharers, so no figure.
  if (viewerInterests.length === 0) return { hereCount, tasteMatchCount: null }

  const parentOf = await interestParents()
  const mine = new Set(expandInterests(viewerInterests.map((i) => i.category_id), parentOf))
  let tasteMatchCount = 0
  for (const ids of people.values()) {
    if (expandInterests(ids, parentOf).some((id) => mine.has(id))) tasteMatchCount += 1
  }
  return { hereCount, tasteMatchCount: tasteMatchBucket(tasteMatchCount) }
}
