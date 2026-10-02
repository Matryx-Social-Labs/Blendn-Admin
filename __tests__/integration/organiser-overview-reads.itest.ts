import type { DashboardRole } from "@/lib/dashboard-types"

let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
const as = (role: DashboardRole, id: string) => {
  session = { user: { id, role } }
}

import { getDashboardOverview } from "@/app/dashboard/actions"
import EventsPage from "@/app/dashboard/events/page"
import { visibleEventsWhere } from "@/lib/event-visibility"
import { setupFactsFor } from "@/lib/organiser-overview"
import { cleanup, closeDb, db, makeUser, occurrenceOf, testId } from "./helpers"

/*
 * The reads the organiser overview and the Events list gained in step 15, on
 * real rows: the setup checklist's facts at their edges, the Events rows'
 * host and going counts, and the live banner and latest feedback reached
 * through the organisation — a colleague who created nothing — never by a
 * stranger.
 */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const HOUR = 3_600_000
const DAY = 24 * HOUR

async function org(kind: "company" | "individual" = "company") {
  const o = await db.organisations.create({ data: { display_name: `Org ${testId("o")}`, kind, status: "verified" } })
  orgs.push(o.id)
  return o.id
}

async function member(orgId: string, label: string, at = new Date()) {
  const id = await makeUser(label, "organizer")
  users.push(id)
  await db.organisation_members.create({ data: { org_id: orgId, user_id: id, role: "owner", created_at: at } })
  return id
}

async function event(
  creator: string,
  orgId: string | null,
  opts: { start: Date; hours?: number; status?: "published" | "draft" | "cancelled" | "completed"; capacity?: number | null; curated?: boolean }
) {
  const e = await db.events.create({
    data: {
      slug: testId("ovr"),
      title: `Night ${testId("t")}`,
      description: "integration fixture",
      start_time: opts.start,
      end_time: new Date(opts.start.getTime() + (opts.hours ?? 3) * HOUR),
      timezone: "UTC",
      status: opts.status ?? "published",
      organizer_id: creator,
      organizer_org_id: orgId,
      max_capacity: opts.capacity ?? null,
      curated_at: opts.curated ? new Date() : null,
    },
  })
  await db.event_occurrences.create({
    data: { event_id: e.id, occurs_on: new Date(e.start_time.toISOString().slice(0, 10)), start_time: e.start_time, end_time: e.end_time },
  })
  events.push(e.id)
  return e.id
}

const facts = async (userId: string) => setupFactsFor(userId, await visibleEventsWhere({ id: userId, role: "organizer" }))

afterAll(async () => {
  await db.organisation_invites.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisation_domains.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

describe("Getting set up, at its edges", () => {
  it("ticks the domain step when any domain is verified, whichever was claimed first", async () => {
    const o = await org()
    const owner = await member(o, "dom")
    await db.organisation_domains.create({ data: { org_id: o, domain: `${testId("a").replace(/_/g, "-")}.example`, verification_token: "t", created_at: new Date(Date.now() - DAY) } })
    const later = `${testId("b").replace(/_/g, "-")}.example`
    await db.organisation_domains.create({ data: { org_id: o, domain: later, verification_token: "t", verified_at: new Date() } })
    expect((await facts(owner)).org?.domain).toEqual({ name: later, verified: true })
  })

  it("does not count a revoked invite, or a suspended or deleted member, as a colleague", async () => {
    const o = await org()
    const owner = await member(o, "alone")
    await db.organisation_invites.create({
      data: { org_id: o, email: "gone@itest.invalid", token_hash: testId("h"), expires_at: new Date(Date.now() + DAY), invited_by: owner, revoked_at: new Date() },
    })
    const suspended = await member(o, "susp")
    await db.user.update({ where: { id: suspended }, data: { suspended_at: new Date() } })
    const deleted = await member(o, "del")
    await db.user.update({ where: { id: deleted }, data: { deletedAt: new Date() } })
    expect((await facts(owner)).org?.colleagues).toBe(false)
  })

  it("counts a colleague who joined without an invite, and stops when they leave", async () => {
    const o = await org()
    const owner = await member(o, "host")
    const joined = await member(o, "joined")
    expect((await facts(owner)).org?.colleagues).toBe(true)
    await db.organisation_members.deleteMany({ where: { org_id: o, user_id: joined } })
    expect((await facts(owner)).org?.colleagues).toBe(false)
  })

  it("reads the home organisation — the oldest membership — and its kind", async () => {
    const [older, newer] = [await org("individual"), await org("company")]
    const person = await makeUser("two", "organizer")
    users.push(person)
    await db.organisation_members.createMany({
      data: [
        { org_id: newer, user_id: person, role: "owner", created_at: new Date() },
        { org_id: older, user_id: person, role: "owner", created_at: new Date(Date.now() - DAY) },
      ],
    })
    const home = await db.organisations.findUniqueOrThrow({ where: { id: older } })
    expect((await facts(person)).org).toMatchObject({ name: home.display_name, kind: "individual" })
  })

  it("counts a completed event as published, and a cancelled-only organisation as not", async () => {
    const cancelled = await org()
    const a = await member(cancelled, "canc")
    await event(a, cancelled, { start: new Date(Date.now() - 2 * DAY), status: "cancelled" })
    expect((await facts(a)).published).toBe(false)

    const completed = await org()
    const b = await member(completed, "comp")
    await event(b, completed, { start: new Date(Date.now() - 2 * DAY), status: "completed" })
    expect((await facts(b)).published).toBe(true)
  })
})

describe("the Events list's rows", () => {
  let hostOrg: string
  let creator: string
  let ahead: string
  let listing: string
  let admin: string

  beforeAll(async () => {
    hostOrg = await org()
    creator = await member(hostOrg, "rows")
    admin = await makeUser("rows_admin", "app_admin")
    users.push(admin)
    ahead = await event(creator, hostOrg, { start: new Date(Date.now() + 3 * DAY), capacity: 10 })
    // A listing an admin curated: its organizer_id is the founder.
    listing = await event(admin, null, { start: new Date(Date.now() + 4 * DAY), curated: true })
    const people = await Promise.all(["g1", "g2", "m1", "n1"].map((l) => makeUser(`rows_${l}`)))
    users.push(...people)
    await db.event_rsvps.createMany({
      data: [
        { event_id: ahead, user_id: people[0], status: "going" },
        { event_id: ahead, user_id: people[1], status: "going" },
        { event_id: ahead, user_id: people[2], status: "maybe" },
        { event_id: ahead, user_id: people[3], status: "not_going" },
      ],
    })
  })

  type Row = { id: string; host: string | null; going: number | null }
  const rows = async () => ((await EventsPage()) as { props: { rows: Row[] } }).props.rows

  it("counts going RSVPs only — not maybe, not a decline — on the list and in Coming up", async () => {
    as("organizer", creator)
    expect((await rows()).find((r) => r.id === ahead)?.going).toBe(2)
    const overview = await getDashboardOverview()
    if (overview.role !== "organizer") throw new Error("wrong overview role")
    expect(overview.comingUp.find((e) => e.id === ahead)?.going).toBe(2)
    // And the hero's fill is going over capacity, the same count: 2 of 10.
    expect(overview.nextEvent).toMatchObject({ id: ahead, going: 2, maybe: 1, fillPct: 20 })
  })

  it("gives an organiser no host name on any row", async () => {
    as("organizer", creator)
    const mine = await rows()
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((r) => r.host === null)).toBe(true)
  })

  it("names the host for an admin, but never the founder behind an unclaimed listing", async () => {
    as("app_admin", admin)
    const all = await rows()
    const creatorName = (await db.user.findUniqueOrThrow({ where: { id: creator } })).name
    expect(all.find((r) => r.id === ahead)?.host).toBe(creatorName)
    expect(all.find((r) => r.id === listing)?.host).toBeNull()
  })
})

describe("the live banner and the latest feedback come through the organisation", () => {
  let colleague: string
  let stranger: string
  let live: string
  let rated: string

  beforeAll(async () => {
    const o = await org()
    const creator = await member(o, "lb_creator")
    colleague = await member(o, "lb_colleague")
    stranger = await makeUser("lb_stranger", "organizer")
    users.push(stranger)
    live = await event(creator, o, { start: new Date(Date.now() - HOUR), hours: 4 })
    rated = await event(creator, o, { start: new Date(Date.now() - 3 * DAY) })
    const raters = await Promise.all([1, 2, 3, 4, 5].map((n) => makeUser(`lb_r${n}`)))
    users.push(...raters)
    await db.event_ratings.createMany({ data: raters.map((user_id, i) => ({ event_id: rated, user_id, rating: [5, 4, 4, 3, 5][i] })) })
    const inside = await makeUser("lb_in")
    users.push(inside)
    await db.event_check_ins.create({
      data: { event_id: live, occurrence_id: await occurrenceOf(live), user_id: inside, status: "checked_in", check_in_time: new Date() },
    })
  })

  it("shows a colleague who created nothing the organisation's live night and its latest rated one", async () => {
    as("organizer", colleague)
    const overview = await getDashboardOverview()
    if (overview.role !== "organizer") throw new Error("wrong overview role")
    expect(overview.live?.id).toBe(live)
    expect(overview.live?.checkedIn).toBe(1)
    expect(overview.latestFeedback?.eventId).toBe(rated)
  })

  it("shows an organiser outside the organisation neither", async () => {
    as("organizer", stranger)
    const overview = await getDashboardOverview()
    if (overview.role !== "organizer") throw new Error("wrong overview role")
    expect(overview.live).toBeNull()
    expect(overview.latestFeedback).toBeNull()
  })
})
