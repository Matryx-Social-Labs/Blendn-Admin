// Relative imports, like the rest of the board's modules (see lib/board-access.ts).
import type { Prisma, board_post_kind, board_post_sub_kind } from "@prisma/client"

import { lobbyHidesTickets, OFFER_ANSWERS } from "./board"
import { boardPseudonyms, visibleBoardRequests } from "./board-access"
import { broadcastAuthorName, broadcastAuthorSelect } from "./broadcast-author"
import { blockCounterparties } from "./conversations"
import { db } from "./db"
import { ticketingOn } from "./env"
import { photoFor } from "./lobby-photo"
import { notStrangersTo, strangersApartBetween } from "./room-people"

/**
 * The Lobby's reads (SCRUM-1026): what the screens need from one event's
 * posts — the list with its filters and counts, the event page's preview, the
 * room's "From the Lobby" card, and the host's pinned post. The gates are the
 * routes'; this is what they read once a caller is through them.
 */

/** What every Lobby route reads of its event. */
export const lobbyEventSelect = {
  id: true,
  title: true,
  start_time: true,
  end_time: true,
  kind: true,
  ticketing_mode: true,
  ...broadcastAuthorSelect,
} as const

export type LobbyEvent = Prisma.eventsGetPayload<{ select: typeof lobbyEventSelect }>

export function hidesTickets(event: { ticketing_mode: string }): boolean {
  return lobbyHidesTickets(event, ticketingOn())
}

/**
 * Who is not in this person's Lobby: anybody blocked either way, and their
 * friends (the owner's rule: a friend must never meet a friend as a pseudonym).
 */
export async function hiddenAuthorsFor(viewerId: string): Promise<string[]> {
  const [blocked, friends] = await Promise.all([blockCounterparties(viewerId), notStrangersTo(viewerId)])
  return [...blocked, ...friends]
}

/**
 * This event's live posts as this viewer may see them. `not` on a nullable
 * column excludes NULL, so a spare-ticket filter is written as the explicit OR.
 */
export function livePostsWhere(event: { id: string; ticketing_mode: string }, hidden: readonly string[]): Prisma.board_postsWhereInput {
  return {
    event_id: event.id,
    deleted_at: null,
    author_id: { notIn: [...hidden] },
    ...(hidesTickets(event) && { OR: [{ sub_kind: null }, { sub_kind: { not: "ticket" } }] }),
  }
}

export interface LobbyFilter {
  kind?: board_post_kind
  subKind?: board_post_sub_kind
  /** Your own posts. */
  mine?: boolean
  /**
   * "Replies to me": your posts somebody has asked on, and the posts whose
   * author said yes to your ask.
   */
  replies?: boolean
}

function repliesTo(viewerId: string): Prisma.board_postsWhereInput {
  return {
    OR: [
      { author_id: viewerId, requests: { some: visibleBoardRequests(viewerId) } },
      { requests: { some: { from_user_id: viewerId, status: "accepted" } } },
    ],
  }
}

export function filteredWhere(base: Prisma.board_postsWhereInput, filter: LobbyFilter, viewerId: string): Prisma.board_postsWhereInput {
  const and: Prisma.board_postsWhereInput[] = [base]
  if (filter.kind) and.push({ kind: filter.kind })
  if (filter.subKind) and.push({ sub_kind: filter.subKind })
  if (filter.mine) and.push({ author_id: viewerId })
  if (filter.replies) and.push(repliesTo(viewerId))
  return { AND: and }
}

export interface LobbyCounts {
  all: number
  offer: number
  seeking: number
  chat: number
  /** "3 offering rides" on the event page. */
  offerRides: number
  mine: number
  replies: number
}

/** The filter chips' counts, and the preview's: three reads however many posts. Compact formatting is the client's. */
export async function lobbyCounts(base: Prisma.board_postsWhereInput, viewerId: string): Promise<LobbyCounts> {
  const [groups, mine, replies] = await Promise.all([
    db.board_posts.groupBy({ by: ["kind", "sub_kind"], where: base, _count: { _all: true } }),
    db.board_posts.count({ where: filteredWhere(base, { mine: true }, viewerId) }),
    db.board_posts.count({ where: filteredWhere(base, { replies: true }, viewerId) }),
  ])
  const sum = (pick: (g: (typeof groups)[number]) => boolean) => groups.filter(pick).reduce((n, g) => n + g._count._all, 0)
  return {
    all: sum(() => true),
    offer: sum((g) => g.kind === "offer"),
    seeking: sum((g) => g.kind === "seeking"),
    chat: sum((g) => g.kind === "chat"),
    offerRides: sum((g) => g.kind === "offer" && g.sub_kind === "ride"),
    mine,
    replies,
  }
}

/** The columns `shapePosts` needs. */
export function postSelect(viewerId: string) {
  return {
    id: true,
    event_id: true,
    kind: true,
    sub_kind: true,
    body: true,
    spaces_left: true,
    created_at: true,
    author_id: true,
    photo_url: true,
    photo_status: true,
    photo_alt: true,
    // Not the silenced ones, except your own: see `visibleBoardRequests`.
    _count: { select: { requests: { where: visibleBoardRequests(viewerId) } } },
  } satisfies Prisma.board_postsSelect
}

type PostRow = Prisma.board_postsGetPayload<{ select: ReturnType<typeof postSelect> }>

/**
 * Posts as a viewer reads them. The author is the event's pseudonym, never a
 * name; the photo is `photoFor`'s answer, so a pending one reaches its author
 * only and nobody else ever holds its URL.
 */
export async function shapePosts(eventId: string, rows: PostRow[], viewerId: string) {
  const pseudonymOf = await boardPseudonyms(eventId, rows.map((p) => p.author_id))
  return Promise.all(
    rows.map(async (p) => ({
      id: p.id,
      eventId: p.event_id,
      kind: p.kind,
      subKind: p.sub_kind,
      body: p.body,
      spacesLeft: p.spaces_left,
      createdAt: p.created_at,
      author: pseudonymOf.get(p.author_id) ?? "Attendee",
      /** Yours, so the client can offer to withdraw rather than to answer. */
      mine: p.author_id === viewerId,
      // A count, never who: naming them would disclose who is looking for company.
      requestCount: p._count.requests,
      photo: await photoFor(p, viewerId),
    }))
  )
}

/**
 * The host's pinned post, under the host's public label (`broadcastAuthorName`:
 * the organisation, or "Organizer"), never the person who typed it.
 */
export async function hostPostFor(event: LobbyEvent) {
  const pin = await db.board_host_posts.findUnique({
    where: { event_id: event.id },
    select: { id: true, body: true, created_at: true, updated_at: true },
  })
  if (!pin) return null
  return { id: pin.id, body: pin.body, host: broadcastAuthorName(event), createdAt: pin.created_at, updatedAt: pin.updated_at }
}

/**
 * "From the Lobby" in the room: the posts you joined or that others joined you
 * on (an accepted ask either way), each with its room if it has one, plus how
 * many asks are still waiting. The host's note is added by the route.
 */
export async function joinedThrough(event: LobbyEvent, viewerId: string, hidden: readonly string[]) {
  const posts = await db.board_posts.findMany({
    where: {
      AND: [
        livePostsWhere(event, hidden),
        {
          OR: [
            { author_id: viewerId, requests: { some: { status: "accepted" } } },
            { requests: { some: { from_user_id: viewerId, status: "accepted" } } },
          ],
        },
      ],
    },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
    select: {
      id: true,
      kind: true,
      sub_kind: true,
      body: true,
      author_id: true,
      requests: { where: { status: "accepted", from_user_id: { notIn: [...hidden] } }, select: { id: true, from_user_id: true } },
      room: { select: { id: true, members: { where: { user_id: viewerId, status: { in: ["active", "muted"] } }, select: { user_id: true } } } },
    },
  })
  const pseudonymOf = await boardPseudonyms(event.id, posts.map((p) => p.author_id))
  return posts.map((p) => {
    const mine = p.author_id === viewerId
    const myAsk = p.requests.find((r) => r.from_user_id === viewerId)
    return {
      postId: p.id,
      kind: p.kind,
      subKind: p.sub_kind,
      body: p.body,
      mine,
      author: pseudonymOf.get(p.author_id) ?? "Attendee",
      /** How many others are in it with you. */
      others: p.requests.length + (mine ? 0 : 1) - (myAsk ? 1 : 0),
      /** The post's room, when it has one and you are seated in it. */
      chatGroupId: p.room && p.room.members.length > 0 ? p.room.id : null,
      /** Your accepted ask on it: its conversation is reached through `/board/requests`. */
      requestId: myAsk?.id ?? null,
    }
  })
}

/**
 * Who hears "Someone offers what you're looking for" for this new offer: the
 * authors of this event's live posts looking for what it offers, with the
 * switch on, and never anybody kept apart from the offerer (a block either
 * way, a closed conversation, or a friendship: the Lobby hides those posts
 * from each other, so a push about one would be the same disclosure).
 */
export const MATCH_PUSH_MAX = 200

export async function matchRecipients(offer: {
  event_id: string
  author_id: string
  sub_kind: keyof typeof OFFER_ANSWERS
}): Promise<string[]> {
  const seekers = await db.board_posts.findMany({
    where: {
      event_id: offer.event_id,
      deleted_at: null,
      kind: "seeking",
      sub_kind: OFFER_ANSWERS[offer.sub_kind],
      author_id: { not: offer.author_id },
      author: { board_alert_preferences: { some: { event_id: offer.event_id, offers_match: true } } },
    },
    distinct: ["author_id"],
    select: { author_id: true },
    // ponytail: the newest few hundred seekers; a digest is the upgrade if one offer ever has more.
    orderBy: { created_at: "desc" },
    take: MATCH_PUSH_MAX,
  })
  const ids = seekers.map((s) => s.author_id)
  const apart = await strangersApartBetween([offer.author_id], ids)
  return ids.filter((id) => !apart.has(`${offer.author_id}|${id}`))
}

/** The three switches, as the API names them. No row is all off. */
export async function alertPrefsFor(userId: string, eventId: string) {
  const row = await db.board_alert_preferences.findUnique({
    where: { user_id_event_id: { user_id: userId, event_id: eventId } },
    select: { offers_match: true, replies: true, host_posts: true },
  })
  return { offersMatch: row?.offers_match ?? false, replies: row?.replies ?? false, hostPosts: row?.host_posts ?? false }
}
