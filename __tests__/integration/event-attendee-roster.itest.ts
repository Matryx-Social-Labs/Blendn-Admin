import type { user_role } from "@prisma/client"

import { attendeeRoster, eventAttendees } from "@/lib/attendee-roster"
import { actorFor } from "@/lib/org-membership"
import { db, cleanup, closeDb, makeUser, testId } from "./helpers"

/**
 * The event's Attendees tab: that event's people, by label, and nobody else's.
 *
 * The tab used to redirect to `/messaging?view=attendees`, which nothing read,
 * so it landed on the room chat and no per-event list existed (SCRUM-499).
 *
 * Whoever runs the event gets labels. The venue it is held at gets a count and
 * no person (SCRUM-501), held back under `MIN_CELL`, and nothing at all for an
 * event before its claim (SCRUM-355).
 *
 * Real Postgres, because the two things that matter are what the queries
 * select and what they scope on. A mocked `db` returns whatever the test
 * thought to give it, so it could prove neither.
 */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const venues: string[] = []

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

async function makeOrg(label: string) {
  const org = await db.organisations.create({
    data: { display_name: `Org ${testId(label)}`, kind: "company", status: "verified" },
  })
  orgs.push(org.id)
  return org.id
}

type Fixture = { id: string; occurrences: string[]; start: Date }

/** An event of `orgId` starting `startsInHours` from now, with one occurrence per day. */
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
  minutesAfterStart: number,
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
      check_in_time: new Date(e.start.getTime() + day * DAY + minutesAfterStart * 60_000),
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

/** What `userId` acting as `role` is given for the event. */
async function seen(role: user_role, userId: string, eventId: string) {
  return eventAttendees(await actorFor({ id: userId, role }), eventId)
}

/** The labelled roster, failing the test if the caller was given anything else. */
async function roster(role: user_role, userId: string, eventId: string) {
  const out = await seen(role, userId, eventId)
  if (out?.view !== "labels") throw new Error(`expected labels, got ${JSON.stringify(out)}`)
  return out
}

describe("an event's attendee roster", () => {
  let hostA: string
  let hostB: string
  let admin: string
  let priya: string // RSVP'd, came on both days of the conference
  let rahul: string // RSVP'd going, never came
  let mia: string // RSVP'd maybe, never came
  let wally: string // walked in, no RSVP
  let olga: string // came to the OTHER event only
  let nina: string // said not_going
  let stan: string // staff, checked in
  let pat: string // check-in still pending
  let venueOwner: string
  let past: Fixture
  let other: Fixture
  let live: Fixture
  let cancelled: Fixture
  let busy: Fixture // at the venue, five guests
  let beforeClaim: Fixture // at the venue, before it was claimed

  const identityOf = () =>
    [priya, rahul, mia, wally, olga, "Priya Realname", `${priya}@itest.invalid`, "img.invalid"]

  beforeAll(async () => {
    hostA = await makeUser("hostA", "organizer")
    hostB = await makeUser("hostB", "organizer")
    admin = await makeUser("admin", "app_admin")
    priya = await makeUser("priya")
    rahul = await makeUser("rahul")
    mia = await makeUser("mia")
    wally = await makeUser("wally")
    olga = await makeUser("olga")
    nina = await makeUser("nina")
    stan = await makeUser("stan")
    pat = await makeUser("pat")
    venueOwner = await makeUser("venueOwner")
    users.push(hostA, hostB, admin, priya, rahul, mia, wally, olga, nina, stan, pat, venueOwner)
    await db.user.update({ where: { id: priya }, data: { name: "Priya Realname", image: "https://img.invalid/p.jpg" } })

    const orgA = await makeOrg("a")
    const orgB = await makeOrg("b")
    const orgV = await makeOrg("venue")
    await db.organisation_members.createMany({
      data: [
        { org_id: orgA, user_id: hostA, role: "owner" },
        { org_id: orgB, user_id: hostB, role: "owner" },
        { org_id: orgV, user_id: venueOwner, role: "owner" },
      ],
    })
    // Org A runs its events at a venue org V claimed a month ago.
    const venue = await db.venues.create({
      data: { name: testId("roster-venue"), city: "Bengaluru", owner_org_id: orgV, claimed_at: new Date(Date.now() - 30 * DAY) },
    })
    venues.push(venue.id)

    // A two-day conference that ended yesterday, and another event of the same
    // organisation the week before.
    past = await event(orgA, hostA, -3 * DAY / HOUR, { days: 2, venueId: venue.id })
    other = await event(orgA, hostA, -7 * DAY / HOUR)

    await rsvp(past, priya)
    await checkIn(past, priya, 95, { day: 1 })
    await checkIn(past, priya, 20, { day: 0 })
    await rsvp(past, rahul)
    await rsvp(past, mia, "maybe")
    await checkIn(past, wally, 40)
    await rsvp(past, nina, "not_going")
    await checkIn(past, stan, 5, { kind: "staff" })
    await checkIn(past, pat, 10, { status: "pending" })

    await rsvp(other, olga)
    await checkIn(other, olga, 30)
    await checkIn(other, priya, 30)

    // Started an hour ago and still running.
    live = await event(orgA, hostA, -1)
    await rsvp(live, rahul)
    await rsvp(live, priya)
    await checkIn(live, priya, 10)

    cancelled = await event(orgA, hostA, -30, { status: "cancelled" })
    await rsvp(cancelled, rahul)

    busy = await event(orgA, hostA, -10 * DAY / HOUR, { venueId: venue.id })
    beforeClaim = await event(orgA, hostA, -40 * DAY / HOUR, { venueId: venue.id })
    for (const label of ["g1", "g2", "g3", "g4", "g5"]) {
      const guest = await makeUser(label)
      users.push(guest)
      await checkIn(busy, guest, 15)
      await checkIn(beforeClaim, guest, 15)
    }
  })

  it("lists that event's people by label, in the order they came through the door", async () => {
    const out = await roster("organizer", hostA, past.id)

    expect(out.rows.map((r) => [r.rsvp, r.status])).toEqual([
      ["going", "came"],
      [null, "came"],
      // Committed and never came, after the event: no-shows, at the bottom.
      ["going", "no_show"],
      ["maybe", "no_show"],
    ])
    for (const row of out.rows) {
      expect(row.id).toMatch(/^attendee-[0-9a-f]{12}$/)
      expect(Object.keys(row).sort()).toEqual(["arrivedAt", "id", "rsvp", "status"])
    }
    // The first arrival of a multi-day stay, not the last.
    expect(out.rows[0].arrivedAt).toBe(new Date(past.start.getTime() + 20 * 60_000).toISOString())
    expect(out).toMatchObject({ came: 2, walkIns: 1, noShows: 2 })
  })

  it("never shows another event's attendees, staff, a pending check-in or a no", async () => {
    const out = await roster("organizer", hostA, past.id)
    const org = await attendeeRoster("organizer", hostA)

    // Olga came to the other event only; she is on the org roster and not here.
    const olgaLabel = org.rows.find((r) => r.attended === 1 && r.noShows === 0 && r.rsvps === 1)!.id
    expect(out.rows.map((r) => r.id)).not.toContain(olgaLabel)
    expect(out.rows).toHaveLength(4)
    // Every label here is the one the org roster and the export use.
    const orgLabels = new Set(org.rows.map((r) => r.id))
    for (const row of out.rows) expect(orgLabels.has(row.id)).toBe(true)

    const wire = JSON.stringify(out)
    for (const secret of [...identityOf(), nina, stan, pat]) expect(wire).not.toContain(secret)
  })

  it("gives nothing for an event outside the caller's organisation", async () => {
    // The page refuses first, on the same resolver; this is the floor under it.
    expect(await seen("organizer", hostB, past.id)).toBeNull()
  })

  it("does not call anybody a no-show before the event is over", async () => {
    const out = await roster("organizer", hostA, live.id)
    expect(out.rows.map((r) => r.status)).toEqual(["came", "expected"])
    expect(out.noShows).toBe(0)
  })

  it("does not call anybody a no-show at a cancelled event", async () => {
    const out = await roster("organizer", hostA, cancelled.id)
    expect(out.rows.map((r) => r.status)).toEqual(["expected"])
    expect(out.noShows).toBe(0)
  })

  it("gives a platform admin the same labels, never the person", async () => {
    const out = await roster("app_admin", admin, past.id)
    expect(out.rows).toHaveLength(4)
    const wire = JSON.stringify(out)
    for (const secret of identityOf()) expect(wire).not.toContain(secret)
  })

  describe("the venue the event is held at", () => {
    it("gets how many came, and no person", async () => {
      const out = await seen("venue_owner", venueOwner, busy.id)
      expect(out).toEqual({ view: "count", came: 5 })
    })

    it("has the count held back under the floor", async () => {
      // Two came to the conference; a count that small can point at somebody.
      expect(await seen("venue_owner", venueOwner, past.id)).toEqual({ view: "count", came: null })
    })

    it("gets nothing for an event before its claim", async () => {
      expect(await seen("venue_owner", venueOwner, beforeClaim.id)).toBeNull()
    })
  })
})
