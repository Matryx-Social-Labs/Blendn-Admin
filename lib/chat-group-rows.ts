import { Prisma } from "@prisma/client"
import { hereCounts } from "@/lib/attendee-counts"
import { db } from "@/lib/db"
import { inRoomWhere, realEventsWhere } from "@/lib/event-kind"
import { namesInRoom } from "@/lib/identity"
import { idForViewer } from "@/lib/room-handle"
import { ownerDoor, roomOwnerDenial } from "@/lib/room-kind"
import { roomMuteState } from "@/lib/room-mute"

/**
 * A chat list's rows, shared by `GET /chat/groups` (the Banter) and
 * `GET /me/muted-rooms` (the rooms you silenced): one builder, so a row means
 * the same thing wherever it is listed.
 *
 * The callers choose WHICH memberships (paging and filters are theirs); this
 * file owns what a membership must satisfy to be listed at all (the live-room
 * and kind filters, the owner's door), the shape the queries read
 * (`eventMemberArgs`, `otherMemberArgs`) and the rows built from them.
 */

/**
 * A venue's room is in the list only while your Go Live there is open
 * (`liveInVenueDay`). After it, the row carried the room's last message,
 * its sender's pseudonym, an exact unread count and member count — the
 * room you can no longer open, read from outside, and a counter that moves
 * with each arrival (step 4 review). Event rooms stay as they were.
 */
export const liveRoomsOnly = (now: Date) => ({
  AND: [{ OR: [{ chat_group: { event: realEventsWhere } }, { last_allowed_at: { gt: now } }] }],
})

/**
 * A mute silences; it does not banish (SCRUM-178). `active` alone dropped a
 * muted member's room out of the only list the phone has, while the room
 * itself still let them read. Banned and left stay out: those are removals.
 */
export const LISTED_MEMBER_STATUSES = ["active", "muted"] as const

/**
 * Event rooms. A room of another kind has no event to show in `groups`, and an
 * installed app reads `event` off every row; those rooms are `rooms`.
 * A draft or deleted event has no room (SCRUM-8, SCRUM-303) — the same rule as
 * `eventHidesRoom`. Likewise a locked room is still the member's room,
 * read-only; only an archived one is over. any-kind: a member's own rooms, and
 * a venue day's room is one they went live in (D-6).
 */
export const EVENT_ROOM_WHERE = {
  kind: "event" as const,
  status: { in: ["active", "locked"] as ("active" | "locked")[] },
  event: { deleted_at: null, status: { not: "draft" as const } },
}

/**
 * Crew and Blend rooms: the viewer's crews' chats, and their Blends while open.
 * Who is let in — a crew dissolved or a Blend closed, on its clock or early, a
 * block across it — is the door's (`openRooms`), the one rule.
 */
export const OTHER_ROOM_WHERE = {
  OR: [
    { kind: "crew" as const, status: { in: ["active", "locked"] as ("active" | "locked")[] } },
    { kind: "blend" as const, status: "active" as const },
  ],
}

export const eventMemberArgs = (unreadMessages: Prisma.chat_messagesWhereInput) =>
  ({
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
          _count: { select: { messages: { where: unreadMessages } } },
        },
      },
    },
  }) satisfies Prisma.chat_group_membersFindManyArgs

/** What the owner's door reads for a crew or Blend room: enough to say whether this viewer may still enter. */
export const doorArgs = (userId: string) =>
  ({
    select: {
      chat_group_id: true,
      chat_group: {
        select: { id: true, kind: true, status: true, crew_id: true, blend_id: true, ...ownerDoor(userId) },
      },
    },
  }) satisfies Prisma.chat_group_membersFindManyArgs

export const otherMemberArgs = (userId: string, unreadMessages: Prisma.chat_messagesWhereInput) =>
  ({
    select: {
      chat_group_id: true,
      status: true,
      role: true,
      joined_at: true,
      last_read_message_id: true,
      notification_preferences: true,
      chat_group: {
        select: {
          ...doorArgs(userId).select.chat_group.select,
          name: true,
          last_message_at: true,
          _count: { select: { messages: { where: unreadMessages } } },
        },
      },
    },
  }) satisfies Prisma.chat_group_membersFindManyArgs

type RawEventRow = Prisma.chat_group_membersGetPayload<ReturnType<typeof eventMemberArgs>>
export type EventMemberRow = Omit<RawEventRow, "chat_group"> & {
  chat_group: Omit<RawEventRow["chat_group"], "event"> & { event: NonNullable<RawEventRow["chat_group"]["event"]> }
}
export type OtherMemberRow = Prisma.chat_group_membersGetPayload<ReturnType<typeof otherMemberArgs>>
type DoorRow = Prisma.chat_group_membersGetPayload<ReturnType<typeof doorArgs>>

/**
 * The where above reads only event rooms; this says so to the type, with
 * nothing to fall back on — a row without its event is not listed.
 */
export function eventRowsWithEvent(rows: RawEventRow[]): EventMemberRow[] {
  return rows.flatMap((m) => (m.chat_group.event ? [{ ...m, chat_group: { ...m.chat_group, event: m.chat_group.event } }] : []))
}

/** The crew and Blend rows the viewer may still enter, as the room's owner says now. */
export const openRooms = <T extends DoorRow>(rows: T[], userId: string): T[] =>
  rows.filter((m) => roomOwnerDenial({ ...m.chat_group, event: null }, userId) === null)

export interface ChatRowsInput {
  userId: string
  memberships: EventMemberRow[]
  others: OtherMemberRow[]
  /** Never unread: a blocked person's line, nor your own. */
  notUnread: string[]
  blockedIds: string[]
  now: Date
}

export async function buildChatRows({ userId, memberships, others, notUnread, blockedIds, now }: ChatRowsInput) {
  // Batch fetch all data in 3 queries instead of N*3 queries
  const chatGroupIds = [...memberships, ...others].map((m) => m.chat_group_id)

  // 1. Batch fetch last read messages (single query)
  const lastReadMessageIds = [...memberships, ...others]
    .filter((m) => m.last_read_message_id)
    .map((m) => m.last_read_message_id!)

  const lastReadMessages =
    lastReadMessageIds.length > 0
      ? await db.chat_messages.findMany({
          where: { id: { in: lastReadMessageIds } },
          select: { id: true, created_at: true },
        })
      : []

  const lastReadMessageMap = new Map(
    lastReadMessages.map((m) => [m.id, m.created_at])
  )

  // 2. Batch fetch last message per group using raw SQL (single query)
  type LastMessageRow = {
    id: string
    chat_group_id: string
    content: string
    type: string
    created_at: Date
    user_id: string
    user_name: string | null
  }

  const lastMessagesRaw: LastMessageRow[] = chatGroupIds.length > 0
    ? await db.$queryRaw<LastMessageRow[]>`
        SELECT DISTINCT ON (cm.chat_group_id)
          cm.id, cm.chat_group_id, cm.content, cm.type, cm.created_at, cm.user_id,
          cgm.anonymous_name as user_name
        FROM chat_messages cm
        LEFT JOIN chat_group_members cgm
          ON cm.user_id = cgm.user_id AND cm.chat_group_id = cgm.chat_group_id
        WHERE cm.chat_group_id = ANY(${chatGroupIds}::uuid[])
          AND cm.deleted_at IS NULL
          AND NOT (cm.user_id = ANY(${blockedIds}::text[]))
        ORDER BY cm.chat_group_id, cm.created_at DESC
      `
    : []

  const lastMessageMap = new Map(
    lastMessagesRaw.map((m) => [m.chat_group_id, m])
  )

  // 3. Batch calculate unread counts (single query)
  // Build membership data for unread calculation
  const membershipData = [...memberships, ...others].map((m) => ({
    chatGroupId: m.chat_group_id,
    lastReadAt: m.last_read_message_id
      ? lastReadMessageMap.get(m.last_read_message_id)
      : null,
    totalMessages: m.chat_group._count.messages,
  }))

  // For groups with last_read_message_id, count messages after that timestamp
  const groupsWithLastRead = membershipData.filter((m) => m.lastReadAt)

  const unreadCountMap = new Map<string, number>()

  if (groupsWithLastRead.length > 0) {
    // Build parameterized SQL conditions for each group
    const conditions = groupsWithLastRead.map((m) =>
      Prisma.sql`(chat_group_id = ${m.chatGroupId}::uuid AND created_at > ${m.lastReadAt!}::timestamptz)`
    )

    const unreadCountsRaw = await db.$queryRaw<
      Array<{ chat_group_id: string; unread_count: bigint }>
    >`
      SELECT chat_group_id, COUNT(*) as unread_count
      FROM chat_messages
      WHERE deleted_at IS NULL
        AND NOT (user_id = ANY(${notUnread}::text[]))
        AND (${Prisma.join(conditions, " OR ")})
      GROUP BY chat_group_id
    `

    unreadCountsRaw.forEach((row) => {
      unreadCountMap.set(row.chat_group_id, Number(row.unread_count))
    })
  }

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
  const eventIds = memberships.map((m) => m.chat_group.event.id)
  const activeCheckIns = eventIds.length > 0
    ? await db.event_check_ins.findMany({
        where: {
          user_id: userId,
          event_id: { in: eventIds },
          status: "checked_in",
          check_out_time: null,
          // A venue's room is live for you only while your Go Live is.
          ...inRoomWhere(userId, now),
        },
        select: { event_id: true },
      })
    : []
  const checkedInEventIds = new Set(activeCheckIns.map((c) => c.event_id))

  /*
   * 5. How many are in each room: inside now (`hereCounts`), the Room's own
   * number, one GROUP BY for the page. Never the room's members — a member row
   * outlives the check-in, so that counted everybody who had ever been in.
   * A venue day's room says no count at all (below).
   */
  const here = await hereCounts(memberships.filter((m) => m.chat_group.event.kind !== "venue_day").map((m) => m.chat_group.event.id))

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
      unreadCount = membership.chat_group._count.messages
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
       * (D-19, F14).
       */
      hereCount: venueDay ? null : here.get(membership.chat_group.event.id) ?? 0,
      /** `hereCount` under its old name, for the apps installed before it: every one of them prints it as "N in the room". */
      memberCount: venueDay ? null : here.get(membership.chat_group.event.id) ?? 0,
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
            /** The message's kind (`text`, `image`, `system`, `announcement`…): a `system` line is the room's, so the list says no "You:" before it (S-7). */
            type: lastMessage.type,
            createdAt: lastMessage.created_at,
            user: {
              // The room's handle for anyone but you (SCRUM-371).
              id: idForViewer(userId, membership.chat_group.event.id, lastMessage.user_id),
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
      unreadCount: lastReadAt ? unreadCountMap.get(room.id) || 0 : room._count.messages,
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
            // As on `groups`: a crew's "liked … for the crew" line is `system` (S-7).
            type: lastMessage.type,
            createdAt: lastMessage.created_at,
            user: { id: idForViewer(userId, scope, lastMessage.user_id), name: roomSenderNames.get(room.id) },
          }
        : null,
      membership: { role: m.role, joinedAt: m.joined_at, status: m.status },
      status: room.status,
    }
  })
  return { groups: groupsWithUnread, rooms }
}
