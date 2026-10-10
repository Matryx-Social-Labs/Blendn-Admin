// Relative imports throughout — see lib/conversations.ts.
import { blockCounterparties } from "../conversations"
import { CREW } from "../constants"
import { db } from "../db"
import { inRoomWhere } from "../event-kind"
import { namesInRoom } from "../identity"
import { logger } from "../logger"
import { sendBulkPushNotifications } from "../push-notifications"
import { deliverToRoom } from "../room-delivery"
import { isRoomMuted } from "../room-mute"
import { blocksBetween, blocksExclude } from "./blocks"
import { CREW_TAGS, NO_CREW, type CrewRefusal, type CrewTag } from "./crews"
import { crewBadges, nightsTogether, rankCrewsFor, type RankedCrew } from "./signals"
import type { Badge, Overlap } from "../overlaps"

/**
 * A crew at an event: presence, the crew cards, "We're here" (plan v2 §6).
 *
 * ## Presence is a query, never a column
 *
 * A crew is **present** at an occurrence when two or more of its members are
 * checked in there now — each by their own GPS, at their own door. Nothing
 * stores it, so it cannot drift from where people are, and "We're here"
 * cannot fake it: tapping it checks nobody in (CR-I04).
 *
 * "Checked in now" is the room's own idea of it: `checked_in` with no
 * checkout, and at a venue day only while the Go Live is open
 * (`inRoomWhere`). The suspended and the erased are on no crew surface.
 */

/** Checked in at this occurrence now. Spread into an `event_check_ins` filter. */
export function hereNowAt(occurrenceId: string, now: Date = new Date()) {
  return { occurrence_id: occurrenceId, status: "checked_in" as const, check_out_time: null, ...inRoomWhere(undefined, now) }
}

/**
 * The members of each crew who are checked in at this occurrence now, by crew.
 * A crew a moderator hid (`hidden_at`) is here for nobody: its own members
 * still have their crew, but no card, like or Blend comes of it (C12).
 */
export async function presentMembersAt(occurrenceId: string, crewIds?: readonly string[]): Promise<Map<string, string[]>> {
  const rows = await db.crew_members.findMany({
    where: {
      ...(crewIds && { crew_id: { in: [...crewIds] } }),
      crew: { dissolved_at: null, hidden_at: null },
      user: { suspended_at: null, deletedAt: null, event_check_ins: { some: hereNowAt(occurrenceId) } },
    },
    select: { crew_id: true, user_id: true },
  })
  const byCrew = new Map<string, string[]>()
  for (const r of rows) byCrew.set(r.crew_id, [...(byCrew.get(r.crew_id) ?? []), r.user_id])
  return byCrew
}

/** The occurrence this person is checked in at now, at this event, or null. */
export async function occurrenceHereNow(eventId: string, userId: string): Promise<string | null> {
  const row = await db.event_check_ins.findFirst({
    where: { event_id: eventId, user_id: userId, status: "checked_in", check_out_time: null, ...inRoomWhere(userId) },
    select: { occurrence_id: true },
    orderBy: { check_in_time: "desc" },
  })
  return row?.occurrence_id ?? null
}

/** An event a crew surface may be about: there, not a draft, not deleted. */
export async function crewEvent(eventId: string) {
  return db.events.findFirst({
    // any-kind: a crew can be here at a venue's room too — "We're here" at an event or a venue (§6).
    where: { id: eventId, deleted_at: null, status: { not: "draft" } },
    select: { id: true, crews_enabled: true },
  })
}

/** Active members, by crew, for these crews. */
export async function membersOf(crewIds: readonly string[]): Promise<Map<string, string[]>> {
  const rows = await db.crew_members.findMany({
    where: { crew_id: { in: [...crewIds] }, user: { suspended_at: null, deletedAt: null } },
    select: { crew_id: true, user_id: true },
  })
  const byCrew = new Map<string, string[]>()
  for (const r of rows) byCrew.set(r.crew_id, [...(byCrew.get(r.crew_id) ?? []), r.user_id])
  return byCrew
}

/**
 * Whether a crew and one person may match at all (§8.3, the research's
 * guardrails): the crew has room for one more, is no bigger than
 * `CREW.MAX_SOLO_MATCH` active members, and dating is out unless both chose it
 * — a group approaching one person romantically is the scenario women report
 * as unsafe. The person's own opt-in ("Open to joining a crew tonight") is
 * asked separately, because it is theirs to give. Pure.
 */
export function crewMayMeetSolo(
  crew: { open_to_solo: boolean; intent: readonly string[] },
  size: number,
  personIntents: readonly string[]
): boolean {
  if (!crew.open_to_solo || size > CREW.MAX_SOLO_MATCH) return false
  return !crew.intent.includes("dating") || personIntents.includes("dating")
}

/**
 * A person's intents at this event — what they chose here, else their
 * profile's default — and whether they are open to crews **now**: the opt-in
 * lasts until the end of the occurrence they gave it at (`open_to_crews_until`).
 */
export async function intentsAt(eventId: string, userId: string): Promise<{ intents: string[]; openToCrews: boolean }> {
  const [pref, profile] = await Promise.all([
    db.event_match_preferences.findUnique({
      where: { event_id_user_id: { event_id: eventId, user_id: userId } },
      select: { intent: true, open_to_crews_until: true },
    }),
    db.profiles.findUnique({ where: { id: userId }, select: { intent_default: true } }),
  ])
  return {
    intents: pref?.intent.length ? pref.intent : (profile?.intent_default ?? []),
    openToCrews: !!pref?.open_to_crews_until && pref.open_to_crews_until > new Date(),
  }
}

export interface CrewCard {
  crewId: string
  name: string
  bio: string | null
  emblemSeed: string
  /** "Crew of N": its active members. */
  size: number
  /** "Here now · N of size". Always ≥ 2: a crew with fewer here is not shown. */
  presentCount: number
  tags: { slug: string; label: string }[]
  intent: string[]
  /** Whether your side has liked them tonight. Never whether they liked you. */
  youLiked: boolean
  /**
   * Up to two lines of what the crew holds in common with your side — "Both
   * crews are into techno", "Two RCB crews" — crew-held only, never a member
   * or a count (lib/crews/signals.ts).
   */
  overlaps: Overlap[]
  /** "6 nights out together", from its members' check-ins. */
  badges: Badge[]
}

/**
 * Counts, never people (C4): no pseudonym, name or photo of anybody on a
 * card. A list of tonight's pseudonyms, beside a crew whose members later
 * reveal, lets a stranger eliminate the ones who kept themselves anonymous —
 * and a pseudonym that recurs with the same crew across nights links them.
 * Inside a Blend its people are shown (lib/crews/blends.ts); out here, a card.
 */

/** A page of cards: at most `CREW.CARDS_MAX`, `CREW.CARDS_DEFAULT` unless asked. */
export interface CardPage {
  limit: number
  offset: number
}

export type CrewsAtEvent =
  | { crewsEnabled: false; crews: []; myCrews: []; total: 0; hasMore: false }
  | {
      crewsEnabled: true
      crews: CrewCard[]
      /** The caller's own crews that are here now: what a like is sent "as". */
      myCrews: { crewId: string; name: string; presentCount: number }[]
      /** Every crew the caller may see here now, across pages. */
      total: number
      hasMore: boolean
    }

/**
 * The crews here now, as a checked-in person sees them (`GET /events/:id/crews`).
 *
 * - Only crews with two or more active members here now, never a hidden one.
 * - Not the caller's own crews (those are `myCrews`).
 * - Never a crew with any member kept apart (a block, or a closed
 *   conversation, either way) from the caller or from any member of the
 *   caller's crews here now: a block between any two members hides the crews
 *   from each other (§6 Safety, C6).
 * - A caller here without a crew of their own sees crews only after opting
 *   in ("Open to joining a crew tonight", until the end of the occurrence they
 *   said it at), and then only crews they may meet (`crewMayMeetSolo`: room
 *   for one more, ≤ 6, dating only if both chose it — §8.3).
 * - Most here first, then by id, a page at a time.
 *
 * A fixed handful of set-based reads however many crews are here (the PR
 * body has the EXPLAIN ANALYZE on a seeded 300-crew night). `null` for an
 * event that is not there; `"not_here"` for a caller who is not checked in
 * now — the room's own reciprocity.
 */
export async function crewsAtEvent(
  eventId: string,
  viewerId: string,
  page: CardPage = { limit: CREW.CARDS_DEFAULT, offset: 0 }
): Promise<CrewsAtEvent | null | "not_here"> {
  const event = await crewEvent(eventId)
  if (!event) return null
  const occurrenceId = await occurrenceHereNow(eventId, viewerId)
  if (!occurrenceId) return "not_here"
  if (!event.crews_enabled) return { crewsEnabled: false, crews: [], myCrews: [], total: 0, hasMore: false }

  const present = new Map([...(await presentMembersAt(occurrenceId))].filter(([, ids]) => ids.length >= CREW.MIN_MEMBERS))
  if (present.size === 0) return { crewsEnabled: true, crews: [], myCrews: [], total: 0, hasMore: false }

  const crews = await db.crews.findMany({
    // Standing and not hidden already: `presentMembersAt` reads only those.
    where: { id: { in: [...present.keys()] } },
    select: { id: true, name: true, bio: true, emblem_seed: true, tags: true, intent: true, open_to_solo: true },
  })
  const members = await membersOf(crews.map((c) => c.id))
  const mine = crews.filter((c) => present.get(c.id)?.includes(viewerId))
  const others = crews.filter((c) => !present.get(c.id)?.includes(viewerId))

  const mySide = [...new Set([viewerId, ...mine.flatMap((c) => members.get(c.id) ?? [])])]
  const blocked = await blocksBetween(mySide, [...new Set(others.flatMap((c) => members.get(c.id) ?? []))])
  let visible = others.filter((c) => !blocksExclude(mySide, members.get(c.id) ?? [], blocked))

  let viewerIntents: string[] = []
  if (mine.length === 0) {
    const me = await intentsAt(eventId, viewerId)
    viewerIntents = me.intents
    visible = me.openToCrews
      ? visible.filter((c) => crewMayMeetSolo(c, members.get(c.id)?.length ?? 0, me.intents))
      : []
  }

  const presentCount = (id: string) => present.get(id)?.length ?? 0
  /*
   * Ranked from the viewer's side (lib/crews/signals.ts): crew-held interests
   * and intent, damped for a size mismatch; then most here, then id, so a
   * page boundary never moves between two reads of the same room.
   */
  const myCrew = [...mine].sort((a, b) => presentCount(b.id) - presentCount(a.id) || (a.id < b.id ? -1 : 1))[0]
  const ranked =
    visible.length > 0
      ? await rankCrewsFor({
          viewerId,
          mine: myCrew ? { id: myCrew.id, intent: myCrew.intent, present: present.get(myCrew.id) ?? [] } : null,
          viewerIntents,
          crews: visible.map((c) => ({ id: c.id, intent: c.intent, present: present.get(c.id) ?? [] })),
          roomSize: await db.event_check_ins.count({ where: { ...hereNowAt(occurrenceId), kind: "attendee" } }),
        })
      : new Map<string, RankedCrew>()
  const scoreOf = (id: string) => ranked.get(id)?.score ?? 0
  visible.sort(
    (a, b) => scoreOf(b.id) - scoreOf(a.id) || presentCount(b.id) - presentCount(a.id) || (a.id < b.id ? -1 : 1)
  )
  const shown = visible.slice(page.offset, page.offset + page.limit)
  const nights = await nightsTogether(shown.map((c) => c.id))

  // What your side liked tonight, of this page: your crews here, or you.
  const liked = new Set(
    (
      await db.crew_likes.findMany({
        where: {
          occurrence_id: occurrenceId,
          to_crew_id: { in: shown.map((c) => c.id) },
          ...(mine.length ? { from_crew_id: { in: mine.map((c) => c.id) } } : { from_user_id: viewerId }),
        },
        select: { to_crew_id: true },
      })
    ).map((l) => l.to_crew_id)
  )

  return {
    crewsEnabled: true,
    crews: shown.map((c) => ({
      crewId: c.id,
      name: c.name,
      bio: c.bio,
      emblemSeed: c.emblem_seed,
      size: members.get(c.id)?.length ?? 0,
      presentCount: presentCount(c.id),
      tags: c.tags.filter((t): t is CrewTag => t in CREW_TAGS).map((t) => ({ slug: t, label: CREW_TAGS[t] })),
      intent: c.intent,
      youLiked: liked.has(c.id),
      overlaps: ranked.get(c.id)?.overlaps ?? [],
      badges: crewBadges(nights.get(c.id) ?? 0),
    })),
    myCrews: mine.map((c) => ({ crewId: c.id, name: c.name, presentCount: presentCount(c.id) })),
    total: visible.length,
    hasMore: page.offset + shown.length < visible.length,
  }
}

/* -------------------------------------------------------------------------- */
/* "We're here"                                                               */
/* -------------------------------------------------------------------------- */

const CREWS_OFF: CrewRefusal = { refusal: "The host has turned crews off for this event.", status: 403 }
const NOT_IN: CrewRefusal = { refusal: "Check in first — \"We're here\" is for when you're in.", status: 403 }
const NO_EVENT: CrewRefusal = { refusal: "Event not found", status: 404 }

/**
 * "We're here" (§6): a line in the crew chat, and a push to every other
 * member — once per person per crew per occurrence, never to the person who
 * tapped it, never to a member who muted the crew chat or is in a block with
 * them. A member who turned notifications off (`push_enabled`) gets no push
 * but does get the bell line, as every bulk send writes one
 * (`sendBulkPushNotifications`).
 *
 * Once means once: the line itself is the record. Whether this person already
 * said it in this crew's room for this occurrence is read, and the line
 * written, in one transaction under an advisory lock on (room, person,
 * occurrence) — so it holds across restarts and replicas, and a double tap
 * cannot write two. Keyed on the crew as the database knows it, never on the
 * id as the path spelled it (an upper-case uuid is the same crew).
 *
 * The tapper must be checked in here now, by their own GPS. Nobody else is
 * checked in by it: each member checks in at their own door (CR-I04).
 *
 * The push carries no place: a lock screen is read by whoever holds the
 * phone. The line in the crew chat carries the event in its metadata, for
 * the members it was meant for.
 */
export async function crewHere(
  userId: string,
  crewId: string,
  eventId: string
): Promise<{ notified: number; repeated: boolean } | CrewRefusal> {
  const crew = await db.crews.findFirst({
    where: { id: crewId, dissolved_at: null, members: { some: { user_id: userId, user: { suspended_at: null } } } },
    select: { id: true, name: true, room: { select: { id: true, kind: true, name: true } } },
  })
  if (!crew?.room) return NO_CREW
  const event = await crewEvent(eventId)
  if (!event) return NO_EVENT
  if (!event.crews_enabled) return CREWS_OFF
  const occurrenceId = await occurrenceHereNow(event.id, userId)
  if (!occurrenceId) return NOT_IN

  const room = crew.room
  const message = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crew-here:${room.id}:${userId}:${occurrenceId}`}, 0))`
    const said = await tx.chat_messages.findFirst({
      where: {
        chat_group_id: room.id,
        user_id: userId,
        type: "system",
        AND: [{ metadata: { path: ["kind"], equals: "crew_here" } }, { metadata: { path: ["occurrenceId"], equals: occurrenceId } }],
      },
      select: { id: true },
    })
    if (said) return null
    const line = await tx.chat_messages.create({
      data: {
        chat_group_id: room.id,
        user_id: userId,
        type: "system",
        // No name in the words: the room names the sender (`namesInRoom`), and
        // stored text outlives an account erasure where a name must not.
        content: "We're here 👋",
        metadata: { kind: "crew_here", eventId: event.id, occurrenceId },
      },
    })
    await tx.chat_groups.update({ where: { id: room.id }, data: { last_message_at: line.created_at } })
    return line
  })
  if (!message) return { notified: 0, repeated: true }

  const senderName = (await namesInRoom(room, [userId])).get(userId) ?? "Someone"
  await deliverToRoom({
    chatGroupId: room.id,
    scope: { kind: "crew", groupId: room.id },
    groupName: room.name,
    senderId: userId,
    senderAnonName: senderName,
    message,
    preview: message.content,
  })

  const [others, blocked] = await Promise.all([
    db.chat_group_members.findMany({
      where: {
        chat_group_id: room.id,
        user_id: { not: userId },
        status: { in: ["active", "muted"] },
        user: { suspended_at: null, deletedAt: null, crew_memberships: { some: { crew_id: crew.id } } },
      },
      select: { user_id: true, notification_preferences: true },
    }),
    blockCounterparties(userId),
  ])
  const recipients = others
    .filter((m) => !blocked.includes(m.user_id) && !isRoomMuted(m.notification_preferences))
    .map((m) => m.user_id)
  if (recipients.length > 0) {
    await sendBulkPushNotifications({
      userIds: recipients,
      title: crew.name,
      body: "Someone from your crew is here 👋",
      data: { type: "crew_here", crewId: crew.id, chatGroupId: room.id },
    }).catch((error: unknown) => logger.warn("Push notification failed", { context: "crew here", error: String(error) }))
  }
  return { notified: recipients.length, repeated: false }
}
