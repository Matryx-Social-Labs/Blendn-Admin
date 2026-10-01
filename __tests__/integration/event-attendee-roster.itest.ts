import type { user_role } from "@prisma/client"

import { attendeeRoster, eventAttendees } from "@/lib/attendee-roster"
import { actorFor } from "@/lib/org-membership"
import { attendeeLabel } from "@/lib/pseudonym"
import { db, cleanup, closeDb, makeUser, testId } from "./helpers"

/**
 * The event's Attendees tab: that event's people, by label, and nobody else's.
 *
 * The tab used to redirect to `/messaging?view=attendees`, which nothing read,
 * so it landed on the room chat and no per-event list existed (SCRUM-499).
 *
 * Whoever runs the event gets labels: salted with the event's organisation,
 * in label order, arrivals to the quarter hour, and nothing about who came
 * while fewer than five did. The venue it is held at gets a count and no
 * person, by the rule every venue surface shares (`venueCounts`, SCRUM-501),
 * and nothing for an event before its claim (SCRUM-355).
 *
 * Real Postgres, because what matters is what the queries select and scope on.
 * A mocked `db` returns whatever the test thought to give it.
 */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const venues: string[] = []

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const QUARTER = 15 * MINUTE

async function makeOrg(label: string) {
  const org = await db.organisations.create({
    data: { display_name: `Org ${testId(label)}`, kind: "company", status: "verified" },
  })
  orgs.push(org.id)
  return org.id
}

async function person(label: string) {
  const id = await makeUser(label)
  users.push(id)
  return id
}

type Fixture = { id: string; occurrences: string[]; start: Date }

/** An event of `orgId` starting `startsInHours` from now, one occurrence per day, three hours a day. */
async function event(
  orgId: string,
  creator: string,
  startsInHours: number,
  opts: { days?: number; status?: "published" | "cancelled"; venueId?: string } = {}
): Promise<Fixture> {
  const days = opts.days ?? 1
  const start = new Date(Date.now() + startsInHours * HOUR)
  const row = await db.events.create({
    data: {
      slug: testId("roster"),
      title: "Roster fixture",
      description: "integration fixture",
      start_time: start,
      end_time: new Date(start.getTime() + (days - 1) * DAY + 3 * HOUR),
      timezone: "Asia/Kolkata",
      status: opts.status ?? "published",
      organizer_id: creator,
      organizer_org_id: orgId,
      venue_id: opts.venueId ?? null,
    },
  })
  events.push(row.id)
  const occurrences: string[] = []
  for (let d = 0; d < days; d++) {
    const dayStart = new Date(start.getTime() + d * DAY)
    const occ = await db.event_occurrences.create({
      data: {
        event_id: row.id,
        occurs_on: new Date(dayStart.toISOString().slice(0, 10)),
        start_time: dayStart,
        end_time: new Date(dayStart.getTime() + 3 * HOUR),
      },
    })
    occurrences.push(occ.id)
  }
  return { id: row.id, occurrences, start }
}

async function checkIn(
  e: Fixture,
  userId: string,
  minutesAfterStart: number | null,
  opts: { day?: number; kind?: "attendee" | "staff"; status?: "checked_in" | "checked_out" | "pending" } = {}
) {
  const day = opts.day ?? 0
  await db.event_check_ins.create({
    data: {
      event_id: e.id,
      occurrence_id: e.occurrences[day],
      user_id: userId,
      kind: opts.kind ?? "attendee",
      status: opts.status ?? "checked_out",
      check_in_time:
        minutesAfterStart === null ? null : new Date(e.start.getTime() + day * DAY + minutesAfterStart * MINUTE),
    },
  })
}

async function rsvp(e: Fixture, userId: string, status: "going" | "maybe" | "not_going" | "waitlisted" = "going") {
  await db.event_rsvps.create({ data: { event_id: e.id, user_id: userId, status } })
}

afterAll(async () => {
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

/** What `userId` acting as `role` is given for the event, through the real `actorFor`. */
async function seen(role: user_role, userId: string, eventId: string) {
  return eventAttendees(await actorFor({ id: userId, role }), eventId)
}

/** The labelled roster, failing the test if the caller was given anything else. */
async function roster(role: user_role, userId: string, eventId: string) {
  const out = await seen(role, userId, eventId)
  if (out?.view !== "labels") throw new Error(`expected labels, got ${JSON.stringify(out)}`)
  return out
}

const statusOf = (out: Awaited<ReturnType<typeof roster>>) =>
  Object.fromEntries(out.rows.map((r) => [r.id, [r.rsvp, r.status]]))

describe("an event's attendee roster", () => {
  let hostA: string, colleague: string, dual: string, leaver: string, hostB: string, admin: string, venueOwner: string
  // At `past`: came with an RSVP (priya, gina, gus, nora), walked in (wally;
  // wanda waitlisted; nina said no), promised and stayed away (rahul going,
  // mia maybe), worked it with an RSVP (stan), a pending check-in (pat).
  let priya: string, gina: string, gus: string, nora: string, wally: string, wanda: string, nina: string
  let rahul: string, mia: string, stan: string, pat: string, olga: string
  let guests: string[]
  let past: Fixture, other: Fixture, live: Fixture, cancelled: Fixture
  let small: Fixture, busy: Fixture, complete: Fixture, residual: Fixture, quiet: Fixture
  let beforeClaim: Fixture, upcoming: Fixture
  let orgA: string
  /** The label org A's members see for `who`. */
  const atA = (who: string) => attendeeLabel(who, orgA)

  const identityOf = () => [priya, rahul, mia, wally, olga, stan, pat, "Priya Realname", `${priya}@itest.invalid`, "img.invalid"]

  beforeAll(async () => {
    hostA = await makeUser("hostA", "organizer")
    colleague = await makeUser("colleague", "organizer")
    dual = await makeUser("dual", "organizer")
    leaver = await makeUser("leaver", "organizer")
    hostB = await makeUser("hostB", "organizer")
    admin = await makeUser("admin", "app_admin")
    venueOwner = await makeUser("venueOwner")
    users.push(hostA, colleague, dual, leaver, hostB, admin, venueOwner)
    ;[priya, gina, gus, nora, wally, wanda, nina, rahul, mia, stan, pat, olga] = await Promise.all(
      ["priya", "gina", "gus", "nora", "wally", "wanda", "nina", "rahul", "mia", "stan", "pat", "olga"].map(person)
    )
    guests = await Promise.all(["g1", "g2", "g3", "g4", "g5", "g6"].map(person))
    await db.user.update({ where: { id: priya }, data: { name: "Priya Realname", image: "https://img.invalid/p.jpg" } })

    orgA = await makeOrg("a")
    const orgB = await makeOrg("b")
    const orgV = await makeOrg("venue")
    await db.organisation_members.createMany({
      data: [
        { org_id: orgA, user_id: hostA, role: "owner" },
        // Staff work the door and the room; they see the roster too (R1).
        { org_id: orgA, user_id: colleague, role: "staff" },
        { org_id: orgA, user_id: dual, role: "admin" },
        { org_id: orgB, user_id: dual, role: "owner" },
        { org_id: orgA, user_id: leaver, role: "staff" },
        { org_id: orgB, user_id: hostB, role: "owner" },
        { org_id: orgV, user_id: venueOwner, role: "owner" },
      ],
    })
    // Org A runs its events at a venue org V claimed a month ago.
    const venue = await db.venues.create({
      data: { name: testId("roster-venue"), city: "Bengaluru", owner_org_id: orgV, claimed_at: new Date(Date.now() - 30 * DAY) },
    })
    venues.push(venue.id)
    const atV = { venueId: venue.id }

    // A two-day conference that ended two days ago.
    past = await event(orgA, hostA, -3 * 24, { days: 2, ...atV })
    await rsvp(past, priya)
    await checkIn(past, priya, 95, { day: 1 })
    await checkIn(past, priya, 20, { day: 0 })
    for (const [who, at] of [[gina, 31], [gus, 47]] as const) {
      await rsvp(past, who)
      await checkIn(past, who, at)
    }
    await rsvp(past, nora)
    await checkIn(past, nora, null) // an older row with no check-in time
    await checkIn(past, wally, 40)
    await rsvp(past, wanda, "waitlisted")
    await checkIn(past, wanda, 50)
    await rsvp(past, nina, "not_going")
    await checkIn(past, nina, 55)
    await rsvp(past, rahul)
    await rsvp(past, mia, "maybe")
    await rsvp(past, stan)
    await checkIn(past, stan, 5, { kind: "staff" })
    await checkIn(past, pat, 10, { status: "pending" })

    other = await event(orgA, hostA, -7 * 24)
    await rsvp(other, olga)
    await checkIn(other, olga, 30)
    await checkIn(other, priya, 30)

    // Started an hour ago, five in, Rahul still to come.
    live = await event(orgA, hostA, -1)
    await rsvp(live, rahul)
    for (const g of guests.slice(0, 5)) await checkIn(live, g, 10)

    cancelled = await event(orgA, hostA, -30, { status: "cancelled" })
    await rsvp(cancelled, rahul)

    // Four people over two days: eight rows, four people. Under the floor.
    small = await event(orgA, hostA, -5 * 24, { days: 2, ...atV })
    for (const g of guests.slice(0, 4)) {
      await checkIn(small, g, 10, { day: 0 })
      await checkIn(small, g, 10, { day: 1 })
    }
    await rsvp(small, rahul)
    await rsvp(small, mia)

    // Seven going, five came; one crew, one pending.
    busy = await event(orgA, hostA, -10 * 24, atV)
    for (const g of guests.slice(0, 5)) {
      await rsvp(busy, g)
      await checkIn(busy, g, 15)
    }
    await rsvp(busy, rahul)
    await rsvp(busy, mia)
    await checkIn(busy, stan, 5, { kind: "staff" })
    await checkIn(busy, pat, 10, { status: "pending" })

    // Everybody who promised came: the count names them all.
    complete = await event(orgA, hostA, -11 * 24, atV)
    for (const g of guests.slice(0, 5)) {
      await rsvp(complete, g)
      await checkIn(complete, g, 15)
    }

    // All but one who promised came: the count names the one who didn't.
    residual = await event(orgA, hostA, -12 * 24, atV)
    for (const g of guests.slice(0, 6)) await rsvp(residual, g)
    for (const g of guests.slice(0, 5)) await checkIn(residual, g, 15)

    quiet = await event(orgA, hostA, -13 * 24, atV)
    await rsvp(quiet, rahul)

    beforeClaim = await event(orgA, hostA, -40 * 24, atV)
    for (const g of guests.slice(0, 5)) await checkIn(beforeClaim, g, 15)

    upcoming = await event(orgA, hostA, 2 * 24, atV)
    await rsvp(upcoming, rahul)
  })

  describe("for whoever runs it", () => {
    it("lists that event's people by label, in label order, with what each did", async () => {
      const out = await roster("organizer", hostA, past.id)

      expect(out.rows.map((r) => r.id)).toEqual([...out.rows.map((r) => r.id)].sort())
      for (const row of out.rows) {
        expect(row.id).toMatch(/^attendee-[0-9a-f]{12}$/)
        expect(Object.keys(row).sort()).toEqual(["arrivedAt", "id", "rsvp", "status"])
      }
      const statuses = out.rows.map((r) => `${r.rsvp}:${r.status}`).sort()
      expect(statuses).toEqual(
        [
          "going:came", // priya
          "going:came", // gina
          "going:came", // gus
          "going:came", // nora
          "null:came", // wally
          "null:came", // wanda, waitlisted: not a promise
          "null:came", // nina, said no and came anyway
          "going:no_show", // rahul
          "maybe:no_show", // mia
        ].sort()
      )
      expect(out).toMatchObject({ came: 7, walkIns: 3, noShows: 2 })
    })

    it("gives the first arrival of a multi-day stay, to the quarter hour, and none for a row without a time", async () => {
      const mine = await roster("organizer", hostA, past.id)
      const priyaRow = mine.rows.find((r) => r.id === atA(priya))!
      const first = past.start.getTime() + 20 * MINUTE
      expect(priyaRow.arrivedAt).toBe(new Date(Math.floor(first / QUARTER) * QUARTER).toISOString())
      for (const row of mine.rows) if (row.arrivedAt) expect(Date.parse(row.arrivedAt) % QUARTER).toBe(0)
      // Nora's check-in has no time: she came, and there is nothing to round.
      expect(mine.rows.filter((r) => r.status === "came" && r.arrivedAt === null)).toHaveLength(1)
    })

    it("never shows another event's attendees, staff, a pending check-in, or any identity", async () => {
      const out = await roster("organizer", hostA, past.id)
      const org = await attendeeRoster("organizer", hostA)

      // Olga came to the other event only; she is on the org roster and not here.
      expect(org.rows.map((r) => r.id)).toContain(atA(olga))
      const here = out.rows.map((r) => r.id)
      for (const absent of [olga, stan, pat]) expect(here).not.toContain(atA(absent))
      expect(here).toContain(atA(priya))
      expect(out.rows).toHaveLength(9)
      // Every label here is the one the org roster and the export use.
      const orgLabels = new Set(org.rows.map((r) => r.id))
      for (const row of out.rows) expect(orgLabels.has(row.id)).toBe(true)

      const wire = JSON.stringify(out)
      for (const secret of identityOf()) expect(wire).not.toContain(secret)
    })

    it("holds back who came, and when, while fewer than five did -- counted in people, not rows", async () => {
      // Four people over two days is eight check-in rows.
      const out = await roster("organizer", hostA, small.id)
      expect(out).toMatchObject({ came: 4, walkIns: null, noShows: null })
      // Only who promised, and nothing about whether they came.
      expect(out.rows).toHaveLength(2)
      for (const row of out.rows) expect(row).toMatchObject({ arrivedAt: null, status: "held_back" })
      expect(out.rows.map((r) => r.rsvp).sort()).toEqual(["going", "going"])
    })

    it("does not call anybody a no-show before the event is over", async () => {
      const out = await roster("organizer", hostA, live.id)
      expect(out.rows.filter((r) => r.status === "expected")).toHaveLength(1)
      expect(out.noShows).toBe(0)
    })

    it("does not call anybody a no-show at a cancelled event", async () => {
      const out = await roster("organizer", hostA, cancelled.id)
      expect(out.rows.map((r) => r.status)).toEqual(["expected"])
      expect(out.noShows).toBe(0)
    })
  })

  describe("labels", () => {
    it("are the same for every member of the organisation, staff included", async () => {
      const mine = statusOf(await roster("organizer", hostA, past.id))
      expect(statusOf(await roster("organizer", colleague, past.id))).toEqual(mine)
    })

    it("follow the event's organisation, not the viewer's other memberships", async () => {
      // A member of A and B sees A's event exactly as A's owner does.
      const mine = statusOf(await roster("organizer", hostA, past.id))
      expect(statusOf(await roster("organizer", dual, past.id))).toEqual(mine)
    })

    it("are gone for somebody who has left the organisation", async () => {
      expect(await seen("organizer", leaver, past.id)).not.toBeNull()
      await db.organisation_members.deleteMany({ where: { user_id: leaver } })
      expect(await seen("organizer", leaver, past.id)).toBeNull()
    })

    it("are the platform's own for an admin, never the person", async () => {
      const out = await roster("app_admin", admin, past.id)
      const host = await roster("organizer", hostA, past.id)
      const platform = new Set((await attendeeRoster("app_admin", admin)).rows.map((r) => r.id))
      expect(out.rows).toHaveLength(9)
      for (const row of out.rows) expect(platform.has(row.id)).toBe(true)
      expect(out.rows.map((r) => r.id).sort()).not.toEqual(host.rows.map((r) => r.id).sort())
      const wire = JSON.stringify(out)
      for (const secret of identityOf()) expect(wire).not.toContain(secret)
    })
  })

  describe("no-shows agree between the event and the organisation's roster", () => {
    it("counts a no-show only at an event that is over and ran, and never for somebody who worked it", async () => {
      const org = await attendeeRoster("organizer", hostA)
      const tabs = await Promise.all([past, other, live, cancelled, busy, complete, residual, quiet, beforeClaim, upcoming].map((e) => roster("organizer", hostA, e.id)))
      const fromTabs = new Map<string, number>()
      for (const tab of tabs) for (const row of tab.rows) if (row.status === "no_show") fromTabs.set(row.id, (fromTabs.get(row.id) ?? 0) + 1)
      // `small` is the one event whose tab holds no-shows back; the org roster
      // still counts its two.
      const heldBack = new Set((await roster("organizer", hostA, small.id)).rows.map((r) => r.id))
      for (const row of org.rows) {
        expect([row.id, row.noShows]).toEqual([row.id, (fromTabs.get(row.id) ?? 0) + (heldBack.has(row.id) ? 1 : 0)])
      }
      // Stan RSVP'd to an event he worked: not on the roster at all.
      expect(org.rows.map((r) => r.id)).not.toContain(atA(stan))
      // Rahul: past, small and quiet. Not the live one, not the cancelled one.
      expect(org.rows.find((r) => r.id === atA(rahul))).toMatchObject({ noShows: 4, rsvps: 4 })
      expect(fromTabs.size).toBeGreaterThan(0)
    })
  })

  describe("the venue the event is held at", () => {
    it("gets how many came, never a label, counted in people", async () => {
      // Five of seven going came; a crew member and a pending check-in don't count.
      const out = await seen("venue_owner", venueOwner, busy.id)
      expect(out).toEqual({ view: "count", started: true, came: 5 })
      expect(JSON.stringify(out)).not.toMatch(/attendee-/)
    })

    it("has the count held back under the floor, in people not rows", async () => {
      expect(await seen("venue_owner", venueOwner, small.id)).toEqual({ view: "count", started: true, came: null })
    })

    it("has it held back when it would name everyone going, the one who didn't come, or runs past them", async () => {
      expect(await seen("venue_owner", venueOwner, complete.id)).toEqual({ view: "count", started: true, came: null })
      expect(await seen("venue_owner", venueOwner, residual.id)).toEqual({ view: "count", started: true, came: null })
      // Seven came against six going: walk-ins cover the whole population.
      expect(await seen("venue_owner", venueOwner, past.id)).toEqual({ view: "count", started: true, came: null })
    })

    it("is told zero, which names nobody, and that an upcoming event has not started", async () => {
      expect(await seen("venue_owner", venueOwner, quiet.id)).toEqual({ view: "count", started: true, came: 0 })
      expect(await seen("venue_owner", venueOwner, upcoming.id)).toEqual({ view: "count", started: false, came: 0 })
    })

    it("gets nothing for an event before its claim, or one held elsewhere", async () => {
      expect(await seen("venue_owner", venueOwner, beforeClaim.id)).toBeNull()
      expect(await seen("venue_owner", venueOwner, other.id)).toBeNull()
    })
  })

  it("gives nothing to an organisation that does not run the event", async () => {
    // The page refuses first, on the same resolver; this is the floor under it.
    expect(await seen("organizer", hostB, past.id)).toBeNull()
  })
})
