// Relative imports throughout — see lib/conversations.ts.
import { firstName, UNNAMED } from "../conversation-identity"
import { db } from "../db"
import { idForViewer } from "../room-handle"
import { friendIdsOf } from "../friends"
import { blocksBetween } from "./blocks"
import { CREW_TAGS, openInviteWhere, type CrewTag } from "./crews"

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

function crewView(
  viewerId: string,
  crew: CrewRow,
  apart: ReadonlySet<string>,
  friends: ReadonlySet<string>,
  blockedByMe: ReadonlySet<string>
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

/** My crews, newest first, and the invites waiting for me. */
export async function crewsOf(userId: string) {
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
            members: { where: { user: { suspended_at: null, deletedAt: null } }, select: { user_id: true } },
          },
        },
      },
      orderBy: { created_at: "desc" },
    }),
  ])
  const [apart, friends, blockedByMe] = await Promise.all([
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
  ])
  /*
   * Only an invite the accept would take (`acceptCrewInvite`, step 9 review
   * H4): whoever sent it still in the crew and still your friend, and nobody
   * in it kept apart from you. One the accept would refuse is not on the
   * screen — listed and then refused, it told you a block was there.
   */
  const acceptable = invites.filter((i) => {
    const active = i.crew.members.map((m) => m.user_id)
    return active.includes(i.invited_by) && friends.has(i.invited_by) && !active.some((id) => apart.has(`${userId}|${id}`))
  })
  return {
    crews: crews.map((c) => crewView(userId, c, apart, friends, blockedByMe)),
    invites: acceptable.map((i) => ({
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

/** One crew, for one of its members; null for anybody else. */
export async function crewDetail(userId: string, crewId: string) {
  const crew = await db.crews.findFirst({
    where: { id: crewId, dissolved_at: null, members: { some: { user_id: userId, user: { suspended_at: null } } } },
    select: crewSelect,
  })
  if (!crew) return null
  const [apart, friends, blockedByMe] = await Promise.all([
    blocksBetween([userId], crew.members.map((m) => m.user_id)),
    friendIdsOf(userId).then((ids) => new Set(ids)),
    blockedByViewer(userId, [crew]),
  ])
  return crewView(userId, crew, apart, friends, blockedByMe)
}
