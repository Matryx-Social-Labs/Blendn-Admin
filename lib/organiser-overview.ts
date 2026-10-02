import type { Prisma } from "@prisma/client"

import { db } from "./db"
import { discloseStars, type StarSpread } from "./disclosure"
import type { LiveEvent, OrganizerOverview } from "./dashboard-types"
import { eventClock } from "./event-phase"
import { realEventsWhere } from "./event-kind"
import { eventRowFields, type EventRowData } from "./event-row"
import { activeMembership, HOME_ORG_ORDER } from "./org-membership"
import { getOccupancy } from "./occupancy"
import type { SetupFacts } from "./setup-checklist"

/*
 * The parts of the organiser overview that the design kit added (step 15):
 * the live banner, the setup checklist, Coming up and the latest feedback.
 * Kept out of `app/dashboard/actions.ts`, which is a `"use server"` file and
 * already long, and which may export only async functions.
 *
 * Every function takes the organiser's `visibleEventsWhere` scope. For an
 * organiser that is their organisations' events and the ones they created —
 * never a venue's view of somebody else's night — so the counts here are
 * exact, and nothing in them is a person.
 *
 * `scope` already carries `realEventsWhere`; each read spreads it again so the
 * venue-day decision is visible where the query is (events-kind-boundary).
 */

/** The earliest night of the organisation's running right now, with what it needs. */
export async function liveEventFor(scope: Prisma.eventsWhereInput, now: Date): Promise<LiveEvent | null> {
  const event = await db.events.findFirst({
    where: { ...scope, ...realEventsWhere, status: "published", start_time: { lte: now }, end_time: { gte: now } },
    orderBy: { start_time: "asc" },
    select: {
      id: true,
      title: true,
      start_time: true,
      timezone: true,
      venue_name: true,
      venue: { select: { name: true } },
      // The same count the Chatrooms screen shows for this room.
      chat_group: { select: { id: true, _count: { select: { messages: true } } } },
    },
  })
  if (!event) return null

  const [occupancy, flags] = await Promise.all([
    // Who is inside today, resolved to the day of a multi-day run.
    getOccupancy(event.id),
    event.chat_group
      ? db.moderation_flags.count({ where: { chat_group_id: event.chat_group.id, status: "pending" } })
      : 0,
  ])
  return {
    id: event.id,
    title: event.title,
    venue: event.venue?.name ?? event.venue_name,
    doors: eventClock(event.timezone).time(event.start_time),
    flags,
    inside: occupancy.inside,
    checkedIn: occupancy.uniqueAttendance,
    messages: event.chat_group?._count.messages ?? 0,
  }
}

/** What "Getting set up" reads: the home organisation, and whether anything went out. */
export async function setupFactsFor(
  userId: string,
  scope: Prisma.eventsWhereInput
): Promise<SetupFacts> {
  const [membership, published] = await Promise.all([
    db.organisation_members.findFirst({
      where: { user_id: userId, ...activeMembership },
      orderBy: HOME_ORG_ORDER,
      select: {
        org: {
          select: {
            display_name: true,
            kind: true,
            domains: { orderBy: { created_at: "asc" }, take: 1, select: { domain: true, verified_at: true } },
            _count: {
              select: {
                members: true,
                // Accepted or still open: a revoked invite asked nobody.
                invites: { where: { revoked_at: null } },
              },
            },
          },
        },
      },
    }),
    db.events.count({ where: { ...scope, ...realEventsWhere, status: { in: ["published", "completed"] } } }),
  ])
  const org = membership?.org
  return {
    org: org
      ? {
          name: org.display_name,
          kind: org.kind,
          domain: org.domains[0]
            ? { name: org.domains[0].domain, verified: org.domains[0].verified_at !== null }
            : null,
          colleagues: org._count.members > 1 || org._count.invites > 0,
        }
      : null,
    published: published > 0,
  }
}

/** The next few nights ahead, and drafts, soonest first. */
export async function comingUpFor(
  scope: Prisma.eventsWhereInput,
  now: Date,
  take = 5
): Promise<EventRowData[]> {
  const events = await db.events.findMany({
    where: { ...scope, ...realEventsWhere, status: { in: ["published", "draft"] }, start_time: { gt: now } },
    orderBy: { start_time: "asc" },
    take,
    select: {
      id: true,
      title: true,
      status: true,
      start_time: true,
      end_time: true,
      timezone: true,
      venue_name: true,
      city: true,
      latitude: true,
      geofence: true,
      max_capacity: true,
      _count: { select: { rsvps: { where: { status: "going" } } } },
    },
  })
  // Nothing ahead has been checked in to; the cell reads going for these.
  return events.map((e) => ({ ...eventRowFields(e, now), going: e._count.rsvps, arrivals: 0 }))
}

/**
 * The most recent past event whose own ratings clear the floor, with its bars.
 *
 * One event's spread, never a pool: the pooled average is the tile beside it,
 * built by `discloseStarsAcross`, and this panel answers "what did the last
 * night say".
 */
export async function latestFeedbackFor(
  spreads: Map<string, StarSpread>,
  now: Date
): Promise<OrganizerOverview["latestFeedback"]> {
  const shown = [...spreads].filter(([, spread]) => discloseStars(spread).averageRating !== null)
  if (shown.length === 0) return null
  const latest = await db.events.findFirst({
    where: { ...realEventsWhere, id: { in: shown.map(([id]) => id) }, start_time: { lt: now } },
    orderBy: { start_time: "desc" },
    select: { id: true, title: true },
  })
  if (!latest) return null
  const stars = discloseStars(spreads.get(latest.id)!)
  return { eventId: latest.id, title: latest.title, ratings: stars.ratings, averageRating: stars.averageRating! }
}
