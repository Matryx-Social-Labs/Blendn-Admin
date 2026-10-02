// Relative imports throughout — see lib/conversations.ts.
import type { Prisma } from "@prisma/client"

import { CREW } from "../constants"
import { db } from "../db"
import { namesInRoom } from "../identity"
import { logger } from "../logger"
import { sendBulkPushNotifications } from "../push-notifications"
import { deliverToRoom } from "../room-delivery"
import { closeRoomSockets } from "../room-close"
import { ownerAdmits, ownerRoomClosesAt } from "../room-kind"
import type { CrewRefusal } from "./crews"
import {
  blocksBetween,
  blocksExclude,
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
 * - **Any present member likes on the crew's behalf**, and their crew chat
 *   says so ("liked Crew Nebula for the crew") — transparency instead of a
 *   vote. Nobody else is told, and nobody learns who liked first: the only
 *   outcome anybody outside the crew sees is a Blend.
 * - **Crew ↔ person has guardrails** (`crewMayMeetSolo`): the person opted in
 *   for this event, the crew has room for one more, crews over 6 match crews
 *   only, and dating only if both chose it.
 * - **A block between any member of one side and any member of the other**
 *   refuses the like — the same 404 as a crew that is not there.
 *
 * ## One Blend per pair, however the likes land
 *
 * A like and the check for the other side's like run in one transaction
 * holding an advisory lock on the pair at this occurrence, so the second of
 * two simultaneous likes always sees the first, and the unique on
 * (occurrence, side A, side B) makes the Blend exactly one row. The pair is
 * ordered by uuid — compared bytewise, so this and `blends_pair_order` agree.
 */

const NO_CREW: CrewRefusal = { refusal: "Crew not found", status: 404 }
const NO_PERSON: CrewRefusal = { refusal: "User not found", status: 404 }
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
    return like(here, likerId, { crewId: mine.id }, { crewId: target.id }, { a_crew_id: a, b_crew_id: b }, mine.room, target.name)
  }

  const me = await intentsAt(eventId, likerId)
  if (!me.openToCrews) return NOT_OPTED_IN
  if (!crewMayMeetSolo(target, target.members.length, me.intents)) return NO_CREW
  if (blocksExclude([likerId], target.members, await blocksBetween([likerId], target.members))) return NO_CREW
  return like(here, likerId, { userId: likerId }, { crewId: target.id }, { a_crew_id: target.id, b_user_id: likerId }, null, null)
}

/**
 * Like one person here now on your crew's behalf (crew → person). The person
 * must have opted in for this event and be somebody the crew may meet
 * (`crewMayMeetSolo`); every refusal about them is the same 404 as nobody.
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
  if (!theirCheckIn || !them.openToCrews || !crewMayMeetSolo(mine, mine.members.length, them.intents)) return NO_PERSON
  if (blocksExclude(mine.members, [personId], await blocksBetween(mine.members, [personId]))) return NO_PERSON

  const pseudonym = (
    await db.chat_group_members.findFirst({
      where: { chat_group: { event_id: eventId }, user_id: personId },
      select: { anonymous_name: true },
    })
  )?.anonymous_name
  return like(
    here,
    likerId,
    { crewId: mine.id },
    { userId: personId },
    { a_crew_id: mine.id, b_user_id: personId },
    mine.room,
    pseudonym ?? "someone here"
  )
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
 * in one transaction holding the pair's lock. Then, outside it: the line in
 * the liker's crew chat, and the "It's a Blend" push to everyone the room now
 * admits but the liker.
 */
async function like(
  here: Here,
  likerId: string,
  from: Side,
  to: Side,
  pair: { a_crew_id: string; b_crew_id?: string; b_user_id?: string },
  likerCrewRoom: { id: string; name: string } | null,
  likedLabel: string | null
): Promise<LikeOutcome> {
  const pairKey = `${pair.a_crew_id}:${pair.b_crew_id ?? pair.b_user_id}`
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`blend:${here.occurrenceId}:${pairKey}`}, 0))`
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
      select: { id: true, room: { select: { id: true } } },
    })
    if (existing?.room) return { fresh: fresh > 0, blend: { blendId: existing.id, chatGroupId: existing.room.id, created: false } }

    const sides = await tx.crews.findMany({
      where: { id: { in: [pair.a_crew_id, ...(pair.b_crew_id ? [pair.b_crew_id] : [])] } },
      select: { id: true, name: true, members: { select: { user_id: true } } },
    })
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
    // Every member of both sides holds a row; the door admits those at the
    // occurrence (`roomOwnerDenial`), so a crewmate who arrives later walks in.
    const people = [...new Set([...sides.flatMap((c) => c.members.map((m) => m.user_id)), ...(pair.b_user_id ? [pair.b_user_id] : [])])]
    const name = sides.map((c) => c.name).join(" × ") + (pair.b_user_id ? " + 1" : "")
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
 * A block between `a` and `b` closes every open Blend with one of them on
 * each side (§6 Safety, CR-I10): `closed_at`, the room archived and emptied,
 * every socket in it taken out. Called by every writer of `blocked_users`
 * after its block commits (`crew-matching-boundary.test.ts`). Never throws:
 * the block has committed, and the door already refuses the blocked pair
 * (`roomOwnerDenial`) whether or not this lands.
 */
export async function closeBlendsBetween(a: string, b: string): Promise<void> {
  try {
    const onSide = (userId: string) => ({ members: { some: { user_id: userId } } })
    const across = (x: string, y: string): Prisma.blendsWhereInput => ({
      a_crew: onSide(x),
      OR: [{ b_crew: onSide(y) }, { b_user_id: y }],
    })
    const now = new Date()
    const open = await db.blends.findMany({
      where: { closed_at: null, closes_at: { gt: now }, OR: [across(a, b), across(b, a)] },
      select: { id: true, room: { select: { id: true } } },
    })
    if (open.length === 0) return
    const roomIds = open.flatMap((o) => (o.room ? [o.room.id] : []))
    await db.$transaction([
      db.blends.updateMany({ where: { id: { in: open.map((o) => o.id) }, closed_at: null }, data: { closed_at: now } }),
      db.chat_groups.updateMany({ where: { id: { in: roomIds }, status: "active" }, data: { status: "archived" } }),
      db.chat_group_members.updateMany({
        where: { chat_group_id: { in: roomIds }, status: { in: ["active", "muted"] } },
        data: { status: "left" },
      }),
    ])
    for (const id of roomIds) closeRoomSockets(id)
  } catch (error) {
    logger.error("Closing Blends after a block failed", { error: error instanceof Error ? error.message : String(error) })
  }
}
