import { Prisma } from "@prisma/client"

import { ageFrom } from "@/lib/age"
import { chatClosesAt, eventHidesRoom } from "@/lib/chat-window"
import { blockCounterparties, closedPairKeys } from "@/lib/conversations"
import { db } from "@/lib/db"
import { visibleInRoom } from "@/lib/identity"
import { tierBBudget } from "@/lib/matching"
import { displayTraitsOf, expandInterests, interestParents, iplTeamIds, type TraitProfile } from "@/lib/matches"
import { NO_TRAITS, personCard, traitHolders, viewerTierB } from "@/lib/overlaps"
import { idForViewer, roomMemberFromRef } from "@/lib/room-handle"
import { eventRoomBan } from "@/lib/room-kind"
import { notStrangersTo } from "@/lib/room-people"
import { MIN_ROOM_FOR_WORK_FIELD } from "@/lib/work-fields"

/**
 * People from a night you attended: the Recap's "People from tonight" row and
 * its deck (Flow 4 · 4.5, SV6).
 *
 * A read-only deck of the people who checked in, by the name the room gave
 * them, marked "Was here", with Like and Message — until the room's chat
 * closes, 24 hours after the end (`chatClosesAt`). After that, the count only.
 *
 * ## Who appears, and as what
 *
 * Privacy-critical, because it outlives the room: the deck is still there
 * when the roster (people inside now) is empty.
 *
 * - **Only by the room's terms.** Every person is their room handle
 *   (`idForViewer`), never an account id; their name and photo only where the
 *   room already shows them (`visibleInRoom`, the roster's rule), otherwise the
 *   pseudonym from their membership row and no photo.
 * - **Never a block, either way** (`blockCounterparties`), and never a pair
 *   that closed a conversation: leaving is permanent (`closedPairKeys`).
 * - **Never a friend** — not as a stranger card, and not named. The owner's
 *   ruling (2026-10-22): friends never appear to each other as stranger cards
 *   (no like, wave or match between friends). A friend who lets friends see
 *   them belongs in a "Friends here" section, which the Recap does not have;
 *   one who does not is not shown to friends at all.
 * - **Not for a viewer the room banned**: the chat's refusal, `USER_BANNED`.
 * - **Not anybody the room hides**: staff (working, not mingling), "Show
 *   online status" off (counted, not listed — SCRUM-141), a member a host
 *   banned from the room, a suspended or deleted account.
 *
 * ## Scale
 *
 * A concert night is 5,000+ people. One page at a time by a keyset over
 * (first arrival, id), with the total, and every read after it bounded by
 * the page. The cursor is the last card's handle — a string the client
 * already holds, valid only in this room, so it names nobody new.
 *
 * Not a venue's live room: a venue day's people are for whoever is live there
 * now (`inRoomWhere`), and a deck that outlived your window would be a seat you
 * no longer have. The route answers a venue day as an unknown event.
 */

export const NIGHT_PEOPLE_DEFAULT_LIMIT = 30
export const NIGHT_PEOPLE_MAX_LIMIT = 50

export interface NightPerson {
  /** Their handle in this room (`rh_…`), never the account id. `POST /matches/likes` and message requests take it. */
  userId: string
  /** The room's pseudonym, or their name where the room already names them (they revealed here). */
  displayName: string
  /** Only where the room names them; null beside a pseudonym. */
  photo: string | null
  age: number | null
  /** Still checked in. False is "Was here". */
  insideNow: boolean
  /** Whether *you* liked them here. Never whether they liked you. */
  youLiked: boolean
  /** One sentence of overlap, or null: nothing shared, or a night under `MIN_ROOM_FOR_WORK_FIELD` people. */
  overlap: string | null
}

export type NightPeople =
  | { open: true; total: number; people: NightPerson[]; nextCursor: string | null }
  /** The room's chat has closed: the count, never the people. */
  | { open: false; total: number; people: []; nextCursor: null }

export type NightPeopleOutcome =
  | NightPeople
  | { refused: "not_found" | "not_attended" | "bad_cursor" }
  /** Banned from the night's room: the chat's own answer (`bannedRefusal`). */
  | { refused: "banned"; banned_by: string | null }

/**
 * A person's first arrival, at the millisecond a JS Date can carry back as a
 * cursor: Postgres keeps microseconds, and a row seeded with them would sort
 * after its own truncated key and repeat on the next page.
 */
const FIRST_IN = Prisma.sql`date_trunc('milliseconds', MIN(c.check_in_time))`

interface Row {
  user_id: string
  first_in: Date
  inside_now: boolean
}

export async function nightPeople(
  eventId: string,
  viewerId: string,
  opts: { cursor?: string | null; limit?: number; now?: Date } = {}
): Promise<NightPeopleOutcome> {
  const now = opts.now ?? new Date()
  const limit = Math.min(Math.max(opts.limit ?? NIGHT_PEOPLE_DEFAULT_LIMIT, 1), NIGHT_PEOPLE_MAX_LIMIT)

  const event = await db.events.findUnique({
    where: { id: eventId },
    select: { kind: true, status: true, deleted_at: true, end_time: true },
  })
  if (!event || event.kind !== "event" || eventHidesRoom(event)) return { refused: "not_found" }

  // A night you attended: any check-in, staff's included, as the deck asks (`matchesForEvent`).
  const viewerCheckIn = await db.event_check_ins.findFirst({
    where: { event_id: eventId, user_id: viewerId, check_in_time: { not: null } },
    orderBy: { check_in_time: "desc" },
    select: { check_in_time: true },
  })
  if (!viewerCheckIn) return { refused: "not_attended" }
  // A host's ban closes the room's people as it closes its chat.
  const ban = await eventRoomBan(eventId, viewerId)
  if (ban) return { refused: "banned", banned_by: ban.banned_by }

  /*
   * Friends: every one, whatever their room setting, and anyone whose
   * friendship ended in the last 24 hours — plans/friends-in-room.md D1 and
   * B4, through the one helper every people surface asks (`notStrangersTo`).
   */
  const [blocked, closed, friends] = await Promise.all([blockCounterparties(viewerId), closedPairKeys(viewerId), notStrangersTo(viewerId)])
  const hidden = [...new Set([viewerId, ...blocked, ...closed, ...friends])]

  /*
   * Who may be listed, as SQL: one predicate for the page and the total, so
   * they cannot disagree. Raw because the page groups per person (a run's
   * days are several rows) and keysets on the group's first arrival.
   */
  const listable = Prisma.sql`
        u."deletedAt" IS NULL
    AND u.suspended_at IS NULL
    AND (p.id IS NULL OR p.show_online)
    AND c.user_id <> ALL(${hidden}::text[])
    AND NOT EXISTS (
      SELECT 1 FROM chat_group_members m JOIN chat_groups g ON g.id = m.chat_group_id
       WHERE g.event_id = c.event_id AND m.user_id = c.user_id AND m.status = 'banned' AND m.banned_by IS NOT NULL
    )`
  const attendees = Prisma.sql`
      FROM event_check_ins c
      JOIN "User" u ON u.id = c.user_id
      LEFT JOIN profiles p ON p.id = c.user_id
     WHERE c.event_id = ${eventId}::uuid
       AND c.kind = 'attendee'
       AND c.check_in_time IS NOT NULL`

  const [counts] = await db.$queryRaw<{ night: bigint; total: bigint }[]>`
    SELECT COUNT(DISTINCT c.user_id) AS night,
           COUNT(DISTINCT c.user_id) FILTER (WHERE ${listable}) AS total
    ${attendees}`
  const total = Number(counts?.total ?? 0)

  // Closed: the count only (4.5). "Nobody to show" is total 0, and the row is absent.
  if (now >= chatClosesAt(event)) return { open: false, total, people: [], nextCursor: null }

  // The cursor: the last card's handle, in this room's scope only.
  let after = Prisma.empty
  if (opts.cursor) {
    const last = roomMemberFromRef(eventId, opts.cursor, viewerId)
    // Through the same `listable` as the page (L1): a person this viewer may not
    // see is no cursor, whatever handle the client holds for them.
    const [key] = last
      ? await db.$queryRaw<{ first_in: Date }[]>`
          SELECT ${FIRST_IN} AS first_in ${attendees} AND ${listable} AND c.user_id = ${last} GROUP BY c.user_id`
      : []
    const firstIn = key?.first_in
    if (!last || !firstIn) return { refused: "bad_cursor" }
    after = Prisma.sql`HAVING (${FIRST_IN}, c.user_id) > (${firstIn}::timestamptz, ${last})`
  }

  const rows = await db.$queryRaw<Row[]>`
    SELECT c.user_id, ${FIRST_IN} AS first_in, bool_or(c.status = 'checked_in') AS inside_now
    ${attendees}
       AND ${listable}
     GROUP BY c.user_id
     ${after}
     ORDER BY first_in, c.user_id
     LIMIT ${limit + 1}`
  const page = rows.slice(0, limit)
  const people = await cardsFor(eventId, viewerId, page, {
    nightIsBigEnough: Number(counts?.night ?? 0) >= MIN_ROOM_FOR_WORK_FIELD,
    viewerCheckedInAt: viewerCheckIn.check_in_time,
  })
  return {
    open: true,
    total,
    people,
    nextCursor: rows.length > limit && people.length > 0 ? people[people.length - 1].userId : null,
  }
}

const traitColumns = { languages: true, home_state: true, sun_sign: true, sign_system: true, work_field: true } as const

/** The page's cards: a fixed number of set-based reads, whatever the page holds. */
async function cardsFor(
  eventId: string,
  viewerId: string,
  page: Row[],
  room: { nightIsBigEnough: boolean; viewerCheckedInAt: Date | null }
): Promise<NightPerson[]> {
  if (page.length === 0) return []
  const ids = page.map((r) => r.user_id)

  const [users, pseudonyms, visible, likes] = await Promise.all([
    db.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        profile: { select: { photos: true, date_of_birth: true, age: true, ...traitColumns } },
        user_interests: { select: { category_id: true } },
      },
    }),
    db.chat_group_members.findMany({
      where: { chat_group: { event_id: eventId }, user_id: { in: ids } },
      select: { user_id: true, anonymous_name: true },
    }),
    // The roster's rule: revealed here (friends never reach this page).
    visibleInRoom(viewerId, eventId, ids),
    db.event_likes.findMany({ where: { event_id: eventId, liker_id: viewerId, liked_id: { in: ids } }, select: { liked_id: true } }),
  ])
  const userOf = new Map(users.map((u) => [u.id, u]))
  const pseudonymOf = new Map(pseudonyms.map((p) => [p.user_id, p.anonymous_name || "Attendee"]))
  const liked = new Set(likes.map((l) => l.liked_id))
  const overlapOf = room.nightIsBigEnough ? await overlapLines(viewerId, users, visible, room.viewerCheckedInAt) : new Map<string, string>()

  return page.map((r) => {
    const u = userOf.get(r.user_id)
    const named = visible.has(r.user_id) && !!u?.name
    return {
      userId: idForViewer(viewerId, eventId, r.user_id),
      displayName: named ? u!.name! : pseudonymOf.get(r.user_id) ?? "Attendee",
      photo: named ? u?.profile?.photos?.[0] ?? null : null,
      age: ageFrom(u?.profile),
      insideNow: r.inside_now,
      youLiked: liked.has(r.user_id),
      overlap: overlapOf.get(r.user_id) ?? null,
    }
  })
}

/**
 * One sentence of overlap per card, by the deck's own rules (`personCard`):
 * Tier B only within its budget (one before a reveal), the viewer's Tier B
 * only if it predates their check-in (`viewerTierB`, H1).
 *
 * ponytail: rarity is counted over the page, not the whole night, so which
 * line leads is the page's rarest, not the room's; reading 5,000 people's
 * traits to order one sentence each is the cost that buys. Upgrade path:
 * holder counts per event, computed once when the room closes.
 */
async function overlapLines(
  viewerId: string,
  users: { id: string; profile: TraitProfile | null; user_interests: { category_id: string }[] }[],
  revealed: Set<string>,
  viewerCheckedInAt: Date | null
): Promise<Map<string, string>> {
  const [viewer, viewerInterests, parentOf, iplTeams] = await Promise.all([
    db.profiles.findUnique({ where: { id: viewerId }, select: { tier_b_changed_at: true, ...traitColumns } }),
    db.user_interests.findMany({ where: { user_id: viewerId }, select: { category_id: true } }),
    interestParents(),
    iplTeamIds(),
  ])
  const traits = await displayTraitsOf(new Map<string, TraitProfile | null>([[viewerId, viewer], ...users.map((u) => [u.id, u.profile] as const)]))
  const traitsOf = (id: string) => traits.get(id) ?? NO_TRAITS
  const interestsOf = new Map(users.map((u) => [u.id, expandInterests(u.user_interests.map((i) => i.category_id), parentOf)]))
  const interestHolders = new Map<string, number>()
  for (const held of interestsOf.values()) for (const id of held) interestHolders.set(id, (interestHolders.get(id) ?? 0) + 1)
  const holders = traitHolders(users.map((u) => traitsOf(u.id)))
  const me = {
    traits: viewerTierB(traitsOf(viewerId), viewer?.tier_b_changed_at, viewerCheckedInAt),
    interestIds: expandInterests(viewerInterests.map((i) => i.category_id), parentOf),
  }

  const out = new Map<string, string>()
  for (const u of users) {
    const card = personCard(
      me,
      { traits: traitsOf(u.id), interestIds: interestsOf.get(u.id) ?? [] },
      { holders, interestHolders, population: users.length, iplTeams, roomTeam: null },
      { max: 1, tierB: tierBBudget({ roomIsBigEnough: true, revealed: revealed.has(u.id) }) }
    )
    const line = card.overlaps[0]?.text
    if (line) out.set(u.id, line)
  }
  return out
}
