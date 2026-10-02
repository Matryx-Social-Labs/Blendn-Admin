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
import { db, cleanup, closeDb, makeUser, testId , occurrenceOf, putInRoom } from "./helpers"

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

  it("a walk-in does not cancel a no-show: one RSVP stayed home, one stranger came, 100% (SCRUM-467)", async () => {
    const owner = await makeUser("ovw_ns_owner", "organizer")
    users.push(owner)
    const past = await makeScheduledEvent(owner, { startsInDays: -4, capacity: 50 })
    const [stayedHome, walkedIn] = await Promise.all([makeUser("ovw_ns_home"), makeUser("ovw_ns_walkin")])
    users.push(stayedHome, walkedIn)
    await db.event_rsvps.create({ data: { event_id: past, user_id: stayedHome, status: "going" } })
    await db.event_check_ins.create({
      data: { event_id: past, occurrence_id: await occurrenceOf(past), user_id: walkedIn, status: "checked_in", check_in_time: new Date() },
    })

    const overview = (as("organizer", owner), await getDashboardOverview())
    if (overview.role !== "organizer") throw new Error("wrong overview role")
    // It read 0%: one person checked in, against one RSVP.
    expect(overview.noShowRatePct).toBe(100)
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

    // Five: the fewest the overview will show (SCRUM-437).
    const raters = await Promise.all([1, 2, 3, 4, 5].map((n) => makeUser(`ovw_r${n}`)))
    users.push(...raters)
    await db.event_ratings.createMany({
      data: [5, 1, 5, 1, 3].map((rating, i) => ({ event_id: event, user_id: raters[i], rating })),
    })

    const overview = (as("organizer", owner), await getDashboardOverview())
    if (overview.role !== "organizer") throw new Error("wrong overview role")

    // The mean is 3.0, which describes none of the raters.
    expect(overview.averageRating).toBe(3)
    expect(overview.ratings).toEqual([2, 0, 1, 0, 2])
  })

  it("withholds the average and the spread under five raters: two ratings are each other's (SCRUM-437)", async () => {
    const owner = await makeUser("ovw_rating_few", "organizer")
    users.push(owner)
    const event = await makeScheduledEvent(owner, { startsInDays: -2 })
    const raters = await Promise.all([makeUser("ovw_f1"), makeUser("ovw_f2")])
    users.push(...raters)
    await db.event_ratings.createMany({
      data: [
        { event_id: event, user_id: raters[0], rating: 5 },
        { event_id: event, user_id: raters[1], rating: 1 },
      ],
    })

    const overview = (as("organizer", owner), await getDashboardOverview())
    if (overview.role !== "organizer") throw new Error("wrong overview role")

    // Either rater could subtract their own score from 3.0 x 2 and read the other's.
    expect(overview.averageRating).toBeNull()
    expect(overview.ratings).toEqual([0, 0, 0, 0, 0])
    expect(overview.ratingCount).toBe(2)
  })

  it("puts the night running now in a banner, with its waiting flags, who is inside and who came (step 15)", async () => {
    const owner = await makeUser("ovw_live", "organizer")
    users.push(owner)
    const tonight = await makeScheduledEvent(owner, { startsInDays: 0, capacity: 50 })
    await db.events.update({
      where: { id: tonight },
      data: { start_time: new Date(Date.now() - 60 * 60 * 1000), end_time: new Date(Date.now() + 3 * 60 * 60 * 1000) },
    })
    // A later night is not the live one, and is next up.
    const later = await makeScheduledEvent(owner, { startsInDays: 3, capacity: 40 })
    const [inside, left] = await Promise.all([makeUser("ovw_in"), makeUser("ovw_left")])
    users.push(inside, left)
    const occ = await occurrenceOf(tonight)
    await putInRoom({ eventId: tonight, occurrenceId: occ, userId: inside })
    await putInRoom({ eventId: tonight, occurrenceId: occ, userId: left })
    await db.event_check_ins.updateMany({ where: { event_id: tonight, user_id: left }, data: { status: "checked_out" } })
    await db.presence_sessions.updateMany({ where: { event_id: tonight, user_id: left }, data: { departed_at: new Date() } })
    const room = await db.chat_groups.create({ data: { event_id: tonight, name: "room" } })
    const message = await db.chat_messages.create({ data: { chat_group_id: room.id, user_id: inside, content: "hello" } })
    await db.moderation_flags.createMany({
      data: [
        { message_id: message.id, chat_group_id: room.id, user_id: inside, source: "auto_keyword", categories: {}, confidence: 0.9 },
        // Decided already: nothing waits on anybody.
        { message_id: message.id, chat_group_id: room.id, user_id: inside, source: "user_report", categories: {}, confidence: 1, status: "approved" },
      ],
    })

    const overview = (as("organizer", owner), await getDashboardOverview())
    if (overview.role !== "organizer") throw new Error("wrong overview role")
    try {
      expect(overview.live).toMatchObject({ id: tonight, flags: 1, inside: 1, checkedIn: 2, messages: 1 })
      expect(overview.nextEvent?.id).toBe(later)
      // Coming up is ahead of now: the running night is the banner, not a row.
      expect(overview.comingUp.map((e) => e.id)).toEqual([later])
      expect(overview.comingUp[0]).toMatchObject({ phase: "upcoming", tab: "upcoming", capacity: 40, going: 0 })
      // Tonight started in the last 30 days: two people, one check-in each.
      expect(overview.checkIns.current).toBe(2)
    } finally {
      await db.moderation_flags.deleteMany({ where: { chat_group_id: room.id } })
      await db.presence_sessions.deleteMany({ where: { event_id: tonight } })
    }
  })

  it("derives Getting set up from the organisation's rows: domain unverified, nobody invited, one published (step 15)", async () => {
    const owner = await makeUser("ovw_setup", "organizer")
    users.push(owner)
    const org = await db.organisations.create({ data: { display_name: `Setup ${testId("o")}`, kind: "company" } })
    try {
      await db.organisation_members.create({ data: { org_id: org.id, user_id: owner, role: "owner" } })
      const domain = `${testId("d").replace(/_/g, "-")}.example`
      await db.organisation_domains.create({ data: { org_id: org.id, domain, verification_token: "t" } })

      let overview = (as("organizer", owner), await getDashboardOverview())
      if (overview.role !== "organizer") throw new Error("wrong overview role")
      expect(overview.setup).toEqual({
        org: { name: org.display_name, kind: "company", domain: { name: domain, verified: false }, colleagues: false },
        published: false,
      })

      const draft = await makeScheduledEvent(owner, { startsInDays: 5, status: "draft" })
      await db.events.update({ where: { id: draft }, data: { organizer_org_id: org.id } })
      overview = (as("organizer", owner), await getDashboardOverview())
      if (overview.role !== "organizer") throw new Error("wrong overview role")
      // A draft is not a published event; it is in Coming up, in Drafts.
      expect(overview.setup.published).toBe(false)
      expect(overview.comingUp.find((e) => e.id === draft)?.tab).toBe("drafts")

      await db.events.update({ where: { id: draft }, data: { status: "published" } })
      await db.organisation_invites.create({
        data: { org_id: org.id, email: "colleague@itest.invalid", token_hash: testId("h"), expires_at: new Date(Date.now() + DAY), invited_by: owner },
      })
      overview = (as("organizer", owner), await getDashboardOverview())
      if (overview.role !== "organizer") throw new Error("wrong overview role")
      expect(overview.setup.published).toBe(true)
      expect(overview.setup.org?.colleagues).toBe(true)
    } finally {
      await db.organisations.delete({ where: { id: org.id } })
    }
  })

  it("shows the latest event whose own ratings clear the floor, never a newer one under it (step 15)", async () => {
    const owner = await makeUser("ovw_latest", "organizer")
    users.push(owner)
    const [older, newer] = await Promise.all([
      makeScheduledEvent(owner, { startsInDays: -6 }),
      makeScheduledEvent(owner, { startsInDays: -1 }),
    ])
    const raters = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => makeUser(`ovw_l${n}`)))
    users.push(...raters)
    await db.event_ratings.createMany({
      data: [
        ...[4, 4, 5, 3, 4].map((rating, i) => ({ event_id: older, user_id: raters[i], rating })),
        // Four raters on the newer night: under the floor, so it is not "latest".
        ...[1, 1, 2, 5].map((rating, i) => ({ event_id: newer, user_id: raters[i + 1], rating })),
      ],
    })

    const overview = (as("organizer", owner), await getDashboardOverview())
    if (overview.role !== "organizer") throw new Error("wrong overview role")
    expect(overview.latestFeedback).toMatchObject({ eventId: older, ratings: [0, 0, 1, 3, 1], averageRating: 4 })
  })

  it("pools only events that pass alone: the org's bars minus a visible event are never a withheld one's (SCRUM-437)", async () => {
    const owner = await makeUser("ovw_rating_pool", "organizer")
    users.push(owner)
    const [open, small] = await Promise.all([
      makeScheduledEvent(owner, { startsInDays: -2 }),
      makeScheduledEvent(owner, { startsInDays: -4 }),
    ])
    const raters = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => makeUser(`ovw_p${n}`)))
    users.push(...raters)
    await db.event_ratings.createMany({
      data: [
        ...[5, 4, 4, 3, 5].map((rating, i) => ({ event_id: open, user_id: raters[i], rating })),
        { event_id: small, user_id: raters[5], rating: 1 },
      ],
    })

    const overview = (as("organizer", owner), await getDashboardOverview())
    if (overview.role !== "organizer") throw new Error("wrong overview role")

    // The one-rater event's 1 is not in the total, or total minus `open` would show it.
    expect(overview.ratings).toEqual([0, 0, 1, 2, 2])
    expect(overview.averageRating).toBe(4.2)
    expect(overview.ratingCount).toBe(5)
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

  it("withholds a venue's rating under five raters, and says nothing about it skewing low (SCRUM-437)", async () => {
    const owner = await makeUser("ovw_venue_rating", "organizer")
    users.push(owner)
    await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })
    const event = await makeScheduledEvent(owner, { startsInDays: -3, venue: "Snug" })
    const rater = await makeUser("ovw_venue_r1")
    users.push(rater)
    await db.event_ratings.create({ data: { event_id: event, user_id: rater, rating: 1 } })

    const overview = (as("venue_owner", owner), await getDashboardOverview())
    if (overview.role !== "venue_owner") throw new Error("wrong overview role")

    const snug = overview.venues.find((v) => v.name === "Snug")
    expect(snug?.averageRating).toBeNull()
    expect(snug?.ratings).toEqual([0, 0, 0, 0, 0])
    // Counted, so the screen can say "not enough ratings yet" rather than "nobody".
    expect(snug?.ratingCount).toBe(1)
    expect(snug?.note).not.toBe("ratings skew low")
    expect(snug?.tone).not.toBe("destructive")
  })

  it("shows a venue's rating from five raters, and flags it when it skews low (SCRUM-437)", async () => {
    const owner = await makeUser("ovw_venue_low", "organizer")
    users.push(owner)
    await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })
    const event = await makeScheduledEvent(owner, { startsInDays: -3, venue: "Cellar" })
    const raters = await Promise.all([1, 2, 3, 4, 5].map((n) => makeUser(`ovw_venue_low${n}`)))
    users.push(...raters)
    await db.event_ratings.createMany({
      data: [1, 2, 2, 3, 4].map((rating, i) => ({ event_id: event, user_id: raters[i], rating })),
    })

    const overview = (as("venue_owner", owner), await getDashboardOverview())
    if (overview.role !== "venue_owner") throw new Error("wrong overview role")

    const cellar = overview.venues.find((v) => v.name === "Cellar")
    expect(cellar).toMatchObject({ averageRating: 2.4, ratings: [1, 2, 1, 1, 0], ratingCount: 5 })
    expect(cellar?.note).toBe("ratings skew low")
    expect(cellar?.tone).toBe("destructive")
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
      "came back",
      "matched",
      "conversed",
    ])

    // Nested subsets, or the shape lies: no stage may exceed the one it is a
    // share of — the stage above it, or its declared base (SCRUM-313).
    for (const [i, stage] of overview.funnel.entries()) {
      if (i === 0) continue
      const base = stage.base ? overview.funnel.find((s) => s.label === stage.base) : overview.funnel[i - 1]
      expect(stage.value).toBeLessThanOrEqual(base!.value)
    }
    /*
     * All four queues, always — including the empty ones.
     *
     * The strip used to count `moderation_flags` alone and rendered
     * "Moderation queue is clear" beside a sidebar showing Claims 4 and
     * Applications 7. Asserting the SHAPE rather than any count is what stops
     * that returning: a fifth queue added to `attentionQueues` without a row
     * here fails, and so does silently dropping one.
     */
    expect(overview.attention.map((q) => q.key).sort()).toEqual([
      "applications",
      "claims",
      "creative",
      "moderation",
    ])
    for (const queue of overview.attention) {
      expect(queue.count).toBeGreaterThanOrEqual(0)
      // An empty queue has no oldest item, and a non-empty one always does.
      expect(queue.oldest === null).toBe(queue.count === 0)
      expect(queue.slaHours).toBeGreaterThan(0)
    }

    // Refusals are distinct people, so the total can never exceed the sum of
    // the per-reason rows and can be lower when one person hit two reasons.
    const refusalRows = overview.refusals.byReason.reduce((sum, r) => sum + r.people, 0)
    expect(overview.refusals.total).toBeLessThanOrEqual(refusalRows || 0)

    expect(overview.upcomingEvents).toBeGreaterThanOrEqual(0)
    // Server time, carried to the client so both render the same ages.
    expect(Number.isNaN(Date.parse(overview.generatedAt))).toBe(false)
    expect(overview.publishingHosts.publishing).toBeLessThanOrEqual(
      overview.publishingHosts.total + overview.publishingHosts.publishing
    )
  })

  it("keeps the funnel monotonically non-increasing", async () => {
    const overview = (as("app_admin"), await getDashboardOverview())
    if (overview.role !== "app_admin") throw new Error("wrong overview role")

    // Each stage is a subset of the one it is a share of — the stage above,
    // or its declared base. If this ever inverts, the stages are counting
    // different populations and the funnel is a lie.
    for (const [i, stage] of overview.funnel.entries()) {
      if (i === 0) continue
      const base = stage.base ? overview.funnel.find((s) => s.label === stage.base) : overview.funnel[i - 1]
      expect(stage.value).toBeLessThanOrEqual(base!.value)
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
