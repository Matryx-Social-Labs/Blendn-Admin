import type { DashboardRole } from "@/lib/dashboard-types"

/**
 * The action reads role and identity from the session rather than taking them
 * as arguments -- it is a POST endpoint, and a caller-supplied `role` let any
 * organiser ask for the admin report. So the test drives the session instead,
 * which is also the only way left to exercise the three overviews.
 */
let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))

const as = (role: DashboardRole, id = "no-user") => {
  session = { user: { id, role } }
}

import { getDashboardOverview } from "@/app/dashboard/actions"
import { db, cleanup, closeDb, makeUser, testId , occurrenceOf } from "./helpers"

/**
 * The three overviews are ~20 parallel Prisma calls between them, several of
 * them `groupBy` with relation filters. TypeScript checks the shapes but not
 * whether the query is valid SQL — a wrong relation name in a `groupBy`
 * compiles and throws at request time, which is precisely the class of bug the
 * unit suite cannot see because it mocks `@/lib/db`.
 *
 * They also pin the arithmetic that is easy to get subtly wrong: capacity
 * percentages when capacity is absent, turn-up when walk-ins outnumber RSVPs,
 * and the pacing curve's days-out bucketing.
 */

const users: string[] = []
const events: string[] = []

const DAY = 24 * 60 * 60 * 1000

async function makeScheduledEvent(
  organizerId: string,
  opts: {
    startsInDays: number
    capacity?: number | null
    venue?: string | null
    status?: "published" | "draft"
  }
) {
  const slug = testId("dash")
  const start = new Date(Date.now() + opts.startsInDays * DAY)
  const event = await db.events.create({
    data: {
      slug,
      title: `Dash ${slug}`,
      description: "integration fixture",
      start_time: start,
      end_time: new Date(start.getTime() + 2 * 60 * 60 * 1000),
      timezone: "UTC",
      status: opts.status ?? "published",
      organizer_id: organizerId,
      max_capacity: opts.capacity ?? null,
      venue_name: opts.venue ?? null,
    },
  })
  // Every event has at least one occurrence — the API guarantees it and
  // check-ins are NOT NULL on it, so a fixture without one is a shape that
  // cannot exist in production.
  await db.event_occurrences.create({
    data: {
      event_id: event.id,
      occurs_on: new Date(event.start_time.toISOString().slice(0, 10)),
      start_time: event.start_time,
      end_time: event.end_time,
    },
  })
  events.push(event.id)
  return event.id
}

afterAll(async () => {
  await cleanup(users, events)
  await closeDb()
})

describe("organiser overview", () => {
  it("leads with the next event and its commitment against capacity", async () => {
    const owner = await makeUser("ovw_owner", "organizer")
    users.push(owner)

    const soon = await makeScheduledEvent(owner, { startsInDays: 4, capacity: 10 })
    await makeScheduledEvent(owner, { startsInDays: 30, capacity: 20 })

    const attendees = await Promise.all([
      makeUser("ovw_a1"),
      makeUser("ovw_a2"),
      makeUser("ovw_a3"),
    ])
    users.push(...attendees)

    await db.event_rsvps.createMany({
      data: [
        { event_id: soon, user_id: attendees[0], status: "going" },
        { event_id: soon, user_id: attendees[1], status: "maybe" },
        // A decline is not commitment and must not reach the fill bar.
        { event_id: soon, user_id: attendees[2], status: "not_going" },
      ],
    })

    const overview = (as("organizer", owner), await getDashboardOverview())
    if (overview.role !== "organizer") throw new Error("wrong overview role")

    expect(overview.nextEvent?.id).toBe(soon)
    expect(overview.nextEvent?.going).toBe(1)
    expect(overview.nextEvent?.maybe).toBe(1)
    expect(overview.nextEvent?.capacity).toBe(10)
    // 2 committed of 10, not 3 of 10.
    expect(overview.nextEvent?.fillPct).toBe(20)
    expect(overview.pacingCapacity).toBe(10)
  })

  it("leaves fill undefined rather than zero when no capacity is set", async () => {
    const owner = await makeUser("ovw_nocap", "organizer")
    users.push(owner)
    const event = await makeScheduledEvent(owner, { startsInDays: 6, capacity: null })
    const attendee = await makeUser("ovw_nc1")
    users.push(attendee)
    await db.event_rsvps.create({
      data: { event_id: event, user_id: attendee, status: "going" },
    })

    const overview = (as("organizer", owner), await getDashboardOverview())
    if (overview.role !== "organizer") throw new Error("wrong overview role")

    // There is no target to fall short of, so a percentage would be invented.
    expect(overview.nextEvent?.capacity).toBeNull()
    expect(overview.nextEvent?.fillPct).toBeNull()
  })

  it("builds a cumulative pacing curve that never decreases", async () => {
    const owner = await makeUser("ovw_pace", "organizer")
    users.push(owner)
    const event = await makeScheduledEvent(owner, { startsInDays: 10, capacity: 30 })

    const attendees = await Promise.all([makeUser("ovw_p1"), makeUser("ovw_p2")])
    users.push(...attendees)
    await db.event_rsvps.createMany({
      data: attendees.map((id) => ({ event_id: event, user_id: id, status: "going" as const })),
    })

    const overview = (as("organizer", owner), await getDashboardOverview())
    if (overview.role !== "organizer") throw new Error("wrong overview role")

    expect(overview.pacing.length).toBeGreaterThan(0)
    // Days-out counts down to the event, so cumulative must be non-decreasing.
    const cumulative = overview.pacing.map((p) => p.cumulative)
    for (let i = 1; i < cumulative.length; i++) {
      expect(cumulative[i]).toBeGreaterThanOrEqual(cumulative[i - 1])
    }
    expect(cumulative[cumulative.length - 1]).toBe(2)
  })

  it("floors the no-show rate at zero when walk-ins outnumber RSVPs", async () => {
    const owner = await makeUser("ovw_walkin", "organizer")
    users.push(owner)
    const past = await makeScheduledEvent(owner, { startsInDays: -5, capacity: 50 })

    const attendees = await Promise.all([
      makeUser("ovw_w1"),
      makeUser("ovw_w2"),
      makeUser("ovw_w3"),
    ])
    users.push(...attendees)

    await db.event_rsvps.create({
      data: { event_id: past, user_id: attendees[0], status: "going" },
    })
    const pastOcc = await occurrenceOf(past)
    await db.event_check_ins.createMany({
      data: attendees.map((id) => ({
        event_id: past,
        occurrence_id: pastOcc,
        user_id: id,
        status: "checked_in" as const,
        check_in_time: new Date(),
      })),
    })

    const overview = (as("organizer", owner), await getDashboardOverview())
    if (overview.role !== "organizer") throw new Error("wrong overview role")

    // 3 attended against 1 RSVP is a 300% turn-up; a negative no-show rate
    // would render as "−200% didn't show".
    expect(overview.noShowRatePct).toBe(0)
  })

  it("counts repeat attendees, not repeat check-ins", async () => {
    const owner = await makeUser("ovw_repeat", "organizer")
    users.push(owner)
    const first = await makeScheduledEvent(owner, { startsInDays: -20 })
    const second = await makeScheduledEvent(owner, { startsInDays: -10 })

    const loyal = await makeUser("ovw_loyal")
    const once = await makeUser("ovw_once")
    users.push(loyal, once)

    const [firstOcc, secondOcc] = await Promise.all([occurrenceOf(first), occurrenceOf(second)])
    await db.event_check_ins.createMany({
      data: [
        { event_id: first, occurrence_id: firstOcc, user_id: loyal, status: "checked_in", check_in_time: new Date() },
        { event_id: second, occurrence_id: secondOcc, user_id: loyal, status: "checked_in", check_in_time: new Date() },
        { event_id: first, occurrence_id: firstOcc, user_id: once, status: "checked_in", check_in_time: new Date() },
      ],
    })

    const overview = (as("organizer", owner), await getDashboardOverview())
    if (overview.role !== "organizer") throw new Error("wrong overview role")
    expect(overview.repeatAttendees).toBe(1)
  })

  it("breaks ratings down rather than only averaging them", async () => {
    const owner = await makeUser("ovw_rating", "organizer")
    users.push(owner)
    const event = await makeScheduledEvent(owner, { startsInDays: -2 })

    const raters = await Promise.all([makeUser("ovw_r1"), makeUser("ovw_r2")])
    users.push(...raters)
    await db.event_ratings.createMany({
      data: [
        { event_id: event, user_id: raters[0], rating: 5 },
        { event_id: event, user_id: raters[1], rating: 1 },
      ],
    })

    const overview = (as("organizer", owner), await getDashboardOverview())
    if (overview.role !== "organizer") throw new Error("wrong overview role")

    // The mean is 3.0, which describes neither rater.
    expect(overview.averageRating).toBe(3)
    expect(overview.ratings[4]).toBe(1)
    expect(overview.ratings[0]).toBe(1)
    expect(overview.ratings[2]).toBe(0)
  })
})

describe("venue owner overview", () => {
  it("splits the portfolio by venue instead of blending it", async () => {
    const owner = await makeUser("ovw_venue", "organizer")
    users.push(owner)
    await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })

    await makeScheduledEvent(owner, { startsInDays: -3, venue: "Rooftop" })
    await makeScheduledEvent(owner, { startsInDays: -6, venue: "Rooftop" })
    await makeScheduledEvent(owner, { startsInDays: -9, venue: "Basement" })

    const overview = (as("venue_owner", owner), await getDashboardOverview())
    if (overview.role !== "venue_owner") throw new Error("wrong overview role")

    const byName = Object.fromEntries(overview.venues.map((v) => [v.name, v.eventsInWindow]))
    expect(byName["Rooftop"]).toBe(2)
    expect(byName["Basement"]).toBe(1)
  })

  it("fills the utilisation grid from event start times", async () => {
    const owner = await makeUser("ovw_util", "organizer")
    users.push(owner)
    await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })
    await makeScheduledEvent(owner, { startsInDays: -4, venue: "Grid Room" })

    const overview = (as("venue_owner", owner), await getDashboardOverview())
    if (overview.role !== "venue_owner") throw new Error("wrong overview role")

    expect(overview.utilisation).toHaveLength(7)
    expect(overview.utilisation[0]).toHaveLength(4)
    const total = overview.utilisation.flat().reduce((a, b) => a + b, 0)
    expect(total).toBe(1)
    expect(overview.peakWindow).not.toBeNull()
  })
})

describe("admin overview", () => {
  it("executes every query and reports the moderation queue", async () => {
    const overview = (as("app_admin"), await getDashboardOverview())
    if (overview.role !== "app_admin") throw new Error("wrong overview role")

    expect(overview.growth).toHaveLength(8)
    /*
     * The whole loop, not the first four stages.
     *
     * It used to stop at "checked in" — which every events app can measure. The
     * last three require verified physical attendance, which is the thing no
     * competitor has, and they are the only figures that say whether the
     * product's one sentence is true.
     */
    expect(overview.funnel.map((s) => s.label)).toEqual([
      "signed up",
      "onboarded",
      "RSVP'd",
      "checked in",
      "matched",
      "conversed",
      "came back",
    ])

    // Nested subsets, or the shape lies: no stage may exceed the one above it.
    const values = overview.funnel.map((s) => s.value)
    expect(values).toEqual([...values].sort((a, b) => b - a))
    expect(overview.attention.pending).toBeGreaterThanOrEqual(0)
    expect(overview.publishingHosts.publishing).toBeLessThanOrEqual(
      overview.publishingHosts.total + overview.publishingHosts.publishing
    )
  })

  it("keeps the funnel monotonically non-increasing", async () => {
    const overview = (as("app_admin"), await getDashboardOverview())
    if (overview.role !== "app_admin") throw new Error("wrong overview role")

    // Each stage is a subset of the one above it. If this ever inverts, the
    // stages are counting different populations and the funnel is a lie.
    const values = overview.funnel.map((s) => s.value)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1])
    }
  })
})

describe("role gating", () => {
  /*
   * This used to assert "a scoped role needs a user id", which was a check on
   * an argument the caller supplied -- and therefore on nothing at all. The
   * action is a POST endpoint: an organiser could pass `"app_admin"` and read
   * the whole-platform report, every other organiser's name and email included.
   * Role and identity now come from the session, so these pin the boundary
   * instead of the argument.
   */
  it("refuses a caller with no session", async () => {
    session = null
    await expect(getDashboardOverview()).rejects.toThrow(/Not authorised/)
  })

  it("refuses an attendee", async () => {
    // Middleware already keeps attendees out of /dashboard. It is one control,
    // and it never sees which action is being invoked.
    session = { user: { id: "someone", role: "attendee" as never } }
    await expect(getDashboardOverview()).rejects.toThrow(/Not authorised/)
  })

  it("gives an organiser the organiser overview, whatever they ask for", async () => {
    // The point of the fix: there is no argument left that can change this.
    const owner = await makeUser("ovw_gate", "organizer")
    users.push(owner)
    as("organizer", owner)
    const overview = await getDashboardOverview()
    expect(overview.role).toBe("organizer")
  })
})
