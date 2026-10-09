/*
 * The plan's server actions, called the way Next calls them: as POST
 * endpoints with nothing but a session (TQ-DO08, TQ-X08).
 *
 *   - Only an owner or admin of the organisation buys or cancels; staff,
 *     another organisation and an admin acting as a host are refused.
 *   - Starting a purchase writes our record of it and NO entitlement: the
 *     entitlement comes from the signed webhook only.
 *   - With no Razorpay keys, every purchase is refused with one sentence and
 *     no request leaves the server.
 *   - Admin grants: admin only, a reason, audited, and a grant can be ended.
 *
 * Razorpay's API is replaced by a stub `fetch` that records each call.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const actions = require("@/lib/billing-actions") as typeof import("@/lib/billing-actions")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
let owner = ""
let staff = ""
let outsider = ""
let admin = ""
let orgId = ""
let otherOrgId = ""
let eventId = ""
let otherEventId = ""

const calls: { method: string; url: string; body: unknown }[] = []
const realFetch = global.fetch

function stubRazorpay() {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method: init?.method ?? "GET", url, body })
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status })
    if (url.includes("/plans")) {
      return json(200, {
        items: [
          { id: "plan_month", period: "monthly", interval: 1, item: { name: "x", amount: 235_900, currency: "INR" }, notes: { key: "analytics_monthly" } },
          { id: "plan_year", period: "yearly", interval: 1, item: { name: "x", amount: 2_358_800, currency: "INR" }, notes: { key: "analytics_yearly" } },
        ],
      })
    }
    if (url.endsWith("/subscriptions")) return json(200, { id: `sub_${testId("s")}`, plan_id: body.plan_id, status: "created" })
    if (url.includes("/cancel")) return json(200, { id: "sub_x", plan_id: "plan_month", status: "active" })
    if (url.endsWith("/orders")) return json(200, { id: `order_${testId("o")}`, amount: body.amount, currency: "INR", status: "created" })
    return json(404, { error: { description: "not stubbed" } })
  }) as typeof fetch
}

const as = (id: string, role: "organizer" | "app_admin") => mockGetAuth.mockResolvedValue({ user: { id, role } })

beforeAll(async () => {
  owner = await makeUser(testId("bill-owner"), "organizer")
  staff = await makeUser(testId("bill-staff"), "organizer")
  outsider = await makeUser(testId("bill-outsider"), "organizer")
  admin = await makeUser(testId("bill-admin"), "app_admin")
  users.push(owner, staff, outsider, admin)
  for (const label of ["bill-org", "bill-other"]) {
    const org = await db.organisations.create({ data: { kind: "company", display_name: testId(label), status: "verified" } })
    orgs.push(org.id)
  }
  ;[orgId, otherOrgId] = orgs
  await db.organisation_members.createMany({
    data: [
      { org_id: orgId, user_id: owner, role: "owner" },
      { org_id: orgId, user_id: staff, role: "staff" },
      { org_id: otherOrgId, user_id: outsider, role: "owner" },
    ],
  })
  eventId = await makeEvent(owner)
  otherEventId = await makeEvent(outsider)
  events.push(eventId, otherEventId)
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: orgId } })
  await db.events.update({ where: { id: otherEventId }, data: { organizer_org_id: otherOrgId } })

  // Past the free window: the org's first event with five people ended 60
  // days ago (lib/analytics-access.ts), so an Event Pass has something to open.
  const DAY = 24 * 60 * 60 * 1000
  const pastId = await makeEvent(owner)
  events.push(pastId)
  const start = new Date(Date.now() - 60 * DAY)
  const end = new Date(start.getTime() + 3 * 60 * 60 * 1000)
  await db.events.update({ where: { id: pastId }, data: { organizer_org_id: orgId, start_time: start, end_time: end } })
  const occ = await db.event_occurrences.findFirstOrThrow({ where: { event_id: pastId } })
  for (let i = 0; i < 5; i++) {
    const guest = await makeUser(testId(`bill-guest${i}`))
    users.push(guest)
    await db.event_check_ins.create({
      data: { event_id: pastId, occurrence_id: occ.id, user_id: guest, status: "checked_in", check_in_time: start },
    })
  }
})

beforeEach(() => {
  calls.length = 0
  process.env.RAZORPAY_KEY_ID = "rzp_test_itestkey"
  process.env.RAZORPAY_KEY_SECRET = "itest_key_secret_value"
  stubRazorpay()
})

afterEach(async () => {
  global.fetch = realFetch
  delete process.env.RAZORPAY_KEY_ID
  delete process.env.RAZORPAY_KEY_SECRET
  await db.entitlements.deleteMany({ where: { subject_id: { in: orgs } } })
  await db.billing_checkouts.deleteMany({ where: { org_id: { in: orgs } } })
})

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { resource_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, events)
  await closeDb()
})

describe("starting a purchase", () => {
  it("an owner starts an Analytics subscription: our record, Razorpay's id, and no entitlement", async () => {
    as(owner, "organizer")
    const out = await actions.startAnalyticsCheckout("monthly")
    expect(out).toMatchObject({ kind: "subscription", keyId: "rzp_test_itestkey" })

    const create = calls.find((c) => c.url.endsWith("/subscriptions"))
    expect(create?.body).toMatchObject({ plan_id: "plan_month", total_count: 120 })

    const row = await db.billing_checkouts.findUniqueOrThrow({ where: { provider_ref: out.subscriptionId } })
    expect(row).toMatchObject({ org_id: orgId, plan_key: "analytics_monthly", amount_minor: 235_900, provider_plan_id: "plan_month", created_by: owner })
    // The webhook grants; the action never does.
    expect(await db.entitlements.count({ where: { subject_id: orgId } })).toBe(0)
  })

  it("refuses a second subscription while one is running", async () => {
    as(owner, "organizer")
    const first = await actions.startAnalyticsCheckout("yearly")
    await db.billing_checkouts.update({ where: { provider_ref: first.subscriptionId }, data: { status: "active" } })
    await expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow(/already has an Analytics subscription/)
  })

  it("an owner buys an Event Pass for their own event at ₹589, and nothing is granted yet", async () => {
    as(owner, "organizer")
    const out = await actions.startEventPassCheckout(eventId)
    expect(out.amountMinor).toBe(58_900)
    expect(calls.find((c) => c.url.endsWith("/orders"))?.body).toMatchObject({ amount: 58_900, currency: "INR" })
    expect(await db.billing_checkouts.count({ where: { provider_ref: out.orderId, event_id: eventId } })).toBe(1)
    expect(await db.entitlements.count({ where: { subject_id: orgId } })).toBe(0)
  })

  it("refuses another organisation's event as if it were not there, before calling Razorpay", async () => {
    as(owner, "organizer")
    await expect(actions.startEventPassCheckout(otherEventId)).rejects.toThrow(/isn't one of your organisation's/)
    expect(calls.filter((c) => c.url.endsWith("/orders"))).toHaveLength(0)
  })

  it("refuses staff, with a sentence naming who can", async () => {
    as(staff, "organizer")
    await expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow(/owner or admin/)
    await expect(actions.startEventPassCheckout(eventId)).rejects.toThrow(/owner or admin/)
    await expect(actions.cancelAnalytics()).rejects.toThrow(/owner or admin/)
    expect(calls).toHaveLength(0)
    expect(await db.billing_checkouts.count({ where: { org_id: orgId } })).toBe(0)
  })

  it("refuses a platform admin acting as a buyer", async () => {
    as(admin, "app_admin")
    await expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow(/organiser's organisation/)
    expect(calls).toHaveLength(0)
  })

  it("with no keys, refuses with one sentence and never calls out", async () => {
    delete process.env.RAZORPAY_KEY_ID
    delete process.env.RAZORPAY_KEY_SECRET
    as(owner, "organizer")
    await expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow("Payments aren't switched on here yet.")
    expect(calls).toHaveLength(0)
  })

  it("refuses a live key outside production rather than charging real money", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_live_itestkey"
    as(owner, "organizer")
    await expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow("Payments aren't switched on here yet.")
    expect(calls).toHaveLength(0)
  })
})

describe("cancelling", () => {
  it("cancels a running subscription at the cycle's end and leaves the entitlement to the webhook", async () => {
    as(owner, "organizer")
    const out = await actions.startAnalyticsCheckout("monthly")
    await db.billing_checkouts.update({ where: { provider_ref: out.subscriptionId }, data: { status: "active" } })
    await actions.cancelAnalytics()
    expect(calls.find((c) => c.url.includes("/cancel"))?.body).toEqual({ cancel_at_cycle_end: 1 })
    const row = await db.billing_checkouts.findUniqueOrThrow({ where: { provider_ref: out.subscriptionId } })
    expect(row.cancel_at_cycle_end).toBe(true)
    await expect(actions.cancelAnalytics()).rejects.toThrow(/already set to end/)
  })
})

describe("admin grants", () => {
  it("grants six months with a reason, audited, and ends it", async () => {
    as(admin, "app_admin")
    const { expiresAt } = await actions.grantAnalytics(orgId, 6, "Founding organiser, Bengaluru season one")
    const [grant] = await db.entitlements.findMany({ where: { subject_id: orgId, source: "grant" } })
    expect(grant).toMatchObject({ product: "analytics", subject_kind: "org" })
    expect(grant.expires_at?.toISOString()).toBe(expiresAt)
    await expect(actions.grantAnalytics(orgId, 6, "Founding organiser, again please")).rejects.toThrow(/already has a grant/)

    await actions.endAnalyticsGrant(orgId, grant.id, "Granted to the wrong organisation")
    const ended = await db.entitlements.findUniqueOrThrow({ where: { id: grant.id } })
    expect(ended.expires_at!.getTime()).toBeLessThanOrEqual(Date.now())

    await new Promise((r) => setTimeout(r, 200))
    const audit = await db.audit_logs.findMany({ where: { resource_id: orgId, user_id: admin }, select: { action: true } })
    expect(audit.map((a) => a.action).sort()).toEqual(["entitlement.grant_ended", "entitlement.granted"])
  })

  it("refuses anyone but a platform admin, a missing reason, and silly lengths", async () => {
    as(owner, "organizer")
    await expect(actions.grantAnalytics(orgId, 6, "I would like it for free please")).rejects.toThrow("Forbidden")
    as(admin, "app_admin")
    await expect(actions.grantAnalytics(orgId, 6, "short")).rejects.toThrow(/Record why/)
    await expect(actions.grantAnalytics(orgId, 0, "Founding organiser, Bengaluru")).rejects.toThrow(/between 1 and 24/)
    await expect(actions.grantAnalytics(orgId, 1.5, "Founding organiser, Bengaluru")).rejects.toThrow(/between 1 and 24/)
    expect(await db.entitlements.count({ where: { subject_id: orgId } })).toBe(0)
  })
})
