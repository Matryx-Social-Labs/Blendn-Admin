/*
 * Venue plans against real Postgres (step 17 part B; TQ-DV06: MN-I05 for a
 * venue, the no-charge rule, founding grants, insights by tier).
 *
 *   - No charge before four weeks of venue-day data: the checkout action
 *     refuses, with nothing written and nothing asked of Razorpay; past it, a
 *     purchase names its venue and grants nothing until the webhook.
 *   - One open subscription per venue, and an organisation may hold Pro on two.
 *   - The webhook settles a venue's Pro onto the VENUE, from our own row.
 *   - Founding grants: admin only, claimed venues only, one live at a time.
 *   - Insights: Listed computes 30 days and nothing paid — no 12-month query,
 *     no pre-claim query — and its page tree carries none of the paid
 *     canaries; Venue Pro carries them (the positive control). Pre-claim
 *     history is three totals. Floors on every figure; regulars and
 *     one-timers held back together.
 *
 * Razorpay's API is a stub `fetch`; signatures are computed here.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
// The venue's map form imports Leaflet's CSS, which node cannot load.
jest.mock("@/app/dashboard/venues/[id]/venue-manage", () => ({ VenueManage: () => null }))
/*
 * Every raw query the app's client runs, with its values, so a test can say
 * which windows were asked for. The real client does the work.
 */
const mockRawCalls: unknown[][] = []
jest.mock("@/lib/db", () => {
  const actual = jest.requireActual("@/lib/db")
  const real = actual.db
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "$queryRaw") {
        return (...args: unknown[]) => {
          mockRawCalls.push(args.slice(1))
          return target.$queryRaw(...args)
        }
      }
      const value = Reflect.get(target, prop)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return { ...actual, db }
})

import { createHmac, randomUUID } from "crypto"
import { NextRequest } from "next/server"
import { isValidElement, type ReactElement } from "react"

import { hasEntitlement } from "@/lib/entitlements"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { venueDayFor } from "@/lib/venue-day"
import { venueInsights } from "@/lib/venue-insights"
import { venuePlanPage, venueReadiness } from "@/lib/venue-plan"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const actions = require("@/lib/billing-actions") as typeof import("@/lib/billing-actions")
const route = require("@/app/api/webhooks/razorpay/route") as typeof import("@/app/api/webhooks/razorpay/route")
const venuePage = require("@/app/dashboard/venues/[id]/page") as typeof import("@/app/dashboard/venues/[id]/page")
/* eslint-enable @typescript-eslint/no-require-imports */

const DAY = 24 * 60 * 60 * 1000
const SECRET = "whsec_itest_venue_plans_0123456789abcdef"
const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const venues: string[] = []

let owner = ""
let staff = ""
let stranger = ""
let organiser = ""
let admin = ""
let orgId = ""

const calls: { method: string; url: string; body: Record<string, unknown> | undefined }[] = []
const realFetch = global.fetch

function stubRazorpay() {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ method: init?.method ?? "GET", url, body })
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status })
    if (url.includes("/plans")) {
      return json(200, {
        items: [
          { id: "plan_vp_month", period: "monthly", interval: 1, item: { name: "x", amount: 353_900, currency: "INR" }, notes: { key: "venue_pro_monthly" } },
          { id: "plan_vp_year", period: "yearly", interval: 1, item: { name: "x", amount: 3_538_800, currency: "INR" }, notes: { key: "venue_pro_yearly" } },
        ],
      })
    }
    if (url.endsWith("/subscriptions")) return json(200, { id: `sub_${randomUUID().slice(0, 12)}`, plan_id: body?.plan_id, status: "created" })
    return json(404, { error: { description: "not stubbed" } })
  }) as typeof fetch
}

const as = (id: string, role: "organizer" | "app_admin" | "venue_owner") => mockGetAuth.mockResolvedValue({ user: { id, role } })

async function venue(label: string, opts: { org?: string | null; claimedDaysAgo?: number } = {}) {
  const org = opts.org === undefined ? orgId : opts.org
  const v = await db.venues.create({
    data: {
      name: testId(label),
      city: "Bengaluru",
      latitude: 12.97,
      longitude: 77.64,
      timezone: "UTC",
      day_reset_hour: 6,
      owner_org_id: org,
      claimed_at: org ? new Date(Date.now() - (opts.claimedDaysAgo ?? 100) * DAY) : null,
    },
  })
  venues.push(v.id)
  return v.id
}

/** Somebody went live at the venue `daysAgo` days ago: its venue-day data starts then. */
async function liveSince(venueId: string, daysAgo: number) {
  const day = await venueDayFor(venueId)
  if (!day) throw new Error("no venue day")
  events.push(day.id)
  const person = await makeUser(testId("vp-live"))
  users.push(person)
  await db.event_check_ins.create({
    data: {
      event_id: day.id,
      occurrence_id: day.occurrenceId,
      user_id: person,
      status: "checked_in",
      check_in_time: new Date(Date.now() - daysAgo * DAY),
    },
  })
}

/** A night at the venue at `at`, with these people checked in. */
async function night(venueId: string, at: Date, people: string[]) {
  const id = await makeEvent(owner)
  events.push(id)
  await db.events.update({
    where: { id },
    data: { venue_id: venueId, start_time: at, end_time: new Date(at.getTime() + 3 * 60 * 60 * 1000), title: testId("vp-night") },
  })
  const occ = await db.event_occurrences.findFirstOrThrow({ where: { event_id: id } })
  for (const user_id of people) {
    await db.event_check_ins.create({ data: { event_id: id, occurrence_id: occ.id, user_id, status: "checked_in", check_in_time: at } })
  }
  return id
}

async function guests(n: number, label: string) {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const id = await makeUser(testId(`${label}${i}`))
    users.push(id)
    out.push(id)
  }
  return out
}

/** `daysAgo` days back, moved to the nearest such weekday (0 = Monday) and hour, UTC. */
function onWeekday(daysAgo: number, weekday: number, hour: number) {
  const d = new Date(Date.now() - daysAgo * DAY)
  const isoDow = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - ((isoDow - weekday + 7) % 7))
  d.setUTCHours(hour, 0, 0, 0)
  return d
}

beforeAll(async () => {
  owner = await makeUser(testId("vp-owner"), "organizer")
  staff = await makeUser(testId("vp-staff"), "organizer")
  stranger = await makeUser(testId("vp-stranger"), "organizer")
  organiser = await makeUser(testId("vp-organiser"), "organizer")
  admin = await makeUser(testId("vp-admin"), "app_admin")
  users.push(owner, staff, stranger, organiser, admin)
  for (const id of [owner, staff, stranger]) await db.user.update({ where: { id }, data: { role: "venue_owner" } })
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("vp-org"), status: "verified" } })
  const other = await db.organisations.create({ data: { kind: "company", display_name: testId("vp-other"), status: "verified" } })
  orgs.push(org.id, other.id)
  orgId = org.id
  await db.organisation_members.createMany({
    data: [
      { org_id: org.id, user_id: owner, role: "owner" },
      { org_id: org.id, user_id: staff, role: "staff" },
      { org_id: org.id, user_id: organiser, role: "owner" },
      { org_id: other.id, user_id: stranger, role: "owner" },
    ],
  })
})

beforeEach(() => {
  resetMemoryStore()
  calls.length = 0
  process.env.RAZORPAY_KEY_ID = "rzp_test_itestkey"
  process.env.RAZORPAY_KEY_SECRET = "itest_key_secret_value_24"
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET
  stubRazorpay()
})

afterEach(() => {
  global.fetch = realFetch
  delete process.env.RAZORPAY_KEY_ID
  delete process.env.RAZORPAY_KEY_SECRET
  delete process.env.RAZORPAY_WEBHOOK_SECRET
})

afterAll(async () => {
  await db.payment_events.deleteMany({ where: { provider_event_id: { startsWith: "itest_vp_" } } })
  await db.billing_payments.deleteMany({ where: { checkout: { venue_id: { in: venues } } } })
  await db.billing_checkouts.deleteMany({ where: { OR: [{ venue_id: { in: venues } }, { org_id: { in: orgs } }] } })
  await db.entitlements.deleteMany({ where: { subject_id: { in: [...venues, ...orgs] } } })
  await db.audit_logs.deleteMany({ where: { resource_id: { in: [...venues, ...orgs] } } })
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

describe("no charge before four weeks of venue-day data", () => {
  it("counts from the first person who went live there", async () => {
    const fresh = await venue("vp-fresh")
    expect(await venueReadiness(fresh)).toMatchObject({ dataSince: null, chargeable: false, dataDays: 0 })
    await liveSince(fresh, 10)
    expect(await venueReadiness(fresh)).toMatchObject({ chargeable: false, dataDays: 10 })
    const ready = await venue("vp-ready")
    await liveSince(ready, 29)
    expect(await venueReadiness(ready)).toMatchObject({ chargeable: true, dataDays: 28 })
  })

  it("refuses to start Venue Pro before then: no row, nothing asked of Razorpay", async () => {
    const young = await venue("vp-young")
    await liveSince(young, 20)
    as(owner, "venue_owner")
    await expect(actions.startVenueProCheckout(young, "monthly")).rejects.toThrow(/Venue Pro can be bought from .*four weeks after people first went live here/)
    expect(await db.billing_checkouts.count({ where: { venue_id: young } })).toBe(0)
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0)
  })

  it("refuses a venue nobody has gone live at yet", async () => {
    const empty = await venue("vp-empty")
    as(owner, "venue_owner")
    await expect(actions.startVenueProCheckout(empty, "monthly")).rejects.toThrow("four weeks after people first go live")
  })

  it("past four weeks: a purchase for that venue, at the table's price, and no entitlement yet", async () => {
    const v = await venue("vp-buy")
    await liveSince(v, 35)
    as(owner, "venue_owner")
    const out = await actions.startVenueProCheckout(v, "monthly")
    const row = await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: out.subscriptionId } })
    expect(row).toMatchObject({ venue_id: v, org_id: orgId, plan_key: "venue_pro_monthly", amount_minor: 353_900, provider_plan_id: "plan_vp_month" })
    expect(calls.find((c) => c.url.endsWith("/subscriptions"))?.body).toMatchObject({ notes: { org_id: orgId, venue_id: v } })
    expect(await hasEntitlement({ kind: "venue", id: v }, "venue_pro")).toBe(false)
    // A second start resumes it; a second venue of the same organisation opens its own.
    expect((await actions.startVenueProCheckout(v, "monthly")).subscriptionId).toBe(out.subscriptionId)
    const v2 = await venue("vp-buy2")
    await liveSince(v2, 35)
    const out2 = await actions.startVenueProCheckout(v2, "monthly")
    expect(out2.subscriptionId).not.toBe(out.subscriptionId)
  })

  it.each([
    ["staff of the venue's organisation", () => staff, "venue_owner", "Only an owner or admin"],
    ["another organisation's owner", () => stranger, "venue_owner", "isn't one of your organisation's"],
    ["an organiser of the same organisation", () => organiser, "organizer", "Only an owner or admin"],
  ] as const)("refuses %s", async (_label, who, role, sentence) => {
    const v = await venue("vp-refuse")
    await liveSince(v, 35)
    as(who(), role)
    await expect(actions.startVenueProCheckout(v, "monthly")).rejects.toThrow(sentence)
    expect(await db.billing_checkouts.count({ where: { venue_id: v } })).toBe(0)
  })

  it("refuses while Venue Pro is already live from a founding grant", async () => {
    const v = await venue("vp-granted")
    await liveSince(v, 35)
    as(admin, "app_admin")
    await actions.grantVenuePro(v, 3, "Founding venue, claimed in Bengaluru")
    as(owner, "venue_owner")
    await expect(actions.startVenueProCheckout(v, "monthly")).rejects.toThrow("already has Venue Pro until")
  })
})

describe("the webhook settles a venue's Venue Pro onto the venue (MN-I05)", () => {
  function post(body: unknown) {
    const raw = JSON.stringify(body)
    return route.POST(
      new NextRequest("http://localhost/api/webhooks/razorpay", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-real-ip": "203.0.113.11",
          "x-razorpay-signature": createHmac("sha256", SECRET).update(raw).digest("hex"),
          "x-razorpay-event-id": `itest_vp_${randomUUID()}`,
        },
        body: raw,
      })
    )
  }
  const T0 = Math.floor(Date.now() / 1000) - 3600
  const sub = (type: string, id: string, at: number, extra: Record<string, unknown> = {}) => ({
    event: type,
    created_at: at,
    payload: {
      subscription: {
        entity: { id, plan_id: "plan_vp_month", status: "active", start_at: T0, current_start: at, current_end: at + 30 * 86_400, ...extra },
      },
      payment: { entity: { id: `pay_${randomUUID().slice(0, 10)}`, amount: 353_900, currency: "INR", status: "captured" } },
    },
  })

  it("charged grants the venue, never the organisation; halted ends it; a wrong amount is refused", async () => {
    const v = await venue("vp-webhook")
    const ref = `sub_${randomUUID().slice(0, 12)}`
    await db.billing_checkouts.create({
      data: { kind: "subscription", provider_ref: ref, provider_plan_id: "plan_vp_month", org_id: orgId, venue_id: v, plan_key: "venue_pro_monthly", amount_minor: 353_900 },
    })

    const wrong = sub("subscription.charged", ref, T0)
    ;(wrong.payload.payment.entity as { amount: number }).amount = 235_900
    expect((await post(wrong)).status).toBe(200)
    expect(await hasEntitlement({ kind: "venue", id: v }, "venue_pro")).toBe(false)

    expect((await post(sub("subscription.charged", ref, T0 + 1))).status).toBe(200)
    expect(await hasEntitlement({ kind: "venue", id: v }, "venue_pro")).toBe(true)
    expect(await hasEntitlement({ kind: "org", id: orgId }, "analytics")).toBe(false)
    const row = await db.entitlements.findFirstOrThrow({ where: { external_ref: ref } })
    expect(row).toMatchObject({ subject_kind: "venue", subject_id: v, product: "venue_pro", source: "razorpay" })

    expect((await post(sub("subscription.halted", ref, T0 + 60, { status: "halted" }))).status).toBe(200)
    expect(await hasEntitlement({ kind: "venue", id: v }, "venue_pro")).toBe(false)
    expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: ref } })).status).toBe("halted")
  })
})

describe("founding grants (admin)", () => {
  it("grants 3 months to a claimed venue, audited; one at a time; then ends", async () => {
    const v = await venue("vp-found")
    as(admin, "app_admin")
    const { expiresAt } = await actions.grantVenuePro(v, 3, "Founding venue, claimed in Bengaluru")
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(85 * DAY)
    expect(await hasEntitlement({ kind: "venue", id: v }, "venue_pro")).toBe(true)
    const audit = await db.audit_logs.findFirstOrThrow({ where: { resource_id: v, action: "entitlement.granted" } })
    expect(audit).toMatchObject({ resource: "venue", user_id: admin })
    await expect(actions.grantVenuePro(v, 3, "Founding venue, a second time")).rejects.toThrow("already has a grant")
    await actions.endVenueProGrant(v, "Granted to the wrong venue")
    expect(await hasEntitlement({ kind: "venue", id: v }, "venue_pro")).toBe(false)
  })

  it("refuses an unclaimed venue, and anyone but an admin", async () => {
    const unclaimed = await venue("vp-unclaimed", { org: null })
    as(admin, "app_admin")
    await expect(actions.grantVenuePro(unclaimed, 3, "Founding venue, claimed in Bengaluru")).rejects.toThrow("unclaimed")
    const v = await venue("vp-found2")
    as(owner, "venue_owner")
    await expect(actions.grantVenuePro(v, 3, "Founding venue, claimed in Bengaluru")).rejects.toThrow("Forbidden")
    expect(await hasEntitlement({ kind: "venue", id: v }, "venue_pro")).toBe(false)
  })
})

describe("insights by plan", () => {
  let v = ""
  let preClaimNights: string[] = []

  beforeAll(async () => {
    // Claimed 100 days ago.
    v = await venue("vp-insight", { claimedDaysAgo: 100 })
    // In the last 30 days: five regulars (two nights) and five who came once.
    const regulars = await guests(5, "vp-reg")
    const once = await guests(5, "vp-once")
    await night(v, onWeekday(9, 4, 20), [...regulars, ...once])
    await night(v, onWeekday(16, 5, 20), regulars)
    // Inside a year but not 30 days, after the claim: 23 people on a Monday morning. The 12-month canary.
    await night(v, onWeekday(60, 0, 9), await guests(23, "vp-year"))
    // Before the claim: 19 people over three nights. The pre-claim canary.
    const before = await guests(19, "vp-before")
    preClaimNights = [
      await night(v, new Date(Date.now() - 150 * DAY), before.slice(0, 7)),
      await night(v, new Date(Date.now() - 140 * DAY), before.slice(7, 13)),
      await night(v, new Date(Date.now() - 130 * DAY), before.slice(13)),
    ]
  })

  afterEach(async () => {
    await db.entitlements.deleteMany({ where: { subject_id: v } })
  })

  it("Listed: 30 days, regulars and their complement both shown at 5, nothing paid computed", async () => {
    mockRawCalls.length = 0
    {
      const view = await venueInsights(v)
      expect(view).toMatchObject({ plan: "listed", recent: { window: "30d" }, preClaim: null })
      expect(view!.recent.regulars).toEqual({ visitors: 10, regulars: 5, oneTimers: 5, sharePct: 50 })
      // The Monday-morning 23 are outside 30 days.
      expect(view!.recent.people[0][0]).toBe(0)
      // No query asked for anything older than the free window, or before the claim.
      expect(mockRawCalls.length).toBeGreaterThan(0)
      const cutoff = Date.now() - 31 * DAY
      const old = mockRawCalls.flat().filter((x): x is Date => x instanceof Date && x.getTime() < cutoff)
      expect(old).toEqual([])
    }
  })

  it("Venue Pro: the year and the pre-claim totals; pre-claim is three totals and nothing else", async () => {
    as(admin, "app_admin")
    await actions.grantVenuePro(v, 3, "Founding venue, claimed in Bengaluru")
    const view = await venueInsights(v)
    expect(view).toMatchObject({ plan: "pro", recent: { window: "12m" } })
    expect(view!.recent.people[0][0]).toBe(23)
    expect(view!.preClaim).toEqual({ nights: 3, people: 19, since: expect.stringMatching(/^\d{4}-\d{2}$/) })
    expect(Object.keys(view!.preClaim!).sort()).toEqual(["nights", "people", "since"])
    // The year starts at the claim, never before it.
    expect(new Date(view!.recent.from).getTime()).toBeGreaterThanOrEqual(Date.now() - 100 * DAY - 60_000)
  })

  it("the page tree (what the RSC payload carries) has no paid figure for Listed, and has them for Pro", async () => {
    /*
     * The page's tree with its server components rendered in place (the
     * insights section is one), as the RSC payload would carry them. Client
     * components stay as their props, which is what crosses the wire.
     */
    const expand = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(expand)
      if (!isValidElement(node)) return node
      const el = node as ReactElement<Record<string, unknown>>
      if (typeof el.type === "function" && el.type.name === "VenueInsights") {
        return expand((el.type as (p: unknown) => unknown)(el.props))
      }
      return { ...el, props: { ...el.props, children: expand(el.props.children) } }
    }
    const tree = async () => {
      as(owner, "venue_owner")
      const el = await venuePage.default({ params: Promise.resolve({ id: v }), searchParams: Promise.resolve({ range: "90d" }) })
      // An element's `type` is code (a component, a forwardRef object), never data.
      return JSON.stringify(expand(el), (k, value) => (k === "type" || k === "_owner" || typeof value === "function" ? undefined : value))
    }
    const listed = await tree()
    // The 12-month cell and the pre-claim guests, as the payload would carry them.
    expect(listed).not.toContain('"people":[[23,')
    expect(listed).not.toContain('"people":19')
    for (const id of preClaimNights) expect(listed).not.toContain(id)
    // The sample is there instead.
    expect(listed).toContain('"nights":37')

    as(admin, "app_admin")
    await actions.grantVenuePro(v, 3, "Founding venue, claimed in Bengaluru")
    const pro = await tree()
    expect(pro).toContain('"people":[[23,')
    expect(pro).toContain('"people":19')
    // Aggregate only: the nights before the claim are counted, never named.
    for (const id of preClaimNights) expect(pro).not.toContain(id)
  })

  it("holds back a cell under 5, and regulars with their complement when either is under it", async () => {
    const small = await venue("vp-small")
    const regulars = await guests(5, "vp-sreg")
    const once = await guests(2, "vp-sonce")
    await night(small, onWeekday(9, 4, 20), [...regulars, ...once])
    await night(small, onWeekday(16, 5, 20), regulars)
    await night(small, onWeekday(12, 1, 9), regulars.slice(0, 3))
    const view = await venueInsights(small)
    // 5 regulars and 2 who came once: the 5 would give the 2 back, so neither shows.
    expect(view!.recent.regulars).toEqual({ visitors: 7, regulars: null, oneTimers: null, sharePct: null })
    expect(view!.recent.people[1][0]).toBeNull()
    expect(view!.recent.people[4][2]).toBe(7)
  })

  it("is nobody's for an unclaimed venue", async () => {
    expect(await venueInsights(await venue("vp-nobody", { org: null }))).toBeNull()
  })
})

describe("the venue owner's Plan page", () => {
  it("lists the organisation's venues with their plan and readiness, and who may buy", async () => {
    const v = await venue("vp-page")
    await liveSince(v, 10)
    const page = await venuePlanPage({ id: owner, role: "venue_owner" })
    const row = page.venues.find((r) => r.venueId === v)
    expect(row).toMatchObject({ mayBuy: true, pro: null, readiness: { chargeable: false, dataDays: 10 } })
    const asStaff = await venuePlanPage({ id: staff, role: "venue_owner" })
    expect(asStaff.venues.find((r) => r.venueId === v)?.mayBuy).toBe(false)
    const asStranger = await venuePlanPage({ id: stranger, role: "venue_owner" })
    expect(asStranger.venues.find((r) => r.venueId === v)).toBeUndefined()
  })
})
