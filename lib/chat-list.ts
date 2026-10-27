import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { blendDoor, crewDoor, roomOwnerDenial } from "@/lib/room-kind"

/* The reads behind a chat list (GET /chat/groups, GET /me/muted-rooms); the rows are built in `lib/chat-group-rows.ts`. */

/**
 * Crew and Blend rooms (step 9): the viewer's crews' chats, and their Blends
 * while open — each as its door admits them now (a member of the crew; on a
 * side of the Blend, in no block across it). A list of their own, `rooms`, not
 * rows of `groups`: an installed app reads `event` off every `groups` row, and
 * these rooms have none. Not paged — a person is in at most `CREW.MAX_JOINED`
 * crews and a night's few Blends — so the list sends them with its first page only.
 *
 * Most people are in none, and the doors are the expensive part (Prisma 7 runs
 * every `include` level as its own statement: 32 over 7 levels for the three
 * owners, for a person in no crew or Blend room at all). So the kinds the
 * viewer has rooms of are read first, in one cheap row each, and only those
 * kinds' doors are asked, side by side.
 */
export async function crewAndBlendRooms(userId: string, only: Prisma.chat_group_membersWhereInput = {}) {
  // Listed: a mute silences, it does not banish (SCRUM-178). `only` narrows further (the muted list's ids).
  const where = {
    ...only,
    user_id: userId,
    status: { in: ["active", "muted"] as ("active" | "muted")[] },
  }
  const crewWhere = { ...where, chat_group: { kind: "crew" as const, status: { in: ["active", "locked"] as ("active" | "locked")[] } } }
  const blendWhere = { ...where, chat_group: { kind: "blend" as const, status: "active" as const } }
  const has = await db.chat_group_members.findMany({
    where: { OR: [crewWhere, blendWhere] },
    select: { chat_group: { select: { kind: true } } },
  })
  const kinds = new Set(has.map((m) => m.chat_group.kind))
  const memberSelect = {
    chat_group_id: true,
    status: true,
    role: true,
    joined_at: true,
    last_read_message_id: true,
    notification_preferences: true,
  } as const
  const roomSelect = { id: true, kind: true, name: true, status: true, last_message_at: true, crew_id: true, blend_id: true } as const

  const [crews, blends] = await Promise.all([
    kinds.has("crew")
      ? db.chat_group_members.findMany({
          where: crewWhere,
          select: { ...memberSelect, chat_group: { select: { ...roomSelect, crew: crewDoor(userId) } } },
        })
      : [],
    kinds.has("blend")
      ? db.chat_group_members.findMany({
          where: blendWhere,
          select: { ...memberSelect, chat_group: { select: { ...roomSelect, blend: blendDoor(userId) } } },
        })
      : [],
  ])
  // Who is let in — a crew dissolved or a Blend closed, on its clock or
  // early, a block across it — is the door's, the one rule.
  const rooms = [
    ...crews.map((m) => ({ ...m, chat_group: { ...m.chat_group, blend: null } })),
    ...blends.map((m) => ({ ...m, chat_group: { ...m.chat_group, crew: null } })),
  ]
  return rooms.filter((m) => roomOwnerDenial({ ...m.chat_group, event: null }, userId) === null)
}

export interface LastMessageRow {
  id: string
  chat_group_id: string
  content: string
  type: string
  created_at: Date
  user_id: string
  user_name: string | null
}

/**
 * The newest message each room shows this viewer, with its sender's pseudonym.
 * One index probe per room (`chat_messages(chat_group_id, created_at)`), not a
 * sort of every message of every room the viewer is in; a room with no visible
 * message is absent, as before.
 */
export async function lastMessagesOf(chatGroupIds: string[], blockedIds: string[]): Promise<LastMessageRow[]> {
  if (chatGroupIds.length === 0) return []
  return db.$queryRaw<LastMessageRow[]>`
    SELECT cm.id, cm.chat_group_id, cm.content, cm.type, cm.created_at, cm.user_id,
      cgm.anonymous_name as user_name
    FROM unnest(${chatGroupIds}::uuid[]) AS g(id)
    CROSS JOIN LATERAL (
      SELECT id, chat_group_id, content, type, created_at, user_id
      FROM chat_messages
      WHERE chat_group_id = g.id
        AND deleted_at IS NULL
        AND NOT (user_id = ANY(${blockedIds}::text[]))
      ORDER BY created_at DESC
      LIMIT 1
    ) cm
    LEFT JOIN chat_group_members cgm
      ON cm.user_id = cgm.user_id AND cm.chat_group_id = cgm.chat_group_id
  `
}

/**
 * Read markers, then what was said after each: the one pair of queries here
 * that cannot overlap, as the count is taken from the marker's timestamp.
 */
export async function unreadAfterMarkers(rooms: { chat_group_id: string; last_read_message_id: string | null }[], notUnread: string[]) {
  const markerIds = rooms.flatMap((m) => (m.last_read_message_id ? [m.last_read_message_id] : []))
  const markers = markerIds.length > 0
    ? await db.chat_messages.findMany({ where: { id: { in: markerIds } }, select: { id: true, created_at: true } })
    : []
  const lastReadMessageMap = new Map(markers.map((m) => [m.id, m.created_at]))

  // For groups with a read marker, count messages after that timestamp
  const read = rooms.flatMap((m) => {
    const lastReadAt = m.last_read_message_id ? lastReadMessageMap.get(m.last_read_message_id) : null
    return lastReadAt ? [{ chatGroupId: m.chat_group_id, lastReadAt }] : []
  })
  const unreadCountMap = new Map<string, number>()
  if (read.length > 0) {
    // Build parameterized SQL conditions for each group
    const conditions = read.map((m) => Prisma.sql`(chat_group_id = ${m.chatGroupId}::uuid AND created_at > ${m.lastReadAt}::timestamptz)`)
    const counts = await db.$queryRaw<Array<{ chat_group_id: string; unread_count: bigint }>>`
      SELECT chat_group_id, COUNT(*) as unread_count
      FROM chat_messages
      WHERE deleted_at IS NULL
        AND NOT (user_id = ANY(${notUnread}::text[]))
        AND (${Prisma.join(conditions, " OR ")})
      GROUP BY chat_group_id
    `
    for (const row of counts) unreadCountMap.set(row.chat_group_id, Number(row.unread_count))
  }
  return { lastReadMessageMap, unreadCountMap }
}

export type OtherMemberRow = Awaited<ReturnType<typeof crewAndBlendRooms>>[number]
