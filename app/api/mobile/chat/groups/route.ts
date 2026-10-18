import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { inRoomWhere, realEventsWhere } from "@/lib/event-kind"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { blockCounterparties } from "@/lib/conversations"
import { PAGINATION } from "@/lib/constants"
import { namesInRoom } from "@/lib/identity"
import { idForViewer } from "@/lib/room-handle"
import { blendDoor, crewDoor, roomOwnerDenial } from "@/lib/room-kind"
import { roomMuteState } from "@/lib/room-mute"
import {
  successResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { boundedInt, paginationMeta } from "@/lib/pagination"

export async function GET(request: NextRequest) {
  try {
    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Archiving moved to app/api/cron/archive-chats. Doing it here meant it
    // only ran when somebody happened to open their chat list, so a room
    // nobody looked at stayed active indefinitely.

    // Parse pagination params
    const searchParams = request.nextUrl.searchParams
    const page = boundedInt(searchParams.get("page"), 1, 1, Number.MAX_SAFE_INTEGER)
    const limit = boundedInt(searchParams.get("limit"), PAGINATION.DEFAULT_LIMIT, 1, PAGINATION.MAX_LIMIT)

    /*
     * A venue's room is in the list only while your Go Live there is open
     * (`liveInVenueDay`). After it, the row carried the room's last message,
     * its sender's pseudonym, an exact unread count and member count — the
     * room you can no longer open, read from outside, and a counter that moves
     * with each arrival (step 4 review). Event rooms stay as they were.
     */
    const now = new Date()
    const liveRoomsOnly = {
      AND: [{ OR: [{ chat_group: { event: realEventsWhere } }, { last_allowed_at: { gt: now } }] }],
    }

    /*
     * A row says only what the room's history would show this viewer: no
     * preview, sender or unread count from somebody in a block with them,
     * either way — the history route's own filter (`blockCounterparties`).
     * Counted, or previewed, a blocked person's message told the blocker they
     * were still talking (step 9 review of the chat list).
     */
    /*
     * A mute silences; it does not banish (SCRUM-178). `active` alone
     * dropped a muted member's room out of the only list the phone has,
     * while the room itself still let them read — "you were never here"
     * beside "you can read but not write". Banned and left stay out:
     * those are removals. Likewise a locked room is still the member's
     * room, read-only; only an archived one is over.
     */
    const eventRoomsWhere = {
      user_id: authUser.userId,
      status: { in: ["active", "muted"] as ("active" | "muted")[] },
      chat_group: {
        // Event rooms. A room of another kind has no event to show here, and
        // an installed app reads `event` off every row; those rooms get their
        // own place in the list when the app does (step 9).
        kind: "event" as const,
        status: { in: ["active", "locked"] as ("active" | "locked")[] },
        // A draft or deleted event has no room (SCRUM-8, SCRUM-303) — the
        // same rule as `eventHidesRoom`, so the list agrees with the room.
        // any-kind: a member's own rooms, and a venue day's room is one they went live in (D-6).
        event: { deleted_at: null, status: { not: "draft" as const } },
      },
      ...liveRoomsOnly,
    }

    /*
     * One level, not four: the block list, the page's count, the page and the
     * crew and Blend rooms depend on nothing but the viewer, and ran one after
     * another (16 sequential levels, 41 statements, 75-88 ms warm on staging).
     * The per-room counts are no longer a `_count` on the page's query, which
     * Prisma ran as a `LEFT JOIN (SELECT … COUNT(*) GROUP BY chat_group_id)`
     * over every message on the platform; they are counted below, for the
     * page's rooms only.
     */
    const [blockedIds, totalCount, rows, others] = await Promise.all([
      blockCounterparties(authUser.userId),
      db.chat_group_members.count({ where: eventRoomsWhere }),
      db.chat_group_members.findMany({
        where: eventRoomsWhere,
        include: {
          chat_group: {
            include: {
              event: {
                select: {
                  id: true,
                  kind: true,
                  venue_id: true,
                  slug: true,
                  title: true,
                  cover_image_url: true,
                  start_time: true,
                  end_time: true,
                  status: true,
                },
              },
            },
          },
        },
        orderBy: {
          chat_group: {
            last_message_at: "desc",
          },
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      crewAndBlendRooms(authUser.userId, page),
    ])
    // What can be unread: never a blocked person's line, nor your own.
    const notUnread = [...blockedIds, authUser.userId]
    const unreadMessages = { deleted_at: null, user_id: { notIn: notUnread } }

    // The where above reads only event rooms; this says so to the type, with
    // nothing to fall back on — a row without its event is not listed.
    const memberships = rows.flatMap((m) =>
      m.chat_group.event ? [{ ...m, chat_group: { ...m.chat_group, event: m.chat_group.event } }] : []
    )

    // Batch fetch all data in one round, not N*3 queries: nothing below waits on anything else here
    // but the unread count, which waits on the read markers it counts from.
    const allRooms = [...memberships, ...others]
    const chatGroupIds = allRooms.map((m) => m.chat_group_id)
    const eventIds = memberships.map((m) => m.chat_group.event.id)

    /*
     * 4. Which of these rooms is the user standing in *right now*.
     *
     * An event room is a different thing depending on this. Checked in, it is
     * the live, anonymous room for the event happening around you — the whole
     * point of the product. Checked out, it is a room you were once in, and it
     * belongs in the list with everything else.
     *
     * The client cannot work this out: it has the rooms and it has the event
     * times, but "the event is on now" is not the same as "I am there". Someone
     * who never turned up, or who left an hour ago, has a room whose event is
     * mid-flight and no business in a live section.
     *
     * `checked_in` **and** no `check_out_time` — the status alone is not
     * enough, because check-out writes the timestamp and the sweeper can lag.
     */
    const [totalMessages, activeMembers, lastMessagesRaw, unread, activeCheckIns] = await Promise.all([
      // Every visible message per room: what is unread for a member who has read nothing.
      chatGroupIds.length > 0
        ? db.chat_messages.groupBy({ by: ["chat_group_id"], where: { chat_group_id: { in: chatGroupIds }, ...unreadMessages }, _count: { _all: true } })
        : [],
      // …and who is in each event room, for this page's rooms only.
      memberships.length > 0
        ? db.chat_group_members.groupBy({
            by: ["chat_group_id"],
            where: { chat_group_id: { in: memberships.map((m) => m.chat_group_id) }, status: "active" },
            _count: { _all: true },
          })
        : [],
      lastMessagesOf(chatGroupIds, blockedIds),
      unreadAfterMarkers(allRooms, notUnread),
      eventIds.length > 0
        ? db.event_check_ins.findMany({
            where: {
              user_id: authUser.userId,
              event_id: { in: eventIds },
              status: "checked_in",
              check_out_time: null,
              // A venue's room is live for you only while your Go Live is.
              ...inRoomWhere(authUser.userId, now),
            },
            select: { event_id: true },
          })
        : [],
    ])
    const { lastReadMessageMap, unreadCountMap } = unread
    const messageCountOf = new Map(totalMessages.map((r) => [r.chat_group_id, r._count._all]))
    const memberCountOf = new Map(activeMembers.map((r) => [r.chat_group_id, r._count._all]))
    const lastMessageMap = new Map(lastMessagesRaw.map((m) => [m.chat_group_id, m]))
    const checkedInEventIds = new Set(activeCheckIns.map((c) => c.event_id))

    // Build final response
    /*
     * Who wrote last in each crew and Blend room, named as that room names
     * people. A crew's chat names by first name whatever the crew, so every
     * crew's sender is one lookup; a Blend's names are its event's pseudonyms,
     * one Blend at a time — never a burst on the pool (`lib/db.ts`).
     */
    const roomSenderNames = new Map<string, string | null>()
    const withLast = others.flatMap((m) => {
      const last = lastMessageMap.get(m.chat_group.id)
      return last ? [{ id: m.chat_group.id, kind: m.chat_group.kind, sender: last.user_id }] : []
    })
    const crewRooms = withLast.filter((r) => r.kind === "crew")
    if (crewRooms.length > 0) {
      const named = await namesInRoom({ id: crewRooms[0].id, kind: "crew" }, crewRooms.map((r) => r.sender))
      for (const r of crewRooms) roomSenderNames.set(r.id, named.get(r.sender) ?? null)
    }
    for (const r of withLast.filter((x) => x.kind === "blend")) {
      roomSenderNames.set(r.id, (await namesInRoom({ id: r.id, kind: "blend" }, [r.sender])).get(r.sender) ?? null)
    }

    const groupsWithUnread = memberships.map((membership) => {
      const lastReadAt = membership.last_read_message_id
        ? lastReadMessageMap.get(membership.last_read_message_id)
        : null

      // Calculate unread count
      let unreadCount: number
      if (lastReadAt) {
        unreadCount = unreadCountMap.get(membership.chat_group_id) || 0
      } else {
        // User hasn't read any messages, count all
        unreadCount = messageCountOf.get(membership.chat_group_id) ?? 0
      }

      const lastMessage = lastMessageMap.get(membership.chat_group_id)
      const venueDay = membership.chat_group.event.kind === "venue_day"
      // The member's own room's place, never an owner's view of events.
      const venueId = venueDay ? membership.chat_group.event.venue_id : null

      return {
        id: membership.chat_group.id,
        /** Always `event` here (a venue day's room is one too); crews' and Blends' are in `rooms`. */
        kind: "event" as const,
        name: membership.chat_group.name,
        type: membership.chat_group.type,
        /*
         * Never for a venue's room: an exact count that moves as people go live
         * and expire is the differencing the venue's bucket exists to stop
         * (D-19, F14) — and it counts members whose windows have ended.
         */
        memberCount: venueDay ? null : (memberCountOf.get(membership.chat_group_id) ?? 0),
        unreadCount,
        /** Whether you silenced this room's pushes, and until when (`lib/room-mute.ts`). */
        mute: roomMuteState(membership.notification_preferences),
        lastMessageAt: membership.chat_group.last_message_at,
        lastMessage: lastMessage
          ? {
              id: lastMessage.id,
              /*
               * The branch is about *media*, not about one enum value.
               *
               * It read `type === "text"`, which was fine while `text` was the
               * only kind anything wrote. The moment announcements started
               * storing `announcement`, this rendered a perfectly ordinary
               * sentence as the literal string `[announcement]` in the
               * conversation list — a kind marker leaking into copy, from a
               * change three files away that looked purely additive.
               *
               * An image or a video has no text to preview. Everything else
               * does, whoever sent it and whatever kind it is.
               */
              content:
                lastMessage.type === "image" || lastMessage.type === "video"
                  ? `[${lastMessage.type}]`
                  : lastMessage.content.substring(0, 100),
              createdAt: lastMessage.created_at,
              user: {
                // The room's handle for anyone but you (SCRUM-371).
                id: idForViewer(authUser.userId, membership.chat_group.event.id, lastMessage.user_id),
                name: lastMessage.user_name,
              },
            }
          : null,
        event: {
          id: membership.chat_group.event.id,
          /** `venue_day`: a place's room — name it by the room's `name` (the place); its title is bookkeeping. */
          kind: membership.chat_group.event.kind,
          /** The place, for a venue day's room: "Go live again" opens it. Null for an event's room. */
          venueId,
          slug: membership.chat_group.event.slug,
          title: membership.chat_group.event.title,
          coverImageUrl: membership.chat_group.event.cover_image_url,
          startTime: membership.chat_group.event.start_time,
          endTime: membership.chat_group.event.end_time,
          status: membership.chat_group.event.status,
        },
        membership: {
          role: membership.role,
          joinedAt: membership.joined_at,
          /** `muted`: the room is readable, posting is refused. Label it. */
          status: membership.status,
        },
        /** `locked`: read-only for everyone until the organiser reopens it. */
        status: membership.chat_group.status,
        /** The user is checked in and has not checked out — this room is live. */
        isCheckedIn: checkedInEventIds.has(membership.chat_group.event.id),
      }
    })

    // The crew and Blend rows: who wrote last, named as that room names people.
    const rooms = others.map((m) => {
      const room = m.chat_group
      const kind = room.kind as "crew" | "blend"
      const lastMessage = lastMessageMap.get(room.id)
      const lastReadAt = m.last_read_message_id ? lastReadMessageMap.get(m.last_read_message_id) : null
      const scope = { kind, groupId: room.id }
      return {
        id: room.id,
        /** `crew` or `blend`: open it as that room, never as an event's. */
        kind,
        name: room.name,
        crewId: room.crew_id,
        blendId: room.blend_id,
        /** A Blend's clock: it closes then (the occurrence's end + 12 h). Null for a crew's chat. */
        closesAt: room.blend?.closes_at ?? null,
        unreadCount: lastReadAt ? unreadCountMap.get(room.id) || 0 : (messageCountOf.get(room.id) ?? 0),
        mute: roomMuteState(m.notification_preferences),
        // The newest message this viewer can see — a blocked person's later
        // line moves the room's own `last_message_at`, not this.
        lastMessageAt: lastMessage?.created_at ?? null,
        lastMessage: lastMessage
          ? {
              id: lastMessage.id,
              content:
                lastMessage.type === "image" || lastMessage.type === "video"
                  ? `[${lastMessage.type}]`
                  : lastMessage.content.substring(0, 100),
              createdAt: lastMessage.created_at,
              user: { id: idForViewer(authUser.userId, scope, lastMessage.user_id), name: roomSenderNames.get(room.id) },
            }
          : null,
        membership: { role: m.role, joinedAt: m.joined_at, status: m.status },
        status: room.status,
      }
    })
    // Newest visible message first, then rooms with none yet.
    rooms.sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0))

    return successResponse({
      /** Event and venue-day rooms, paged. Each says `kind: "event"`. */
      groups: groupsWithUnread,
      /** Crew and Blend rooms, newest message first, not paged (see above). */
      rooms,
      pagination: paginationMeta(page, limit, totalCount),
    })
  } catch (error) {
    logger.error("Get chat groups error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get chat groups")
  }
}

/**
 * Crew and Blend rooms (step 9): the viewer's crews' chats, and their Blends
 * while open — each as its door admits them now (a member of the crew; on a
 * side of the Blend, in no block across it). A list of their own, `rooms`, not
 * rows of `groups`: an installed app reads `event` off every `groups` row, and
 * these rooms have none. Not paged — a person is in at most `CREW.MAX_JOINED`
 * crews and a night's few Blends — so sent with the first page only.
 *
 * Most people are in none, and the doors are the expensive part (Prisma 7 runs
 * every `include` level as its own statement: 32 over 7 levels for the three
 * owners, for a person in no crew or Blend room at all). So the kinds the
 * viewer has rooms of are read first, in one cheap row each, and only those
 * kinds' doors are asked, side by side.
 */
async function crewAndBlendRooms(userId: string, page: number) {
  if (page > 1) return []
  const where = {
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

interface LastMessageRow {
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
async function lastMessagesOf(chatGroupIds: string[], blockedIds: string[]): Promise<LastMessageRow[]> {
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
async function unreadAfterMarkers(rooms: { chat_group_id: string; last_read_message_id: string | null }[], notUnread: string[]) {
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
