// Relative imports throughout — see lib/conversations.ts.
import { firstName, UNNAMED } from "../conversation-identity"
import { db } from "../db"
import { idForViewer } from "../room-handle"
import { CREW_TAGS, type CrewTag } from "./crews"

/**
 * Crews as their own members see them (`GET /crews`, `GET /crews/:id`).
 *
 * Inside a crew people are named: first names and a photo, because every one
 * of them was invited by a friend and said yes (the friend-surface rule). A
 * member is identified by their handle in the crew's room, never by their
 * account id — the same id rule as every room (SCRUM-371) — and the removal
 * route takes that handle back. Nobody outside the crew learns anything here:
 * a crew you are not in is the same 404 as one that does not exist.
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

function crewView(viewerId: string, crew: CrewRow) {
  const roomId = crew.room?.id
  const me = crew.members.find((m) => m.user_id === viewerId)
  return {
    crewId: crew.id,
    name: crew.name,
    bio: crew.bio,
    intent: crew.intent,
    tags: tagsOf(crew.tags),
    emblemSeed: crew.emblem_seed,
    openToSolo: crew.open_to_solo,
    createdAt: crew.created_at,
    chatGroupId: roomId ?? null,
    size: crew.members.length,
    you: me ? { role: me.role, keepMeAnonymous: me.keep_me_anonymous } : null,
    members: crew.members.map((m) => ({
      // Yours real; everyone else's as their handle in the crew's room.
      userId: roomId ? idForViewer(viewerId, { kind: "crew", groupId: roomId }, m.user_id) : m.user_id,
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
      where: { invited_user_id: userId, declined_at: null, crew: { dissolved_at: null } },
      select: {
        created_at: true,
        inviter: { select: { name: true, profile: { select: { name: true } } } },
        crew: {
          select: {
            id: true,
            name: true,
            bio: true,
            emblem_seed: true,
            tags: true,
            _count: { select: { members: { where: { user: { suspended_at: null, deletedAt: null } } } } },
          },
        },
      },
      orderBy: { created_at: "desc" },
    }),
  ])
  return {
    crews: crews.map((c) => crewView(userId, c)),
    invites: invites.map((i) => ({
      crewId: i.crew.id,
      name: i.crew.name,
      bio: i.crew.bio,
      emblemSeed: i.crew.emblem_seed,
      tags: tagsOf(i.crew.tags),
      size: i.crew._count.members,
      // A friend asked them in: their first name, the friend-surface rule.
      invitedBy: firstName(i.inviter.profile?.name || i.inviter.name || UNNAMED),
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
  return crew ? crewView(userId, crew) : null
}
