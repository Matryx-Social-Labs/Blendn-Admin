/*
 * The paid figures, against real Postgres, with literal dates and counts
 * (review G1, G3, G6, G9; C15–C20). Each organisation here is its own world.
 *
 *   G1  cohorts: the hero on the DEFAULT range (90 days) is a number, not
 *       "held back"; the cohort row's counts; the IST month; a person whose
 *       earlier attendance was at ANOTHER organisation is a first-timer here.
 *   G3  scoping: an organisation's page never carries another's canary, even
 *       for a person who belongs to both.
 *   G6  the first event that clears the floor: one below the floor first, an
 *       in-progress one, another org's; the window is end + 30 days exactly,
 *       written once, and a soft-deleted event cannot restart it.
 *   G9  floors: the complement rule (20/18, 12/11, 12 = 7 + 5), quartiles at
 *       7 vs 8 stays, merged arrival bars, the funnel's floors and filters.
 */
import { randomUUID } from "crypto"

import { analyticsAccess } from "@/lib/analytics-access"
import { analyticsPage, eventAnalytics, orgAnalytics } from "@/lib/org-analytics"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

const MIN = 60_000
const DAY = 86_400_000
/** Thirty days in milliseconds, written out. */
const THIRTY_DAYS_MS = 2_592_000_000
const NOW = new Date("2026-10-03T12:00:00Z")

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
let host = ""

async function org(label: string) {
  const o = await db.organisations.create({ data: { kind: "company", display_name: testId(label), status: "verified" } })
  orgs.push(o.id)
  return o.id
}

async function people(n: number, label: string) {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(await makeUser(testId(`${label}${i}`)))
  users.push(...out)
  return out
}

async function event(orgId: string, start: Date, hours = 3, title = testId("ev")) {
  const end = new Date(start.getTime() + hours * 60 * MIN)
  const e = await db.events.create({
    data: { slug: testId("af"), title, description: "fixture", start_time: start, end_time: end, timezone: "UTC", status: "published", organizer_id: host, organizer_org_id: orgId },
  })
  const occ = await db.event_occurrences.create({ data: { event_id: e.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end } })
  events.push(e.id)
  return { id: e.id, occ: occ.id, start, end }
}

async function attend(e: { id: string; occ: string; start: Date }, who: string[], opts: { stay?: number[]; arriveAt?: number[] } = {}) {
  for (let i = 0; i < who.length; i++) {
    await db.event_check_ins.create({ data: { event_id: e.id, occurrence_id: e.occ, user_id: who[i], status: "checked_in", check_in_time: e.start } })
    if (opts.stay) {
      const arrived = new Date(e.start.getTime() + (opts.arriveAt?.[i] ?? 0) * MIN)
      await db.presence_sessions.create({
        data: { event_id: e.id, occurrence_id: e.occ, user_id: who[i], arrived_at: arrived, departed_at: new Date(arrived.getTime() + opts.stay[i] * MIN), departed_source: "user" },
      })
    }
  }
}

const openAccess = async (orgId: string) => ({ ...(await analyticsAccess(orgId, NOW)), org: true })

beforeAll(async () => {
  host = await makeUser(testId("af-host"), "organizer")
  users.push(host)
})

afterAll(async () => {
  await db.product_events.deleteMany({ where: { entity_id: { in: events } } })
  await db.event_rsvps.deleteMany({ where: { event_id: { in: events } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await db.entitlements.deleteMany({ where: { subject_id: { in: orgs } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

describe("G1 cohorts and the hero", () => {
  let orgX = ""
  let canaryEvent = ""

  beforeAll(async () => {
    orgX = await org("af-cohort")
    const orgY = await org("af-other")
    const ten = await people(10, "c")
    // A cohort of ten, 150 days before NOW: five come back 20 days later, five never.
    const first = await event(orgX, new Date(NOW.getTime() - 150 * DAY))
    await attend(first, ten)
    const second = await event(orgX, new Date(NOW.getTime() - 130 * DAY))
    await attend(second, ten.slice(0, 5))
    // A closed cohort whose 90-day cell is HELD BACK (one of six came back):
    // the hero must not pool it, or hero minus the shown rows names that one.
    const six = await people(6, "h")
    const march = await event(orgX, new Date(NOW.getTime() - 200 * DAY))
    await attend(march, six)
    const marchAgain = await event(orgX, new Date(NOW.getTime() - 190 * DAY))
    await attend(marchAgain, six.slice(0, 1))
    // An IST month boundary: 20:00 UTC on 31 Aug is 01:30 IST on 1 Sep.
    const boundary = await event(orgX, new Date("2026-08-31T20:00:00Z"))
    await attend(boundary, await people(10, "b"))
    // Five new people at a canary event 10 days ago (23 Sep), one of whom
    // went to ANOTHER organisation's event first; and five returning.
    const fresh = await people(5, "n")
    const elsewhere = await event(orgY, new Date(NOW.getTime() - 300 * DAY))
    await attend(elsewhere, [fresh[0]])
    const canary = await event(orgX, new Date(NOW.getTime() - 10 * DAY))
    canaryEvent = canary.id
    await attend(canary, [...ten.slice(0, 5), ...fresh])
  })

  it("on the default range the hero is a number: 50% of 10, from the one closed cohort shown", async () => {
    const view = await orgAnalytics(await openAccess(orgX), "90d", NOW)
    expect(view?.backWithin90).toEqual({ pct: 50, cohort: 10, cohorts: 1 })
  })

  it("never pools a held-back cohort into the hero", async () => {
    const view = await orgAnalytics(await openAccess(orgX), "all", NOW)
    expect(view!.cohorts.find((c) => c.month === "2026-03")).toEqual({ month: "2026-03", people: 6, back: { d30: null, d60: null, d90: null } })
    expect(view!.backWithin90).toEqual({ pct: 50, cohort: 10, cohorts: 1 })
  })

  it("the cohort row's numbers: 10 people, 50% back at 30, 60 and 90 days", async () => {
    const view = await orgAnalytics(await openAccess(orgX), "all", NOW)
    const may = view!.cohorts.find((c) => c.month === "2026-05")
    expect(may).toEqual({ month: "2026-05", people: 10, back: { d30: 50, d60: 50, d90: 50 } })
  })

  it("files a 20:00 UTC 31 August first event under September (IST), and the 90-day window there is still open", async () => {
    const view = await orgAnalytics(await openAccess(orgX), "all", NOW)
    const sep = view!.cohorts.find((c) => c.month === "2026-09")
    // The ten from 31 Aug (IST 1 Sep) and the five new on 23 Sep.
    expect(sep?.people).toBe(15)
    expect(view!.cohorts.find((c) => c.month === "2026-08")).toBeUndefined()
    expect(sep?.back.d90).toBe("open")
  })

  it("a range shows whole IST months only", async () => {
    const view = await orgAnalytics(await openAccess(orgX), "30d", NOW)
    // 30 days before 3 Oct is 3 Sep: the whole of September is shown, never a part of it.
    expect(view!.cohorts.map((c) => c.month)).toEqual(["2026-09"])
  })

  it("someone who came to another organisation's event first is a first-timer here", async () => {
    const view = await orgAnalytics(await openAccess(orgX), "all", NOW)
    const row = view!.comparison.find((r) => r.eventId === canaryEvent)
    // Five first-timers of ten: shown; five returning: the complement also reaches the floor.
    expect(row?.firstTimePct).toBe(50)
  })
})

describe("G3 scoping", () => {
  it("an organisation's page carries none of another's figures, even for a member of both", async () => {
    const orgA = await org("af-scope-a")
    const orgB = await org("af-scope-b")
    const both = await makeUser(testId("af-both"), "organizer")
    users.push(both)
    await db.organisation_members.createMany({ data: [{ org_id: orgA, user_id: both, role: "owner" }, { org_id: orgB, user_id: both, role: "owner" }] })
    const crowd = await people(9, "s")
    const canary = await event(orgB, new Date(NOW.getTime() - 5 * DAY), 4, "Canary of B 4417")
    await attend(canary, crowd, { stay: crowd.map(() => 211) })
    const view = await analyticsPage(orgA, { range: "all", eventId: canary.id }, NOW)
    const json = JSON.stringify(view)
    expect(json).not.toContain(canary.id)
    expect(json).not.toContain("Canary of B 4417")
    expect(json).not.toContain('"p50Min":211')
    expect(view.selected).toBeNull()
  })
})

describe("G6 the first event that clears the floor", () => {
  it("skips one below the floor, another org's and one in progress; the window is the end + 30 days, written once", async () => {
    const orgF = await org("af-first")
    const orgOther = await org("af-first-other")
    const crowd = await people(6, "f")
    const small = await event(orgF, new Date("2026-06-01T10:00:00Z"))
    await attend(small, crowd.slice(0, 4))
    const others = await event(orgOther, new Date("2026-06-15T10:00:00Z"))
    await attend(others, crowd)
    const qualifying = await event(orgF, new Date("2026-07-01T10:00:00Z"), 3)
    await attend(qualifying, crowd.slice(0, 5))
    const running = await event(orgF, new Date(NOW.getTime() - 60 * MIN), 4)
    await attend(running, crowd)

    const access = await analyticsAccess(orgF, NOW)
    expect(access.firstFreeEventId).toBe(qualifying.id)
    expect(access.freeUntil?.getTime()).toBe(qualifying.end.getTime() + THIRTY_DAYS_MS)
    const row = await db.organisations.findUniqueOrThrow({ where: { id: orgF }, select: { analytics_free_until: true, first_free_event_id: true } })
    expect(row).toEqual({ analytics_free_until: new Date(qualifying.end.getTime() + THIRTY_DAYS_MS), first_free_event_id: qualifying.id })

    // Soft-deleting the event that started the clock does not restart it.
    await db.events.update({ where: { id: qualifying.id }, data: { deleted_at: NOW } })
    const later = await event(orgF, new Date("2026-09-01T10:00:00Z"))
    await attend(later, crowd)
    const again = await analyticsAccess(orgF, NOW)
    expect(again.firstFreeEventId).toBe(qualifying.id)
    expect(again.freeUntil?.getTime()).toBe(qualifying.end.getTime() + THIRTY_DAYS_MS)
  })

  it("is open at one millisecond before the window's end and locked at it", async () => {
    const orgB = await org("af-boundary")
    const crowd = await people(5, "w")
    const e = await event(orgB, new Date("2026-08-01T10:00:00Z"), 2)
    await attend(e, crowd)
    const end = e.end.getTime() + THIRTY_DAYS_MS
    expect((await analyticsAccess(orgB, new Date(end - 1))).org).toBe(true)
    expect((await analyticsAccess(orgB, new Date(end))).org).toBe(false)
  })
})

describe("G9 floors", () => {
  let orgF = ""
  beforeAll(async () => {
    orgF = await org("af-floors")
  })

  async function eventWith(firstTimers: number, returning: number, opts: { stay?: number[]; arriveAt?: number[] } = {}) {
    const earlier = await people(returning, "r")
    const before = await event(orgF, new Date(NOW.getTime() - 40 * DAY))
    await attend(before, earlier)
    const fresh = await people(firstTimers, "n")
    const e = await event(orgF, new Date(NOW.getTime() - 3 * DAY), 6)
    await attend(e, [...earlier, ...fresh], opts)
    return e
  }

  it.each([
    [18, 2, null, null],
    [11, 1, null, null],
    [7, 5, 7, 5],
  ])("%i first-timers and %i returning → %p and %p", async (first, back, wantFirst, wantBack) => {
    const e = await eventWith(first, back)
    const got = await eventAnalytics(await openAccess(orgF), e.id)
    expect({ firstTimers: got!.firstTimers, returning: got!.returning }).toEqual({ firstTimers: wantFirst, returning: wantBack })
  })

  it("quartiles of stay need 8 stays: shown at 8, not at 7 (the median at both)", async () => {
    const seven = await eventWith(7, 0, { stay: [60, 70, 80, 90, 100, 110, 120] })
    const at7 = await eventAnalytics(await openAccess(orgF), seven.id)
    expect(at7!.stay).toMatchObject({ p50Min: 90, quartiles: null })
    const eight = await eventWith(8, 0, { stay: [60, 70, 80, 90, 100, 110, 120, 130] })
    const at8 = await eventAnalytics(await openAccess(orgF), eight.id)
    expect(at8!.stay?.quartiles).toEqual({ p25Min: 78, p75Min: 113 })
  })

  it("arrival bars: a quiet 10 minutes merges into its neighbour, and the bars add up", async () => {
    // 6 at +0, 2 at +10, 4 at +20, 9 at +30 → bars of 6, 6 (+10..+30), 9.
    const arrive = [...Array(6).fill(0), ...Array(2).fill(10), ...Array(4).fill(20), ...Array(9).fill(30)]
    const e = await eventWith(21, 0, { stay: arrive.map(() => 60), arriveAt: arrive })
    const got = await eventAnalytics(await openAccess(orgF), e.id)
    expect(got!.arrivals.map((b) => b.people)).toEqual([6, 6, 9])
    expect(got!.arrivals[1].to).toBe(new Date(e.start.getTime() + 30 * MIN).toISOString())
  })

  it("the funnel: under 5 viewers is held; 11 of 12 is held; members and views after the RSVP don't count", async () => {
    const e = await eventWith(5, 0)
    const viewers = await people(12, "v")
    const member = await makeUser(testId("af-member"), "organizer")
    users.push(member)
    await db.organisation_members.create({ data: { org_id: orgF, user_id: member, role: "staff" } })
    const view = (u: string, at: Date) =>
      db.product_events.create({ data: { name: "event_viewed", user_id: u, entity_kind: "event", entity_id: e.id, dedupe_key: `af:${randomUUID()}`, occurred_at: at } })
    const early = new Date(NOW.getTime() - 10 * DAY)
    const late = new Date(NOW.getTime() - DAY)
    for (const u of viewers.slice(0, 4)) await view(u, early)
    await view(member, early)
    let got = await eventAnalytics(await openAccess(orgF), e.id)
    expect(got!.funnel).toEqual({ viewers: null, viewersWhoRsvpd: null, conversionPct: null })

    for (const u of viewers.slice(4)) await view(u, early)
    // 7 RSVP after viewing, 3 RSVP BEFORE their only view, 2 never.
    for (const u of viewers.slice(0, 7)) await db.event_rsvps.create({ data: { event_id: e.id, user_id: u, status: "going", created_at: new Date(NOW.getTime() - 5 * DAY) } })
    for (const u of viewers.slice(7, 10)) {
      await db.product_events.deleteMany({ where: { user_id: u, entity_id: e.id } })
      await view(u, late)
      await db.event_rsvps.create({ data: { event_id: e.id, user_id: u, status: "going", created_at: new Date(NOW.getTime() - 5 * DAY) } })
    }
    got = await eventAnalytics(await openAccess(orgF), e.id)
    // 12 viewers (the member excluded), 7 converted (the 3 who viewed after are not), 5 did not.
    expect(got!.funnel).toEqual({ viewers: 12, viewersWhoRsvpd: 7, conversionPct: 58 })

    // Two more RSVP after viewing first: 9 of 12, and the rest is 3 → held back.
    for (const u of viewers.slice(10, 12)) await db.event_rsvps.create({ data: { event_id: e.id, user_id: u, status: "going", created_at: NOW } })
    got = await eventAnalytics(await openAccess(orgF), e.id)
    expect(got!.funnel).toEqual({ viewers: 12, viewersWhoRsvpd: null, conversionPct: null })
  })
})
