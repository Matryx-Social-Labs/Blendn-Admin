// Relative imports throughout — see lib/conversations.ts.
import { firstName, UNNAMED } from "../conversation-identity"
import { db } from "../db"
import { idForViewer } from "../room-handle"
import { friendIdsOf } from "../friends"
import { keysetPage, NEWEST_FIRST, type Keyset, type ListPagination } from "../pagination"
import { CREW } from "../constants"
import { blocksBetween } from "./blocks"
import { CREW_TAGS, openInviteWhere, type CrewTag } from "./crews"
import { crewBadges, nightsTogether } from "./signals"

/**
 * Crews as their own members see them (`GET /crews`, `GET /crews/:id`).
 *
 * Inside a crew people are named: first names and a photo, because every one
 * of them was invited by a friend and said yes (the friend-surface rule). A
 * member is identified by their handle in the crew's room, never by their
 * account id — the same id rule as every room (SCRUM-371) — and the removal
 * route takes that handle back. Nobody outside the crew learns anything here:
 * a crew you are not in is the same 404 as one that does not exist.
 *
 * Two members kept apart (a block or a closed conversation either way, C5)
 * are not listed to each other, and not counted to each other either: a
 * `size` one bigger than the list would say a crewmate is hiding from you
 * (step 9 review, H4). Each viewer's crew is the people they can see.
 *
 * `isFriend` on a member says they are one of the viewer's friends — what an
 * invite picker needs to leave out somebody already in, without ever handing
 * the client another person's account id (step 9 review, M5).
 */

const memberSelect = {
  user_id: true,
  role: true,
  joined_at: true,
  keep_me_anonymous: true,
  user: { select: { name: true, profile: { select: { name: true, photos: true } } } },
} as const

const crewSelect = {
  id: true,
  name: true,
  bio: true,
  intent: true,
  tags: true,
  emblem_seed: true,
  open_to_solo: true,
  created_at: true,
  hidden_at: true,
  room: { select: { id: true } },
  members: {
    where: { user: { suspended_at: null, deletedAt: null } },
    select: memberSelect,
    orderBy: { joined_at: "asc" as const },
  },
} as const

type CrewRow = {
  id: string
  name: string
  bio: string | null
  intent: string[]
  tags: string[]
  emblem_seed: string
  open_to_solo: boolean
  created_at: Date
  hidden_at: Date | null
  room: { id: string } | null
  members: {
    user_id: string
    role: string
    joined_at: Date
    keep_me_anonymous: boolean
    user: { name: string | null; profile: { name: string | null; photos: string[] } | null }
  }[]
}

const tagsOf = (tags: string[]) =>
  tags.filter((t): t is CrewTag => t in CREW_TAGS).map((t) => ({ slug: t, label: CREW_TAGS[t] }))

/** The members of these crews that `viewerId` has blocked themselves: their own act, so theirs to be told of. */
async function blockedByViewer(viewerId: string, crews: readonly CrewRow[]): Promise<ReadonlySet<string>> {
  const ids = [...new Set(crews.flatMap((c) => c.members.map((m) => m.user_id)))]
  if (ids.length === 0) return new Set()
  const rows = await db.blocked_users.findMany({ where: { blocker_id: viewerId, blocked_id: { in: ids } }, select: { blocked_id: true } })
  return new Set(rows.map((r) => r.blocked_id))
}

/**
 * Seats left in each crew, as the invite door counts them: every member row
 * (suspended ones too) plus every open invite against `CREW.MAX_MEMBERS`
 * (`inviteToCrew`). Two grouped reads however many crews; never below zero.
 */
async function seatsLeftOf(crewIds: readonly string[]): Promise<Map<string, number>> {
  if (crewIds.length === 0) return new Map()
  const ids = [...crewIds]
  const [members, invites] = await Promise.all([
    db.crew_members.groupBy({ by: ["crew_id"], where: { crew_id: { in: ids } }, _count: { _all: true } }),
    db.crew_invites.groupBy({ by: ["crew_id"], where: { crew_id: { in: ids }, ...openInviteWhere() }, _count: { _all: true } }),
  ])
  const taken = new Map<string, number>()
  for (const r of [...members, ...invites]) taken.set(r.crew_id, (taken.get(r.crew_id) ?? 0) + r._count._all)
  return new Map(ids.map((id) => [id, Math.max(0, CREW.MAX_MEMBERS - (taken.get(id) ?? 0))]))
}

/** What every crew view needs beyond the rows: its badge and its seats (SCRUM-830, SCRUM-836). */
async function crewExtras(crews: readonly CrewRow[]) {
  const ids = crews.map((c) => c.id)
  const [nights, seats] = await Promise.all([nightsTogether(ids), seatsLeftOf(ids)])
  return { nights, seats }
}

type CrewExtras = Awaited<ReturnType<typeof crewExtras>>

function crewView(
  viewerId: string,
  crew: CrewRow,
  apart: ReadonlySet<string>,
  friends: ReadonlySet<string>,
  blockedByMe: ReadonlySet<string>,
  extras: CrewExtras
) {
  const roomId = crew.room?.id
  const me = crew.members.find((m) => m.user_id === viewerId)
  const shown = crew.members.filter((m) => !apart.has(`${viewerId}|${m.user_id}`))
  return {
    crewId: crew.id,
    name: crew.name,
    bio: crew.bio,
    intent: crew.intent,
    tags: tagsOf(crew.tags),
    emblemSeed: crew.emblem_seed,
    openToSolo: crew.open_to_solo,
    createdAt: crew.created_at,
    // A moderator hid it: off every surface outside the crew, and takes nobody new.
    hidden: crew.hidden_at !== null,
    chatGroupId: roomId ?? null,
    size: shown.length,
    // The tier pill ("Out together often"), or none (SCRUM-830).
    badges: crewBadges(extras.nights.get(crew.id) ?? 0),
    // How many more people the crew can take, open invites counted: the number the invite door enforces (SCRUM-836).
    seatsLeft: extras.seats.get(crew.id) ?? 0,
    // Somebody in the crew is left out of this list because YOU blocked them. Never because they
    // blocked you or a conversation closed: a bare "fewer shown" would say a crewmate is hiding from you.
    apart: crew.members.some((m) => blockedByMe.has(m.user_id)),
    you: me ? { role: me.role, keepMeAnonymous: me.keep_me_anonymous } : null,
    members: shown.map((m) => ({
      // Yours real; everyone else's as their handle in the crew's room.
      userId: roomId ? idForViewer(viewerId, { kind: "crew", groupId: roomId }, m.user_id) : m.user_id,
      isFriend: friends.has(m.user_id),
      name: firstName(m.user.profile?.name || m.user.name || UNNAMED),
      photo: m.user.profile?.photos?.[0] ?? null,
      role: m.role,
      joinedAt: m.joined_at,
    })),
  }
}

/** The crew's members the invite door reads: everybody still here (not suspended, not deleted). */
const ACTIVE_MEMBERS = { where: { user: { suspended_at: null, deletedAt: null } }, select: { user_id: true } } as const

/**
 * Would the accept take this invite (`acceptCrewInvite`, step 9 review H4)?
 * Whoever sent it is still in the crew and still the invitee's friend, and
 * nobody in it is kept apart from them (`apart`: `blocksBetween` keys). The
 * one rule for every surface that shows an invite: the Crews screen lists
 * only these, and the bell names only these (S-2 review H1). One the accept
 * would refuse is shown nowhere, or it tells the invitee a block is there.
 * The invite's own state (open, not lapsed) and the crew's (not dissolved,
 * not hidden) are the read's `where`: `openInviteWhere()` and `crew`.
 */
export function inviteAcceptable(
  userId: string,
  invite: { invited_by: string; crew: { members: { user_id: string }[] } },
  apart: Set<string>,
  friends: Set<string>
): boolean {
  const active = invite.crew.members.map((m) => m.user_id)
  return active.includes(invite.invited_by) && friends.has(invite.invited_by) && !active.some((id) => apart.has(`${userId}|${id}`))
}

/**
 * The crews among `crewIds` with an invite to `userId` the Crews screen would
 * list now: open and not lapsed, the crew standing, and `inviteAcceptable`.
 * Set-based: one read of the invites, then the blocks and the friends once.
 * `apart`, when the caller already holds it, is everybody kept apart from
 * `userId` (a block either way or a closed conversation, `blocksBetween`'s
 * rule from their side), so the blocks are not read a second time.
 */
export async function acceptableInviteCrewIds(
  userId: string,
  crewIds: readonly string[],
  now: Date = new Date(),
  apart?: ReadonlySet<string> | Promise<ReadonlySet<string>>
): Promise<Set<string>> {
  if (crewIds.length === 0) return new Set()
  const invites = await db.crew_invites.findMany({
    where: { invited_user_id: userId, crew_id: { in: [...crewIds] }, ...openInviteWhere(now), crew: { dissolved_at: null, hidden_at: null } },
    select: { crew_id: true, invited_by: true, crew: { select: { members: ACTIVE_MEMBERS } } },
  })
  if (invites.length === 0) return new Set()
  const people = [...new Set(invites.flatMap((i) => [i.invited_by, ...i.crew.members.map((m) => m.user_id)]))]
  const [pairs, friends] = await Promise.all([
    apart ? Promise.resolve(apart).then((ids) => new Set([...ids].map((id) => `${userId}|${id}`))) : blocksBetween([userId], people),
    friendIdsOf(userId).then((ids) => new Set(ids)),
  ])
  return new Set(invites.filter((i) => inviteAcceptable(userId, i, pairs, friends)).map((i) => i.crew_id))
}

/** The most open invites one read looks at, newest first. Nobody has this many waiting; the cap is what keeps the read bounded. */
export const INVITES_READ_CAP = 200

/**
 * My crews, newest first, and the invites waiting for me: the newest
 * `INVITES_READ_CAP` of them, a page at a time (`invites` is the page, and
 * `invitesPagination` says how many there are in all and where the next page
 * starts). `totalCount` is the invites an accept would take, the list's own
 * rule, so the number is never above what paging would show.
 */
export async function crewsOf(userId: string, invitesQuery: { limit: number; after: (Keyset & { at: Date }) | null }) {
  const [crews, invites] = await Promise.all([
    db.crews.findMany({
      where: { dissolved_at: null, members: { some: { user_id: userId } } },
      select: crewSelect,
      orderBy: { created_at: "desc" },
    }),
    db.crew_invites.findMany({
      // Never a crew a moderator hid: the invitee is outside it (C12).
      where: { invited_user_id: userId, ...openInviteWhere(), crew: { dissolved_at: null, hidden_at: null } },
      select: {
        id: true,
        created_at: true,
        invited_by: true,
        inviter: { select: { name: true, profile: { select: { name: true, photos: true } } } },
        crew: {
          select: {
            id: true,
            name: true,
            bio: true,
            emblem_seed: true,
            tags: true,
            members: ACTIVE_MEMBERS,
          },
        },
      },
      orderBy: NEWEST_FIRST,
      take: INVITES_READ_CAP,
    }),
  ])
  const [apart, friends, blockedByMe, extras] = await Promise.all([
    blocksBetween(
      [userId],
      [
        ...new Set([
          ...crews.flatMap((c) => c.members.map((m) => m.user_id)),
          ...invites.flatMap((i) => [i.invited_by, ...i.crew.members.map((m) => m.user_id)]),
        ]),
      ]
    ),
    friendIdsOf(userId).then((ids) => new Set(ids)),
    blockedByViewer(userId, crews),
    crewExtras(crews),
  ])
  // Only an invite the accept would take (`inviteAcceptable`): listed and then refused, it told you a block was there.
  const acceptable = invites.filter((i) => inviteAcceptable(userId, i, apart, friends))
  const { limit, after } = invitesQuery
  const rest = after ? acceptable.filter((i) => isAfter(i, after)) : acceptable
  const page = keysetPage(rest.slice(0, limit + 1), limit, (i) => ({ at: i.created_at, id: i.id }))
  return {
    crews: crews.map((c) => crewView(userId, c, apart, friends, blockedByMe, extras)),
    invitesPagination: {
      limit,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      totalCount: acceptable.length,
    } satisfies ListPagination,
    invites: page.items.map((i) => ({
      crewId: i.crew.id,
      name: i.crew.name,
      bio: i.crew.bio,
      emblemSeed: i.crew.emblem_seed,
      tags: tagsOf(i.crew.tags),
      size: i.crew.members.length,
      // A friend asked them in: their first name, the friend-surface rule.
      invitedBy: firstName(i.inviter.profile?.name || i.inviter.name || UNNAMED),
      // Their first photo, shown to exactly who is shown their name: the invite is only listed
      // while the sender is still your friend and in the crew (`acceptable`).
      invitedByPhoto: i.inviter.profile?.photos?.[0] ?? null,
      invitedAt: i.created_at,
    })),
  }
}

/** After `k` in `created_at DESC, id DESC` order, the same cut `createdBefore` makes in SQL. */
const isAfter = (row: { created_at: Date; id: string }, k: Keyset & { at: Date }) => {
  const at = k.at.getTime()
  return row.created_at.getTime() < at || (row.created_at.getTime() === at && row.id < k.id)
}

/** One crew, for one of its members; null for anybody else. */
export async function crewDetail(userId: string, crewId: string) {
  const crew = await db.crews.findFirst({
    where: { id: crewId, dissolved_at: null, members: { some: { user_id: userId, user: { suspended_at: null } } } },
    select: crewSelect,
  })
  if (!crew) return null
  const [apart, friends, blockedByMe, extras] = await Promise.all([
    blocksBetween([userId], crew.members.map((m) => m.user_id)),
    friendIdsOf(userId).then((ids) => new Set(ids)),
    blockedByViewer(userId, [crew]),
    crewExtras([crew]),
  ])
  return crewView(userId, crew, apart, friends, blockedByMe, extras)
}
