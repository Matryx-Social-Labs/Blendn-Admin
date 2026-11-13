// Relative imports throughout — see lib/conversations.ts.
import { blockCounterparties } from "../conversations"
import { CREW } from "../constants"
import { db } from "../db"
import { inRoomWhere } from "../event-kind"
import { crewMemberImages, namesInRoom } from "../identity"
import { logger } from "../logger"
import { sendBulkPushNotifications } from "../push-notifications"
import { deliverToRoom } from "../room-delivery"
import { isRoomMuted } from "../room-mute"
import { blocksBetween, blocksExclude } from "./blocks"
import { UNNAMED } from "../conversation-identity"
import { idForViewer } from "../room-handle"
import { strangersApartBetween } from "../room-people"
import { CREW_TAGS, CREWS_OFF, NO_CREW, NO_EVENT, type CrewRefusal, type CrewTag } from "./crews"
import { crewBadges, nightsTogether, rankCrewsFor, type RankedCrew } from "./signals"
import type { Badge, Overlap } from "../overlaps"
import { eventRoomBan, notHostBannedFrom } from "../room-kind"

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
  return { occurrence_id: occurrenceId, kind: "attendee" as const, status: "checked_in" as const, check_out_time: null, ...inRoomWhere(undefined, now) }
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
      user: {
        suspended_at: null,
        deletedAt: null,
        event_check_ins: { some: hereNowAt(occurrenceId) },
        // A member a host banned from this room is no crew member here (review H2).
        // any-kind: the room is this occurrence's, an event's or a venue day's alike — a crew can be here at either (§6).
        ...notHostBannedFrom({ event: { occurrences: { some: { id: occurrenceId } } } }),
      },
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
    // A guest: staff are out of matching, a crew's included (SCRUM-891).
    where: { event_id: eventId, user_id: userId, kind: "attendee", status: "checked_in", check_out_time: null, ...inRoomWhere(userId) },
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

/** A crewmate on your crew's strip: in now, and came in with the crew. */
export interface CrewmateIn {
  /** Their handle in the crew's room (yours real), as `GET /crews/:id` lists them. */
  userId: string
  name: string
  photo: string | null
  you: boolean
}

export interface MyCrewHere {
  crewId: string
  name: string
  /** Every member checked in now. Installed builds' "N of M here". */
  presentCount: number
  /**
   * Who is in with the crew, first in first (S2): checked in now AND told the
   * crew — by "With {crew}" at the hold or by "We're here". Somebody who came
   * in on their own is not on it, and nobody kept apart from you is. Members
   * only: a crew card (`crews[]`) never carries a person (C4).
   */
  here: CrewmateIn[]
}

export type CrewsAtEvent =
  | { crewsEnabled: false; crews: []; myCrews: []; total: 0; hasMore: false }
  | {
      crewsEnabled: true
      crews: CrewCard[]
      /** The caller's own crews that are here now: what a like is sent "as". */
      myCrews: MyCrewHere[]
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
    select: { id: true, name: true, bio: true, emblem_seed: true, tags: true, intent: true, open_to_solo: true, room: { select: { id: true } } },
  })
  const members = await membersOf(crews.map((c) => c.id))
  const mine = crews.filter((c) => present.get(c.id)?.includes(viewerId))
  const others = crews.filter((c) => !present.get(c.id)?.includes(viewerId))

  const mySide = [...new Set([viewerId, ...mine.flatMap((c) => members.get(c.id) ?? [])])]
  // Kept apart: blocks and closed pairs, AND friendships across the two sides (D18): a friend
  // across would be a stranger to the other inside a pseudonymous crew room.
  const blocked = await strangersApartBetween(mySide, [...new Set(others.flatMap((c) => members.get(c.id) ?? []))])
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
  const side = (c: { id: string; intent: string[] }) => ({
    id: c.id,
    intent: c.intent,
    present: present.get(c.id) ?? [],
    members: members.get(c.id) ?? [],
  })
  const [roomSize, viewerHere] =
    visible.length > 0
      ? await Promise.all([
          db.event_check_ins.count({ where: { ...hereNowAt(occurrenceId), kind: "attendee" } }),
          db.event_check_ins.findFirst({
            where: { ...hereNowAt(occurrenceId), user_id: viewerId },
            select: { check_in_time: true },
            orderBy: { check_in_time: "desc" },
          }),
        ])
      : [0, null]
  const ranked =
    visible.length > 0
      ? await rankCrewsFor({
          viewerId,
          viewerCheckedInAt: viewerHere?.check_in_time ?? null,
          mine: myCrew ? side(myCrew) : null,
          viewerIntents,
          crews: visible.map(side),
          roomSize,
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
    myCrews: await myCrewsHere(viewerId, occurrenceId, mine, present),
    total: visible.length,
    hasMore: page.offset + shown.length < visible.length,
  }
}

/**
 * Who told each room they are here at this occurrence, first in first: the
 * "We're here" lines (written by the tap, or by "With {crew}" at the hold).
 */
async function toldIn(roomIds: readonly string[], occurrenceId: string): Promise<Map<string, string[]>> {
  if (roomIds.length === 0) return new Map()
  const lines = await db.chat_messages.findMany({
    where: {
      chat_group_id: { in: [...roomIds] },
      type: "system",
      AND: [{ metadata: { path: ["kind"], equals: "crew_here" } }, { metadata: { path: ["occurrenceId"], equals: occurrenceId } }],
    },
    select: { chat_group_id: true, user_id: true },
    orderBy: { created_at: "asc" },
  })
  const byRoom = new Map<string, string[]>()
  for (const l of lines) if (l.user_id) byRoom.set(l.chat_group_id, [...(byRoom.get(l.chat_group_id) ?? []), l.user_id])
  return byRoom
}


/** In with the crew: present now and told, first in first. */
function inWithCrew(present: readonly string[], told: readonly string[]): string[] {
  const here = new Set(present)
  return [...new Set(told)].filter((id) => here.has(id))
}

async function myCrewsHere(
  viewerId: string,
  occurrenceId: string,
  mine: readonly { id: string; name: string; room: { id: string } | null }[],
  present: ReadonlyMap<string, string[]>
): Promise<MyCrewHere[]> {
  const told = await toldIn(mine.flatMap((c) => (c.room ? [c.room.id] : [])), occurrenceId)
  const inOf = new Map(mine.map((c) => [c.id, c.room ? inWithCrew(present.get(c.id) ?? [], told.get(c.room.id) ?? []) : []]))
  const apart = await blocksBetween([viewerId], [...new Set([...inOf.values()].flat())])
  return Promise.all(
    mine.map(async (c) => {
      const ids = (inOf.get(c.id) ?? []).filter((id) => !apart.has(`${viewerId}|${id}`))
      const room = c.room ? { id: c.room.id, kind: "crew" as const } : null
      // The crew room's own identity, as its chat shows it: first names, and a photo only for
      // a member who did not choose "keep me anonymous" (and is not erased) — one read each per room.
      const [names, photos] = room && ids.length ? await Promise.all([namesInRoom(room, ids), crewMemberImages(room, ids)]) : [new Map<string, string>(), new Map<string, string>()]
      return {
        crewId: c.id,
        name: c.name,
        presentCount: present.get(c.id)?.length ?? 0,
        here: ids.map((id) => ({
          userId: room ? idForViewer(viewerId, { kind: "crew", groupId: room.id }, id) : id,
          name: names.get(id) ?? UNNAMED,
          photo: photos.get(id) ?? null,
          you: id === viewerId,
        })),
      }
    })
  )
}

/** The longest list of names a push spells out before "and N others". */
const PUSH_NAMES_MAX = 3

/**
 * The crew push's words (S3, owner 1a): who is in, never who is not, never
 * where. "Priya is in." / "Priya and Arjun are in." / "Priya, Arjun and Meera
 * are in." / "Priya, Arjun and 2 others are in." — then, for a crewmate not in
 * yet, "Hold to Blend’n when you get there." Pure.
 */
export function crewInBody(names: readonly string[], recipientIsIn: boolean): string {
  const shown =
    names.length <= PUSH_NAMES_MAX ? [...names] : [...names.slice(0, PUSH_NAMES_MAX - 1), `${names.length - (PUSH_NAMES_MAX - 1)} others`]
  const list = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`
  const said = `${list} ${names.length === 1 ? "is" : "are"} in.`
  return recipientIsIn ? said : `${said} Hold to Blend’n when you get there.`
}

/* -------------------------------------------------------------------------- */
/* "We're here"                                                               */
/* -------------------------------------------------------------------------- */

const NOT_IN: CrewRefusal = { refusal: "Check in first — \"We’re here\" is for when you’re in.", status: 403 }

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
 * The push names who is in with the crew, never who is not, and carries no
 * place (owner 1a): a lock screen is read by whoever holds the phone. The line
 * in the crew chat carries the event in its metadata, for the members it was
 * meant for. "With {crew}" at the hold runs this same write
 * (`tellCrewAtTheHold`), so the hold is the crew check-in with no second tap.
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
        content: "We’re here 👋",
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
  const bodies = await crewInBodies(crew.id, room.id, occurrenceId, recipients)
  for (const [body, userIds] of bodies) {
    await sendBulkPushNotifications({
      userIds,
      title: crew.name,
      body,
      data: { type: "crew_here", crewId: crew.id, chatGroupId: room.id },
    }).catch((error: unknown) => logger.warn("Push notification failed", { context: "crew here", error: String(error) }))
  }
  const notified = [...bodies.values()].reduce((n, ids) => n + ids.length, 0)
  return { notified, repeated: false }
}

/**
 * Each recipient's push, grouped by its words: the crewmates in with the crew
 * now (the tapper among them), by first name, minus the recipient and anybody
 * kept apart from them — a crewmate's view of the crew never shows someone
 * they blocked or were blocked by (C5). A recipient already in gets the
 * names without "Hold to Blend’n". At most 12 people: a crew's ceiling.
 */
async function crewInBodies(
  crewId: string,
  roomId: string,
  occurrenceId: string,
  recipients: readonly string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (recipients.length === 0) return out
  const [present, told] = await Promise.all([presentMembersAt(occurrenceId, [crewId]), toldIn([roomId], occurrenceId)])
  const presentIds = present.get(crewId) ?? []
  const inIds = inWithCrew(presentIds, told.get(roomId) ?? [])
  // The crew room's names, as its chat prints them (`namesInRoom`): the same identity on every crew surface.
  const [apart, names] = await Promise.all([blocksBetween(recipients, inIds), namesInRoom({ id: roomId, kind: "crew" }, inIds)])
  for (const r of recipients) {
    const shown = inIds.filter((id) => id !== r && !apart.has(`${r}|${id}`)).map((id) => names.get(id) ?? UNNAMED)
    if (shown.length === 0) continue
    const body = crewInBody(shown, presentIds.includes(r))
    out.set(body, [...(out.get(body) ?? []), r])
  }
  return out
}

/**
 * "With {crew}" at the hold (S1, owner 1A): a successful check-in that names
 * one of your crews runs "We're here" for it — the same line, the same
 * once-per-person-per-crew-per-occurrence lock, the same push — so there is
 * no second tap. Your own check-in is the only one: nobody else is checked in
 * by it (CR-I04).
 *
 * Silent either way, and never a reason to refuse the check-in: a crew you are
 * not in, a dissolved one, crews off at this event, a room ban — all answer
 * `false` and tell nobody. `true` when the crew knows (now, or already).
 */
export async function tellCrewAtTheHold(userId: string, crewId: string, eventId: string): Promise<boolean> {
  try {
    if (await eventRoomBan(eventId, userId)) return false
    const told = await crewHere(userId, crewId, eventId)
    return !("refusal" in told)
  } catch (error) {
    logger.warn("Crew at the hold failed", { error: error instanceof Error ? error.message : String(error) })
    return false
  }
}
