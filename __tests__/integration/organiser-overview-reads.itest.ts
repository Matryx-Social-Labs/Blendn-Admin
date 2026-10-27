import type { DashboardRole } from "@/lib/dashboard-types"

let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await session; return s?.user ? { ...s, user: { signedInAt: 0, ...s.user } } : s } }))
const as = (role: DashboardRole, id: string) => {
  session = { user: { id, role } }
}

jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { renderToStaticMarkup } from "react-dom/server"

import { getDashboardOverview } from "@/app/dashboard/actions"
import ChatroomsPage from "@/app/dashboard/chatrooms/page"
import EventsPage from "@/app/dashboard/events/page"
import { visibleEventsWhere } from "@/lib/event-visibility"
import { setupFactsFor } from "@/lib/organiser-overview"
import { getUsers } from "@/app/dashboard/users/actions"
import { sqlCounter } from "./sql-count"
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
  let claimedListing: string
  let liveNight: string
  let admin: string

  beforeAll(async () => {
    hostOrg = await org()
    creator = await member(hostOrg, "rows")
    admin = await makeUser("rows_admin", "app_admin")
    users.push(admin)
    ahead = await event(creator, hostOrg, { start: new Date(Date.now() + 3 * DAY), capacity: 10 })
    // A listing an admin curated: its organizer_id is the founder.
    listing = await event(admin, null, { start: new Date(Date.now() + 4 * DAY), curated: true })
    // The same kind of listing after a claim was approved: the organisation owns it, `organizer_id` is still the founder (SCRUM-612).
    claimedListing = await event(admin, hostOrg, { start: new Date(Date.now() + 5 * DAY), curated: true })
    await db.events.update({ where: { id: claimedListing }, data: { claimed_at: new Date() } })
    // Running now, so it has a room on the Chatrooms screen.
    liveNight = await event(creator, hostOrg, { start: new Date(Date.now() - HOUR), hours: 4 })
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

  it("names the owning organisation as the host for an admin, never the founder behind a listing, claimed or not (SCRUM-612)", async () => {
    as("app_admin", admin)
    const all = await rows()
    const hostName = (await db.organisations.findUniqueOrThrow({ where: { id: hostOrg } })).display_name
    const founderName = (await db.user.findUniqueOrThrow({ where: { id: admin } })).name
    // An organisation's own event: the organisation, not the member who made it.
    expect(all.find((r) => r.id === ahead)?.host).toBe(hostName)
    // A listing nobody has claimed says nobody, and one that was claimed says who now owns it.
    expect(all.find((r) => r.id === listing)?.host).toBeNull()
    expect(all.find((r) => r.id === claimedListing)?.host).toBe(hostName)
    expect(all.map((r) => r.host)).not.toContain(founderName)
  })

  it("names the organisation, not the member who made the event, beside a room on an admin's Chatrooms", async () => {
    as("app_admin", admin)
    const hostName = (await db.organisations.findUniqueOrThrow({ where: { id: hostOrg } })).display_name
    const memberName = (await db.user.findUniqueOrThrow({ where: { id: creator } })).name
    const html = renderToStaticMarkup(await ChatroomsPage())
    const night = (await db.events.findUniqueOrThrow({ where: { id: liveNight } })).title
    // The room's card carries its title and, for an admin, " · <host>".
    const card = html.slice(html.indexOf(night))
    expect(card.slice(0, 1500)).toContain(hostName)
    expect(html).not.toContain(memberName as string)
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

describe("the dashboard counts what is on the page, not the table", () => {
  /*
   * A relation `_count` is a LEFT JOIN over a GROUP BY of the whole child table
   * (`_aggr_count_*`), which Postgres cannot narrow to the page: the Events list's
   * going counts, a live room's messages and the Users table's tallies each read
   * every RSVP, message, check-in and favourite on the platform to answer for a
   * handful of rows.
   */
  const WHOLE_TABLE = /_aggr_count_\w+" FROM "public"\."(chat_messages|event_rsvps|event_check_ins|event_favorites|event_ratings)"/

  let host: string
  let live: string
  let admin: string

  beforeAll(async () => {
    const o = await org()
    host = await member(o, "wt_host")
    admin = await makeUser("wt_admin", "app_admin")
    users.push(admin)
    live = await event(host, o, { start: new Date(Date.now() - HOUR), hours: 4 })
    const group = await db.chat_groups.create({ data: { event_id: live, name: "room" }, select: { id: true } })
    await db.chat_messages.createMany({ data: ["a", "b", "c"].map((content) => ({ chat_group_id: group.id, user_id: host, content })) })
    await db.event_rsvps.create({ data: { event_id: live, user_id: admin, status: "going" } })
  })

  afterAll(async () => {
    await db.chat_messages.deleteMany({ where: { chat_group: { event_id: live } } })
    await db.chat_groups.deleteMany({ where: { event_id: live } })
    await db.event_rsvps.deleteMany({ where: { event_id: live } })
  })

  it("the live banner's message count is that room's", async () => {
    as("organizer", host)
    const overview = await getDashboardOverview()
    if (overview.role !== "organizer") throw new Error("wrong overview role")
    expect(overview.live?.messages).toBe(3)
  })

  it.each([
    ["the organiser's overview", async () => { as("organizer", host); await getDashboardOverview() }],
    ["the Events list", async () => { as("organizer", host); await EventsPage() }],
    ["the Chatrooms screen", async () => { as("app_admin", admin); renderToStaticMarkup(await ChatroomsPage()) }],
    ["the Users table", async () => { as("app_admin", admin); await getUsers() }],
  ])("%s joins no whole-table count", async (_name, run) => {
    const counter = sqlCounter()
    try {
      const { sql } = await counter.during(run)
      expect(sql.filter((statement) => WHOLE_TABLE.test(statement))).toEqual([])
    } finally {
      await counter.stop()
    }
  })

  it("the Users table still tallies each person's events, check-ins and favourites", async () => {
    as("app_admin", admin)
    const event_id = live
    await db.event_favorites.create({ data: { event_id, user_id: host } })
    const { users: listed } = await getUsers(host)
    const row = listed.find((u) => u.id === host)
    expect(row?._count).toEqual({ organized_events: expect.any(Number), event_check_ins: 0, event_favorites: 1 })
    expect(row?._count.organized_events).toBeGreaterThanOrEqual(1)
    await db.event_favorites.deleteMany({ where: { event_id } })
  })
})
