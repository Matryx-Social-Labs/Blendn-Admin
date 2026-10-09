/*
 * The plan's server actions, called the way Next calls them: as POST
 * endpoints with nothing but a session (TQ-DO08, TQ-X08; review G7, G8, G10).
 *
 *   - Only an owner or admin of the organisation, as an organiser, buys or
 *     cancels; staff, another organisation, a venue owner who owns an org, a
 *     suspended org and a platform admin are refused.
 *   - Starting a purchase writes our record of it and NO entitlement.
 *   - One open purchase: a second start resumes the first, sequentially and
 *     at once; an unpaid pass order is reused.
 *   - Razorpay failing, no keys, a live key outside production: one sentence,
 *     no row.
 *   - Admin grants: admin only, a reason, audited, one live grant, ended all
 *     at once, never hidden behind a paid row; revoking a paid row.
 *
 * Razorpay's API is replaced by a stub `fetch` that records each call.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { randomUUID } from "crypto"

import { resetMemoryStore } from "@/lib/rate-limit-store"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const actions = require("@/lib/billing-actions") as typeof import("@/lib/billing-actions")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
let owner = ""
let orgAdmin = ""
let staff = ""
let outsider = ""
let venueOwner = ""
let suspendedOwner = ""
let admin = ""
let orgId = ""
let eventId = ""
let otherEventId = ""

const calls: { method: string; url: string; body: Record<string, unknown> | undefined }[] = []
const realFetch = global.fetch
let failNext = false

function stubRazorpay() {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ method: init?.method ?? "GET", url, body })
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status })
    if (failNext && init?.method === "POST") {
      failNext = false
      return json(500, { error: { description: "Razorpay is having a bad day" } })
    }
    if (url.includes("/plans")) {
      return json(200, {
        items: [
          { id: "plan_month", period: "monthly", interval: 1, item: { name: "x", amount: 235_900, currency: "INR" }, notes: { key: "analytics_monthly" } },
          { id: "plan_year", period: "yearly", interval: 1, item: { name: "x", amount: 2_358_800, currency: "INR" }, notes: { key: "analytics_yearly" } },
        ],
      })
    }
    if (url.endsWith("/subscriptions")) return json(200, { id: `sub_${randomUUID().slice(0, 12)}`, plan_id: body?.plan_id, status: "created" })
    if (url.includes("/cancel")) return json(200, { id: "sub_x", plan_id: "plan_month", status: "active" })
    if (url.endsWith("/orders")) return json(200, { id: `order_${randomUUID().slice(0, 12)}`, amount: body?.amount, currency: "INR", status: "created" })
    return json(404, { error: { description: "not stubbed" } })
  }) as typeof fetch
}

const as = (id: string, role: "organizer" | "app_admin" | "venue_owner") => mockGetAuth.mockResolvedValue({ user: { id, role } })
const newOrg = async (label: string, status: "verified" | "suspended" = "verified") => {
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId(label), status } })
  orgs.push(org.id)
  return org.id
}
/** Audit rows are written after the response (auditLog); wait for them, never a fixed sleep. */
async function audited(where: { resource_id: string; action: string }, want: number) {
  for (let i = 0; i < 50; i++) {
    const n = await db.audit_logs.count({ where })
    if (n >= want) return n
    await new Promise((r) => setTimeout(r, 40))
  }
  return db.audit_logs.count({ where })
}

beforeAll(async () => {
  owner = await makeUser(testId("bill-owner"), "organizer")
  orgAdmin = await makeUser(testId("bill-orgadmin"), "organizer")
  staff = await makeUser(testId("bill-staff"), "organizer")
  outsider = await makeUser(testId("bill-outsider"), "organizer")
  venueOwner = await makeUser(testId("bill-venue"))
  await db.user.update({ where: { id: venueOwner }, data: { role: "venue_owner" } })
  suspendedOwner = await makeUser(testId("bill-susp"), "organizer")
  admin = await makeUser(testId("bill-admin"), "app_admin")
  users.push(owner, orgAdmin, staff, outsider, venueOwner, suspendedOwner, admin)
  orgId = await newOrg("bill-org")
  const otherOrgId = await newOrg("bill-other")
  const venueOrg = await newOrg("bill-venue-org")
  const suspended = await newOrg("bill-susp-org", "suspended")
  await db.organisation_members.createMany({
    data: [
      { org_id: orgId, user_id: owner, role: "owner" },
      { org_id: orgId, user_id: orgAdmin, role: "admin" },
      { org_id: orgId, user_id: staff, role: "staff" },
      { org_id: otherOrgId, user_id: outsider, role: "owner" },
      { org_id: venueOrg, user_id: venueOwner, role: "owner" },
      { org_id: suspended, user_id: suspendedOwner, role: "owner" },
    ],
  })
  eventId = await makeEvent(owner)
  otherEventId = await makeEvent(outsider)
  events.push(eventId, otherEventId)
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: orgId } })
  await db.events.update({ where: { id: otherEventId }, data: { organizer_org_id: otherOrgId } })
})

beforeEach(() => {
  // Each test starts with a fresh checkout rate limit (5 a minute per org).
  resetMemoryStore()
  calls.length = 0
  failNext = false
  process.env.RAZORPAY_KEY_ID = "rzp_test_itestkey"
  process.env.RAZORPAY_KEY_SECRET = "itest_key_secret_value_24"
  process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_itest_billing_actions_0123456789ab"
  stubRazorpay()
})

afterEach(async () => {
  global.fetch = realFetch
  delete process.env.RAZORPAY_KEY_ID
  delete process.env.RAZORPAY_KEY_SECRET
  delete process.env.RAZORPAY_WEBHOOK_SECRET
  await db.entitlements.deleteMany({ where: { subject_id: { in: orgs } } })
  await db.billing_checkouts.deleteMany({ where: { org_id: { in: orgs } } })
})

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { resource_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, events)
  await closeDb()
})

describe("starting a subscription", () => {
  it("an owner starts one: our record, Razorpay's id, expire_by, and no entitlement", async () => {
    as(owner, "organizer")
    const out = await actions.startAnalyticsCheckout("monthly")
    expect(out).toMatchObject({ kind: "subscription", keyId: "rzp_test_itestkey" })
    const create = calls.find((c) => c.url.endsWith("/subscriptions"))
    expect(create?.body).toMatchObject({ plan_id: "plan_month", total_count: 120 })
    expect(typeof create?.body?.expire_by).toBe("number")
    const row = await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: out.subscriptionId } })
    expect(row).toMatchObject({ org_id: orgId, plan_key: "analytics_monthly", amount_minor: 235_900, provider_plan_id: "plan_month", created_by: owner, status: "created" })
    // The webhook grants; the action never does.
    expect(await db.entitlements.count({ where: { subject_id: orgId } })).toBe(0)
  })

  it("an org admin may start one too", async () => {
    as(orgAdmin, "organizer")
    await expect(actions.startAnalyticsCheckout("yearly")).resolves.toMatchObject({ kind: "subscription" })
  })

  it("a second start while the first is unpaid resumes it: one row, one Razorpay subscription", async () => {
    as(owner, "organizer")
    const first = await actions.startAnalyticsCheckout("monthly")
    const second = await actions.startAnalyticsCheckout("monthly")
    expect(second.subscriptionId).toBe(first.subscriptionId)
    expect(calls.filter((c) => c.url.endsWith("/subscriptions"))).toHaveLength(1)
    expect(await db.billing_checkouts.count({ where: { org_id: orgId, kind: "subscription" } })).toBe(1)
  })

  it("two starts at once still make one open subscription", async () => {
    as(owner, "organizer")
    const [a, b] = await Promise.all([actions.startAnalyticsCheckout("monthly"), actions.startAnalyticsCheckout("monthly")])
    expect(a.subscriptionId).toBe(b.subscriptionId)
    expect(await db.billing_checkouts.count({ where: { org_id: orgId, kind: "subscription", status: "created" } })).toBe(1)
  })

  it("switching period expires the unpaid one rather than opening a second", async () => {
    as(owner, "organizer")
    const monthly = await actions.startAnalyticsCheckout("monthly")
    const yearly = await actions.startAnalyticsCheckout("yearly")
    expect(yearly.subscriptionId).not.toBe(monthly.subscriptionId)
    const rows = await db.billing_checkouts.findMany({ where: { org_id: orgId, kind: "subscription" }, select: { provider_ref: true, status: true } })
    expect(rows.find((r) => r.provider_ref === monthly.subscriptionId)?.status).toBe("expired")
    expect(rows.filter((r) => r.status === "created")).toHaveLength(1)
  })

  it("refuses a second subscription while one is running", async () => {
    as(owner, "organizer")
    const first = await actions.startAnalyticsCheckout("yearly")
    await db.billing_checkouts.updateMany({ where: { provider_ref: first.subscriptionId }, data: { status: "active" } })
    await expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow(/already has an Analytics subscription/)
  })

  it("the database holds one open subscription per organisation even past the lock", async () => {
    await db.billing_checkouts.create({
      data: { kind: "subscription", provider_ref: `sub_${randomUUID()}`, provider_plan_id: "plan_month", org_id: orgId, plan_key: "analytics_monthly", amount_minor: 235_900, status: "active" },
    })
    await expect(
      db.billing_checkouts.create({
        data: { kind: "subscription", provider_ref: `sub_${randomUUID()}`, provider_plan_id: "plan_month", org_id: orgId, plan_key: "analytics_monthly", amount_minor: 235_900, status: "paused" },
      })
    ).rejects.toThrow("billing_checkouts_one_open_subscription_per_org")
  })

  it("Razorpay failing: one sentence, nothing saved", async () => {
    as(owner, "organizer")
    failNext = true
    await expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow("Razorpay didn't accept that just now")
    expect(await db.billing_checkouts.count({ where: { org_id: orgId } })).toBe(0)
  })

  it("five starts a minute, then a refusal", async () => {
    as(outsider, "organizer")
    const outcomes: string[] = []
    for (let i = 0; i < 7; i++) {
      outcomes.push(await actions.startAnalyticsCheckout("monthly").then(() => "ok", (e: Error) => e.message))
    }
    expect(outcomes.slice(0, 5).every((o) => o === "ok")).toBe(true)
    expect(outcomes[5]).toMatch(/Too many tries/)
  })
})

describe("an Event Pass", () => {
  it("an owner buys one for their own event at 58,900 paise, and nothing is granted yet", async () => {
    as(owner, "organizer")
    const out = await actions.startEventPassCheckout(eventId)
    expect(out.amountMinor).toBe(58_900)
    expect(calls.find((c) => c.url.endsWith("/orders"))?.body).toMatchObject({ amount: 58_900, currency: "INR" })
    expect(await db.entitlements.count({ where: { subject_id: orgId } })).toBe(0)
  })

  it("a second start for the same event reuses the unpaid order", async () => {
    as(owner, "organizer")
    const a = await actions.startEventPassCheckout(eventId)
    const b = await actions.startEventPassCheckout(eventId)
    expect(b.orderId).toBe(a.orderId)
    expect(calls.filter((c) => c.url.endsWith("/orders"))).toHaveLength(1)
  })

  it("refuses when Analytics already covers every event", async () => {
    await db.entitlements.create({
      data: { subject_kind: "org", subject_id: orgId, product: "analytics", source: "grant", starts_at: new Date(Date.now() - 1000), expires_at: new Date(Date.now() + 86_400_000) },
    })
    as(owner, "organizer")
    await expect(actions.startEventPassCheckout(eventId)).rejects.toThrow("Analytics already covers every event")
    expect(calls).toHaveLength(0)
  })

  it("refuses when that event already has an Event Pass", async () => {
    await db.entitlements.create({
      data: { subject_kind: "org", subject_id: orgId, product: "event_pass", event_id: eventId, source: "razorpay", external_ref: `order_${randomUUID()}`, starts_at: new Date(Date.now() - 1000) },
    })
    as(owner, "organizer")
    await expect(actions.startEventPassCheckout(eventId)).rejects.toThrow("already has an Event Pass")
    expect(calls).toHaveLength(0)
  })

  it("refuses another organisation's event, and a malformed id, before calling Razorpay", async () => {
    as(owner, "organizer")
    await expect(actions.startEventPassCheckout(otherEventId)).rejects.toThrow(/isn't one of your organisation's/)
    await expect(actions.startEventPassCheckout("not-a-uuid")).rejects.toThrow(/isn't one of your organisation's/)
    expect(calls.filter((c) => c.url.endsWith("/orders"))).toHaveLength(0)
  })
})

describe("who may buy (G7)", () => {
  it.each([
    ["staff", () => as(staff, "organizer"), /owner or admin/],
    ["a venue owner who owns an organisation", () => as(venueOwner, "venue_owner"), /organiser's organisation/],
    ["the owner of a suspended organisation", () => as(suspendedOwner, "organizer"), /organiser's organisation/],
    ["a platform admin", () => as(admin, "app_admin"), /organiser's organisation/],
  ])("refuses %s on every action, with no call out and no row", async (_label, sign, sentence) => {
    sign()
    await expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow(sentence)
    await expect(actions.startEventPassCheckout(eventId)).rejects.toThrow(sentence)
    await expect(actions.cancelAnalytics()).rejects.toThrow(sentence)
    expect(calls).toHaveLength(0)
    expect(await db.billing_checkouts.count({ where: { org_id: orgId } })).toBe(0)
  })

  it("with no keys, or a live key outside production, refuses with one sentence and never calls out", async () => {
    as(owner, "organizer")
    delete process.env.RAZORPAY_KEY_ID
    await expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow("Payments aren't switched on here yet.")
    process.env.RAZORPAY_KEY_ID = "rzp_live_itestkey"
    await expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow("Payments aren't switched on here yet.")
    process.env.RAZORPAY_KEY_ID = "rzp_test_itestkey"
    delete process.env.RAZORPAY_WEBHOOK_SECRET
    await expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow("Payments aren't switched on here yet.")
    expect(calls).toHaveLength(0)
  })
})

describe("cancelling", () => {
  it("an org admin cancels a running subscription at the cycle's end, and the entitlement waits for the webhook", async () => {
    as(owner, "organizer")
    const out = await actions.startAnalyticsCheckout("monthly")
    await db.billing_checkouts.updateMany({ where: { provider_ref: out.subscriptionId }, data: { status: "active" } })
    as(orgAdmin, "organizer")
    await actions.cancelAnalytics()
    expect(calls.find((c) => c.url.includes("/cancel"))?.body).toEqual({ cancel_at_cycle_end: 1 })
    expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: out.subscriptionId } })).cancel_at_cycle_end).toBe(true)
    await expect(actions.cancelAnalytics()).rejects.toThrow(/no subscription to cancel/)
  })
})

describe("admin grants (G8)", () => {
  it("grants six months with a reason, audited, one at a time, and ends them all", async () => {
    as(admin, "app_admin")
    const { expiresAt } = await actions.grantAnalytics(orgId, 6, "Founding organiser, Bengaluru season one")
    const grants = () => db.entitlements.findMany({ where: { subject_id: orgId, source: "grant" } })
    expect((await grants())[0].expires_at?.toISOString()).toBe(expiresAt)
    await expect(actions.grantAnalytics(orgId, 6, "Founding organiser, again please")).rejects.toThrow(/already has a grant/)
    expect(await db.audit_logs.count({ where: { resource_id: orgId, action: "entitlement.granted" } })).toBe(1)

    await actions.endAnalyticsGrant(orgId, "Granted to the wrong organisation")
    expect((await grants()).every((g) => g.expires_at!.getTime() <= Date.now())).toBe(true)
    expect(await audited({ resource_id: orgId, action: "entitlement.grant_ended" }, 1)).toBe(1)
    await expect(actions.endAnalyticsGrant(orgId, "Ending it a second time")).rejects.toThrow(/already ended/)
  })

  it("two grants at once still leave one live grant", async () => {
    as(admin, "app_admin")
    const results = await Promise.allSettled([
      actions.grantAnalytics(orgId, 6, "Founding organiser, Bengaluru A"),
      actions.grantAnalytics(orgId, 6, "Founding organiser, Bengaluru B"),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await db.entitlements.count({ where: { subject_id: orgId, source: "grant", expires_at: { gt: new Date() } } })).toBe(1)
  })

  it("a longer paid row never hides a grant: the second grant is refused and ending ends the grant", async () => {
    await db.entitlements.create({
      data: { subject_kind: "org", subject_id: orgId, product: "analytics", source: "razorpay", external_ref: `sub_${randomUUID()}`, starts_at: new Date(Date.now() - 1000), expires_at: new Date(Date.now() + 400 * 86_400_000) },
    })
    as(admin, "app_admin")
    await actions.grantAnalytics(orgId, 1, "Founding organiser while subscribed")
    await expect(actions.grantAnalytics(orgId, 1, "A second grant on top")).rejects.toThrow(/already has a grant/)
    await actions.endAnalyticsGrant(orgId, "Ending the grant, keeping the paid row")
    const live = await db.entitlements.findMany({ where: { subject_id: orgId, expires_at: { gt: new Date() } }, select: { source: true } })
    expect(live.map((l) => l.source)).toEqual(["razorpay"])
  })

  it("revokes a paid row, audited, and never a grant through that door", async () => {
    const paid = await db.entitlements.create({
      data: { subject_kind: "org", subject_id: orgId, product: "analytics", source: "razorpay", external_ref: `sub_${randomUUID()}`, starts_at: new Date(Date.now() - 1000), expires_at: new Date(Date.now() + 86_400_000) },
    })
    as(admin, "app_admin")
    await actions.grantAnalytics(orgId, 1, "A grant beside the paid row")
    const grant = await db.entitlements.findFirstOrThrow({ where: { subject_id: orgId, source: "grant" } })
    await expect(actions.revokePaidEntitlement(orgId, grant.id, "Trying to revoke a grant")).rejects.toThrow(/isn't a paid one/)
    await actions.revokePaidEntitlement(orgId, paid.id, "Refunded by bank transfer, ticket 42")
    expect((await db.entitlements.findUniqueOrThrow({ where: { id: paid.id } })).expires_at!.getTime()).toBeLessThanOrEqual(Date.now())
    expect(await audited({ resource_id: orgId, action: "entitlement.revoked" }, 1)).toBe(1)
  })

  it("refuses anyone but a platform admin, short or long reasons, and silly lengths", async () => {
    as(owner, "organizer")
    await expect(actions.grantAnalytics(orgId, 6, "I would like it for free please")).rejects.toThrow("Forbidden")
    await expect(actions.endAnalyticsGrant(orgId, "I would like to end it")).rejects.toThrow("Forbidden")
    await expect(actions.revokePaidEntitlement(orgId, randomUUID(), "I would like to end it")).rejects.toThrow("Forbidden")
    as(admin, "app_admin")
    await expect(actions.grantAnalytics(orgId, 6, "short")).rejects.toThrow(/Record why/)
    await expect(actions.grantAnalytics(orgId, 6, "x".repeat(501))).rejects.toThrow(/Record why/)
    await expect(actions.grantAnalytics(orgId, 0, "Founding organiser, Bengaluru")).rejects.toThrow(/between 1 and 24/)
    await expect(actions.grantAnalytics(orgId, 1.5, "Founding organiser, Bengaluru")).rejects.toThrow(/between 1 and 24/)
    await expect(actions.grantAnalytics("not-an-org", 6, "Founding organiser, Bengaluru")).rejects.toThrow(/not found/)
    expect(await db.entitlements.count({ where: { subject_id: orgId } })).toBe(0)
  })
})
