/*
 * SCRUM-1151 (design/05): plans are sold only where their prices are, India.
 * An organisation running anything elsewhere (Canada at launch) is shown
 * "Free while we launch in your city." instead of a price and Buy, and the
 * server refuses every way to start a checkout or a subscription for it,
 * before Razorpay is called and before any row is written. Cancel is never
 * refused: an organisation that already pays keeps what it paid for and can
 * stop it.
 *
 * The market rule is `mayBuyHere` (lib/plan-market.ts): its events' cities
 * and, for a venue owner, its venues' cities, resolved through the city
 * catalogue. The catalogue's rows (Bengaluru IN, Toronto CA preview) exist
 * only in migration SQL, so this runs on a db:migrate database.
 *
 * Razorpay's API is a stub `fetch` that records each call.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await mockGetAuth(); return s?.user ? { ...s, user: { signedInAt: Date.now(), ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { randomUUID } from "crypto"

import { resetMemoryStore } from "@/lib/rate-limit-store"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const actions = require("@/lib/billing-actions") as typeof import("@/lib/billing-actions")
const market = require("@/lib/plan-market") as typeof import("@/lib/plan-market")
const billing = require("@/lib/billing") as typeof import("@/lib/billing")
const page = require("@/app/dashboard/plan/page") as typeof import("@/app/dashboard/plan/page")
/* eslint-enable @typescript-eslint/no-require-imports */

const NOT_SOLD = "Plans aren’t sold in your city yet. Free while we launch there."
const LINE = "Free while we launch in your city."
const DAY = 24 * 60 * 60 * 1000

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const venues: string[] = []
const calls: { method: string; url: string }[] = []
const realFetch = global.fetch

function stubRazorpay() {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ method: init?.method ?? "GET", url })
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status })
    if (url.includes("/plans")) {
      return json(200, {
        items: [
          { id: "plan_month", period: "monthly", interval: 1, item: { name: "x", amount: 235_900, currency: "INR" }, notes: { key: "analytics_monthly" } },
          { id: "plan_vp_month", period: "monthly", interval: 1, item: { name: "x", amount: 353_900, currency: "INR" }, notes: { key: "venue_pro_monthly" } },
        ],
      })
    }
    if (url.endsWith("/subscriptions")) {
      const body = init?.body ? (JSON.parse(String(init.body)) as { plan_id?: string }) : {}
      return json(200, { id: `sub_${randomUUID().slice(0, 12)}`, plan_id: body.plan_id ?? "", status: "created" })
    }
    if (url.endsWith("/cancel")) return json(200, { id: url.split("/").at(-2), plan_id: "plan_month", status: "active" })
    if (url.endsWith("/orders")) return json(200, { id: `order_${randomUUID().slice(0, 12)}`, amount: 58_900, currency: "INR", status: "created" })
    return json(404, { error: { description: "not stubbed" } })
  }) as typeof fetch
}

const as = (id: string, role: "organizer" | "venue_owner") => mockGetAuth.mockResolvedValue({ user: { id, role } })

/** A new organisation with one owner of this role; returns both ids. */
async function orgWithOwner(label: string, role: "organizer" | "venue_owner" = "organizer") {
  const owner = await makeUser(testId(`${label}-owner`), "organizer")
  if (role === "venue_owner") await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })
  users.push(owner)
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId(label), status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: owner, role: "owner" } })
  return { owner, orgId: org.id }
}

/** An event of the organisation's in `city`, ended `endedDaysAgo` days ago. */
async function eventIn(orgId: string, owner: string, city: string | null, opts: { deleted?: boolean; status?: "cancelled" | "draft" | "completed"; endedDaysAgo?: number } = {}) {
  const id = await makeEvent(owner)
  events.push(id)
  const end = new Date(Date.now() - (opts.endedDaysAgo ?? 30) * DAY)
  await db.events.update({
    where: { id },
    data: {
      organizer_org_id: orgId,
      city,
      start_time: new Date(end.getTime() - 3 * 60 * 60 * 1000),
      end_time: end,
      deleted_at: opts.deleted ? new Date() : null,
      ...(opts.status ? { status: opts.status } : {}),
    },
  })
  return id
}

async function venueIn(orgId: string, city: string, opts: { deleted?: boolean } = {}) {
  const v = await db.venues.create({
    data: {
      name: testId("pm-venue"),
      city,
      latitude: 43.65,
      longitude: -79.38,
      timezone: "UTC",
      owner_org_id: orgId,
      claimed_at: new Date(Date.now() - 200 * DAY),
      deleted_at: opts.deleted ? new Date() : null,
    },
  })
  venues.push(v.id)
  return v.id
}

/** Everything a refused checkout must not have left behind, for one organisation. */
async function leftBehind(orgId: string, paymentEventsBefore: number) {
  return {
    razorpayPosts: calls.filter((c) => c.method === "POST").length,
    checkouts: await db.billing_checkouts.count({ where: { org_id: orgId } }),
    entitlements: await db.entitlements.count({ where: { subject_id: orgId } }),
    newPaymentEvents: (await db.payment_events.count()) - paymentEventsBefore,
  }
}
const NOTHING = { razorpayPosts: 0, checkouts: 0, entitlements: 0, newPaymentEvents: 0 }

async function tree(): Promise<string> {
  const t = await page.default({ searchParams: Promise.resolve({}) })
  const seen = new WeakSet<object>()
  return JSON.stringify(t, (key, value) => {
    if (key.startsWith("_") || typeof value === "function" || typeof value === "symbol") return undefined
    if (value && typeof value === "object") {
      if (seen.has(value)) return undefined
      seen.add(value)
    }
    return value
  })
}

beforeEach(() => {
  resetMemoryStore()
  calls.length = 0
  process.env.RAZORPAY_KEY_ID = "rzp_test_itestkey"
  process.env.RAZORPAY_KEY_SECRET = "itest_key_secret_value_24"
  process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_itest_plan_market_0123456789abcd"
  stubRazorpay()
})

afterEach(() => {
  global.fetch = realFetch
  delete process.env.RAZORPAY_KEY_ID
  delete process.env.RAZORPAY_KEY_SECRET
  delete process.env.RAZORPAY_WEBHOOK_SECRET
})

afterAll(async () => {
  await db.entitlements.deleteMany({ where: { subject_id: { in: [...orgs, ...venues] } } })
  await db.billing_checkouts.deleteMany({ where: { org_id: { in: orgs } } })
  await db.audit_logs.deleteMany({ where: { resource_id: { in: [...orgs, ...venues] } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

describe("mayBuyHere: the organisation's events and venues, by the catalogue's country", () => {
  it.each([
    ["every event in Bengaluru", [{ city: "Bengaluru" }], true],
    ["a spelling the catalogue folds (Bangalore)", [{ city: "bangalore" }], true],
    ["one event in Toronto", [{ city: "Toronto" }], false],
    ["Bengaluru and Toronto", [{ city: "Bengaluru" }, { city: "Toronto" }], false],
    ["a Toronto suburb the catalogue maps to Toronto (Mississauga)", [{ city: "Mississauga" }], false],
    ["a name the catalogue does not know (Toronto Downtown) counts as India", [{ city: "Toronto Downtown" }], true],
    ["no city at all counts as India", [{ city: null }], true],
    ["a deleted Toronto event is no reason", [{ city: "Bengaluru" }, { city: "Toronto", deleted: true }], true],
    ["a cancelled Toronto event still is", [{ city: "Bengaluru" }, { city: "Toronto", status: "cancelled" as const }], false],
    // SCRUM-1277: not being able to buy now opens Analytics, so the evidence must cost something; a draft costs nothing.
    ["a draft Toronto event is no reason", [{ city: "Bengaluru" }, { city: "Toronto", status: "draft" as const }], true],
    ["an organisation whose only event is a Toronto draft counts as India", [{ city: "Toronto", status: "draft" as const }], true],
    ["a completed Toronto event is", [{ city: "Toronto", status: "completed" as const }], false],
  ])("%s", async (_label, rows, expected) => {
    const { owner, orgId } = await orgWithOwner("pm-rule")
    for (const r of rows) await eventIn(orgId, owner, r.city, { deleted: "deleted" in r && r.deleted, status: "status" in r ? r.status : undefined })
    expect(await market.mayBuyHere(orgId)).toBe(expected)
  })

  it("an organisation with no events and no venues counts as India", async () => {
    const { orgId } = await orgWithOwner("pm-empty")
    expect(await market.mayBuyHere(orgId)).toBe(true)
  })

  it("a venue owner's venues count: a Toronto venue and no events is not India", async () => {
    const { orgId } = await orgWithOwner("pm-venue-ca", "venue_owner")
    await venueIn(orgId, "Toronto")
    expect(await market.mayBuyHere(orgId)).toBe(false)
  })

  it("a Bengaluru venue is India; a deleted Toronto venue is no reason", async () => {
    const { orgId } = await orgWithOwner("pm-venue-in", "venue_owner")
    await venueIn(orgId, "Bengaluru")
    await venueIn(orgId, "Toronto", { deleted: true })
    expect(await market.mayBuyHere(orgId)).toBe(true)
  })

  it("billingOrgFor carries it, for the page and the actions", async () => {
    const { owner, orgId } = await orgWithOwner("pm-org-field")
    await eventIn(orgId, owner, "Toronto")
    expect(await billing.billingOrgFor({ id: owner, role: "organizer" })).toMatchObject({ orgId, mayBuyHere: false })
  })
})

describe("the server refuses every checkout for an organisation outside India", () => {
  it("Analytics: refused before Razorpay, nothing written", async () => {
    const { owner, orgId } = await orgWithOwner("pm-ca-analytics")
    await eventIn(orgId, owner, "Toronto")
    const before = await db.payment_events.count()
    as(owner, "organizer")
    await expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow(NOT_SOLD)
    await expect(actions.startAnalyticsCheckout("yearly")).rejects.toThrow(NOT_SOLD)
    expect(await leftBehind(orgId, before)).toEqual(NOTHING)
  })

  it("Event Insights for a Toronto night: refused before Razorpay, nothing written", async () => {
    const { owner, orgId } = await orgWithOwner("pm-ca-pass")
    const night = await eventIn(orgId, owner, "Toronto", { endedDaysAgo: 200 })
    const before = await db.payment_events.count()
    as(owner, "organizer")
    await expect(actions.startEventPassCheckout(night)).rejects.toThrow(NOT_SOLD)
    expect(await leftBehind(orgId, before)).toEqual(NOTHING)
  })

  it("Venue Pro for a Toronto venue: refused before Razorpay, nothing written", async () => {
    const { owner, orgId } = await orgWithOwner("pm-ca-venue", "venue_owner")
    const v = await venueIn(orgId, "Toronto")
    const before = await db.payment_events.count()
    as(owner, "venue_owner")
    await expect(actions.startVenueProCheckout(v, "monthly")).rejects.toThrow(NOT_SOLD)
    expect(await leftBehind(orgId, before)).toEqual(NOTHING)
    expect(await db.billing_checkouts.count({ where: { venue_id: v } })).toBe(0)
  })

  it("an Indian organisation still reaches Razorpay and gets its checkout row", async () => {
    const { owner, orgId } = await orgWithOwner("pm-in-analytics")
    await eventIn(orgId, owner, "Bengaluru")
    as(owner, "organizer")
    const out = await actions.startAnalyticsCheckout("monthly")
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/subscriptions"))).toBe(true)
    expect(await db.billing_checkouts.findFirst({ where: { provider_ref: out.subscriptionId } })).toMatchObject({ org_id: orgId, status: "created" })
  })
})

describe("an Indian organisation that already pays, then runs a night in Toronto", () => {
  let owner = ""
  let orgId = ""
  let sub = ""

  beforeAll(async () => {
    ;({ owner, orgId } = await orgWithOwner("pm-mixed"))
    await eventIn(orgId, owner, "Bengaluru")
    await eventIn(orgId, owner, "Toronto")
    sub = `sub_${randomUUID().slice(0, 10)}`
    await db.billing_checkouts.create({
      data: { kind: "subscription", provider_ref: sub, provider_plan_id: "plan_month", org_id: orgId, plan_key: "analytics_monthly", amount_minor: 235_900, status: "active", current_end: new Date(Date.now() + 20 * DAY) },
    })
    await db.entitlements.create({
      data: { subject_kind: "org", subject_id: orgId, product: "analytics", source: "razorpay", external_ref: sub, starts_at: new Date(Date.now() - DAY), expires_at: new Date(Date.now() + 23 * DAY) },
    })
  })

  it("keeps its Analytics, and the page says it is on, not the launch line", async () => {
    as(owner, "organizer")
    const t = await tree()
    expect(t).toMatch(/On, renews /)
    expect(t).toContain(sub)
    // Nothing for sale on the page: no buy control is rendered.
    expect(t).not.toMatch(/"enabled":(true|false)/)
  })

  it("may not buy anything new", async () => {
    as(owner, "organizer")
    await expect(actions.startAnalyticsCheckout("yearly")).rejects.toThrow(NOT_SOLD)
  })

  it("may still cancel: the cancel path is never refused", async () => {
    as(owner, "organizer")
    await actions.cancelAnalytics()
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith(`/${sub}/cancel`))).toBe(true)
  })
})

describe("the Plan page", () => {
  it("a Toronto organisation: the launch line, no price, no buy control", async () => {
    const { owner, orgId } = await orgWithOwner("pm-page-ca")
    await eventIn(orgId, owner, "Toronto")
    as(owner, "organizer")
    const t = await tree()
    expect(t).toContain(LINE)
    expect(t).not.toMatch(/₹/)
    expect(t).not.toMatch(/"enabled":(true|false)/)
    expect(t).not.toContain("can change its plan")
  })

  it("an Indian organisation sees today's page: prices and Buy, no launch line", async () => {
    const { owner, orgId } = await orgWithOwner("pm-page-in")
    await eventIn(orgId, owner, "Bengaluru")
    as(owner, "organizer")
    const t = await tree()
    expect(t).not.toContain(LINE)
    expect(t).toContain("₹589")
    expect(t).toMatch(/"enabled":true/)
  })
})

describe("review: the cases the first pass missed", () => {
  it("a Toronto organisation past its free window: the launch line, no Event Insights picker", async () => {
    const { owner, orgId } = await orgWithOwner("pm-ca-past")
    const night = await eventIn(orgId, owner, "Toronto", { endedDaysAgo: 200 })
    await db.organisations.update({ where: { id: orgId }, data: { analytics_free_until: new Date(Date.now() - DAY), first_free_event_id: night } })
    as(owner, "organizer")
    const t = await tree()
    expect(t.split(LINE)).toHaveLength(3)
    expect(t).not.toContain("Every event is open while Analytics is free.")
    expect(t).not.toMatch(/"enabled":(true|false)/)
    expect(t).not.toMatch(/₹/)
  })

  it("the payer of Venue Pro on a Toronto venue may still cancel it, and may not start a new one", async () => {
    const { owner, orgId } = await orgWithOwner("pm-ca-vp-cancel", "venue_owner")
    const v = await venueIn(orgId, "Toronto")
    const sub = `sub_${randomUUID().slice(0, 10)}`
    await db.billing_checkouts.create({
      data: { kind: "subscription", provider_ref: sub, provider_plan_id: "plan_vp_month", org_id: orgId, venue_id: v, plan_key: "venue_pro_monthly", amount_minor: 353_900, status: "active", current_end: new Date(Date.now() + 20 * DAY) },
    })
    as(owner, "venue_owner")
    await actions.cancelVenuePro(v)
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith(`/${sub}/cancel`))).toBe(true)
    await expect(actions.startVenueProCheckout(v, "monthly")).rejects.toThrow(NOT_SOLD)
  })

  it("one person in an Indian and a Canadian venue organisation: the Toronto venue is refused, the rule is each venue's owner's", async () => {
    const { owner, orgId: indianOrg } = await orgWithOwner("pm-two-in", "venue_owner")
    const canadianOrg = (await db.organisations.create({ data: { kind: "company", display_name: testId("pm-two-ca"), status: "verified" } })).id
    orgs.push(canadianOrg)
    await db.organisation_members.create({ data: { org_id: canadianOrg, user_id: owner, role: "owner" } })
    await venueIn(indianOrg, "Bengaluru")
    const toronto = await venueIn(canadianOrg, "Toronto")
    as(owner, "venue_owner")
    await expect(actions.startVenueProCheckout(toronto, "monthly")).rejects.toThrow(NOT_SOLD)
    expect(await market.mayBuyHere(indianOrg)).toBe(true)
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0)
  })
})
