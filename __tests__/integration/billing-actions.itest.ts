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
 *   - When one side fails (scan 3): Razorpay refusing, and the database
 *     refusing after Razorpay said yes, for every action that writes both —
 *     the final row, the audit, and that no access is left open. The role is
 *     the database's, not the session's.
 *
 * Razorpay's API is replaced by a stub `fetch` that records each call.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { createHmac, randomUUID } from "crypto"
import { NextRequest } from "next/server"

import { logger } from "@/lib/logger"
import { resetMemoryStore } from "@/lib/rate-limit-store"

import { cleanup, closeDb, db, makeEvent, makeUser, refusingWrites as refusing, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const actions = require("@/lib/billing-actions") as typeof import("@/lib/billing-actions")
const route = require("@/app/api/webhooks/razorpay/route") as typeof import("@/app/api/webhooks/razorpay/route")
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
/** Every id Razorpay handed back, newest last. */
const made: string[] = []
const WEBHOOK_SECRET = "whsec_itest_billing_actions_0123456789ab"

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
    if (url.endsWith("/subscriptions")) {
      made.push(`sub_${randomUUID().slice(0, 12)}`)
      return json(200, { id: made.at(-1), plan_id: body?.plan_id, status: "created" })
    }
    if (url.includes("/cancel")) return json(200, { id: "sub_x", plan_id: "plan_month", status: "active" })
    if (url.endsWith("/orders")) {
      made.push(`order_${randomUUID().slice(0, 12)}`)
      return json(200, { id: made.at(-1), amount: body?.amount, currency: "INR", status: "created" })
    }
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
  // Each test starts with a fresh checkout rate limit (5 a minute per org).
  resetMemoryStore()
  calls.length = 0
  failNext = false
  process.env.RAZORPAY_KEY_ID = "rzp_test_itestkey"
  process.env.RAZORPAY_KEY_SECRET = "itest_key_secret_value_24"
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET
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
  await db.payment_events.deleteMany({ where: { provider_event_id: { startsWith: "itest_ba_" } } })
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

describe("when one side fails (scan 3)", () => {
  let errors: jest.SpyInstance
  beforeEach(() => {
    errors = jest.spyOn(logger, "error").mockImplementation(() => undefined)
  })
  afterEach(() => errors.mockRestore())
  const logged = (key: string, value: string) => errors.mock.calls.some(([, meta]) => (meta as Record<string, unknown> | undefined)?.[key] === value)
  const auditsSince = (since: Date, action: string) => db.audit_logs.count({ where: { resource_id: orgId, action, created_at: { gte: since } } })

  /** A running Analytics subscription with its paid entitlement, as the webhook leaves it. */
  async function running() {
    const ref = `sub_${randomUUID().slice(0, 12)}`
    await db.billing_checkouts.create({
      data: { kind: "subscription", provider_ref: ref, provider_plan_id: "plan_month", org_id: orgId, plan_key: "analytics_monthly", amount_minor: 235_900, status: "active", current_end: new Date(Date.now() + 20 * 86_400_000) },
    })
    const ent = await db.entitlements.create({
      data: { subject_kind: "org", subject_id: orgId, product: "analytics", source: "razorpay", external_ref: ref, starts_at: new Date(Date.now() - 86_400_000), expires_at: new Date(Date.now() + 23 * 86_400_000) },
    })
    return { ref, ent }
  }

  describe("starting a subscription", () => {
    it("Razorpay refuses: no row, no audit, nothing granted", async () => {
      const t0 = new Date()
      as(owner, "organizer")
      failNext = true
      await expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow("Razorpay didn't accept that just now")
      expect(await db.billing_checkouts.count({ where: { org_id: orgId } })).toBe(0)
      expect(await auditsSince(t0, "billing.checkout.started")).toBe(0)
      expect(await db.entitlements.count({ where: { subject_id: orgId } })).toBe(0)
    })

    it("the database refuses after Razorpay made it: no row, and Razorpay's subscription is cancelled and logged", async () => {
      const t0 = new Date()
      as(owner, "organizer")
      await refusing("billing_checkouts", "INSERT", `NEW.org_id::text = '${orgId}'`, () =>
        expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow("Nothing was started")
      )
      const orphan = made.at(-1)!
      expect(orphan).toMatch(/^sub_/)
      expect(await db.billing_checkouts.count({ where: { org_id: orgId } })).toBe(0)
      expect(await auditsSince(t0, "billing.checkout.started")).toBe(0)
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith(`/subscriptions/${orphan}/cancel`))).toBe(true)
      expect(logged("orphanProviderRef", orphan)).toBe(true)
      expect(await db.entitlements.count({ where: { subject_id: orgId } })).toBe(0)
    })

    it("its audit row is refused: the checkout is not saved either (one transaction)", async () => {
      as(owner, "organizer")
      await refusing("audit_logs", "INSERT", `NEW.action = 'billing.checkout.started' AND NEW.resource_id = '${orgId}'`, () =>
        expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow("Nothing was started")
      )
      expect(await db.billing_checkouts.count({ where: { org_id: orgId } })).toBe(0)
      expect(calls.some((c) => c.url.endsWith(`/subscriptions/${made.at(-1)}/cancel`))).toBe(true)
    })
  })

  describe("starting an Event Pass", () => {
    it("Razorpay refuses: no order row, no audit, nothing granted", async () => {
      const t0 = new Date()
      as(owner, "organizer")
      failNext = true
      await expect(actions.startEventPassCheckout(eventId)).rejects.toThrow("Razorpay didn't accept that just now")
      expect(await db.billing_checkouts.count({ where: { org_id: orgId } })).toBe(0)
      expect(await auditsSince(t0, "billing.checkout.started")).toBe(0)
      expect(await db.entitlements.count({ where: { subject_id: orgId } })).toBe(0)
    })

    it("the database refuses after Razorpay made the order: no row, the orphan's id logged, nothing granted", async () => {
      as(owner, "organizer")
      await refusing("billing_checkouts", "INSERT", `NEW.org_id::text = '${orgId}'`, () =>
        expect(actions.startEventPassCheckout(eventId)).rejects.toThrow("Nothing was started")
      )
      const orphan = made.at(-1)!
      expect(orphan).toMatch(/^order_/)
      expect(await db.billing_checkouts.count({ where: { org_id: orgId } })).toBe(0)
      expect(logged("orphanProviderRef", orphan)).toBe(true)
      expect(await db.entitlements.count({ where: { subject_id: orgId } })).toBe(0)
    })
  })

  describe("cancelling (cancelAnalytics; cancelVenuePro shares cancelOpen)", () => {
    it("Razorpay refuses: still open here, no audit, and the entitlement neither ended nor stretched", async () => {
      const { ref, ent } = await running()
      const t0 = new Date()
      as(owner, "organizer")
      failNext = true
      await expect(actions.cancelAnalytics()).rejects.toThrow("Nothing was cancelled")
      expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: ref } })).cancel_at_cycle_end).toBe(false)
      expect(await auditsSince(t0, "billing.subscription.cancelled")).toBe(0)
      expect((await db.entitlements.findUniqueOrThrow({ where: { id: ent.id } })).expires_at).toEqual(ent.expires_at)
      expect(logged("providerRef", ref)).toBe(true)
    })

    it("the database refuses after Razorpay cancelled: refused, logged with the id, and Razorpay's webhook settles it", async () => {
      const { ref, ent } = await running()
      const t0 = new Date()
      as(owner, "organizer")
      await refusing("billing_checkouts", "UPDATE", `NEW.provider_ref = '${ref}'`, () =>
        expect(actions.cancelAnalytics()).rejects.toThrow("Razorpay has stopped it")
      )
      expect(calls.some((c) => c.url.endsWith(`/subscriptions/${ref}/cancel`))).toBe(true)
      expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: ref } })).cancel_at_cycle_end).toBe(false)
      expect(await auditsSince(t0, "billing.subscription.cancelled")).toBe(0)
      expect(logged("providerRef", ref)).toBe(true)

      // Razorpay's subscription.cancelled, at the cycle's end, is the repair.
      const endedAt = Math.floor(Date.now() / 1000) - 5
      const raw = JSON.stringify({
        event: "subscription.cancelled",
        created_at: endedAt,
        payload: { subscription: { entity: { id: ref, plan_id: "plan_month", status: "cancelled", ended_at: endedAt } } },
      })
      const res = await route.POST(
        new NextRequest("http://localhost/api/webhooks/razorpay", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-real-ip": "203.0.113.12",
            "x-razorpay-signature": createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex"),
            "x-razorpay-event-id": `itest_ba_${randomUUID()}`,
          },
          body: raw,
        })
      )
      expect(res.status).toBe(200)
      expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: ref } })).status).toBe("cancelled")
      const after = await db.entitlements.findUniqueOrThrow({ where: { id: ent.id } })
      expect(after.expires_at!.getTime()).toBeLessThanOrEqual(endedAt * 1000)
    })

    it("its audit row is refused: the cancel is not recorded either (one transaction)", async () => {
      const { ref } = await running()
      as(owner, "organizer")
      await refusing("audit_logs", "INSERT", `NEW.action = 'billing.subscription.cancelled' AND NEW.resource_id = '${orgId}'`, () =>
        expect(actions.cancelAnalytics()).rejects.toThrow("Razorpay has stopped it")
      )
      expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: ref } })).cancel_at_cycle_end).toBe(false)
    })
  })

  describe("an admin ending or revoking (no Razorpay call)", () => {
    it("ending a grant whose audit is refused leaves the grant live and says so", async () => {
      as(admin, "app_admin")
      await actions.grantAnalytics(orgId, 1, "Founding organiser, for the failure test")
      await refusing("audit_logs", "INSERT", `NEW.action = 'entitlement.grant_ended' AND NEW.resource_id = '${orgId}'`, () =>
        expect(actions.endAnalyticsGrant(orgId, "Ending it while the audit is down")).rejects.toThrow()
      )
      expect(await db.entitlements.count({ where: { subject_id: orgId, source: "grant", expires_at: { gt: new Date() } } })).toBe(1)
    })

    it("revoking a paid row whose audit is refused leaves it live and says so", async () => {
      const { ent } = await running()
      as(admin, "app_admin")
      await refusing("audit_logs", "INSERT", `NEW.action = 'entitlement.revoked' AND NEW.resource_id = '${orgId}'`, () =>
        expect(actions.revokePaidEntitlement(orgId, ent.id, "Refunded by bank transfer, ticket 43")).rejects.toThrow()
      )
      expect((await db.entitlements.findUniqueOrThrow({ where: { id: ent.id } })).expires_at).toEqual(ent.expires_at)
    })
  })

  describe("the role is the database's, not the session's (review LOW 18)", () => {
    it("a session claiming app_admin for an organiser grants nothing", async () => {
      as(owner, "app_admin")
      await expect(actions.grantAnalytics(orgId, 6, "A stale or forged admin claim")).rejects.toThrow("Forbidden")
      expect(await db.entitlements.count({ where: { subject_id: orgId } })).toBe(0)
    })

    it("a buyer demoted, or suspended, since the session began buys nothing", async () => {
      const demoted = await makeUser(testId("bill-demoted"), "organizer")
      users.push(demoted)
      await db.organisation_members.create({ data: { org_id: orgId, user_id: demoted, role: "owner" } })
      await db.user.update({ where: { id: demoted }, data: { role: "attendee" } })
      as(demoted, "organizer")
      await expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow(/organiser's organisation/)
      await db.user.update({ where: { id: demoted }, data: { role: "organizer", suspended_at: new Date() } })
      await expect(actions.startAnalyticsCheckout("monthly")).rejects.toThrow("Unauthorized")
      expect(calls).toHaveLength(0)
      await db.organisation_members.deleteMany({ where: { user_id: demoted } })
    })
  })
})
