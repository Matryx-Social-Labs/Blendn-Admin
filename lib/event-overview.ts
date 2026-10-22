import { venueCounts } from "@/lib/attendee-roster"
import { db } from "@/lib/db"
import { discloseHeadcount, discloseRating, liveCountBucket, liveCountLabel, MIN_CELL } from "@/lib/disclosure"
import { phoneCheckInRadius } from "@/lib/geofence"
import { distinctAttendees, turnUpPct as turnUp } from "@/lib/counting"
import { PRE_EVENT_CHAT_HOURS } from "@/lib/chat-window"
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
/**
 * A count held back by the floor alone, in a sentence. Not for "came": that is
 * also held back when it is complete, residual or past the going count, and
 * "fewer than 5" would then be false.
 */
const say = (n: number | null) => (n === null ? `fewer than ${MIN_CELL}` : String(n))

/**
 * `host` is whoever runs the event. `venue` is the owner of the building it is
 * held at, operating somebody else's event: venues see aggregates, never
 * people. Going, came and fill are `venueCounts` -- the figures the venue's
 * Attendees tab, Events list and exports show -- and every other count of
 * people goes through `discloseHeadcount`. A tab that held a count back would
 * mean nothing if this one printed it.
 */
export type OverviewView = "host" | "venue"

export async function getEventOverview(
  eventId: string,
  view: OverviewView = "host"
): Promise<EventOverview | null> {
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
      check_in_radius: true,
      // The area the radius below is derived from — the event's own copy.
      geofence: true,
      cover_image_url: true,
      _count: { select: { categories: true, favorites: true } },
    },
  })
  if (!event) return null

  const state = eventStateFor(event)

  const [going, maybe, checkedIn, everCheckedIn, ratings] = await Promise.all([
    db.event_rsvps.count({ where: { event_id: eventId, status: "going" } }),
    db.event_rsvps.count({ where: { event_id: eventId, status: "maybe" } }),
    db.event_check_ins.count({ where: { event_id: eventId, status: "checked_in" } }),
    /*
     * Rows, not people — and this one is rendered next to a panel that folds
     * correctly, so the same screen showed two different turn-up figures. On a
     * three-day event the hero read 100% (three attendance-days per person,
     * clamped) while the attendance panel two boxes below read 62%.
     *
     * Staff excluded here too. They attend every day by definition, and the
     * count was including them.
     */
    db.event_check_ins.findMany({
      where: { event_id: eventId, check_in_time: { not: null } },
      select: { user_id: true, kind: true },
    }),
    db.event_ratings.findMany({ where: { event_id: eventId }, select: { rating: true } }),
  ])

  const capacity = event.max_capacity
  const venue = view === "venue" ? await venueCounts(eventId, capacity) : null
  const shown = (count: number) => (venue ? discloseHeadcount(count) : count)
  const goingN = venue ? venue.going : going
  const fillPct = venue ? venue.fillPct : capacity ? pct(going, capacity) : null
  const maybeN = shown(maybe)
  const savedN = shown(event._count.favorites)
  // Turn-up is against people who said they were coming, not against capacity —
  // an event that half-filled and had everyone turn up did the hard part right.
  const attendedPeople = venue ? venue.came : distinctAttendees(everCheckedIn)
  /*
   * No `Math.min` clamp any more. It existed to stop no-show going negative
   * when row-counting inflated attendance past the RSVP count; counting people
   * removes the cause, and clamping now would hide walk-ins — the one signal
   * that says an event outperformed what it was promised.
   *
   * Held back with either side: a percentage and one count give the other.
   */
  const turnUpPct = attendedPeople === null || goingN === null ? null : turnUp(attendedPeople, goingN)
  const avgRating = discloseRating(
    Math.round((ratings.reduce((s, r) => s + r.rating, 0) / ratings.length) * 10) / 10,
    ratings.length
  )

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
            /*
             * Going, not "Filled". Fill needs a capacity, and most events here
             * have none — so the hero on the state an organiser watches most
             * read "Filled —". The count of people is the number; capacity,
             * when set, is the context.
             */
            label: "Going",
            value: fmt(goingN),
            // `=== null`, not truthy: max_capacity has no floor in the schema
            // or the form, so 0 is a reachable value, and the tile below says
            // "Capacity 0" — the hint must not say "no capacity set" beside it.
            hint: [
              capacity === null
                ? "no capacity set"
                : capacity === 0
                  ? "capacity 0"
                  : // A fill percentage and the capacity give the count back.
                    `of ${capacity}${fillPct === null ? "" : ` · ${fillPct}% full`}`,
              `${say(maybeN)} maybe`,
              `${say(savedN)} saved`,
            ].join(" · "),
          }
        : state === "live"
          ? {
              label: "Checked in now",
              // A range for the venue: it moves with every arrival (SCRUM-516).
              value: venue ? liveCountLabel(liveCountBucket(checkedIn)) : fmt(checkedIn),
              hint: going === 0 ? "Nobody RSVP'd" : `${say(goingN)} said they were coming`,
            }
          : going === 0
            ? {
                // A percentage of nothing is a dash. The count is still real.
                label: "Came",
                value: fmt(attendedPeople),
                hint: "nobody RSVP'd — walk-ins only",
              }
            : {
                label: "Turned up",
                value: fmt(turnUpPct, "%"),
                hint:
                  attendedPeople === null || goingN === null
                    ? "held back, so it cannot point at anybody"
                    : `${attendedPeople} of ${goingN} who said they would`,
              }

  const tiles: EventOverview["tiles"] =
    state === "draft"
      ? [
          { label: "Capacity", value: capacity === null ? null : String(capacity) },
          { label: "Categories", value: String(event._count.categories) },
        ]
      : state === "upcoming"
        ? [
            { label: "Capacity", value: capacity === null ? null : String(capacity) },
            {
              label: "Checked in",
              // Check-in opens before the doors, so it can already be moving.
              value: venue ? liveCountLabel(venue.cameSoFar) : fmt(attendedPeople),
              hint: "before the doors, usually zero",
            },
            {
              label: "Room opens",
              value: `${PRE_EVENT_CHAT_HOURS}h before`,
              hint: "the chat, for people who said they are going",
            },
            {
              label: "Check-in fence",
              // What the app is sent (SCRUM-350): the circle around the pin
              // that holds the whole area and its buffer. The stored column of
              // an older outline event can still say 60 or 100.
              value: `${phoneCheckInRadius(event) ?? event.check_in_radius} m`,
              hint: "around the pin, covering the whole area and its buffer",
            },
          ]
        : state === "live"
          ? [
              { label: "Ever checked in", value: venue ? liveCountLabel(venue.cameSoFar) : fmt(attendedPeople) },
              { label: "Going", value: fmt(goingN) },
              { label: "Capacity", value: capacity === null ? null : String(capacity) },
            ]
          : [
              { label: "Checked in", value: fmt(attendedPeople) },
              { label: "Going", value: fmt(goingN) },
              {
                label: "Rating",
                value: avgRating === null ? null : `${avgRating}`,
                hint:
                  ratings.length === 0
                    ? "nobody rated it"
                    : avgRating === null
                      ? "not enough ratings yet"
                      : `${ratings.length} ratings`,
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
