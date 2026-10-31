import { Prisma } from "@prisma/client"
import { hereCounts } from "@/lib/attendee-counts"
import { lastMessagesOf, unreadAfterMarkers, unreadTotalsOf, type OtherMemberRow } from "@/lib/chat-list"
import { db } from "@/lib/db"
import { inRoomWhere, realEventsWhere } from "@/lib/event-kind"
import { namesInRoom } from "@/lib/identity"
import { idForViewer } from "@/lib/room-handle"
import { roomMuteState } from "@/lib/room-mute"

/**
 * A chat list's rows, shared by `GET /chat/groups` (the Banter) and
 * `GET /me/muted-rooms` (the rooms you silenced): one builder, so a row means
 * the same thing wherever it is listed.
 *
 * The callers choose WHICH memberships (paging and filters are theirs); this
 * file owns what an event-room membership must satisfy to be listed at all (the
 * live-room and kind filters), the shape that query reads (`eventMemberArgs`)
 * and the rows built from them. Crew and Blend rooms, and their owners' doors,
 * are read by `crewAndBlendRooms` (`lib/chat-list.ts`).
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

/*
 * No `_count` of messages here: Prisma runs it as a `LEFT JOIN (SELECT … COUNT(*)
 * GROUP BY chat_group_id)` over every message on the platform. `buildChatRows`
 * counts for the page's rooms only.
 */
export const eventMemberArgs = {
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
} satisfies Prisma.chat_group_membersFindManyArgs

type RawEventRow = Prisma.chat_group_membersGetPayload<typeof eventMemberArgs>
export type EventMemberRow = Omit<RawEventRow, "chat_group"> & {
  chat_group: Omit<RawEventRow["chat_group"], "event"> & { event: NonNullable<RawEventRow["chat_group"]["event"]> }
}

/**
 * The where above reads only event rooms; this says so to the type, with
 * nothing to fall back on — a row without its event is not listed.
 */
export function eventRowsWithEvent(rows: RawEventRow[]): EventMemberRow[] {
  return rows.flatMap((m) => (m.chat_group.event ? [{ ...m, chat_group: { ...m.chat_group, event: m.chat_group.event } }] : []))
}

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
  /*
   * One wave, not seven in series: nothing here waits on anything else but the
   * unread count, which waits (inside `unreadAfterMarkers`) on the read markers
   * it counts from.
   */
  const allRooms = [...memberships, ...others]
  const chatGroupIds = allRooms.map((m) => m.chat_group_id)
  const eventIds = memberships.map((m) => m.chat_group.event.id)
  const [totals, lastMessagesRaw, unread, activeCheckIns, here] = await Promise.all([
    // Every visible message per room that is not an advert: what is unread for a member who has read nothing.
    unreadTotalsOf(chatGroupIds, notUnread),
    lastMessagesOf(chatGroupIds, blockedIds),
    unreadAfterMarkers(allRooms, notUnread),
    /*
     * Which of these rooms is the user standing in *right now*.
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
    eventIds.length > 0
      ? db.event_check_ins.findMany({
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
      : [],
    /*
     * How many are in each room: inside now (`hereCounts`), the Room's own
     * number, one GROUP BY for the page. Never the room's members — a member row
     * outlives the check-in, so that counted everybody who had ever been in.
     * A venue day's room says no count at all (below).
     */
    hereCounts(memberships.filter((m) => m.chat_group.event.kind !== "venue_day").map((m) => m.chat_group.event.id)),
  ])
  const { lastReadMessageMap, unreadCountMap } = unread
  const totalOf = totals
  const lastMessageMap = new Map(lastMessagesRaw.map((m) => [m.chat_group_id, m]))
  const checkedInEventIds = new Set(activeCheckIns.map((c) => c.event_id))

  // Build final response
  /*
   * Who wrote last in each crew and Blend room, named as that room names
   * people. A crew's chat names by first name whatever the crew, so every
   * crew's sender is one lookup; a Blend's names are its event's pseudonyms,
   * all Blends in one read — two reads at most, never one per room.
   */
  const roomSenderNames = new Map<string, string | null>()
  const withLast = others.flatMap((m) => {
    const last = lastMessageMap.get(m.chat_group.id)
    return last ? [{ id: m.chat_group.id, kind: m.chat_group.kind, sender: last.user_id }] : []
  })
  const crewRooms = withLast.filter((r) => r.kind === "crew")
  // A Blend's people go by their names in its event's room: one read for all the Blends, not one each.
  const blendRooms = others.flatMap((m) => {
    const last = lastMessageMap.get(m.chat_group.id)
    return m.chat_group.kind === "blend" && last ? [{ id: m.chat_group.id, eventId: m.chat_group.blend?.occurrence.event_id, sender: last.user_id }] : []
  })
  const [crewNamed, blendNames] = await Promise.all([
    crewRooms.length > 0 ? namesInRoom({ id: crewRooms[0].id, kind: "crew" }, crewRooms.map((r) => r.sender)) : new Map<string, string>(),
    blendRooms.length > 0
      ? db.chat_group_members.findMany({
          where: { OR: blendRooms.flatMap((r) => (r.eventId ? [{ chat_group: { event_id: r.eventId }, user_id: r.sender }] : [])) },
          select: { user_id: true, anonymous_name: true, chat_group: { select: { event_id: true } } },
        })
      : [],
  ])
  for (const r of crewRooms) roomSenderNames.set(r.id, crewNamed.get(r.sender) ?? null)
  const pseudonymIn = new Map(blendNames.map((n) => [`${n.chat_group.event_id}|${n.user_id}`, n.anonymous_name || "Attendee"]))
  for (const r of blendRooms) roomSenderNames.set(r.id, pseudonymIn.get(`${r.eventId}|${r.sender}`) ?? "Attendee")

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
      unreadCount = totalOf.get(membership.chat_group_id) ?? 0
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
      unreadCount: lastReadAt ? unreadCountMap.get(room.id) || 0 : (totalOf.get(room.id) ?? 0),
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
