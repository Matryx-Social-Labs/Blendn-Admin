/*
 * Analytics gating against real Postgres (TQ-DO08: MN-I12, DK-I01; the
 * first-event-free rule; the floors on every new figure).
 *
 * The fixture is an organisation past its free window: its first event that
 * cleared the floor ended 60 days ago. Its newest event carries distinctive
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
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { randomUUID } from "crypto"

import { analyticsAccess } from "@/lib/analytics-access"
import { grantEntitlement } from "@/lib/entitlements"
import { analyticsPage, eventAnalytics, orgAnalytics } from "@/lib/org-analytics"
import { db as appDb } from "@/lib/db"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

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
      data: { event_id: e.id, occurrence_id: e.occurrenceId, user_id, status: "checked_in", check_in_time: e.start },
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
  orgs.push(orgId)
  await db.organisation_members.create({ data: { org_id: orgId, user_id: owner, role: "owner" } })
  const people: string[] = []
  for (let i = 0; i < 9; i++) people.push(await makeUser(testId(`an-p${i}`)))
  users.push(...people)

  // The first event to clear the floor: six people, 60 days ago.
  const first = await event("first", new Date(now.getTime() - 60 * DAY))
  firstEventId = first.id
  await attend(first, people.slice(0, 6), 95)

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

const CANARY = ['"p50Min":173', '"medianStayMin":173', '"viewers":11']

describe("the paywall's clock", () => {
  it("has started: the first event that cleared the floor ended 60 days ago", async () => {
    const access = await analyticsAccess(orgId, now)
    expect(access).toMatchObject({ org: false, reason: "free", firstFreeEventId: firstEventId, passEventIds: [] })
    expect(access.freeUntil!.getTime()).toBeLessThan(now.getTime())
  })
})

describe("a free organisation's page carries none of its paid figures (MN-I12)", () => {
  it("computes nothing paid: the cross-event views and the locked event are null", async () => {
    const view = await analyticsPage(orgId, { range: "90d", eventId: canaryEventId }, now)
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
    const view = await analyticsPage(orgId, { range: "90d", eventId: firstEventId }, now)
    expect(view.selected).toMatchObject({ id: firstEventId, open: true })
    expect(view.selected?.data?.stay?.p50Min).toBe(95)
  })
})

describe("the server refuses, not the component (DK-I01)", () => {
  it("returns null before its first query when the access decision says no", async () => {
    const access = await analyticsAccess(orgId, now)
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
})

describe("floors on every new figure", () => {
  it("holds back an event of four: no stay, no first-time split, no arrivals", async () => {
    const access = { ...(await analyticsAccess(orgId, now)), org: true }
    const small = await eventAnalytics(access, smallEventId)
    expect(small).toMatchObject({ people: null, stay: null, firstTimers: null, returning: null })
    expect(small!.arrivals.every((a) => a.people === null)).toBe(true)
  })

  it("shows the canary's figures, each through its floor, once open", async () => {
    const access = { ...(await analyticsAccess(orgId, now)), org: true }
    const canary = await eventAnalytics(access, canaryEventId)
    expect(canary!.people).toBe(7)
    expect(canary!.stay).toMatchObject({ p25Min: 173, p50Min: 173, p75Min: 173, leftEarlyPct: null, softPct: null })
    // Four of the seven had been before (people 2–5), three had not: both parts are under the floor.
    expect(canary!.returning).toBeNull()
    expect(canary!.firstTimers).toBeNull()
    expect(canary!.funnel.viewers).toBe(11)
    // Seven arrived in one 10-minute bucket at the door.
    expect(canary!.arrivals).toEqual([{ at: expect.any(String), people: 7 }])
  })
})

describe("Analytics, granted, opens the same figures (the positive control)", () => {
  afterAll(async () => {
    await db.entitlements.deleteMany({ where: { subject_id: orgId } })
  })

  it("carries the canary once the organisation may see it", async () => {
    await grantEntitlement({ subject: { kind: "org", id: orgId }, product: "analytics", months: 6 })
    const view = await analyticsPage(orgId, { range: "90d", eventId: canaryEventId }, new Date())
    expect(view.access.reason).toBe("grant")
    expect(view.org?.comparison.find((r) => r.eventId === canaryEventId)?.medianStayMin).toBe(173)
    const tree = await renderedTree({ event: canaryEventId })
    for (const c of CANARY) expect(tree).toContain(c)
  })
})

describe("an Event Pass is not sold for what is already open", () => {
  beforeEach(() => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_itestkey"
    process.env.RAZORPAY_KEY_SECRET = "itest_key_secret_value"
  })
  afterEach(() => {
    delete process.env.RAZORPAY_KEY_ID
    delete process.env.RAZORPAY_KEY_SECRET
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
