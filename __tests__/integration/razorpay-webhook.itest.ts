/*
 * The Razorpay webhook, through the real route, against real Postgres
 * (TQ-A15 / TQ-X08: MN-U02 end to end, MN-I01..I03, MN-I05 for an org,
 * SEC-13, SEC-14, SEC-18; review G4, G5, G15).
 *
 * Signatures are computed here with a test secret, the way Razorpay computes
 * them: HMAC-SHA256 of the raw body. Every case reads the rows back.
 */
import { createHmac, randomUUID } from "crypto"
import { NextRequest } from "next/server"

import { hasEntitlement } from "@/lib/entitlements"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const route = require("@/app/api/webhooks/razorpay/route") as typeof import("@/app/api/webhooks/razorpay/route")
const entitlementsModule = require("@/lib/entitlements") as typeof import("@/lib/entitlements")
/* eslint-enable @typescript-eslint/no-require-imports */

const SECRET = "whsec_itest_razorpay_webhook_secret_0123456789"
const PLAN_ID = "plan_itest_monthly"
const T0 = Math.floor(Date.parse("2026-10-03T10:00:00Z") / 1000)
const MONTH = 30 * 24 * 60 * 60
/** The renewal grace, written out: three days in milliseconds. */
const GRACE_MS = 259_200_000

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
let orgId = ""
let strangerOrgId = ""
let eventId = ""

beforeAll(async () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET
  const host = await makeUser(testId("rzp-host"), "organizer")
  users.push(host)
  for (const label of ["rzp-org", "rzp-stranger"]) {
    const org = await db.organisations.create({ data: { kind: "company", display_name: testId(label), status: "verified" } })
    orgs.push(org.id)
  }
  ;[orgId, strangerOrgId] = orgs
  eventId = await makeEvent(host)
  events.push(eventId)
})

afterAll(async () => {
  delete process.env.RAZORPAY_WEBHOOK_SECRET
  await db.payment_events.deleteMany({ where: { provider_event_id: { startsWith: "itest_evt_" } } })
  await db.billing_payments.deleteMany({ where: { checkout: { org_id: { in: orgs } } } })
  await db.entitlements.deleteMany({ where: { subject_id: { in: orgs } } })
  await db.billing_checkouts.deleteMany({ where: { org_id: { in: orgs } } })
  await db.audit_logs.deleteMany({ where: { resource_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, events)
  await closeDb()
})

/** Each subscription in its own organisation: one open subscription per org is a database rule. */
const orgOfRef = new Map<string, string>()
async function subscriptionCheckout(amountMinor = 235_900) {
  const ref = `sub_${randomUUID().slice(0, 12)}`
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("rzp-sub"), status: "verified" } })
  orgs.push(org.id)
  orgOfRef.set(ref, org.id)
  await db.billing_checkouts.create({
    data: { kind: "subscription", provider_ref: ref, provider_plan_id: PLAN_ID, org_id: org.id, plan_key: "analytics_monthly", amount_minor: amountMinor },
  })
  return ref
}

/** An Event Pass order, for its own event unless one is named: a pass is one per (org, event). */
async function orderCheckout(event?: string) {
  if (!event) {
    event = await makeEvent(users[0])
    events.push(event)
  }
  const ref = `order_${randomUUID().slice(0, 12)}`
  await db.billing_checkouts.create({
    data: { kind: "order", provider_ref: ref, org_id: orgId, event_id: event, plan_key: "event_pass", amount_minor: 58_900 },
  })
  return ref
}

function subscriptionEvent(
  type: string,
  subId: string,
  opts: { at?: number; amount?: number; currency?: string; status?: string; planId?: string; endedAt?: number | null; paymentId?: string; currentEnd?: number } = {}
) {
  const at = opts.at ?? T0
  return {
    entity: "event",
    account_id: "acc_itest",
    event: type,
    contains: ["subscription", "payment"],
    payload: {
      subscription: {
        entity: {
          id: subId,
          entity: "subscription",
          plan_id: opts.planId ?? PLAN_ID,
          status: opts.status ?? "active",
          start_at: T0,
          current_start: at,
          current_end: opts.currentEnd ?? at + MONTH,
          ended_at: opts.endedAt ?? null,
          // A reader that trusted notes would grant the stranger.
          notes: { org_id: strangerOrgId },
        },
      },
      payment: {
        entity: {
          id: opts.paymentId ?? `pay_${randomUUID().slice(0, 10)}`,
          entity: "payment",
          amount: opts.amount ?? 235_900,
          currency: opts.currency ?? "INR",
          status: "captured",
          invoice_id: `inv_${randomUUID().slice(0, 10)}`,
          email: "payer@example.com",
          contact: "+919999999999",
        },
      },
    },
    created_at: at,
  }
}

function orderPaid(orderId: string, opts: { amount?: number; paid?: number; currency?: string; status?: string; at?: number; paymentId?: string } = {}) {
  const amount = opts.amount ?? 58_900
  return {
    entity: "event",
    event: "order.paid",
    payload: {
      order: { entity: { id: orderId, amount, amount_paid: opts.paid ?? amount, currency: opts.currency ?? "INR", status: opts.status ?? "paid", notes: { org_id: strangerOrgId } } },
      payment: { entity: { id: opts.paymentId ?? `pay_${randomUUID().slice(0, 10)}`, amount, currency: opts.currency ?? "INR", order_id: orderId } },
    },
    created_at: opts.at ?? T0,
  }
}

const refundEvent = (paymentId: string, amount: number, at: number) => ({
  entity: "event",
  event: "refund.processed",
  payload: { refund: { entity: { id: `rfnd_${randomUUID().slice(0, 8)}`, payment_id: paymentId, amount, currency: "INR", status: "processed" } } },
  created_at: at,
})

const disputeEvent = (type: string, paymentId: string, at: number) => ({
  entity: "event",
  event: type,
  payload: { dispute: { entity: { id: `disp_${randomUUID().slice(0, 8)}`, payment_id: paymentId, amount: 58_900, currency: "INR", status: "open" } } },
  created_at: at,
})

const newEventId = () => `itest_evt_${randomUUID()}`

function post(
  body: unknown,
  opts: { eventId?: string; secret?: string; signature?: string | null; tamper?: (raw: string) => string; ip?: string } = {}
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body)
  const signature =
    opts.signature === undefined ? createHmac("sha256", opts.secret ?? SECRET).update(raw).digest("hex") : opts.signature
  const headers: Record<string, string> = { "content-type": "application/json", "x-real-ip": opts.ip ?? "203.0.113.10" }
  if (signature !== null) headers["x-razorpay-signature"] = signature
  headers["x-razorpay-event-id"] = opts.eventId ?? newEventId()
  return route.POST(
    new NextRequest("http://localhost/api/webhooks/razorpay", { method: "POST", headers, body: opts.tamper ? opts.tamper(raw) : raw })
  )
}

const entitlementsFor = (ref: string) => db.entitlements.findMany({ where: { external_ref: ref } })
const deliveries = (id: string) => db.payment_events.findMany({ where: { provider_event_id: id } })
const expiryOf = async (ref: string) => (await entitlementsFor(ref))[0]?.expires_at?.getTime() ?? null

describe("a delivery that is not Razorpay's writes nothing (SEC-13)", () => {
  it.each([
    ["signed with another secret", { secret: "an_entirely_different_secret_0123456789" }],
    ["unsigned", { signature: null }],
    ["a garbage signature", { signature: "deadbeef" }],
    ["changed after signing", { tamper: (raw: string) => raw.replace("235900", "1") }],
  ])("%s → 401, and no row", async (_label, opts) => {
    const sub = await subscriptionCheckout()
    const id = newEventId()
    const res = await post(subscriptionEvent("subscription.charged", sub), { ...opts, eventId: id })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "unauthorized" })
    expect(await deliveries(id)).toHaveLength(0)
    expect(await entitlementsFor(sub)).toHaveLength(0)
  })

  it("refuses everything when the webhook secret is not configured", async () => {
    const sub = await subscriptionCheckout()
    delete process.env.RAZORPAY_WEBHOOK_SECRET
    try {
      expect((await post(subscriptionEvent("subscription.charged", sub))).status).toBe(401)
    } finally {
      process.env.RAZORPAY_WEBHOOK_SECRET = SECRET
    }
    expect(await entitlementsFor(sub)).toHaveLength(0)
  })

  it.each([
    ["not JSON", "not json at all"],
    ["JSON without an event", JSON.stringify({ created_at: T0 })],
    ["JSON without a time", JSON.stringify({ event: "order.paid" })],
  ])("answers a signed body that is %s with 400 and records nothing", async (_label, body) => {
    const id = newEventId()
    expect((await post(body, { eventId: id })).status).toBe(400)
    expect(await deliveries(id)).toHaveLength(0)
  })

  it("refuses a body over 256 KB before reading the rest", async () => {
    const id = newEventId()
    const res = await post({ event: "x", created_at: T0, pad: "a".repeat(300 * 1024) }, { eventId: id })
    expect(res.status).toBe(413)
    expect(await deliveries(id)).toHaveLength(0)
  })
})

describe("a charged subscription grants Analytics, once (MN-I01, SEC-14, G4)", () => {
  it("writes the org's entitlement to the paid-up date plus three days, the payment, the delivery and the audit, in one go", async () => {
    const sub = await subscriptionCheckout()
    const id = newEventId()
    const paymentId = `pay_${randomUUID().slice(0, 10)}`
    const res = await post(subscriptionEvent("subscription.charged", sub, { paymentId }), { eventId: id })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, duplicate: false, applied: true })

    const [ent] = await entitlementsFor(sub)
    expect(ent).toMatchObject({ subject_kind: "org", subject_id: orgOfRef.get(sub), product: "analytics", source: "razorpay" })
    expect(ent.expires_at?.getTime()).toBe((T0 + MONTH) * 1000 + GRACE_MS)
    // Never the org that `notes` named.
    expect(await db.entitlements.count({ where: { subject_id: strangerOrgId } })).toBe(0)

    const [row] = await deliveries(id)
    expect(row.processed_at).not.toBeNull()
    expect(row.error).toBeNull()
    expect(row.body_sha256).toMatch(/^[0-9a-f]{64}$/)
    // Redacted: the payer's email and phone were never stored.
    expect(JSON.stringify(row.payload)).not.toContain("payer@example.com")
    expect(JSON.stringify(row.payload)).not.toContain("9999999999")

    const payment = await db.billing_payments.findUniqueOrThrow({
      where: { provider_provider_payment_id: { provider: "razorpay", provider_payment_id: paymentId } },
    })
    expect(payment).toMatchObject({ amount_minor: 235_900, currency: "INR", status: "captured" })
    // The audit row is written in the same transaction: no waiting.
    const audit = await db.audit_logs.findMany({ where: { resource_id: orgOfRef.get(sub), action: "entitlement.paid" } })
    expect(audit.filter((a) => (a.details as { externalRef?: string }).externalRef === sub)).toHaveLength(1)
  })

  it("replays the same event id as a no-op, and the same body under a new event id too", async () => {
    const sub = await subscriptionCheckout()
    const id = newEventId()
    const body = subscriptionEvent("subscription.charged", sub)
    await post(body, { eventId: id })
    expect(await (await post(body, { eventId: id })).json()).toMatchObject({ duplicate: true, applied: false })
    expect(await (await post(body)).json()).toMatchObject({ duplicate: true, applied: false })
    expect(await deliveries(id)).toHaveLength(1)
    expect(await entitlementsFor(sub)).toHaveLength(1)
    expect(await db.audit_logs.count({ where: { resource_id: orgOfRef.get(sub), action: "entitlement.paid", details: { path: ["externalRef"], equals: sub } } })).toBe(1)
  })

  it.each([
    ["subscription.charged", (ref: string) => subscriptionEvent("subscription.charged", ref)],
    ["subscription.halted", (ref: string) => subscriptionEvent("subscription.halted", ref, { status: "halted", at: T0 + 60 })],
  ])("delivered twice at once (%s): one row, one change, no 500", async (_label, make) => {
    const sub = await subscriptionCheckout()
    if (_label === "subscription.halted") await post(subscriptionEvent("subscription.charged", sub))
    const id = newEventId()
    const body = make(sub)
    const answers = await Promise.all([post(body, { eventId: id }), post(body, { eventId: id }), post(body, { eventId: id })])
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200])
    const results = await Promise.all(answers.map((a) => a.json()))
    expect(results.filter((r) => r.duplicate === false)).toHaveLength(1)
    expect(await deliveries(id)).toHaveLength(1)
    expect(await entitlementsFor(sub)).toHaveLength(1)
  })

  it("order.paid delivered twice at once: one pass, one audit row", async () => {
    const order = await orderCheckout()
    const id = newEventId()
    const body = orderPaid(order)
    const answers = await Promise.all([post(body, { eventId: id }), post(body, { eventId: id })])
    expect(answers.map((a) => a.status)).toEqual([200, 200])
    expect(await entitlementsFor(order)).toHaveLength(1)
    expect(await db.audit_logs.count({ where: { action: "entitlement.paid", details: { path: ["externalRef"], equals: order } } })).toBe(1)
  })

  it("a renewal moves the end of the same row", async () => {
    const sub = await subscriptionCheckout()
    await post(subscriptionEvent("subscription.charged", sub))
    await post(subscriptionEvent("subscription.charged", sub, { at: T0 + MONTH }))
    const rows = await entitlementsFor(sub)
    expect(rows).toHaveLength(1)
    expect(rows[0].expires_at?.getTime()).toBe((T0 + 2 * MONTH) * 1000 + GRACE_MS)
  })

  it("a failure while applying rolls the claim back, so Razorpay's retry applies it", async () => {
    const sub = await subscriptionCheckout()
    const id = newEventId()
    const body = subscriptionEvent("subscription.charged", sub)
    const spy = jest.spyOn(entitlementsModule, "recordPaidEntitlement").mockRejectedValueOnce(new Error("database went away"))
    try {
      await expect(post(body, { eventId: id })).rejects.toThrow("database went away")
    } finally {
      spy.mockRestore()
    }
    expect(await deliveries(id)).toHaveLength(0)
    expect(await (await post(body, { eventId: id })).json()).toMatchObject({ duplicate: false, applied: true })
    expect(await entitlementsFor(sub)).toHaveLength(1)
  })
})

describe("held to what this server asked for (MN-I02)", () => {
  it.each([
    ["an amount other than the checkout's", { amount: 199_900 }],
    ["another currency", { currency: "USD" }],
    ["another plan", { planId: "plan_someone_elses" }],
  ])("%s → recorded, refused, no entitlement, and refused again on replay", async (_label, opts) => {
    const sub = await subscriptionCheckout()
    const id = newEventId()
    const body = subscriptionEvent("subscription.charged", sub, opts)
    const first = await (await post(body, { eventId: id })).json()
    expect(first.applied).toBe(false)
    expect(["amount_mismatch", "plan_mismatch"]).toContain(first.refused)
    expect(await entitlementsFor(sub)).toHaveLength(0)
    const [row] = await deliveries(id)
    expect(row.processed_at).toBeNull()
    expect(row.error).toBe(first.refused)
    // A replay of a refusal stays a refusal: nothing is applied the second time.
    expect(await (await post(body, { eventId: id })).json()).toMatchObject({ duplicate: true, applied: false })
    expect(await entitlementsFor(sub)).toHaveLength(0)
  })

  it("an old subscriber's renewal at the price they bought at is applied, whatever the table says today", async () => {
    const sub = await subscriptionCheckout(199_900)
    const res = await (await post(subscriptionEvent("subscription.charged", sub, { amount: 199_900 }))).json()
    expect(res).toMatchObject({ applied: true })
    expect(await entitlementsFor(sub)).toHaveLength(1)
  })
})

describe("a reference we did not start is never trusted (MN-I03)", () => {
  it("an unknown subscription → 200, recorded as unknown_ref, nothing granted to anyone", async () => {
    const id = newEventId()
    const res = await post(subscriptionEvent("subscription.charged", "sub_nobody_started_this"), { eventId: id })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ applied: false, refused: "unknown_ref" })
    expect(await db.entitlements.count({ where: { external_ref: "sub_nobody_started_this" } })).toBe(0)
    expect((await deliveries(id))[0].error).toBe("unknown_ref")
  })
})

describe("the lifecycle, on Razorpay's clock (MN-I05, G5)", () => {
  it("a halt ends Analytics at the halt", async () => {
    const sub = await subscriptionCheckout()
    await post(subscriptionEvent("subscription.charged", sub, { at: T0 }))
    const haltAt = T0 + 10 * 86400
    await post(subscriptionEvent("subscription.halted", sub, { at: haltAt, status: "halted" }))
    expect(await expiryOf(sub)).toBe(haltAt * 1000)
    expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: sub } })).status).toBe("halted")
  })

  it("a halt, then a newer charge, gives access back", async () => {
    const sub = await subscriptionCheckout()
    await post(subscriptionEvent("subscription.charged", sub, { at: T0 }))
    await post(subscriptionEvent("subscription.halted", sub, { at: T0 + 100, status: "halted" }))
    await post(subscriptionEvent("subscription.charged", sub, { at: T0 + 200 }))
    expect(await expiryOf(sub)).toBe((T0 + 200 + MONTH) * 1000 + GRACE_MS)
    expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: sub } })).status).toBe("active")
  })

  it("a late, older halt after a newer charge changes nothing", async () => {
    const sub = await subscriptionCheckout()
    await post(subscriptionEvent("subscription.charged", sub, { at: T0 + 200 }))
    await post(subscriptionEvent("subscription.halted", sub, { at: T0 + 100, status: "halted" }))
    expect(await expiryOf(sub)).toBe((T0 + 200 + MONTH) * 1000 + GRACE_MS)
    expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: sub } })).status).toBe("active")
  })

  it("a charge that arrives after the activation it followed is still applied (no 'stale' refusal)", async () => {
    const sub = await subscriptionCheckout()
    await post(subscriptionEvent("subscription.activated", sub, { at: T0 + 5 }))
    const res = await (await post(subscriptionEvent("subscription.charged", sub, { at: T0 }))).json()
    expect(res).toMatchObject({ applied: true })
    expect(await expiryOf(sub)).toBe((T0 + MONTH) * 1000 + GRACE_MS)
  })

  it("same second: the halt after the charge ends it; the charge after the halt restores it", async () => {
    const a = await subscriptionCheckout()
    await post(subscriptionEvent("subscription.charged", a, { at: T0 + 50 }))
    await post(subscriptionEvent("subscription.halted", a, { at: T0 + 50, status: "halted" }))
    expect(await expiryOf(a)).toBe((T0 + 50) * 1000)

    const b = await subscriptionCheckout()
    await post(subscriptionEvent("subscription.charged", b, { at: T0 }))
    await post(subscriptionEvent("subscription.halted", b, { at: T0 + 50, status: "halted" }))
    await post(subscriptionEvent("subscription.charged", b, { at: T0 + 50 }))
    expect(await expiryOf(b)).toBe((T0 + 50 + MONTH) * 1000 + GRACE_MS)
  })

  it("a cancellation at the cycle's end keeps what was paid for, and no longer", async () => {
    const sub = await subscriptionCheckout()
    await post(subscriptionEvent("subscription.charged", sub, { at: T0 }))
    const cycleEnd = T0 + MONTH
    await post(subscriptionEvent("subscription.cancelled", sub, { at: cycleEnd, status: "cancelled", endedAt: cycleEnd }))
    expect(await expiryOf(sub)).toBe(cycleEnd * 1000)
  })

  it("a completed subscription ends at ended_at", async () => {
    const sub = await subscriptionCheckout()
    await post(subscriptionEvent("subscription.charged", sub, { at: T0 }))
    await post(subscriptionEvent("subscription.completed", sub, { at: T0 + 500, status: "completed", endedAt: T0 + 400 }))
    expect(await expiryOf(sub)).toBe((T0 + 400) * 1000)
  })

  it("a charge older than the cancellation that ended it records the payment and grants nothing more", async () => {
    const sub = await subscriptionCheckout()
    await post(subscriptionEvent("subscription.charged", sub, { at: T0 }))
    await post(subscriptionEvent("subscription.cancelled", sub, { at: T0 + 300, status: "cancelled", endedAt: T0 + 300 }))
    const paymentId = `pay_${randomUUID().slice(0, 10)}`
    await post(subscriptionEvent("subscription.charged", sub, { at: T0 + 200, paymentId }))
    expect(await expiryOf(sub)).toBe((T0 + 300) * 1000)
    expect(await db.billing_payments.count({ where: { provider_payment_id: paymentId } })).toBe(1)
  })

  it("a charge and a cancellation racing: whichever lands first, there is no access after the end", async () => {
    for (let i = 0; i < 8; i++) {
      const sub = await subscriptionCheckout()
      const end = T0 + 300
      await Promise.all([
        post(subscriptionEvent("subscription.charged", sub, { at: T0 })),
        post(subscriptionEvent("subscription.cancelled", sub, { at: end, status: "cancelled", endedAt: end })),
      ])
      expect(await hasEntitlement({ kind: "org", id: orgOfRef.get(sub)! }, "analytics", {}, new Date((end + 1) * 1000))).toBe(false)
      const expiry = await expiryOf(sub)
      expect(expiry === null || expiry === end * 1000).toBe(true)
    }
  })
})

describe("an Event Pass is an order (order.paid)", () => {
  it("unlocks that one event for good", async () => {
    const order = await orderCheckout()
    expect(await (await post(orderPaid(order))).json()).toMatchObject({ applied: true })
    const [ent] = await entitlementsFor(order)
    expect(ent).toMatchObject({ subject_id: orgId, product: "event_pass", expires_at: null })
    expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: order } })).status).toBe("paid")
  })

  it.each([
    ["the wrong amount", { amount: 100 }],
    ["another currency", { currency: "USD" }],
    ["a status other than paid", { status: "attempted" }],
    ["less paid than owed", { paid: 100 }],
  ])("refuses an order with %s", async (_label, opts) => {
    const order = await orderCheckout()
    expect((await (await post(orderPaid(order, opts))).json()).refused).toBe("amount_mismatch")
    expect(await entitlementsFor(order)).toHaveLength(0)
  })

  it("a second paid pass for the same event grants nothing more, and is flagged for a refund", async () => {
    const event = await makeEvent(users[0])
    events.push(event)
    const first = await orderCheckout(event)
    const second = await orderCheckout(event)
    await post(orderPaid(first))
    expect(await (await post(orderPaid(second, { at: T0 + 10 }))).json()).toMatchObject({ applied: true })
    expect(await entitlementsFor(second)).toHaveLength(0)
    expect(await db.audit_logs.count({ where: { action: "entitlement.duplicate_pass", details: { path: ["externalRef"], equals: second } } })).toBe(1)
  })

  it("payment.failed marks an unpaid order failed, and never a paid one", async () => {
    const unpaid = await orderCheckout()
    const failed = { entity: "event", event: "payment.failed", payload: { payment: { entity: { id: "pay_f", order_id: unpaid, amount: 58_900, currency: "INR" } } }, created_at: T0 }
    await post(failed)
    expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: unpaid } })).status).toBe("failed")

    const paid = await orderCheckout()
    await post(orderPaid(paid))
    await post({ ...failed, payload: { payment: { entity: { id: "pay_g", order_id: paid } } }, created_at: T0 + 5 })
    expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: paid } })).status).toBe("paid")
  })
})

describe("refunds and disputes (sec H1)", () => {
  it("a full refund of a pass ends it at the refund; a partial one changes nothing", async () => {
    const event = await makeEvent(users[0])
    events.push(event)
    const order = await orderCheckout(event)
    const paymentId = `pay_${randomUUID().slice(0, 10)}`
    await post(orderPaid(order, { paymentId }))
    await post(refundEvent(paymentId, 10_000, T0 + 100))
    expect(await expiryOf(order)).toBeNull()
    await post(refundEvent(paymentId, 58_900, T0 + 200))
    expect(await expiryOf(order)).toBe((T0 + 200) * 1000)
    expect((await db.billing_payments.findFirstOrThrow({ where: { provider_payment_id: paymentId } })).status).toBe("refunded")
  })

  it("a refunded subscription charge ends access and cancels the subscription at Razorpay", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_itestkey"
    process.env.RAZORPAY_KEY_SECRET = "itest_key_secret_value_24"
    const calls: string[] = []
    const realFetch = global.fetch
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)} ${String(init?.body ?? "")}`)
      return new Response(JSON.stringify({ id: "sub_x", plan_id: PLAN_ID, status: "cancelled" }), { status: 200 })
    }) as typeof fetch
    try {
      const sub = await subscriptionCheckout()
      const paymentId = `pay_${randomUUID().slice(0, 10)}`
      await post(subscriptionEvent("subscription.charged", sub, { paymentId }))
      await post(refundEvent(paymentId, 235_900, T0 + 300))
      expect(await expiryOf(sub)).toBe((T0 + 300) * 1000)
      expect(calls.some((c) => c.includes(`/subscriptions/${sub}/cancel`) && c.includes('"cancel_at_cycle_end":0'))).toBe(true)
    } finally {
      global.fetch = realFetch
      delete process.env.RAZORPAY_KEY_ID
      delete process.env.RAZORPAY_KEY_SECRET
    }
  })

  it("a dispute ends a pass, and winning it gives the pass back for good", async () => {
    const event = await makeEvent(users[0])
    events.push(event)
    const order = await orderCheckout(event)
    const paymentId = `pay_${randomUUID().slice(0, 10)}`
    await post(orderPaid(order, { paymentId }))
    await post(disputeEvent("payment.dispute.created", paymentId, T0 + 100))
    expect(await expiryOf(order)).toBe((T0 + 100) * 1000)
    await post(disputeEvent("payment.dispute.won", paymentId, T0 + 900))
    expect(await expiryOf(order)).toBeNull()
  })

  it("a lost dispute ends a subscription's access at the loss", async () => {
    const sub = await subscriptionCheckout()
    const paymentId = `pay_${randomUUID().slice(0, 10)}`
    await post(subscriptionEvent("subscription.charged", sub, { paymentId }))
    await post(disputeEvent("payment.dispute.lost", paymentId, T0 + 700))
    expect(await expiryOf(sub)).toBe((T0 + 700) * 1000)
  })
})

describe("a flood is refused before the database (SEC-18, G15)", () => {
  it("counts only failed signatures: a network sending bad ones is 429'd, a valid delivery never is", async () => {
    const ip = "198.51.100.77"
    let first429 = -1
    for (let i = 0; i < 200 && first429 < 0; i++) {
      if ((await post({ event: "x" }, { signature: "bad", ip })).status === 429) first429 = i
    }
    expect(first429).toBeGreaterThan(0)
    // The same network's valid delivery still goes through.
    const sub = await subscriptionCheckout()
    expect((await post(subscriptionEvent("subscription.charged", sub), { ip })).status).toBe(200)
  })
})
