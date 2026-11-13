// Relative imports: the Live tab's "Meeting tonight" (lib/live-social.ts) reaches this from server.ts.
import type { work_intent } from "@prisma/client"

import { db } from "./db"
import { inRoomWhere } from "./event-kind"
import { actorFor } from "./org-membership"
import { eventPermissionSelect, eventPermissions } from "./rbac"
import { eventRoomBan } from "./room-kind"

/**
 * Tonight's question (Flow 5 · P-A, SCRUM-1042).
 *
 * A room has a lens -- which fields lead on a person's card and the one
 * question it asks -- picked by the event's category from `category_lenses`,
 * which is data: a new category or a new question is a row, never a deploy.
 * A person may answer it, once per event (`event_match_preferences`).
 *
 * Who reads an answer: people checked in to that room as attendees, under the
 * pseudonym the room already gives the person. Never anyone who runs or hosts
 * the event (`eventPermissions().canOperate`, the owner's hosts-see-pseudonyms-
 * only ruling extended: hosts do not get the room's words about itself either),
 * and never by raw id -- only through a room surface.
 */

export interface RoomLens {
  key: string
  /** Null: this lens asks nothing (a venue night), so no answer is taken or shown. */
  question: string | null
}

/** A venue day's lens, whatever its category: the night at a place, which asks nothing. */
const VENUE_NIGHT = "venue_night"

/**
 * The lens whose card leads with the field of work and "Here to …": only here
 * is a `work_intent` taken or read. A row holding one in another room (its
 * category changed after) reads as unset.
 */
export const WORK_LENS = "work"

export type WorkIntent = work_intent

/**
 * The event's lens, or null when nothing maps (the client draws the plain card).
 *
 * A venue day is `venue_night`. Otherwise its categories, primary first, each
 * asked as itself and then as its parent: the first slug with a row wins, so a
 * child category can differ from its parent ("nightlife-comedy").
 */
export async function lensForEvent(eventId: string): Promise<RoomLens | null> {
  const event = await db.events.findUnique({
    where: { id: eventId },
    select: {
      kind: true,
      categories: {
        select: { category: { select: { slug: true, parent: { select: { slug: true } } } } },
        orderBy: [{ primary: "desc" }, { created_at: "asc" }],
      },
    },
  })
  if (!event) return null
  if (event.kind === "venue_day") return lensByKey(VENUE_NIGHT)

  const slugs = event.categories.flatMap(({ category }) => [category.slug, ...(category.parent ? [category.parent.slug] : [])])
  if (slugs.length === 0) return null
  const rows = await db.category_lenses.findMany({
    where: { category_slug: { in: slugs } },
    select: { category_slug: true, lens: { select: { key: true, question: true } } },
  })
  const bySlug = new Map(rows.map((r) => [r.category_slug, r.lens]))
  return slugs.map((s) => bySlug.get(s)).find(Boolean) ?? null
}

async function lensByKey(key: string): Promise<RoomLens | null> {
  return db.room_lenses.findUnique({ where: { key }, select: { key: true, question: true } })
}

/** Whether this person runs or hosts the event: its organising org, its venue's owner, or an admin. They read no answers. */
export async function operatesEvent(userId: string, eventId: string): Promise<boolean> {
  const [actor, event] = await Promise.all([
    // `actorFor` reads the role from the row; the one passed is never trusted.
    actorFor({ id: userId, role: "attendee" }),
    db.events.findUnique({ where: { id: eventId }, select: eventPermissionSelect }),
  ])
  return !!event && eventPermissions(actor, event).canOperate
}

/**
 * Whether `viewerId` may read the answers in this room now: checked in to it
 * (live, at a venue day), their latest row an attendee's -- staff are working,
 * as on the deck -- and not somebody who operates it.
 */
export async function mayReadAnswers(viewerId: string, eventId: string): Promise<boolean> {
  const checkIn = await db.event_check_ins.findFirst({
    where: { event_id: eventId, user_id: viewerId, check_in_time: { not: null }, ...inRoomWhere(viewerId) },
    select: { kind: true },
    orderBy: { check_in_time: "desc" },
  })
  if (!checkIn || checkIn.kind === "staff") return false
  return !(await operatesEvent(viewerId, eventId))
}

/**
 * The tonight block for one person on a room card (`GET /users/:handle`), or
 * null: when the viewer may not read answers here, or the room asks nothing.
 * `answer` is null when they have not answered, or a host banned them here;
 * `workIntent` likewise, and always outside the work lens.
 */
export async function tonightFor(
  viewerId: string,
  eventId: string,
  targetId: string
): Promise<{ lens: RoomLens; answer: string | null; workIntent: WorkIntent | null } | null> {
  if (!(await mayReadAnswers(viewerId, eventId))) return null
  const lens = await lensForEvent(eventId)
  if (!lens?.question) return null
  const [row, banned] = await Promise.all([
    db.event_match_preferences.findUnique({
      where: { event_id_user_id: { event_id: eventId, user_id: targetId } },
      select: { tonight_answer: true, work_intent: true },
    }),
    eventRoomBan(eventId, targetId),
  ])
  // A host banned them from this room: the deck drops them (`notHostBannedFrom`),
  // so their sheet reads as unanswered -- the same as the deck, and no tell.
  if (banned || !row) return { lens, answer: null, workIntent: null }
  return { lens, answer: row.tonight_answer, workIntent: lens.key === WORK_LENS ? row.work_intent : null }
}

export interface PersonAnswers {
  tonightAnswer: string | null
  workIntent: WorkIntent | null
}

/**
 * Answers for a page of people in one room, by user id: only what this room's
 * lens asks (`question` for the answer, the work lens for `workIntent`), and
 * only people who gave one.
 */
export async function answersFor(eventId: string, userIds: readonly string[], lens: RoomLens): Promise<Map<string, PersonAnswers>> {
  const asks = !!lens.question
  const asksWork = lens.key === WORK_LENS
  if (userIds.length === 0 || !(asks || asksWork)) return new Map()
  const rows = await db.event_match_preferences.findMany({
    where: {
      event_id: eventId,
      user_id: { in: [...userIds] },
      OR: [...(asks ? [{ tonight_answer: { not: null } }] : []), ...(asksWork ? [{ work_intent: { not: null } }] : [])],
    },
    select: { user_id: true, tonight_answer: true, work_intent: true },
  })
  return new Map(
    rows.map((r) => [r.user_id, { tonightAnswer: asks ? r.tonight_answer : null, workIntent: asksWork ? r.work_intent : null }])
  )
}
