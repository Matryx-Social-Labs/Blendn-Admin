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
 * Ceiling, deliberately left (owner ruling: buckets only). The sharer count
 * only ever moves with the people inside and the viewer's own interests. A
 * viewer can edit their interests (up to ten leaves, 30 writes a minute) until
 * the count sits one under an edge, which reads `null`; from then on each
 * arrival that shares one of those interests flips the figure, and one that
 * does not leaves it, so a single joiner (told apart by `hereCount` moving) is
 * answered "do you overlap this set". Padding the set with interests nobody
 * inside holds reads out the joiner's interests a bisection at a time. It
 * needs a real arrival per probe and a visible joiner. Closing it takes a
 * per-viewer stability window or a read limit on the route; neither was
 * chosen. `GET /events/:id/matches` (the deck) names shared interests per
 * pseudonymous card to anyone who has checked in, so "never an exact count" is
 * this route's rule, not the app's.
 *
 * Installed clients print the number as "N people here share your taste", so
 * they show "3 people" for three to nine and "10 people" for ten or more: true
 * as a floor, understated above it. A client that knows can print "3+" / "10+".
 */
export const TASTE_MATCH_BUCKET_FLOORS = [MIN_ROOM_FOR_TASTE_COUNT, 10] as const

export type TasteMatchBucket = (typeof TASTE_MATCH_BUCKET_FLOORS)[number]

export function tasteMatchBucket(count: number): TasteMatchBucket | null {
  return TASTE_MATCH_BUCKET_FLOORS.reduce<TasteMatchBucket | null>((bucket, floor) => (count >= floor ? floor : bucket), null)
}

export interface RoomPreview {
  hereCount: number
  /** A bucket's floor or `null`, never the count — see `TASTE_MATCH_BUCKET_FLOORS`. */
  tasteMatchCount: TasteMatchBucket | null
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
 * The bucket is also the floor on the people the count is drawn from
 * (SCRUM-671): the viewer is never one of the sharers, so a figure needs at
 * least `MIN_ROOM_FOR_TASTE_COUNT` visible people, and a room of you, hidden
 * people and one visible person (whose overlap the number would have been) is
 * `null`. `hereCount` stays as a cheap first check: the visible people can only
 * be fewer.
 */
export async function roomPreview(eventId: string, viewerId: string): Promise<RoomPreview> {
  const hereCount = await hereCountFor(eventId)
  if (hereCount < MIN_ROOM_FOR_TASTE_COUNT) return { hereCount, tasteMatchCount: null }

  const [hidden, friends, viewerInterests, inside] = await Promise.all([
    blockCounterparties(viewerId),
    // Friends are never strangers (lib/room-people.ts): not in the count either.
    notStrangersTo(viewerId),
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
  const hiddenSet = new Set([...hidden, ...friends])
  const people = new Map<string, string[]>()
  for (const row of inside) {
    if (hiddenSet.has(row.user_id)) continue
    people.set(row.user_id, row.user.user_interests.map((i) => i.category_id))
  }
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
