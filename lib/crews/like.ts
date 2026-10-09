// Relative imports throughout — see lib/conversations.ts.
import type { Prisma } from "@prisma/client"

import { CREW } from "../constants"
import { db } from "../db"
import { namesInRoom } from "../identity"
import { logger } from "../logger"
import { sendBulkPushNotifications } from "../push-notifications"
import { deliverToRoom } from "../room-delivery"
import { leaveRoomSockets } from "../room-close"
import { ownerAdmits, ownerRoomClosesAt } from "../room-kind"
import type { CrewRefusal } from "./crews"
import { blocksBetween, blocksExclude } from "./blocks"
import {
  crewEvent,
  crewMayMeetSolo,
  hereNowAt,
  intentsAt,
  membersOf,
  occurrenceHereNow,
  presentMembersAt,
} from "./presence"

/**
 * Crew likes and Blends (plan v2 §6 "Matching: no voting", §8.3).
 *
 * ## The one writer of `crew_likes`
 *
 * Every like goes through here (`crew-matching-boundary.test.ts`), because
 * every like has to ask the same things first:
 *
 * - **Both sides here now.** A crew is here when two or more of its members
 *   are checked in at the occurrence (`presentMembersAt`); a person when they
 *   are. A like is a thing that happens in a room.
 * - **Any present member likes on the crew's behalf**, and for a like of a
 *   crew their crew chat says so ("liked Crew Nebula for the crew") — never
 *   for a like of a person, where the line would be the oracle the answer
 *   avoids (C7) — transparency instead of a
 *   vote. Nobody else is told, and nobody learns who liked first: the only
 *   outcome anybody outside the crew sees is a Blend.
 * - **Crew ↔ person has guardrails** (`crewMayMeetSolo`): the person opted in
 *   for tonight, the crew has room for one more, crews over 6 match crews
 *   only, and dating only if both chose it.
 * - **Anybody on one side kept apart from anybody on the other** — a block or
 *   a closed conversation, either way (C6) — refuses the like: the same 404
 *   as a crew that is not here, asked again inside the transaction that
 *   would write the like and the Blend, so a block landing in between aborts
 *   both and stores nothing.
 * - **A like of one person tells the liker nothing about them** (C7): not
 *   here, not opted in, not open to dating, kept apart — each is the same
 *   `{ liked: true, blend: null }` as a like that stood, and none is stored.
 *
 * ## One Blend per pair, however the likes land
 *
 * A like and the check for the other side's like run in one transaction
 * holding an advisory lock on the pair at this occurrence, so the second of
 * two simultaneous likes always sees the first, and the unique on
 * (occurrence, side A, side B) makes the Blend exactly one row. The pair is
 * ordered by uuid — compared bytewise, so this and `blends_pair_order` agree.
 * A Blend that has closed stays the pair's one row for the occurrence: a like
 * after it answers `blend: null`, never a closed room.
 *
 * ## Who is in a Blend: who was here when it matched (C3)
 *
 * Its room gets a member row for each person on either side checked in at the
 * occurrence at that moment, and the matched person — a snapshot. Somebody who
 * arrives later has no row, and every door to the room starts from the row.
 */

const NO_CREW: CrewRefusal = { refusal: "Crew not found", status: 404 }
const NO_PERSON: CrewRefusal = { refusal: "User not found", status: 404 }
/** Every person-level refusal of a crew → person like (C7): what a like that stood answers. */
const NOTHING_TOLD = { liked: true, blend: null } as const
const NO_EVENT: CrewRefusal = { refusal: "Event not found", status: 404 }
const CREWS_OFF: CrewRefusal = { refusal: "The host has turned crews off for this event.", status: 403 }
const NOT_IN: CrewRefusal = { refusal: "Check in before liking anyone here.", status: 403 }
const MY_CREW_NOT_HERE: CrewRefusal = {
  refusal: "Your crew isn't here yet — two of you need to be checked in.",
  status: 403,
}
const NOT_OPTED_IN: CrewRefusal = {
  refusal: "Turn on \"Open to joining a crew tonight\" to like a crew.",
  status: 403,
}
const NO_ROOM_FOR_ONE: CrewRefusal = {
  refusal: `Your crew matches with one person only with "Room for one more" on, and at ${CREW.MAX_SOLO_MATCH} or fewer.`,
  status: 403,
}

export interface LikeOutcome {
  liked: true
  /** Present when this like made a Blend (or found the one it would have made). */
  blend: { blendId: string; chatGroupId: string } | null
}

type Side = { crewId: string } | { userId: string }

interface Here {
  eventId: string
  occurrenceId: string
  occurrenceEnd: Date
}

/** The event and the liker's occurrence, or why not. */
async function hereFor(likerId: string, eventId: string): Promise<Here | CrewRefusal> {
  const event = await crewEvent(eventId)
  if (!event) return NO_EVENT
  if (!event.crews_enabled) return CREWS_OFF
  const occurrenceId = await occurrenceHereNow(eventId, likerId)
  if (!occurrenceId) return NOT_IN
  const occurrence = await db.event_occurrences.findUniqueOrThrow({ where: { id: occurrenceId }, select: { end_time: true } })
  return { eventId, occurrenceId, occurrenceEnd: occurrence.end_time }
}

const refused = (v: unknown): v is CrewRefusal => typeof v === "object" && v !== null && "refusal" in v

/** The people on each side of a like, as the in-transaction block check reads them. */
interface Sides {
  a: readonly string[]
  b: readonly string[]
}

/** A crew here now: its row, its active members, and those of them here. Null if it is not here. */
async function crewHereNow(crewId: string, occurrenceId: string) {
  const present = (await presentMembersAt(occurrenceId, [crewId])).get(crewId) ?? []
  if (present.length < CREW.MIN_MEMBERS) return null
  const crew = await db.crews.findFirst({
    where: { id: crewId, dissolved_at: null },
    select: { id: true, name: true, intent: true, open_to_solo: true, room: { select: { id: true, name: true } } },
  })
  if (!crew) return null
  const members = (await membersOf([crewId])).get(crewId) ?? []
  return { ...crew, members, present }
}

/**
 * Like a crew here now — as one of your crews here (`asCrewId`), or as
 * yourself (crew ↔ person, with its guardrails).
 */
export async function likeCrew(
  likerId: string,
  eventId: string,
  toCrewId: string,
  asCrewId?: string
): Promise<LikeOutcome | CrewRefusal> {
  const here = await hereFor(likerId, eventId)
  if (refused(here)) return here
  const target = await crewHereNow(toCrewId, here.occurrenceId)
  if (!target || target.members.includes(likerId)) return NO_CREW

  if (asCrewId) {
    if (asCrewId === toCrewId) return NO_CREW
    const mine = await crewHereNow(asCrewId, here.occurrenceId)
    if (!mine || !mine.present.includes(likerId)) return MY_CREW_NOT_HERE
    // Two crews sharing somebody are not two sides.
    if (mine.members.some((id) => target.members.includes(id))) return NO_CREW
    if (blocksExclude(mine.members, target.members, await blocksBetween(mine.members, target.members))) return NO_CREW
    const [a, b] = mine.id < target.id ? [mine.id, target.id] : [target.id, mine.id]
    const sides = { a: mine.members, b: target.members }
    const outcome = await like(here, likerId, { crewId: mine.id }, { crewId: target.id }, { a_crew_id: a, b_crew_id: b }, sides, mine.room, target.name)
    return outcome ?? NO_CREW
  }

  const me = await intentsAt(eventId, likerId)
  if (!me.openToCrews) return NOT_OPTED_IN
  if (!crewMayMeetSolo(target, target.members.length, me.intents)) return NO_CREW
  if (blocksExclude([likerId], target.members, await blocksBetween([likerId], target.members))) return NO_CREW
  const sides = { a: target.members, b: [likerId] }
  const outcome = await like(here, likerId, { userId: likerId }, { crewId: target.id }, { a_crew_id: target.id, b_user_id: likerId }, sides, null, null)
  return outcome ?? NO_CREW
}

/**
 * Like one person here now on your crew's behalf (crew → person). The person
 * must be here, have opted in for tonight, be somebody the crew may meet
 * (`crewMayMeetSolo`) and be kept apart from nobody in it. Every refusal about
 * THEM answers exactly as a like that stood — `{ liked: true, blend: null }`,
 * nothing stored (C7) — so the like cannot be used to learn whether somebody
 * is here, opted in, out for dating, or blocked one of you. Refusals about
 * the liker's own crew (not here, no room for one more) say so.
 */
export async function likePersonAsCrew(
  likerId: string,
  eventId: string,
  asCrewId: string,
  personId: string
): Promise<LikeOutcome | CrewRefusal> {
  const here = await hereFor(likerId, eventId)
  if (refused(here)) return here
  const mine = await crewHereNow(asCrewId, here.occurrenceId)
  if (!mine || !mine.present.includes(likerId)) return MY_CREW_NOT_HERE
  if (!mine.open_to_solo || mine.members.length > CREW.MAX_SOLO_MATCH) return NO_ROOM_FOR_ONE
  if (personId === likerId || mine.members.includes(personId)) return NO_PERSON

  const [theirCheckIn, them] = await Promise.all([
    db.event_check_ins.findFirst({ where: { user_id: personId, kind: "attendee", ...hereNowAt(here.occurrenceId) }, select: { id: true } }),
    intentsAt(eventId, personId),
  ])
  if (!theirCheckIn || !them.openToCrews || !crewMayMeetSolo(mine, mine.members.length, them.intents)) return { ...NOTHING_TOLD }
  if (blocksExclude(mine.members, [personId], await blocksBetween(mine.members, [personId]))) return { ...NOTHING_TOLD }

  /*
   * No line in the crew chat for a like of a person. A line only for a like
   * that stood would tell the crew everything the answer hides — that the
   * person is here, opted in, and kept apart from none of them (the step 8
   * review). A crew's like of a crew keeps its line: every refusal there is
   * said out loud anyway.
   */
  const outcome = await like(
    here,
    likerId,
    { crewId: mine.id },
    { userId: personId },
    { a_crew_id: mine.id, b_user_id: personId },
    { a: mine.members, b: [personId] },
    null,
    null
  )
  return outcome ?? { ...NOTHING_TOLD }
}

/** The where for a like, by its two sides. */
function likeWhere(occurrenceId: string, from: Side, to: Side): Prisma.crew_likesWhereInput {
  return {
    occurrence_id: occurrenceId,
    ...("crewId" in from ? { from_crew_id: from.crewId } : { from_user_id: from.userId }),
    ...("crewId" in to ? { to_crew_id: to.crewId } : { to_user_id: to.userId }),
  }
}

/**
 * Record the like, and if the other side liked back, the Blend and its room —
 * in one transaction holding the pair's lock. First, under that lock, the
 * sides are asked again whether anybody across them is kept apart: a block
 * that landed since the checks above aborts the whole thing, like and all
 * (null). Then, outside it: the line in the liker's crew chat, and the "It's
 * a Blend" push to everyone the room admits but the liker.
 */
async function like(
  here: Here,
  likerId: string,
  from: Side,
  to: Side,
  pair: { a_crew_id: string; b_crew_id?: string; b_user_id?: string },
  sides: Sides,
  likerCrewRoom: { id: string; name: string } | null,
  likedLabel: string | null
): Promise<LikeOutcome | null> {
  const pairKey = `${pair.a_crew_id}:${pair.b_crew_id ?? pair.b_user_id}`
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`blend:${here.occurrenceId}:${pairKey}`}, 0))`
    if ((await blocksBetween(sides.a, sides.b, tx)).size > 0) return null
    // Both crews still standing and not hidden — read under a share lock, so a
    // dissolve or a moderator's hide in flight finishes first and this sees it
    // (their close pass would otherwise miss the Blend this is about to make).
    const crewIds = [pair.a_crew_id, ...(pair.b_crew_id ? [pair.b_crew_id] : [])]
    const standing = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM crews WHERE id = ANY(${crewIds}::uuid[]) AND dissolved_at IS NULL AND hidden_at IS NULL FOR SHARE`
    if (standing.length !== crewIds.length) return null

    const { count: fresh } = await tx.crew_likes.createMany({
      data: [
        {
          occurrence_id: here.occurrenceId,
          ...("crewId" in from ? { from_crew_id: from.crewId } : { from_user_id: from.userId }),
          ...("crewId" in to ? { to_crew_id: to.crewId } : { to_user_id: to.userId }),
          liked_by_user_id: likerId,
        },
      ],
      skipDuplicates: true,
    })
    const back = await tx.crew_likes.findFirst({ where: likeWhere(here.occurrenceId, to, from), select: { id: true } })
    if (!back) return { fresh: fresh > 0, blend: null }

    const existing = await tx.blends.findFirst({
      where: { occurrence_id: here.occurrenceId, a_crew_id: pair.a_crew_id, b_crew_id: pair.b_crew_id ?? null, b_user_id: pair.b_user_id ?? null },
      select: { id: true, closed_at: true, closes_at: true, room: { select: { id: true } } },
    })
    if (existing) {
      // One Blend per pair per occurrence: a closed one is not reopened, and is not handed back.
      const open = !existing.closed_at && existing.closes_at > new Date() ? existing.room : null
      return { fresh: fresh > 0, blend: open ? { blendId: existing.id, chatGroupId: open.id, created: false } : null }
    }

    const blend = await tx.blends.create({
      data: {
        occurrence_id: here.occurrenceId,
        a_crew_id: pair.a_crew_id,
        b_crew_id: pair.b_crew_id ?? null,
        b_user_id: pair.b_user_id ?? null,
        closes_at: ownerRoomClosesAt({ end_time: here.occurrenceEnd }),
      },
      select: { id: true },
    })
    // The snapshot (C3): each side's active members checked in here now, and the person.
    const [present, crews] = await Promise.all([
      tx.crew_members.findMany({
        where: {
          crew_id: { in: crewIds },
          user: { suspended_at: null, deletedAt: null, event_check_ins: { some: hereNowAt(here.occurrenceId) } },
        },
        select: { user_id: true },
      }),
      tx.crews.findMany({ where: { id: { in: crewIds } }, select: { id: true, name: true } }),
    ])
    const people = [...new Set([...present.map((m) => m.user_id), ...(pair.b_user_id ? [pair.b_user_id] : [])])]
    const name = crewIds.map((id) => crews.find((c) => c.id === id)?.name ?? "Crew").join(" × ") + (pair.b_user_id ? " + 1" : "")
    const room = await tx.chat_groups.create({
      data: {
        kind: "blend",
        blend_id: blend.id,
        name: name.slice(0, 100),
        members: { createMany: { data: people.map((id) => ({ user_id: id })) } },
      },
      select: { id: true },
    })
    return { fresh: fresh > 0, blend: { blendId: blend.id, chatGroupId: room.id, created: true } }
  })
  if (!result) return null

  if (result.fresh && likerCrewRoom && likedLabel) await sayInCrew(likerCrewRoom, likerId, likedLabel)
  if (result.blend?.created) await announceBlend(result.blend, likerId)
  return { liked: true, blend: result.blend && { blendId: result.blend.blendId, chatGroupId: result.blend.chatGroupId } }
}

/** "Rohan liked Crew Nebula for the crew", in the liker's own crew chat — transparency, not a vote. */
async function sayInCrew(room: { id: string; name: string }, likerId: string, likedLabel: string): Promise<void> {
  try {
    const message = await db.chat_messages.create({
      data: {
        chat_group_id: room.id,
        user_id: likerId,
        type: "system",
        content: `liked ${likedLabel} for the crew`,
        metadata: { kind: "crew_like" },
      },
    })
    await db.chat_groups.update({ where: { id: room.id }, data: { last_message_at: message.created_at } })
    const senderName = (await namesInRoom({ id: room.id, kind: "crew" }, [likerId])).get(likerId) ?? "Someone"
    await deliverToRoom({
      chatGroupId: room.id,
      scope: { kind: "crew", groupId: room.id },
      groupName: room.name,
      senderId: likerId,
      senderAnonName: senderName,
      message,
      preview: message.content,
    })
  } catch (error) {
    // The like stands; the line is a courtesy to the crew.
    logger.warn("Crew like line failed", { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * "It's a Blend", to everyone the room admits but the person whose like made
 * it — they have the response. Names nobody and says nothing of who liked
 * first: everyone on both sides is told the same thing at the same moment.
 */
async function announceBlend(blend: { blendId: string; chatGroupId: string }, likerId: string): Promise<void> {
  try {
    const rows = await db.chat_group_members.findMany({ where: { chat_group_id: blend.chatGroupId }, select: { user_id: true } })
    const admitted = (await ownerAdmits(blend.chatGroupId, rows.map((r) => r.user_id))) ?? new Set<string>()
    const userIds = [...admitted].filter((id) => id !== likerId)
    if (userIds.length === 0) return
    await sendBulkPushNotifications({
      userIds,
      title: "It's a Blend",
      body: "Your crew and another matched tonight. Say hi in the Blend.",
      data: { type: "blend", blendId: blend.blendId, chatGroupId: blend.chatGroupId },
    })
  } catch (error) {
    logger.warn("Push notification failed", { context: "blend", error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * A block (or a closed conversation) between `a` and `b`, in the Blends they
 * are in: the door now refuses that pair (`blendDenial`: anybody kept apart
 * from somebody across the sides), and this takes their sockets out of every
 * open Blend room that now refuses them, so a socket that joined before stops
 * hearing it too. Nobody else is touched: the Blend goes on for everyone else
 * (D-9). Called by every writer of `blocked_users` after its block commits
 * (`crew-matching.test.ts`). Never throws: the block has committed, and the
 * door refuses the pair on their next read whether or not this lands.
 */
export async function evictBlockedFromBlends(a: string, b: string): Promise<void> {
  try {
    const rooms = await db.chat_groups.findMany({
      where: {
        kind: "blend",
        status: "active",
        blend: { closed_at: null, closes_at: { gt: new Date() } },
        members: { some: { user_id: { in: [a, b] } } },
      },
      select: { id: true, members: { where: { user_id: { in: [a, b] } }, select: { user_id: true } } },
    })
    for (const room of rooms) {
      const inIt = room.members.map((m) => m.user_id)
      const admitted = (await ownerAdmits(room.id, inIt)) ?? new Set<string>()
      for (const id of inIt) if (!admitted.has(id)) leaveRoomSockets(room.id, id)
    }
  } catch (error) {
    logger.error("Taking a blocked pair out of their Blends failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
