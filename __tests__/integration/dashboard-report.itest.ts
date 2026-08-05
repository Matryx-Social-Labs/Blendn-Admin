import { getDashboardReport } from "@/app/dashboard/actions"
import { db, cleanup, closeDb, makeUser, testId } from "./helpers"

/**
 * The report is nine parallel Prisma calls per role, several of them `groupBy`
 * with relation filters. TypeScript checks the shapes but not whether the
 * queries are valid SQL — a wrong relation name in a `groupBy` compiles and
 * throws at request time. These run the real thing.
 *
 * They also pin the arithmetic that is easy to get subtly wrong: capacity
 * percentages when capacity is absent, and a turn-up rate when walk-ins mean
 * more people attended than ever RSVP'd.
 */

const users: string[] = []
const events: string[] = []

const DAY = 24 * 60 * 60 * 1000

async function makeScheduledEvent(
  organizerId: string,
  opts: { startsInDays: number; capacity?: number | null }
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
      status: "published",
      organizer_id: organizerId,
      max_capacity: opts.capacity ?? null,
    },
  })
  events.push(event.id)
  return event.id
}

afterAll(async () => {
  await cleanup(users, events)
  await closeDb()
})

describe("organiser report", () => {
  it("reports upcoming events with commitment against capacity", async () => {
    const owner = await makeUser("dash_owner", "organizer")
    users.push(owner)

    const soon = await makeScheduledEvent(owner, { startsInDays: 3, capacity: 10 })
    const later = await makeScheduledEvent(owner, { startsInDays: 20, capacity: null })

    const attendees = await Promise.all([
      makeUser("dash_a1"),
      makeUser("dash_a2"),
      makeUser("dash_a3"),
    ])
    users.push(...attendees)

    await db.event_rsvps.createMany({
      data: [
        { event_id: soon, user_id: attendees[0], status: "going" },
        { event_id: soon, user_id: attendees[1], status: "maybe" },
        // A decline must not count as commitment.
        { event_id: soon, user_id: attendees[2], status: "not_going" },
        { event_id: later, user_id: attendees[0], status: "going" },
      ],
    })

    const report = await getDashboardReport("organizer", owner)
    const rows = report.upcoming.rows

    // Soonest first, and the past events this owner has do not appear.
    expect(rows.map((r) => r.id)).toEqual([soon, later])

    const soonRow = rows[0]
    expect(soonRow.committed).toBe(2)
    expect(soonRow.capacity).toBe(10)
    expect(soonRow.fillPct).toBe(20)
    expect(soonRow.daysOut).toBeGreaterThan(0)

    // No stated capacity means there is no target, so the percentage is absent
    // rather than zero — zero would render as the alarm colour.
    expect(rows[1].capacity).toBeNull()
    expect(rows[1].fillPct).toBeNull()
  })

  it("caps the turn-up rate when walk-ins outnumber RSVPs", async () => {
    const owner = await makeUser("dash_walkin", "organizer")
    users.push(owner)

    const past = await makeScheduledEvent(owner, { startsInDays: -5, capacity: 50 })
    const attendees = await Promise.all([
      makeUser("dash_w1"),
      makeUser("dash_w2"),
      makeUser("dash_w3"),
    ])
    users.push(...attendees)

    // One RSVP, three people through the door.
    await db.event_rsvps.create({
      data: { event_id: past, user_id: attendees[0], status: "going" },
    })
    await db.event_check_ins.createMany({
      data: attendees.map((id) => ({
        event_id: past,
        user_id: id,
        status: "checked_in" as const,
        check_in_time: new Date(),
      })),
    })

    const report = await getDashboardReport("organizer", owner)
    const turnUp = report.spotlights.find((card) => card.title === "Turn-up rate")

    // Raw ratio is 300%. "300% turned up" reads as a bug, not a good night.
    expect(turnUp?.value).toBe("100%")
  })

  it("breaks ratings down rather than only averaging them", async () => {
    const owner = await makeUser("dash_rating", "organizer")
    users.push(owner)
    const event = await makeScheduledEvent(owner, { startsInDays: -2 })

    const raters = await Promise.all([makeUser("dash_r1"), makeUser("dash_r2")])
    users.push(...raters)
    await db.event_ratings.createMany({
      data: [
        { event_id: event, user_id: raters[0], rating: 5 },
        { event_id: event, user_id: raters[1], rating: 1 },
      ],
    })

    const report = await getDashboardReport("organizer", owner)
    expect(report.breakdown.title).toBe("Rating spread")

    const byLabel = Object.fromEntries(
      report.breakdown.bars.map((bar) => [bar.label, bar.value])
    )
    // The average of these two is 3.0, which describes neither rater.
    expect(byLabel["5 stars"]).toBe(1)
    expect(byLabel["1 star"]).toBe(1)
    expect(byLabel["3 stars"]).toBe(0)
  })
})

describe("venue owner report", () => {
  it("splits the portfolio by venue instead of blending it", async () => {
    const owner = await makeUser("dash_venue", "organizer")
    users.push(owner)
    await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })

    for (const [venue, count] of [
      ["Rooftop", 2],
      ["Basement", 1],
    ] as const) {
      for (let i = 0; i < count; i++) {
        const id = await makeScheduledEvent(owner, { startsInDays: 5 + i })
        await db.events.update({ where: { id }, data: { venue_name: venue } })
      }
    }

    const report = await getDashboardReport("venue_owner", owner)
    expect(report.breakdown.title).toBe("Events by venue")

    const byLabel = Object.fromEntries(
      report.breakdown.bars.map((bar) => [bar.label, bar.value])
    )
    expect(byLabel["Rooftop"]).toBe(2)
    expect(byLabel["Basement"]).toBe(1)
  })
})

describe("admin report", () => {
  it("builds without throwing and surfaces the moderation backlog", async () => {
    // Nine parallel queries including two groupBys. The value here is that it
    // executes at all — a bad relation name in groupBy typechecks fine.
    const report = await getDashboardReport("app_admin")

    expect(report.role).toBe("app_admin")
    expect(report.breakdown.title).toBe("Moderation queue")
    expect(report.breakdown.bars.map((bar) => bar.label)).toEqual([
      "Pending",
      "Approved",
      "Rejected",
    ])
    expect(report.spotlights.some((card) => card.title === "Moderation backlog")).toBe(true)
    expect(report.metrics).toHaveLength(4)
    expect(report.spotlights).toHaveLength(5)
  })

  it("refuses a scoped role without a user id", async () => {
    await expect(getDashboardReport("organizer")).rejects.toThrow(/User ID is required/)
  })
})
