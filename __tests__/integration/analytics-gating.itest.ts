/*
 * Analytics gating against real Postgres (TQ-DO08: MN-I12, DK-I01; the
 * first-event-free rule; the floors on every new figure).
 *
 * The fixture is an organisation past its free window: its first event that
 * had 8 people checked in ended 120 days ago, past its 90 free days. Its newest event carries distinctive
 * figures — seven people who each stayed exactly 173 minutes (median stay
 * "2h 53m"), eleven people who viewed it in the app — so a test can say
 * whether those figures reached the page:
 *
 *   - free: neither the page's view model nor the element tree the page
 *     returns (everything React would serialise into the RSC payload)
 *     contains them, and the sample is there instead;
 *   - granted Analytics: they are there (the positive control: without it the
 *     "absent" assertions would pass against a page that never computed them).
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
// As getAuth() returns it: the jwt callback always writes signedInAt (lib/session-revocation.ts).
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await mockGetAuth(); return s?.user ? { ...s, user: { signedInAt: Date.now(), ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { randomUUID } from "crypto"

import { analyticsAccess } from "@/lib/analytics-access"
import { analyticsAccessLine } from "@/lib/access-line-copy"
import { billingOrgFor } from "@/lib/billing"
import { grantEntitlement } from "@/lib/entitlements"
import { analyticsPage, eventAnalytics, orgAnalytics } from "@/lib/org-analytics"
import { db as appDb } from "@/lib/db"

import { cleanup, closeDb, db, makeUser, pinOf, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const page = require("@/app/dashboard/analytics/page") as typeof import("@/app/dashboard/analytics/page")
const actions = require("@/lib/billing-actions") as typeof import("@/lib/billing-actions")
/* eslint-enable @typescript-eslint/no-require-imports */

const DAY = 24 * 60 * 60 * 1000
const MIN = 60 * 1000
const now = new Date()
const users: string[] = []
const events: string[] = []
const orgs: string[] = []
let owner = ""
let orgId = ""
let firstEventId = ""
let canaryEventId = ""
let smallEventId = ""
/** The fixture organisation as the pages pass it: its events have no city, so it may buy here (India). */
let INDIA = { orgId: "", mayBuyHere: true }

async function event(label: string, start: Date, hours = 3) {
  const end = new Date(start.getTime() + hours * 60 * MIN)
  const e = await db.events.create({
    data: {
      slug: testId(label),
      title: `Analytics ${label}`,
      description: "fixture",
      start_time: start,
      end_time: end,
      timezone: "UTC",
      status: "published",
      organizer_id: owner,
      organizer_org_id: orgId,
    },
  })
  const occ = await db.event_occurrences.create({
    data: { event_id: e.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end },
  })
  events.push(e.id)
  return { id: e.id, occurrenceId: occ.id, start, end }
}

async function attend(e: { id: string; occurrenceId: string; start: Date }, people: string[], stayMinutes?: number) {
  for (const user_id of people) {
    await db.event_check_ins.create({
      data: { event_id: e.id, occurrence_id: e.occurrenceId, user_id, status: "checked_out", check_in_time: e.start },
    })
    if (stayMinutes !== undefined) {
      await db.presence_sessions.create({
        data: {
          event_id: e.id,
          occurrence_id: e.occurrenceId,
          user_id,
          arrived_at: e.start,
          departed_at: new Date(e.start.getTime() + stayMinutes * MIN),
          departed_source: "user",
        },
      })
    }
  }
}

beforeAll(async () => {
  owner = await makeUser(testId("an-owner"), "organizer")
  users.push(owner)
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("an-org"), status: "verified" } })
  orgId = org.id
  INDIA = { orgId, mayBuyHere: true }
  orgs.push(orgId)
  await db.organisation_members.create({ data: { org_id: orgId, user_id: owner, role: "owner" } })
  const people: string[] = []
  for (let i = 0; i < 9; i++) people.push(await makeUser(testId(`an-p${i}`)))
  users.push(...people)

  // The first event with 8 people checked in, 120 days ago: its 90 free days are over.
  const first = await event("first", new Date(now.getTime() - 120 * DAY))
  firstEventId = first.id
  await attend(first, people.slice(0, 8), 95)

  // A small event: four people, under every floor.
  const small = await event("small", new Date(now.getTime() - 20 * DAY))
  smallEventId = small.id
  await attend(small, people.slice(0, 4), 50)

  // The canary: seven people, each inside exactly 173 minutes; eleven viewers.
  const canary = await event("canary", new Date(now.getTime() - 10 * DAY), 4)
  canaryEventId = canary.id
  await attend(canary, people.slice(2, 9), 173)
  const viewers = [...people, owner, ...(await Promise.all([makeUser(testId("an-v1"))]))]
  users.push(viewers[viewers.length - 1])
  for (const user_id of viewers.slice(0, 11)) {
    await db.product_events.create({
      data: { name: "event_viewed", user_id, entity_kind: "event", entity_id: canary.id, dedupe_key: `itest:${randomUUID()}` },
    })
  }
  for (const user_id of people.slice(0, 9)) {
    await db.event_rsvps.create({ data: { event_id: canary.id, user_id, status: "going" } })
  }
  mockGetAuth.mockResolvedValue({ user: { id: owner, role: "organizer" } })
})

afterAll(async () => {
  await db.entitlements.deleteMany({ where: { subject_id: { in: orgs } } })
  await db.product_events.deleteMany({ where: { entity_id: { in: events } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await db.audit_logs.deleteMany({ where: { resource_id: { in: orgs } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

/** What React would serialise: the element tree's props, all the way down. */
async function renderedTree(params: Record<string, string> = {}): Promise<string> {
  const tree = await page.default({ searchParams: Promise.resolve(params) })
  const seen = new WeakSet<object>()
  return JSON.stringify(tree, (key, value) => {
    // React's own bookkeeping (`_owner`, `_store`, `_debugStack`…), never props.
    if (key.startsWith("_") || typeof value === "function" || typeof value === "symbol") return undefined
    if (value && typeof value === "object") {
      if (seen.has(value)) return undefined
      seen.add(value)
    }
    return value
  })
}

// The owner's own view is not counted (an org member): ten viewers.
const CANARY = ['"p50Min":173', '"medianStayMin":173', '"viewers":10']

describe("the paywall's clock", () => {
  it("has started and ended: the first event with 8 people ended 120 days ago", async () => {
    const access = await analyticsAccess(INDIA, now)
    expect(access).toMatchObject({ org: false, reason: "free", firstFreeEventId: firstEventId, passEventIds: [] })
    expect(access.freeUntil!.getTime()).toBeLessThan(now.getTime())
  })
})

describe("a free organisation's page carries none of its paid figures (MN-I12)", () => {
  it("computes nothing paid: the cross-event views and the locked event are null", async () => {
    const view = await analyticsPage(INDIA, { range: "90d", eventId: canaryEventId }, now)
    expect(view.org).toBeNull()
    expect(view.selected).toMatchObject({ id: canaryEventId, open: false, data: null })
    const json = JSON.stringify(view)
    for (const c of CANARY) expect(json).not.toContain(c)
  })

  it("renders the sample in its place, and nothing of the organisation's", async () => {
    const tree = await renderedTree({ event: canaryEventId })
    expect(tree).toContain("Sample: Rooftop social")
    expect(tree).toContain('"eventId":"SAMPLE_1"')
    for (const c of CANARY) expect(tree).not.toContain(c)
  })

  it("keeps the first event that cleared the floor open, for good", async () => {
    const view = await analyticsPage(INDIA, { range: "90d", eventId: firstEventId }, now)
    expect(view.selected).toMatchObject({ id: firstEventId, open: true })
    expect(view.selected?.data?.stay?.p50Min).toBe(95)
  })
})

describe("the server refuses, not the component (DK-I01)", () => {
  it("returns null before its first query when the access decision says no", async () => {
    const access = await analyticsAccess(INDIA, now)
    // Every database access from here on is recorded: `lib/db` resolves its
    // client from globalThis.prisma on each use.
    await appDb.$queryRaw`SELECT 1`
    const real = globalThis.prisma!
    const touched: string[] = []
    globalThis.prisma = new Proxy(real, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && prop !== "then") touched.push(prop)
        return Reflect.get(target, prop, receiver)
      },
    })
    let org: unknown
    let one: unknown
    try {
      org = await orgAnalytics(access, "all", now)
      one = await eventAnalytics(access, canaryEventId)
    } finally {
      globalThis.prisma = real
    }
    expect({ org, one, touched }).toEqual({ org: null, one: null, touched: [] })
  })

  it("and the same probe does see the database when access is open (the positive control)", async () => {
    const access = { ...(await analyticsAccess(INDIA, now)), org: true }
    await appDb.$queryRaw`SELECT 1`
    const real = globalThis.prisma!
    const touched: string[] = []
    globalThis.prisma = new Proxy(real, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && prop !== "then") touched.push(prop)
        return Reflect.get(target, prop, receiver)
      },
    })
    try {
      expect(await eventAnalytics(access, canaryEventId)).not.toBeNull()
    } finally {
      globalThis.prisma = real
    }
    expect(touched.length).toBeGreaterThan(0)
  })
})

describe("floors on every new figure", () => {
  it("holds back an event of four: no stay, no first-time split, no arrivals", async () => {
    const access = { ...(await analyticsAccess(INDIA, now)), org: true }
    const small = await eventAnalytics(access, smallEventId)
    expect(small).toMatchObject({ people: null, stay: null, firstTimers: null, returning: null })
    expect(small!.arrivals).toEqual([])
  })

  it("shows the canary's figures, each through its floor, once open", async () => {
    const access = { ...(await analyticsAccess(INDIA, now)), org: true }
    const canary = await eventAnalytics(access, canaryEventId)
    expect(canary!.people).toBe(7)
    // Seven stays: the median, never the quartiles (they need eight).
    expect(canary!.stay).toMatchObject({ p50Min: 173, quartiles: null, leftEarlyPct: null, softPct: null })
    // Four of the seven had been before (people 2–5), three had not: both parts are under the floor.
    expect(canary!.returning).toBeNull()
    expect(canary!.firstTimers).toBeNull()
    expect(canary!.funnel.viewers).toBe(10)
    // Seven arrived in one 10-minute bucket at the door.
    expect(canary!.arrivals).toEqual([{ from: expect.any(String), to: expect.any(String), people: 7 }])
  })
})

describe("an Event Pass opens exactly one event (G2)", () => {
  afterAll(async () => {
    await db.entitlements.deleteMany({ where: { subject_id: orgId, product: "event_pass" } })
  })

  it("the canary opens with its pass; the other locked event stays locked; nothing cross-event opens", async () => {
    await db.entitlements.create({
      data: { subject_kind: "org", subject_id: orgId, product: "event_pass", event_id: canaryEventId, source: "razorpay", external_ref: `order_${randomUUID()}`, starts_at: new Date(now.getTime() - 60_000) },
    })
    const view = await analyticsPage(INDIA, { range: "90d", eventId: canaryEventId }, now)
    expect(view.org).toBeNull()
    expect(view.selected).toMatchObject({ id: canaryEventId, open: true })
    expect(view.selected?.data?.stay?.p50Min).toBe(173)
    expect(view.events.find((e) => e.id === smallEventId)?.open).toBe(false)
    const other = await analyticsPage(INDIA, { range: "90d", eventId: smallEventId }, now)
    expect(other.selected).toMatchObject({ id: smallEventId, open: false, data: null })
  })
})

describe("Analytics, granted, opens the same figures (the positive control)", () => {
  afterAll(async () => {
    await db.entitlements.deleteMany({ where: { subject_id: orgId } })
  })

  it("carries the canary once the organisation may see it", async () => {
    await db.$transaction((tx) => grantEntitlement(tx, { subject: { kind: "org", id: orgId }, product: "analytics", months: 6 }))
    const view = await analyticsPage(INDIA, { range: "90d", eventId: canaryEventId }, new Date())
    expect(view.access.reason).toBe("grant")
    expect(view.org?.comparison.find((r) => r.eventId === canaryEventId)?.medianStayMin).toBe(173)
    const tree = await renderedTree({ event: canaryEventId })
    for (const c of CANARY) expect(tree).toContain(c)
  })
})

describe("an Event Pass is not sold for what is already open", () => {
  beforeEach(() => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_itestkey"
    process.env.RAZORPAY_KEY_SECRET = "itest_key_secret_value_24"
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_itest_analytics_gating_0123456789"
  })
  afterEach(() => {
    delete process.env.RAZORPAY_KEY_ID
    delete process.env.RAZORPAY_KEY_SECRET
    delete process.env.RAZORPAY_WEBHOOK_SECRET
  })

  it("refuses the first event that cleared the floor, before calling Razorpay", async () => {
    const fetchSpy = jest.spyOn(global, "fetch")
    try {
      await expect(actions.startEventPassCheckout(firstEventId)).rejects.toThrow(/already open to you/)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

/*
 * SCRUM-1277: where plans are not sold (an event in Toronto, a CA city in the
 * catalogue's migration rows: `mayBuyHere`, lib/plan-market.ts), nothing can
 * be bought, so nothing is locked: every view open, reason "market", no end
 * date, and the read writes nothing to the window. The day the organisation
 * may buy again, the ordinary rule applies from its stored date, which can
 * mean locked at once. The organisation is read the way the page reads it,
 * through billingOrgFor.
 */
describe("where plans are not sold, Analytics stays open (SCRUM-1277)", () => {
  const LINE = "Free while we launch in your city."
  const MARKET = '"access":{"org":true,"reason":"market","freeUntil":null'
  const NOTHING_TO_BUY = /See plans|₹|Open until|\(locked\)|upgrade/i
  const windowOf = async (id: string) =>
    db.$queryRaw<{ analytics_free_until: Date | null; first_free_event_id: string | null }[]>`
      SELECT analytics_free_until, first_free_event_id FROM organisations WHERE id = ${id}::uuid`
  const orgOf = async (user: string) => (await billingOrgFor({ id: user, role: "organizer" }))!

  afterAll(async () => {
    await db.events.updateMany({ where: { id: canaryEventId }, data: { city: null, latitude: null, longitude: null } })
    mockGetAuth.mockResolvedValue({ user: { id: owner, role: "organizer" } })
  })

  it("a Toronto organisation past its window sees its own figures and the launch line; the read writes nothing", async () => {
    await db.events.update({ where: { id: canaryEventId }, data: { city: "Toronto", ...pinOf("Toronto") } })
    const before = await windowOf(orgId)
    expect(before[0].analytics_free_until!.getTime()).toBeLessThan(now.getTime())
    const org = await orgOf(owner)
    expect(org.mayBuyHere).toBe(false)

    expect(await analyticsAccess(org, now)).toMatchObject({ org: true, reason: "market", freeUntil: null, passEventIds: [] })
    const view = await analyticsPage(org, { range: "90d", eventId: canaryEventId }, now)
    expect(view.access).toMatchObject({ org: true, reason: "market", freeUntil: null })
    expect(view.org?.comparison.find((r) => r.eventId === canaryEventId)?.medianStayMin).toBe(173)
    expect(view.events.every((e) => e.open)).toBe(true)
    // The tree carries the view the access line is drawn from; its words are analyticsAccessLine's (and e2e reads them).
    expect(analyticsAccessLine(view.access, String).headline).toBe(LINE)
    const tree = await renderedTree({ event: canaryEventId })
    for (const c of CANARY) expect(tree).toContain(c)
    expect(tree).toContain(MARKET)
    expect(tree).toContain('"pass":null')
    expect(tree).not.toMatch(NOTHING_TO_BUY)
    expect(tree).not.toContain("Sample: Rooftop social")

    expect(await windowOf(orgId)).toEqual(before)
  })

  it("moved to Bengaluru, the same organisation is locked at once from its stored date, and the read writes nothing", async () => {
    await db.events.update({ where: { id: canaryEventId }, data: { city: "Bengaluru", ...pinOf("Bengaluru") } })
    const before = await windowOf(orgId)
    const org = await orgOf(owner)
    expect(org.mayBuyHere).toBe(true)

    expect(await analyticsAccess(org, now)).toMatchObject({ org: false, reason: "free", freeUntil: before[0].analytics_free_until })
    const tree = await renderedTree({ event: canaryEventId })
    for (const c of CANARY) expect(tree).not.toContain(c)
    expect(tree).toContain("Sample: Rooftop social")
    expect(tree).not.toContain(MARKET)

    expect(await windowOf(orgId)).toEqual(before)
  })

  it("an Indian organisation that adds a draft Toronto night is still locked: a draft is no market", async () => {
    await db.events.update({ where: { id: canaryEventId }, data: { city: "Toronto", ...pinOf("Toronto"), status: "draft" } })
    try {
      const org = await orgOf(owner)
      expect(org.mayBuyHere).toBe(true)
      expect(await analyticsAccess(org, now)).toMatchObject({ org: false, reason: "free" })
    } finally {
      await db.events.update({ where: { id: canaryEventId }, data: { city: null, latitude: null, longitude: null, status: "published" } })
    }
  })

  it("a Toronto organisation with no window written keeps none: its reads write nothing; in India it is found and locks at once", async () => {
    const caOwner = await makeUser(testId("an-ca-owner"), "organizer")
    users.push(caOwner)
    const caOrg = (await db.organisations.create({ data: { kind: "company", display_name: testId("an-ca-org"), status: "verified" } })).id
    orgs.push(caOrg)
    await db.organisation_members.create({ data: { org_id: caOrg, user_id: caOwner, role: "owner" } })
    const start = new Date(now.getTime() - 120 * DAY)
    const night = await db.events.create({
      data: {
        slug: testId("an-ca-night"),
        title: "Analytics Toronto night",
        description: "fixture",
        start_time: start,
        end_time: new Date(start.getTime() + 3 * 60 * MIN),
        timezone: "America/Toronto",
        status: "published",
        city: "Toronto",
        ...pinOf("Toronto"),
        organizer_id: caOwner,
        organizer_org_id: caOrg,
      },
    })
    events.push(night.id)
    const occ = await db.event_occurrences.create({
      data: { event_id: night.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: night.end_time },
    })
    for (let i = 0; i < 8; i++) {
      const user_id = await makeUser(testId(`an-ca-p${i}`))
      users.push(user_id)
      await db.event_check_ins.create({ data: { event_id: night.id, occurrence_id: occ.id, user_id, status: "checked_out", check_in_time: start } })
    }
    mockGetAuth.mockResolvedValue({ user: { id: caOwner, role: "organizer" } })

    const org = await orgOf(caOwner)
    expect(org.mayBuyHere).toBe(false)
    expect(await analyticsAccess(org, now)).toMatchObject({ org: true, reason: "market", freeUntil: null, firstFreeEventId: null })
    expect(await renderedTree()).toContain(MARKET)
    expect(await windowOf(caOrg)).toEqual([{ analytics_free_until: null, first_free_event_id: null }])

    await db.events.update({ where: { id: night.id }, data: { city: "Bengaluru", ...pinOf("Bengaluru") } })
    const india = await orgOf(caOwner)
    expect(await analyticsAccess(india, now)).toMatchObject({ org: false, reason: "free", firstFreeEventId: night.id })
    const [written] = await windowOf(caOrg)
    expect(written.analytics_free_until!.getTime()).toBe(night.end_time.getTime() + 90 * DAY)
  })
})
