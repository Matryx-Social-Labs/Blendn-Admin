// Relative imports throughout — see lib/conversations.ts.
import { blockCounterparties } from "../conversations"
import { CREW } from "../constants"
import { db } from "../db"
import { attendeeEventAccess } from "../event-door"
import { realEventsWhere } from "../event-kind"
import { crewMemberImages, namesInRoom } from "../identity"
import { logger } from "../logger"
import { sendBulkPushNotifications } from "../push-notifications"
import { deliverToRoom } from "../room-delivery"
import { idForViewer } from "../room-handle"
import { isRoomMuted } from "../room-mute"
import { UNNAMED } from "../conversation-identity"
import { blocksBetween } from "./blocks"
import { CREWS_OFF, NO_CREW, NO_EVENT, type CrewRefusal } from "./crews"

/**
 * "Going together" (crews 4-A1, NOTES S4): a crew marks a night out.
 *
 * - **A plan is the crew's**, one per crew per occurrence (`crew_plans`
 *   unique). Any active member may mark it; the one who marked it or the owner
 *   may take it back.
 * - **Marking it tells the crew once**: a line in the crew chat, and one push
 *   to every other member who has not muted the crew chat or blocked the
 *   planner — the plan row is the "once" (a second mark finds it). The push
 *   names the planner by first name and never the place (owner 1a: a lock
 *   screen is read by whoever holds the phone); the line carries the event for
 *   the members.
 * - **Who is going** is each crewmate's own RSVP (`going`), never a vote, as
 *   the crew room shows people (first names; a photo unless they keep
 *   themselves anonymous), minus anybody kept apart from the viewer.
 * - **Members only.** Nothing here reaches a card, a stranger or a host. The
 *   check-in's "With {crew}" chip is on by default only for a crew that
 *   planned the night (owner 1b): the client reads `myCrewPlans`.
 * - Caps: `CREW.MAX_PLANS_PER_WINDOW` nights told per crew a day (each is a
 *   push), counted on the crew-chat lines, which taking a plan back never
 *   deletes; a night planned again after being taken back is not told again.
 */

const TOO_MANY: CrewRefusal = {
  refusal: `Your crew has planned ${CREW.MAX_PLANS_PER_WINDOW} nights today. Try again tomorrow.`,
  status: 429,
}
const ENDED: CrewRefusal = { refusal: "This event has no night left to plan.", status: 400 }

/** The crew and its room, if `userId` is an active member of it. */
async function crewOfMember(userId: string, crewId: string) {
  return db.crews.findFirst({
    where: { id: crewId, dissolved_at: null, members: { some: { user_id: userId, user: { suspended_at: null, deletedAt: null } } } },
    select: { id: true, name: true, room: { select: { id: true, name: true } }, members: { where: { user_id: userId }, select: { role: true } } },
  })
}

/**
 * An event a crew may plan: published, not a venue day, and one this member
 * may take part in by the same door as an RSVP (`attendeeEventAccess`
 * "participate": a private event they were not let into, an age line they are
 * under, a closed city — all "not found"); and its next night not yet over.
 */
async function plannable(userId: string, eventId: string, now: Date) {
  const event = await db.events.findFirst({
    where: { id: eventId, deleted_at: null, status: "published", ...realEventsWhere },
    select: { id: true, crews_enabled: true },
  })
  if (!event || (await attendeeEventAccess(userId, eventId, "participate"))) return null
  const occurrence = await db.event_occurrences.findFirst({
    where: { event_id: eventId, end_time: { gt: now }, cancelled_at: null },
    orderBy: { start_time: "asc" },
    select: { id: true },
  })
  return { event, occurrenceId: occurrence?.id ?? null }
}

/** Mark the event's next night as one the crew is going to together. */
export async function planNight(
  userId: string,
  crewId: string,
  eventId: string,
  now: Date = new Date()
): Promise<{ planned: true; repeated: boolean; occurrenceId: string } | CrewRefusal> {
  const crew = await crewOfMember(userId, crewId)
  if (!crew?.room) return NO_CREW
  const found = await plannable(userId, eventId, now)
  if (!found) return NO_EVENT
  if (!found.event.crews_enabled) return CREWS_OFF
  if (!found.occurrenceId) return ENDED
  const occurrenceId = found.occurrenceId
  const room = crew.room

  /*
   * The crew-chat lines are the log (security review, MEDIUM): taking a plan back deletes its row but
   * never its line, so plan → take back → plan neither refunds the day's cap nor tells the crew again.
   */
  const planLines = { chat_group_id: room.id, type: "system", metadata: { path: ["kind"], equals: "crew_plan" } } as const
  const made = await db.$transaction(async (tx) => {
    // One crew's marks are serialised, so the daily cap is counted, not raced.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crew-plan:${crew.id}`}, 0))`
    const existing = await tx.crew_plans.findUnique({ where: { crew_id_occurrence_id: { crew_id: crew.id, occurrence_id: occurrenceId } }, select: { id: true } })
    if (existing) return "repeated" as const
    const toldBefore = await tx.chat_messages.findFirst({
      where: { chat_group_id: room.id, type: "system", AND: [{ metadata: { path: ["kind"], equals: "crew_plan" } }, { metadata: { path: ["occurrenceId"], equals: occurrenceId } }] },
      select: { id: true },
    })
    if (!toldBefore) {
      const recent = await tx.chat_messages.count({ where: { ...planLines, created_at: { gt: new Date(now.getTime() - CREW.PLANS_WINDOW_MS) } } })
      if (recent >= CREW.MAX_PLANS_PER_WINDOW) return TOO_MANY
    }
    await tx.crew_plans.create({ data: { crew_id: crew.id, occurrence_id: occurrenceId, created_by: userId } })
    // Planned again after being taken back: the crew already heard about this night.
    if (toldBefore) return "quiet" as const
    const line = await tx.chat_messages.create({
      data: {
        chat_group_id: room.id,
        user_id: userId,
        type: "system",
        content: "Going together 🗓",
        metadata: { kind: "crew_plan", eventId, occurrenceId },
      },
    })
    await tx.chat_groups.update({ where: { id: room.id }, data: { last_message_at: line.created_at } })
    return line
  })
  if (made === "quiet") return { planned: true, repeated: false, occurrenceId }
  if (made === "repeated") return { planned: true, repeated: true, occurrenceId }
  if ("refusal" in made) return made

  const senderName = (await namesInRoom({ id: room.id, kind: "crew" }, [userId])).get(userId) ?? UNNAMED
  await deliverToRoom({
    chatGroupId: room.id,
    scope: { kind: "crew", groupId: room.id },
    groupName: room.name,
    senderId: userId,
    senderAnonName: senderName,
    message: made,
    preview: made.content,
  }).catch((error: unknown) => logger.warn("Crew plan line delivery failed", { error: String(error) }))
  await pushPlan(crew, room.id, userId, senderName)
  return { planned: true, repeated: false, occurrenceId }
}

/** One push to the rest of the crew: who, never where. */
async function pushPlan(crew: { id: string; name: string }, roomId: string, plannerId: string, plannerName: string) {
  try {
    const [others, blocked] = await Promise.all([
      db.chat_group_members.findMany({
        where: {
          chat_group_id: roomId,
          user_id: { not: plannerId },
          status: { in: ["active", "muted"] },
          user: { suspended_at: null, deletedAt: null, crew_memberships: { some: { crew_id: crew.id } } },
        },
        select: { user_id: true, notification_preferences: true },
      }),
      blockCounterparties(plannerId),
    ])
    const userIds = others.filter((m) => !blocked.includes(m.user_id) && !isRoomMuted(m.notification_preferences)).map((m) => m.user_id)
    if (userIds.length === 0) return
    await sendBulkPushNotifications({
      userIds,
      title: crew.name,
      body: `${plannerName} wants to go together. Open the crew to see the night.`,
      // ponytail: the crew_here kind — it opens the crew chat and sits in the "Your crew" category, so installed builds
      // route it already. A kind of its own is an enum migration; add one if the client must tell the two apart.
      data: { type: "crew_here", crewId: crew.id, chatGroupId: roomId },
    })
  } catch (error) {
    logger.warn("Push notification failed", { context: "crew plan", error: error instanceof Error ? error.message : String(error) })
  }
}

/** Take a plan back: the member who marked it, or the owner. Nobody is told. */
export async function unplanNight(userId: string, crewId: string, eventId: string, now: Date = new Date()): Promise<{ planned: false } | CrewRefusal> {
  const crew = await crewOfMember(userId, crewId)
  if (!crew) return NO_CREW
  const isOwner = crew.members[0]?.role === "owner"
  await db.crew_plans.deleteMany({
    where: {
      crew_id: crew.id,
      occurrence: { event_id: eventId, end_time: { gt: now } },
      ...(isOwner ? {} : { created_by: userId }),
    },
  })
  return { planned: false }
}

export interface CrewPlanHere {
  crewId: string
  name: string
  emblemSeed: string
  occurrenceId: string
  startsAt: Date
  /** Crewmates whose own RSVP is "going", as the crew room shows them; you included (`you`). */
  going: { userId: string; name: string; photo: string | null; you: boolean }[]
}

/**
 * The viewer's own crews that planned a night of this event not yet over
 * (`GET /events/:id` `myCrewPlans`). Members only; nothing about any other crew.
 */
export async function myCrewPlansAt(viewerId: string, eventId: string, now: Date = new Date()): Promise<CrewPlanHere[]> {
  const plans = await db.crew_plans.findMany({
    where: {
      occurrence: { event_id: eventId, end_time: { gt: now } },
      crew: { dissolved_at: null, members: { some: { user_id: viewerId } } },
    },
    select: {
      occurrence_id: true,
      occurrence: { select: { start_time: true } },
      crew: {
        select: {
          id: true,
          name: true,
          emblem_seed: true,
          room: { select: { id: true } },
          members: { where: { user: { suspended_at: null, deletedAt: null } }, select: { user_id: true } },
        },
      },
    },
    orderBy: { occurrence: { start_time: "asc" } },
  })
  if (plans.length === 0) return []
  const everyone = [...new Set(plans.flatMap((p) => p.crew.members.map((m) => m.user_id)))]
  const [going, apart] = await Promise.all([
    db.event_rsvps.findMany({ where: { event_id: eventId, status: "going", user_id: { in: everyone } }, select: { user_id: true } }),
    blocksBetween([viewerId], everyone),
  ])
  const goingIds = new Set(going.map((g) => g.user_id))
  return Promise.all(
    plans.map(async (p) => {
      const ids = p.crew.members.map((m) => m.user_id).filter((id) => goingIds.has(id) && !apart.has(`${viewerId}|${id}`))
      const room = p.crew.room ? { id: p.crew.room.id, kind: "crew" as const } : null
      const [names, photos] = room && ids.length ? await Promise.all([namesInRoom(room, ids), crewMemberImages(room, ids)]) : [new Map<string, string>(), new Map<string, string>()]
      return {
        crewId: p.crew.id,
        name: p.crew.name,
        emblemSeed: p.crew.emblem_seed,
        occurrenceId: p.occurrence_id,
        startsAt: p.occurrence.start_time,
        going: ids.map((id) => ({
          userId: room ? idForViewer(viewerId, { kind: "crew", groupId: room.id }, id) : id,
          name: names.get(id) ?? UNNAMED,
          photo: photos.get(id) ?? null,
          you: id === viewerId,
        })),
      }
    })
  )
}

/**
 * A crew's nights not yet over, for its own page ("Going together"), as THIS
 * viewer may see them: a plan for an event the viewer cannot open (private and
 * not let in, under its age line, a closed city) is left out, title and all —
 * a crewmate's plan never opens an event to anybody. At most `limit`.
 */
export async function crewPlansOf(crewId: string, viewerId: string, now: Date = new Date(), limit = 10) {
  const rows = await db.crew_plans.findMany({
    where: {
      crew_id: crewId,
      occurrence: { end_time: { gt: now }, event: { deleted_at: null, status: "published", ...realEventsWhere } },
    },
    select: { occurrence_id: true, occurrence: { select: { start_time: true, event: { select: { id: true, title: true } } } } },
    orderBy: { occurrence: { start_time: "asc" } },
    take: limit,
  })
  // ponytail: one door check per row, at most `limit` (10) — batch it if the page ever lists more.
  const allowed = await Promise.all(rows.map(async (r) => !(await attendeeEventAccess(viewerId, r.occurrence.event.id, "view"))))
  return rows
    .filter((_, i) => allowed[i])
    .map((r) => ({ eventId: r.occurrence.event.id, title: r.occurrence.event.title, occurrenceId: r.occurrence_id, startsAt: r.occurrence.start_time }))
}
