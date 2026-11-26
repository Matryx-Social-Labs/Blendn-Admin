import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { blendDoor, boardPostDoor, crewDoor, roomReadDenialFor } from "@/lib/room-kind"

/* The reads behind a chat list (GET /chat/groups, GET /me/muted-rooms); the rows are built in `lib/chat-group-rows.ts`. */

/**
 * The rooms whose owner is not an event (step 9; Lobby rooms, Flow 5 C5 B-A): the viewer's crews' chats, their Blends
 * while open, and the Lobby (board post) rooms they were seated in until the post's room closes — each as its door
 * admits them now (`roomReadDenialFor`: a member of the crew; on a side of the Blend, in no block across it; the
 * post's author or an accepted asker, the post standing, its event's room not yet closed). A list of their own,
 * `rooms`, not rows of `groups`: an installed app reads `event` off every `groups` row, and these rooms have none.
 * Not paged — a person is in at most `CREW.MAX_JOINED` crews, a night's few Blends and the few rides of nights not
 * over — so the list sends them with its first page only.
 *
 * Most people are in none, and the doors are the expensive part (Prisma 7 runs
 * every `include` level as its own statement: 32 over 7 levels for the three
 * owners, for a person in no crew or Blend room at all). So the kinds the
 * viewer has rooms of are read first, in one cheap row each, and only those
 * kinds' doors are asked, side by side.
 */
export async function ownedRooms(userId: string, only: Prisma.chat_group_membersWhereInput = {}, now: Date = new Date()) {
  // Listed: a mute silences, it does not banish (SCRUM-178). `only` narrows further (the muted list's ids).
  const where = {
    ...only,
    user_id: userId,
    status: { in: ["active", "muted"] as ("active" | "muted")[] },
  }
  const openOrLocked = { in: ["active", "locked"] as ("active" | "locked")[] }
  const crewWhere = { ...where, chat_group: { kind: "crew" as const, status: openOrLocked } }
  const blendWhere = { ...where, chat_group: { kind: "blend" as const, status: "active" as const } }
  const boardWhere = { ...where, chat_group: { kind: "board_post" as const, status: openOrLocked } }
  const has = await db.chat_group_members.findMany({
    where: { OR: [crewWhere, blendWhere, boardWhere] },
    select: { chat_group: { select: { kind: true } } },
  })
  const kinds = new Set(has.map((m) => m.chat_group.kind))
  const memberSelect = {
    chat_group_id: true,
    status: true,
    left_at: true,
    role: true,
    joined_at: true,
    last_read_message_id: true,
    notification_preferences: true,
  } as const
  const roomSelect = { id: true, kind: true, name: true, status: true, last_message_at: true, crew_id: true, blend_id: true } as const
  const door = boardPostDoor(userId)
  // The door's rows, plus what the Banter row says about the post (Flow 5 C5: "Your ride").
  const boardPost = { select: { ...door.select, id: true, kind: true, sub_kind: true, event_id: true } }

  const [crews, blends, boards] = await Promise.all([
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
    kinds.has("board_post")
      ? db.chat_group_members.findMany({
          where: boardWhere,
          select: { ...memberSelect, chat_group: { select: { ...roomSelect, board_post: boardPost } } },
        })
      : [],
  ])
  // Who is let in — a crew dissolved, a Blend closed on its clock or early, a post withdrawn or its room over, a
  // block across it — is the door's, the one rule.
  const rooms = [
    ...crews.map((m) => ({ ...m, chat_group: { ...m.chat_group, blend: null, board_post: null } })),
    ...blends.map((m) => ({ ...m, chat_group: { ...m.chat_group, crew: null, board_post: null } })),
    ...boards.map((m) => ({ ...m, chat_group: { ...m.chat_group, crew: null, blend: null } })),
  ]
  return rooms.filter((m) => roomReadDenialFor({ ...m.chat_group, event: null }, { ...m, last_allowed_at: null }, userId, now) === null)
}

/**
 * Not an advert: the scheduler marks a sponsored send by `metadata.sponsored_message_id`, as a poll of the sponsored kind,
 * or (older) by the sponsored type, the same marks the history reads. An advert is never a room's line (SCRUM-625) and
 * counts as nothing in unread (SCRUM-924).
 */
const NOT_AN_ADVERT = Prisma.sql`type <> 'sponsored'
  AND metadata ->> 'sponsored_message_id' IS NULL
  AND (type <> 'poll' OR metadata ->> 'kind' IS DISTINCT FROM 'sponsored')`

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
 * message is absent, as before. A sponsored send is not a message here.
 */
export async function lastMessagesOf(chatGroupIds: string[], blockedIds: string[], hiddenLineIds: string[] = []): Promise<LastMessageRow[]> {
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
        AND NOT (id = ANY(${hiddenLineIds}::uuid[]))
        AND ${NOT_AN_ADVERT}
      ORDER BY created_at DESC
      LIMIT 1
    ) cm
    LEFT JOIN chat_group_members cgm
      ON cm.user_id = cgm.user_id AND cm.chat_group_id = cgm.chat_group_id
  `
}

/**
 * The most a room's `unreadCount` says (SCRUM-1223): the app shows "9+" above 9, so 10 is all it needs, and each room's
 * count stops at its tenth row (`LIMIT` inside the `LATERAL`) however long the room's history is.
 */
const UNREAD_ROOM_CAP = 10

/** A line that can be unread for this viewer: visible, not theirs, not from a block, not hidden, not an advert. */
const mayBeUnread = (notUnread: string[], hiddenLineIds: string[]) => Prisma.sql`deleted_at IS NULL
  AND NOT (user_id = ANY(${notUnread}::text[]))
  AND NOT (id = ANY(${hiddenLineIds}::uuid[]))
  AND ${NOT_AN_ADVERT}`

/**
 * What was said after each room's read marker, capped at `UNREAD_ROOM_CAP`: the read markers first, then one statement.
 * A marker whose message is gone counts the room from its start, as `unreadTotalsOf` would.
 */
export async function unreadAfterMarkers(rooms: { chat_group_id: string; last_read_message_id: string | null }[], notUnread: string[], hiddenLineIds: string[]) {
  const marked = rooms.flatMap((m) => (m.last_read_message_id ? [{ roomId: m.chat_group_id, markerId: m.last_read_message_id }] : []))
  if (marked.length === 0) return new Map<string, number>()
  const markers = await db.chat_messages.findMany({ where: { id: { in: marked.map((m) => m.markerId) } }, select: { id: true, created_at: true } })
  const readAt = new Map(markers.map((m) => [m.id, m.created_at]))
  const counts = await db.$queryRaw<Array<{ chat_group_id: string; unread: number }>>`
    SELECT r.id AS chat_group_id, count(*)::int AS unread
    FROM unnest(${marked.map((m) => m.roomId)}::uuid[], ${marked.map((m) => readAt.get(m.markerId) ?? null)}::timestamptz[]) AS r(id, read_at)
    CROSS JOIN LATERAL (
      SELECT 1 FROM chat_messages
      WHERE chat_group_id = r.id
        AND created_at > COALESCE(r.read_at, '-infinity')
        AND ${mayBeUnread(notUnread, hiddenLineIds)}
      LIMIT ${UNREAD_ROOM_CAP}
    ) m
    GROUP BY r.id
  `
  return new Map(counts.map((r) => [r.chat_group_id, r.unread]))
}

/** Unread for a member who has read nothing, capped at `UNREAD_ROOM_CAP`. Pass only the rooms with no read marker. */
export async function unreadTotalsOf(chatGroupIds: string[], notUnread: string[], hiddenLineIds: string[]): Promise<Map<string, number>> {
  if (chatGroupIds.length === 0) return new Map()
  const rows = await db.$queryRaw<Array<{ chat_group_id: string; total: number }>>`
    SELECT g.id AS chat_group_id, count(*)::int AS total
    FROM unnest(${chatGroupIds}::uuid[]) AS g(id)
    CROSS JOIN LATERAL (
      SELECT 1 FROM chat_messages
      WHERE chat_group_id = g.id
        AND ${mayBeUnread(notUnread, hiddenLineIds)}
      LIMIT ${UNREAD_ROOM_CAP}
    ) m
    GROUP BY g.id
  `
  return new Map(rows.map((r) => [r.chat_group_id, r.total]))
}

/** "With Lunar Fox, Velvet Owl and 2 others": the Banter row names three at most (Flow 5 C5). */
export const LOBBY_NAMES_MAX = 3

/** Who else is in each Lobby room, by room pseudonym: the author first, three at most, and how many in all. */
export interface LobbyOthers {
  names: string[]
  count: number
}

/**
 * The others in these Lobby (board post) rooms, for the Banter's "With Lunar Fox and 2 others" (Flow 5 C5): seated
 * members the post still admits (its author, or an accepted asker -- the door's own rule, `boardPostDenial`), not the
 * viewer, never somebody in a block with them, not anyone who left or was removed. One statement for every room;
 * the window keeps three names a room however many are seated, and counts the rest.
 */
export async function lobbyOthersOf(chatGroupIds: string[], viewerId: string, blockedIds: string[]): Promise<Map<string, LobbyOthers>> {
  if (chatGroupIds.length === 0) return new Map()
  const rows = await db.$queryRaw<Array<{ chat_group_id: string; name: string; n: bigint }>>`
    SELECT chat_group_id, name, n FROM (
      SELECT cgm.chat_group_id, COALESCE(cgm.anonymous_name, 'Attendee') AS name,
        row_number() OVER (
          PARTITION BY cgm.chat_group_id
          ORDER BY (cgm.user_id = bp.author_id) DESC, cgm.joined_at, cgm.anonymous_name, cgm.user_id
        ) AS rn,
        count(*) OVER (PARTITION BY cgm.chat_group_id) AS n
      FROM chat_group_members cgm
      JOIN chat_groups cg ON cg.id = cgm.chat_group_id
      JOIN board_posts bp ON bp.id = cg.board_post_id
      WHERE cgm.chat_group_id = ANY(${chatGroupIds}::uuid[])
        -- Left (by choice or removed) and banned are out; left_at is only ever set beside status left.
        AND cgm.status IN ('active', 'muted')
        AND cgm.user_id <> ${viewerId}
        AND NOT (cgm.user_id = ANY(${blockedIds}::text[]))
        AND (
          cgm.user_id = bp.author_id
          OR EXISTS (
            SELECT 1 FROM board_requests br
            WHERE br.post_id = bp.id AND br.from_user_id = cgm.user_id AND br.status = 'accepted'
          )
        )
    ) seated
    WHERE rn <= ${LOBBY_NAMES_MAX}
    ORDER BY chat_group_id, rn
  `
  const out = new Map<string, LobbyOthers>()
  for (const r of rows) {
    const room = out.get(r.chat_group_id) ?? { names: [], count: Number(r.n) }
    out.set(r.chat_group_id, { ...room, names: [...room.names, r.name] })
  }
  return out
}

export type OtherMemberRow = Awaited<ReturnType<typeof ownedRooms>>[number]
