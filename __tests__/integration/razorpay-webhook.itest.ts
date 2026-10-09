/*
 * The Razorpay webhook, through the real route, against real Postgres
 * (TQ-A15 / TQ-X08: MN-U02 end to end, MN-I01..I03, SEC-13, SEC-14, SEC-18).
 *
 * Signatures are computed here with a test secret, the way Razorpay computes
 * them: HMAC-SHA256 of the raw body. Every case reads the rows back.
 */
import { createHmac, randomUUID } from "crypto"
import { NextRequest } from "next/server"

import { RENEWAL_GRACE_MS } from "@/lib/razorpay-webhook"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const route = require("@/app/api/webhooks/razorpay/route") as typeof import("@/app/api/webhooks/razorpay/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const SECRET = "whsec_itest_razorpay_webhook_secret"
const PLAN_ID = "plan_itest_monthly"
const T0 = Math.floor(Date.parse("2026-10-03T10:00:00Z") / 1000)
const MONTH = 30 * 24 * 60 * 60

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
let orgId = ""
let strangerOrgId = ""
let eventId = ""
const refs: string[] = []

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
  await db.entitlements.deleteMany({ where: { subject_id: { in: orgs } } })
  await db.billing_checkouts.deleteMany({ where: { org_id: { in: orgs } } })
  await db.audit_logs.deleteMany({ where: { resource_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, events)
  await closeDb()
})

async function subscriptionCheckout(amountMinor = 235_900) {
  const ref = `sub_${randomUUID().slice(0, 12)}`
  refs.push(ref)
  await db.billing_checkouts.create({
    data: {
      kind: "subscription",
      provider_ref: ref,
      provider_plan_id: PLAN_ID,
      org_id: orgId,
      plan_key: "analytics_monthly",
      amount_minor: amountMinor,
    },
  })
  return ref
}

async function orderCheckout() {
  const ref = `order_${randomUUID().slice(0, 12)}`
  await db.billing_checkouts.create({
    data: { kind: "order", provider_ref: ref, org_id: orgId, event_id: eventId, plan_key: "event_pass", amount_minor: 58_900 },
  })
  return ref
}

function subscriptionEvent(
  type: string,
  subId: string,
  opts: { at?: number; amount?: number; currency?: string; status?: string; planId?: string; endedAt?: number | null } = {}
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
          current_end: at + MONTH,
          ended_at: opts.endedAt ?? null,
          // A reader that trusted notes would grant the stranger.
          notes: { org_id: strangerOrgId },
        },
      },
      payment: {
        entity: {
          id: `pay_${randomUUID().slice(0, 10)}`,
          entity: "payment",
          amount: opts.amount ?? 235_900,
          currency: opts.currency ?? "INR",
          status: "captured",
          invoice_id: `inv_${randomUUID().slice(0, 10)}`,
        },
      },
    },
    created_at: at,
  }
}

function orderPaid(orderId: string, opts: { amount?: number; currency?: string } = {}) {
  const amount = opts.amount ?? 58_900
  return {
    entity: "event",
    event: "order.paid",
    payload: {
      order: { entity: { id: orderId, amount, amount_paid: amount, currency: opts.currency ?? "INR", status: "paid" } },
      payment: { entity: { id: `pay_${randomUUID().slice(0, 10)}`, amount, currency: opts.currency ?? "INR", order_id: orderId } },
    },
    created_at: T0,
  }
}

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
    new NextRequest("http://localhost/api/webhooks/razorpay", {
      method: "POST",
      headers,
      body: opts.tamper ? opts.tamper(raw) : raw,
    })
  )
}

const entitlementsFor = (ref: string) => db.entitlements.findMany({ where: { external_ref: ref } })
const deliveries = (id: string) => db.payment_events.findMany({ where: { provider_event_id: id } })

describe("a delivery that is not Razorpay's writes nothing (SEC-13)", () => {
  it.each([
    ["signed with another secret", { secret: "an_entirely_different_secret" }],
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
      const res = await post(subscriptionEvent("subscription.charged", sub))
      expect(res.status).toBe(401)
    } finally {
      process.env.RAZORPAY_WEBHOOK_SECRET = SECRET
    }
    expect(await entitlementsFor(sub)).toHaveLength(0)
  })

  it("answers a signed body that is not JSON with 400 and records nothing", async () => {
    const id = newEventId()
    const res = await post("not json at all", { eventId: id })
    expect(res.status).toBe(400)
    expect(await deliveries(id)).toHaveLength(0)
  })
})

describe("a charged subscription grants Analytics, once (MN-I01, SEC-14)", () => {
  it("writes the org's entitlement to the paid-up date plus grace, and records the delivery", async () => {
    const sub = await subscriptionCheckout()
    const id = newEventId()
    const res = await post(subscriptionEvent("subscription.charged", sub), { eventId: id })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, duplicate: false, applied: true })

    const [ent] = await entitlementsFor(sub)
    expect(ent).toMatchObject({ subject_kind: "org", subject_id: orgId, product: "analytics", source: "razorpay" })
    expect(ent.expires_at?.getTime()).toBe((T0 + MONTH) * 1000 + RENEWAL_GRACE_MS)
    // Never the org that `notes` named.
    expect(await db.entitlements.count({ where: { subject_id: strangerOrgId } })).toBe(0)

    const [row] = await deliveries(id)
    expect(row.processed_at).not.toBeNull()
    expect(row.error).toBeNull()
    const checkout = await db.billing_checkouts.findUniqueOrThrow({ where: { provider_ref: sub } })
    expect(checkout.status).toBe("active")
    expect(row.checkout_id).toBe(checkout.id)

    // The audit row is written after the response; give it a moment.
    await new Promise((r) => setTimeout(r, 200))
    const audit = await db.audit_logs.findMany({ where: { resource_id: orgId, action: "entitlement.paid" } })
    expect(audit.some((a) => (a.details as { externalRef?: string }).externalRef === sub)).toBe(true)
  })

  it("replays the same event id as a no-op", async () => {
    const sub = await subscriptionCheckout()
    const id = newEventId()
    const body = subscriptionEvent("subscription.charged", sub)
    await post(body, { eventId: id })
    const again = await post(body, { eventId: id })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ duplicate: true, applied: false })
    expect(await deliveries(id)).toHaveLength(1)
    expect(await entitlementsFor(sub)).toHaveLength(1)
  })

  it("re-sent under a new event id, the same payment still makes one row with one end", async () => {
    const sub = await subscriptionCheckout()
    const body = subscriptionEvent("subscription.charged", sub)
    await post(body)
    const [before] = await entitlementsFor(sub)
    await post(body)
    const after = await entitlementsFor(sub)
    expect(after).toHaveLength(1)
    expect(after[0].expires_at).toEqual(before.expires_at)
  })

  it("a renewal moves the end of the same row", async () => {
    const sub = await subscriptionCheckout()
    await post(subscriptionEvent("subscription.charged", sub))
    await post(subscriptionEvent("subscription.charged", sub, { at: T0 + MONTH }))
    const rows = await entitlementsFor(sub)
    expect(rows).toHaveLength(1)
    expect(rows[0].expires_at?.getTime()).toBe((T0 + 2 * MONTH) * 1000 + RENEWAL_GRACE_MS)
  })

  it("a delivery whose first attempt died before deciding is applied by the retry", async () => {
    const sub = await subscriptionCheckout()
    const id = newEventId()
    const body = subscriptionEvent("subscription.charged", sub)
    await db.payment_events.create({
      data: { provider: "razorpay", provider_event_id: id, type: body.event, payload: body },
    })
    const res = await post(body, { eventId: id })
    expect(await res.json()).toMatchObject({ duplicate: false, applied: true })
    expect(await entitlementsFor(sub)).toHaveLength(1)
    expect(await deliveries(id)).toHaveLength(1)
  })
})

describe("the price table holds (MN-I02)", () => {
  it.each([
    ["the wrong amount", { amount: 199_900 }],
    ["the wrong currency", { currency: "USD" }],
    ["another plan", { planId: "plan_someone_elses" }],
  ])("%s → recorded, refused, no entitlement", async (_label, opts) => {
    const sub = await subscriptionCheckout()
    const id = newEventId()
    const res = await post(subscriptionEvent("subscription.charged", sub, opts), { eventId: id })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.applied).toBe(false)
    expect(["amount_mismatch", "plan_mismatch"]).toContain(body.refused)
    expect(await entitlementsFor(sub)).toHaveLength(0)
    const [row] = await deliveries(id)
    expect(row.processed_at).toBeNull()
    expect(row.error).toBe(body.refused)
  })

  it("a checkout started at another price is refused even when the payment matches the table", async () => {
    const sub = await subscriptionCheckout(100)
    const res = await post(subscriptionEvent("subscription.charged", sub))
    expect((await res.json()).refused).toBe("amount_mismatch")
    expect(await entitlementsFor(sub)).toHaveLength(0)
  })
})

describe("a reference we did not start is never trusted (MN-I03)", () => {
  it("an unknown subscription → 200, recorded as unknown_ref, nothing granted to anyone", async () => {
    const id = newEventId()
    const res = await post(subscriptionEvent("subscription.charged", "sub_nobody_started_this"), { eventId: id })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ applied: false, refused: "unknown_ref" })
    expect(await db.entitlements.count({ where: { subject_id: { in: orgs }, external_ref: "sub_nobody_started_this" } })).toBe(0)
    expect((await deliveries(id))[0].error).toBe("unknown_ref")
  })
})

describe("ending, and Razorpay's clock (MN-I05 for an organisation)", () => {
  it("a halt ends Analytics at the halt, and a late older charge cannot revive it", async () => {
    const sub = await subscriptionCheckout()
    await post(subscriptionEvent("subscription.charged", sub, { at: T0 }))
    const haltAt = T0 + 10 * 24 * 60 * 60
    await post(subscriptionEvent("subscription.halted", sub, { at: haltAt, status: "halted" }))
    let [ent] = await entitlementsFor(sub)
    expect(ent.expires_at?.getTime()).toBe(haltAt * 1000)

    const late = await post(subscriptionEvent("subscription.charged", sub, { at: T0 + 60 }))
    expect((await late.json()).refused).toBe("stale")
    ;[ent] = await entitlementsFor(sub)
    expect(ent.expires_at?.getTime()).toBe(haltAt * 1000)
    expect((await db.billing_checkouts.findUniqueOrThrow({ where: { provider_ref: sub } })).status).toBe("halted")
  })

  it("a cancellation at the cycle's end keeps what was paid for, and no longer", async () => {
    const sub = await subscriptionCheckout()
    await post(subscriptionEvent("subscription.charged", sub, { at: T0 }))
    const cycleEnd = T0 + MONTH
    await post(subscriptionEvent("subscription.cancelled", sub, { at: cycleEnd, status: "cancelled", endedAt: cycleEnd }))
    const [ent] = await entitlementsFor(sub)
    // The grace is for a renewal that might still come; a cancelled one won't.
    expect(ent.expires_at?.getTime()).toBe(cycleEnd * 1000)
  })
})

describe("an Event Pass is an order (order.paid)", () => {
  it("unlocks that one event for good", async () => {
    const order = await orderCheckout()
    const res = await post(orderPaid(order))
    expect(await res.json()).toMatchObject({ applied: true })
    const [ent] = await entitlementsFor(order)
    expect(ent).toMatchObject({ subject_id: orgId, product: "event_pass", event_id: eventId, expires_at: null })
    expect((await db.billing_checkouts.findUniqueOrThrow({ where: { provider_ref: order } })).status).toBe("paid")
  })

  it("refuses an order paid at the wrong amount", async () => {
    const order = await orderCheckout()
    const res = await post(orderPaid(order, { amount: 100 }))
    expect((await res.json()).refused).toBe("amount_mismatch")
    expect(await entitlementsFor(order)).toHaveLength(0)
  })
})

describe("a flood is refused before the database (SEC-18)", () => {
  it("rate-limits one network after 120 a minute", async () => {
    const ip = "198.51.100.77"
    const statuses: number[] = []
    for (let i = 0; i < 122; i++) statuses.push((await post({ event: "x" }, { signature: "bad", ip })).status)
    expect(statuses.slice(0, 120).every((s) => s === 401)).toBe(true)
    expect(statuses.slice(120)).toEqual([429, 429])
  })
})
