import { db } from "@/lib/db"
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
      check_in_radius: true,
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
  const saved = event._count.favorites
  // Turn-up is against people who said they were coming, not against capacity —
  // an event that half-filled and had everyone turn up did the hard part right.
  const attendedPeople = distinctAttendees(everCheckedIn)
  /*
   * No `Math.min` clamp any more. It existed to stop no-show going negative
   * when row-counting inflated attendance past the RSVP count; counting people
   * removes the cause, and clamping now would hide walk-ins — the one signal
   * that says an event outperformed what it was promised.
   */
  const turnUpPct = turnUp(attendedPeople, going)
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
            /*
             * Going, not "Filled". Fill needs a capacity, and most events here
             * have none — so the hero on the state an organiser watches most
             * read "Filled —". The count of people is the number; capacity,
             * when set, is the context.
             */
            label: "Going",
            value: String(going),
            // `=== null`, not truthy: max_capacity has no floor in the schema
            // or the form, so 0 is a reachable value, and the tile below says
            // "Capacity 0" — the hint must not say "no capacity set" beside it.
            hint: [
              capacity === null
                ? "no capacity set"
                : capacity === 0
                  ? "capacity 0"
                  : `of ${capacity} · ${pct(going, capacity)}% full`,
              `${maybe} maybe`,
              `${saved} saved`,
            ].join(" · "),
          }
        : state === "live"
          ? {
              label: "Checked in now",
              value: String(checkedIn),
              hint: going === 0 ? "Nobody RSVP'd" : `${going} said they were coming`,
            }
          : going === 0
            ? {
                // A percentage of nothing is a dash. The count is still real.
                label: "Came",
                value: String(attendedPeople),
                hint: "nobody RSVP'd — walk-ins only",
              }
            : {
                label: "Turned up",
                value: fmt(turnUpPct, "%"),
                hint: `${attendedPeople} of ${going} who said they would`,
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
              value: String(attendedPeople),
              hint: "before the doors, usually zero",
            },
            {
              label: "Room opens",
              value: `${PRE_EVENT_CHAT_HOURS}h before`,
              hint: "the chat, for people who said they are going",
            },
            {
              label: "Check-in fence",
              value: `${event.check_in_radius} m`,
              hint: "around the pin",
            },
          ]
        : state === "live"
          ? [
              { label: "Ever checked in", value: String(attendedPeople) },
              { label: "Going", value: String(going) },
              { label: "Capacity", value: capacity === null ? null : String(capacity) },
            ]
          : [
              { label: "Checked in", value: String(attendedPeople) },
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
