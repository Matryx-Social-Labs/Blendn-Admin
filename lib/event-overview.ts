import { db } from "@/lib/db"
import { eventStateFor, publishBlockers, type EventState, type PublishBlocker } from "@/lib/event-phase"

/**
 * What the Overview tab needs.
 *
 * Every figure here comes from a table that already exists. The previous design
 * round mocked up session devices and locations NextAuth does not record, and
 * they had to be cut during implementation — so this reads only what is really
 * stored, and returns `null` where there is nothing to say rather than zero.
 *
 * The distinction matters on this screen more than most: an event with no
 * capacity has no fill percentage, which is not the same as being empty.
 */

export interface EventOverview {
  state: EventState
  /** Exactly one per state, and it carries the gradient. */
  hero: { label: string; value: string | null; hint: string }
  tiles: { label: string; value: string | null; hint?: string }[]
  blockers: PublishBlocker[]
  /** Only for a draft — whether anything hard is outstanding. */
  publishable: boolean
}

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 100))
const fmt = (n: number | null, suffix = "") => (n === null ? null : `${n}${suffix}`)

export async function getEventOverview(eventId: string): Promise<EventOverview | null> {
  const event = await db.events.findUnique({
    where: { id: eventId, deleted_at: null },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      start_time: true,
      end_time: true,
      latitude: true,
      longitude: true,
      venue_name: true,
      venue_id: true,
      max_capacity: true,
      cover_image_url: true,
      _count: { select: { categories: true } },
    },
  })
  if (!event) return null

  const state = eventStateFor(event)

  const [going, checkedIn, everCheckedIn, ratings] = await Promise.all([
    db.event_rsvps.count({ where: { event_id: eventId, status: "going" } }),
    db.event_check_ins.count({ where: { event_id: eventId, status: "checked_in" } }),
    db.event_check_ins.count({ where: { event_id: eventId, check_in_time: { not: null } } }),
    db.event_ratings.findMany({ where: { event_id: eventId }, select: { rating: true } }),
  ])

  const capacity = event.max_capacity
  const fillPct = capacity ? pct(going, capacity) : null
  // Turn-up is against people who said they were coming, not against capacity —
  // an event that half-filled and had everyone turn up did the hard part right.
  const turnUpPct = going === 0 ? null : pct(Math.min(everCheckedIn, going), going)
  const avgRating =
    ratings.length === 0
      ? null
      : Math.round((ratings.reduce((s, r) => s + r.rating, 0) / ratings.length) * 10) / 10

  const blockers = publishBlockers({
    ...event,
    categoryCount: event._count.categories,
  })

  const hero: EventOverview["hero"] =
    state === "draft"
      ? {
          label: "Ready to publish",
          value: blockers.some((b) => b.blocking)
            ? `${blockers.filter((b) => b.blocking).length} left`
            : "Yes",
          hint: blockers.some((b) => b.blocking)
            ? "Nobody can see this yet"
            : "Nothing is blocking it",
        }
      : state === "upcoming"
        ? {
            label: "Filled",
            value: fmt(fillPct, "%"),
            hint: capacity
              ? `${going} going of ${capacity}`
              : "No capacity set, so there is no fill to show",
          }
        : state === "live"
          ? {
              label: "Checked in now",
              value: String(checkedIn),
              hint: going === 0 ? "Nobody RSVP'd" : `${going} said they were coming`,
            }
          : {
              label: "Turned up",
              value: fmt(turnUpPct, "%"),
              hint:
                going === 0
                  ? "No RSVPs to compare against"
                  : `${everCheckedIn} of ${going} who said they would`,
            }

  const tiles: EventOverview["tiles"] =
    state === "draft"
      ? [
          { label: "Capacity", value: capacity === null ? null : String(capacity) },
          { label: "Categories", value: String(event._count.categories) },
        ]
      : state === "upcoming"
        ? [
            { label: "Going", value: String(going) },
            { label: "Capacity", value: capacity === null ? null : String(capacity) },
            {
              label: "Checked in",
              value: String(everCheckedIn),
              hint: "before the doors, usually zero",
            },
          ]
        : state === "live"
          ? [
              { label: "Ever checked in", value: String(everCheckedIn) },
              { label: "Going", value: String(going) },
              { label: "Capacity", value: capacity === null ? null : String(capacity) },
            ]
          : [
              { label: "Checked in", value: String(everCheckedIn) },
              { label: "Going", value: String(going) },
              {
                label: "Rating",
                value: avgRating === null ? null : `${avgRating}`,
                hint: ratings.length === 0 ? "nobody rated it" : `${ratings.length} ratings`,
              },
            ]

  return {
    state,
    hero,
    tiles,
    blockers,
    publishable: !blockers.some((b) => b.blocking),
  }
}
