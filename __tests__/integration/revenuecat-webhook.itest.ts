/*
 * The RevenueCat webhook, through the real route, against real Postgres
 * (step 11; TQ-A14: MN-U03..U05, MN-I06, SEC-13, SEC-14).
 *
 * Bodies follow RevenueCat's documented samples (revenuecat.com/docs →
 * Webhooks → Sample events), including the fields that must never be stored
 * or trusted: `subscriber_attributes` with an email, `aliases`, the country.
 * Every case reads the rows back. Times are literals relative to T0.
 */
import { createHash, randomUUID } from "crypto"
import { NextRequest } from "next/server"

import { hasPlus } from "@/lib/plus"
import { authorised, recordRevenuecatEvent, revenuecatBodySchema } from "@/lib/revenuecat-webhook"

import { cleanup, closeDb, db, makeUser, refusingWrites } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const route = require("@/app/api/webhooks/revenuecat/route") as typeof import("@/app/api/webhooks/revenuecat/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const SECRET = "rc_itest_webhook_secret_0123456789abcdef"
const AUTH = `Bearer ${SECRET}`
const DAY = 86_400_000
const MONTH = 30 * DAY
/**
 * Three months ago, so every event stamped T0 + (up to two months) is still in the
 * past: the webhook refuses an event stamped ahead of its own clock (SCRUM-731), and
 * these cases order events by the store's clock a month apart.
 */
const T0 = Date.now() - 3 * MONTH

const users: string[] = []
let alice = ""
let bob = ""

beforeAll(async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET
  delete process.env.RAILWAY_ENVIRONMENT_NAME
  alice = await makeUser("rc-alice")
  bob = await makeUser("rc-bob")
  users.push(alice, bob)
})

afterAll(async () => {
  delete process.env.REVENUECAT_WEBHOOK_SECRET
  await db.payment_events.deleteMany({ where: { provider: "revenuecat", provider_event_id: { startsWith: "itest_rc_" } } })
  await db.entitlements.deleteMany({ where: { subject_kind: "user", subject_id: { in: users } } })
  await db.entitlements.deleteMany({ where: { external_ref: { startsWith: "itest_txn_" } } })
  await cleanup(users, [])
  await closeDb()
})

const newTxn = () => `itest_txn_${randomUUID().slice(0, 12)}`

/** Somebody with no other Plus, so "has Plus" reads this case's rows alone. */
async function fresh(label = "rc-fresh") {
  const id = await makeUser(label)
  users.push(id)
  return id
}

/** A RevenueCat delivery, shaped like the documented samples. */
function rc(
  type: string,
  o: {
    user?: string
    txn: string
    at: number
    expires?: number | null
    purchased?: number
    product?: string
    entitlements?: string[] | null
    environment?: string
    store?: string
    cancelReason?: string
    grace?: number
    attributesUser?: string
    /** The store transaction this event is about, when not the purchase's first. */
    transactionId?: string
  }
) {
  return {
    api_version: "1.0",
    event: {
      id: `itest_rc_${randomUUID()}`,
      type,
      event_timestamp_ms: o.at,
      app_id: "app_itest",
      app_user_id: o.user ?? alice,
      original_app_user_id: "$RCAnonymousID:itest0000",
      aliases: ["$RCAnonymousID:itest0000", o.user ?? alice],
      product_id: o.product ?? "blendn_plus_monthly",
      entitlement_ids: o.entitlements === undefined ? ["plus"] : o.entitlements,
      period_type: "NORMAL",
      purchased_at_ms: o.purchased ?? o.at,
      expiration_at_ms: o.expires === undefined ? o.at + MONTH : o.expires,
      ...(o.grace !== undefined ? { grace_period_expiration_at_ms: o.grace } : {}),
      environment: o.environment ?? "SANDBOX",
      store: o.store ?? "APP_STORE",
      transaction_id: o.transactionId ?? o.txn,
      original_transaction_id: o.txn,
      is_family_share: false,
      country_code: "IN",
      currency: "INR",
      price: 2.39,
      ...(o.cancelReason ? { cancel_reason: o.cancelReason } : {}),
      // Never the person: anyone with the app can set these.
      subscriber_attributes: {
        $email: { value: "payer@example.com", updated_at_ms: o.at },
        ...(o.attributesUser ? { user_id: { value: o.attributesUser, updated_at_ms: o.at } } : {}),
      },
      offer_code: null,
      experiments: [{ experiment_id: "prexp", experiment_variant: "b", enrolled_at_ms: o.at }],
    },
  }
}

const transfer = (from: string[], to: string[], at: number, extra: Record<string, unknown> = {}) => ({
  api_version: "1.0",
  event: {
    id: `itest_rc_${randomUUID()}`,
    type: "TRANSFER",
    event_timestamp_ms: at,
    app_id: "app_itest",
    store: "APP_STORE",
    environment: "SANDBOX",
    transferred_from: from,
    transferred_to: to,
    ...extra,
  },
})

async function post(body: unknown, auth: string | null = AUTH) {
  const raw = typeof body === "string" ? body : JSON.stringify(body)
  const headers: Record<string, string> = { "content-type": "application/json", "x-real-ip": "203.0.113.20" }
  if (auth !== null) headers.authorization = auth
  const res = await route.POST(new NextRequest("http://localhost/api/webhooks/revenuecat", { method: "POST", headers, body: raw }))
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

/**
 * RevenueCat's REST API, stubbed: `held` is what GET /v1/subscribers/{id}
 * reports for each app user id (store transaction ids, sandbox). Anything
 * else the test did not expect fails it.
 */
function revenuecatHolds(held: Record<string, string[]>, opts: { status?: number } = {}) {
  process.env.REVENUECAT_SECRET_KEY = "sk_itestsecretkey0123456789"
  return jest.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = String(input)
    const id = decodeURIComponent(url.split("/subscribers/")[1] ?? "")
    if (!url.startsWith("https://api.revenuecat.com/v1/subscribers/")) throw new Error(`unexpected fetch ${url}`)
    if (opts.status) return new Response("{}", { status: opts.status })
    const txns = held[id] ?? []
    return new Response(
      JSON.stringify({
        subscriber: {
          subscriptions: Object.fromEntries(txns.filter((t) => !t.startsWith("pass:")).map((t, i) => [`p${i}`, { store_transaction_id: t, is_sandbox: true }])),
          non_subscriptions: { blendn_night_pass: txns.filter((t) => t.startsWith("pass:")).map((t) => ({ id: t, store_transaction_id: t.slice(5), is_sandbox: true })) },
        },
      }),
      { status: 200 }
    )
  })
}

afterEach(() => {
  jest.restoreAllMocks()
  delete process.env.REVENUECAT_SECRET_KEY
})

const rowsFor = (txn: string) => db.entitlements.findMany({ where: { external_ref: txn } })
const rowOf = async (txn: string) => (await rowsFor(txn))[0]
const deliveryOf = (body: { event: { id: string } }) =>
  db.payment_events.findMany({ where: { provider: "revenuecat", provider_event_id: body.event.id } })
const plusAt = (user: string, at: number) => hasPlus(user, new Date(at))
const transferAudits = (to: string) =>
  db.audit_logs.findMany({ where: { action: "entitlement.transferred", resource_id: to }, select: { details: true } })

describe("authorisation (MN-U03, SEC-13)", () => {
  it("accepts exactly the configured header and nothing near it", () => {
    expect(authorised(AUTH, SECRET)).toBe(true)
    expect(authorised(null, SECRET)).toBe(false)
    expect(authorised(SECRET, SECRET)).toBe(false)
    expect(authorised(AUTH.slice(0, -1), SECRET)).toBe(false)
    expect(authorised(`${AUTH}0`, SECRET)).toBe(false)
    expect(authorised(`bearer ${SECRET}`, SECRET)).toBe(false)
  })

  it.each([
    ["no header", null],
    ["the wrong secret", "Bearer rc_an_entirely_different_secret_0123456789"],
    ["a prefix of the right one", AUTH.slice(0, -4)],
    ["the secret without Bearer", SECRET],
  ])("%s → 401, and no row", async (_label, auth) => {
    const txn = newTxn()
    const body = rc("INITIAL_PURCHASE", { txn, at: T0 })
    const res = await post(body, auth)
    expect(res.status).toBe(401)
    expect(res.json).toEqual({ error: "unauthorized" })
    expect(await deliveryOf(body)).toHaveLength(0)
    expect(await rowsFor(txn)).toHaveLength(0)
  })

  it("refuses everything when the secret is not configured", async () => {
    const txn = newTxn()
    delete process.env.REVENUECAT_WEBHOOK_SECRET
    try {
      expect((await post(rc("INITIAL_PURCHASE", { txn, at: T0 }))).status).toBe(401)
    } finally {
      process.env.REVENUECAT_WEBHOOK_SECRET = SECRET
    }
    expect(await rowsFor(txn)).toHaveLength(0)
  })

  it("keeps an authorised body it cannot read — by its hash, answered 200 — and refuses one far too big (L4)", async () => {
    const unreadable = (body: string) =>
      db.payment_events.findMany({ where: { provider: "revenuecat", body_sha256: createHash("sha256").update(body).digest("hex") } })
    for (const body of [
      "not json",
      JSON.stringify({ api_version: "1.0", event: { type: "RENEWAL" } }),
      // Past what a Date can hold: never an Invalid Date, never a 500.
      JSON.stringify({ api_version: "1.0", event: { id: `itest_rc_${randomUUID()}`, type: "RENEWAL", event_timestamp_ms: 9e15 } }),
    ]) {
      const res = await post(body)
      expect(res).toEqual({ status: 200, json: { ok: true, duplicate: false, applied: false, refused: "malformed" } })
      const [kept] = await unreadable(body)
      expect(kept).toMatchObject({ error: "malformed", processed_at: null })
      expect(kept.provider_event_id).toMatch(/^unreadable:/)
      await post(body)
      expect(await unreadable(body)).toHaveLength(1)
      await db.payment_events.deleteMany({ where: { id: kept.id } })
    }
    expect((await post({ api_version: "1.0", event: { id: "x".repeat(70_000), type: "TEST", event_timestamp_ms: T0 } })).status).toBe(413)
  })

  it("says the secret is missing once, not once a request (L5)", async () => {
    // The route remembers it has said so; a fresh module stands for a fresh process.
    let freshRoute = route
    let freshLogger: typeof import("@/lib/logger").logger | undefined
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      freshRoute = require("@/app/api/webhooks/revenuecat/route") as typeof route
      freshLogger = (require("@/lib/logger") as typeof import("@/lib/logger")).logger
      /* eslint-enable @typescript-eslint/no-require-imports */
    })
    const errors = jest.spyOn(freshLogger!, "error").mockImplementation(() => {})
    delete process.env.REVENUECAT_WEBHOOK_SECRET
    try {
      for (let i = 0; i < 3; i++) {
        const res = await freshRoute.POST(new NextRequest("http://localhost/api/webhooks/revenuecat", { method: "POST", body: "{}" }))
        expect(res.status).toBe(401)
      }
    } finally {
      process.env.REVENUECAT_WEBHOOK_SECRET = SECRET
    }
    expect(errors.mock.calls.filter(([m]) => String(m).includes("REVENUECAT_WEBHOOK_SECRET"))).toHaveLength(1)
  })
})

describe("a purchase", () => {
  it("grants Plus to app_user_id until expiration_at_ms, and stores no personal data", async () => {
    const txn = newTxn()
    // The attributes name Bob. The grant goes to app_user_id (Alice), never to an attribute.
    const body = rc("INITIAL_PURCHASE", { txn, at: T0, attributesUser: bob })
    const res = await post(body)
    expect(res).toEqual({ status: 200, json: { ok: true, duplicate: false, applied: true } })

    const row = await rowOf(txn)
    expect(row).toMatchObject({ subject_kind: "user", subject_id: alice, product: "plus", source: "apple", external_ref: txn })
    expect(row.expires_at!.getTime()).toBe(T0 + 2_592_000_000)
    expect(row.window_event_at!.getTime()).toBe(T0)
    expect(await plusAt(alice, T0 + 1000)).toBe(true)
    expect(await plusAt(bob, T0 + 1000)).toBe(false)

    const [delivery] = await deliveryOf(body)
    expect(delivery.processed_at).not.toBeNull()
    expect(delivery.error).toBeNull()
    const stored = JSON.stringify(delivery.payload)
    for (const leak of ["payer@example.com", "subscriber_attributes", "aliases", "RCAnonymousID", "country_code", "experiments"]) {
      expect(stored).not.toContain(leak)
    }
    expect(stored).toContain(txn)
  })

  it("is applied once however often it arrives: a replay, the same body under a new id, three at once (SEC-14)", async () => {
    const txn = newTxn()
    const body = rc("INITIAL_PURCHASE", { txn, at: T0 })
    await post(body)
    expect((await post(body)).json).toMatchObject({ duplicate: true, applied: false })

    const twins = rc("RENEWAL", { txn, at: T0 + 10_000, expires: T0 + 2 * MONTH })
    const results = await Promise.all([post(twins), post(twins), post(twins)])
    expect(results.map((r) => r.status)).toEqual([200, 200, 200])
    expect(results.filter((r) => r.json.duplicate === false)).toHaveLength(1)
    expect(await deliveryOf(twins)).toHaveLength(1)
    expect(await rowsFor(txn)).toHaveLength(1)
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(T0 + 5_184_000_000)
  })

  it("rolls the claim back when applying fails, so RevenueCat's retry applies it", async () => {
    const txn = newTxn()
    const body = rc("INITIAL_PURCHASE", { txn, at: T0 })
    await refusingWrites("entitlements", "INSERT", `NEW.external_ref = '${txn}'`, async () => {
      await expect(post(body)).rejects.toThrow()
    })
    expect(await deliveryOf(body)).toHaveLength(0)
    expect((await post(body)).json).toMatchObject({ duplicate: false, applied: true })
    expect(await rowsFor(txn)).toHaveLength(1)
  })
})

describe("order: the store's clock decides, never arrival (MN-U04)", () => {
  it("an EXPIRATION that arrives first is not undone by the older purchase and renewal behind it", async () => {
    const txn = newTxn()
    const user = await fresh()
    const bought = rc("INITIAL_PURCHASE", { txn, user, at: T0 - 2 * MONTH, expires: T0 - MONTH })
    const renewed = rc("RENEWAL", { txn, user, at: T0 - MONTH, expires: T0 - 1000 })
    const expired = rc("EXPIRATION", { txn, user, at: T0, purchased: T0 - MONTH, expires: T0 - 1000 })
    expect((await post(expired)).json.applied).toBe(true)
    expect((await post(renewed)).json).toMatchObject({ applied: false, refused: "stale" })
    expect((await post(bought)).json).toMatchObject({ applied: false, refused: "stale" })
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(T0 - 1000)
    expect(await plusAt(user, T0)).toBe(false)
    expect((await deliveryOf(renewed))[0].error).toBe("stale")
  })

  it("a renewal that arrives before its purchase keeps the later end", async () => {
    const txn = newTxn()
    await post(rc("RENEWAL", { txn, at: T0 + MONTH, purchased: T0, expires: T0 + 2 * MONTH }))
    await post(rc("INITIAL_PURCHASE", { txn, at: T0, expires: T0 + MONTH }))
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(T0 + 5_184_000_000)
  })
})

describe("cancellations, refunds and billing", () => {
  it("a cancellation keeps Plus to the end of the period it paid for", async () => {
    const txn = newTxn()
    const user = await fresh()
    await post(rc("INITIAL_PURCHASE", { txn, user, at: T0 }))
    await post(rc("CANCELLATION", { txn, user, at: T0 + DAY, cancelReason: "UNSUBSCRIBE", expires: T0 + MONTH }))
    expect(await plusAt(user, T0 + MONTH - 1000)).toBe(true)
    expect(await plusAt(user, T0 + MONTH + 1000)).toBe(false)
  })

  it("a refund ends it at the refund, a renewal older than the refund cannot give it back, a reversal can", async () => {
    const txn = newTxn()
    await post(rc("INITIAL_PURCHASE", { txn, at: T0, user: bob }))
    // RevenueCat's refund: CANCELLATION with cancel_reason CUSTOMER_SUPPORT.
    await post(rc("CANCELLATION", { txn, at: T0 + DAY, user: bob, cancelReason: "CUSTOMER_SUPPORT", expires: T0 + MONTH }))
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(T0 + 86_400_000)
    expect(await plusAt(bob, T0 + 2 * DAY)).toBe(false)

    const late = rc("RENEWAL", { txn, at: T0 + DAY - 1, user: bob, expires: T0 + 2 * MONTH })
    expect((await post(late)).json).toMatchObject({ refused: "stale" })
    expect(await plusAt(bob, T0 + 2 * DAY)).toBe(false)

    await post(rc("REFUND_REVERSED", { txn, at: T0 + 2 * DAY, user: bob, expires: T0 + MONTH }))
    expect(await plusAt(bob, T0 + 3 * DAY)).toBe(true)
    await db.entitlements.deleteMany({ where: { external_ref: txn } })
  })

  it("a billing issue keeps Plus through the grace period, and the renewal that recovers it moves the end on", async () => {
    const txn = newTxn()
    await post(rc("INITIAL_PURCHASE", { txn, at: T0 - MONTH, expires: T0 }))
    await post(rc("BILLING_ISSUE", { txn, at: T0 + 1000, expires: T0, grace: T0 + 16 * DAY }))
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(T0 + 1_382_400_000)
    await post(rc("RENEWAL", { txn, at: T0 + 2 * DAY, expires: T0 + 2 * DAY + MONTH }))
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(T0 + 172_800_000 + 2_592_000_000)
  })

  it("an uncancellation is applied like any newer event", async () => {
    const txn = newTxn()
    await post(rc("INITIAL_PURCHASE", { txn, at: T0 }))
    await post(rc("CANCELLATION", { txn, at: T0 + DAY, cancelReason: "UNSUBSCRIBE", expires: T0 + MONTH }))
    const back = rc("UNCANCELLATION", { txn, at: T0 + 2 * DAY, expires: T0 + MONTH })
    expect((await post(back)).json.applied).toBe(true)
    expect((await rowOf(txn)).window_event_at!.getTime()).toBe(T0 + 172_800_000)
  })

  it("a product change is informational: nothing moves until the change's own renewal", async () => {
    const txn = newTxn()
    await post(rc("INITIAL_PURCHASE", { txn, at: T0 }))
    const change = rc("PRODUCT_CHANGE", { txn, at: T0 + DAY, expires: T0 + DAY })
    expect((await post(change)).json).toMatchObject({ applied: false })
    expect((await deliveryOf(change))[0].error).toBeNull()
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(T0 + 2_592_000_000)
  })
})

describe("the Night Pass (NON_RENEWING_PURCHASE)", () => {
  it("is Plus for 24 hours from purchase; a second stacks after the first; a refund ends it", async () => {
    // A pass is live now, so stacking ("not yet over") needs events near the present, not three months ago.
    const T0 = Date.now() - 60 * 60 * 1000
    const carol = await makeUser("rc-carol")
    users.push(carol)
    const first = newTxn()
    const pass = (txn: string, at: number) =>
      rc("NON_RENEWING_PURCHASE", { txn, at, user: carol, product: "blendn_night_pass", entitlements: null, expires: null })
    expect((await post(pass(first, T0))).json.applied).toBe(true)
    const row = await rowOf(first)
    expect(row).toMatchObject({ product: "night_pass", subject_id: carol })
    expect(row.expires_at!.getTime() - row.starts_at.getTime()).toBe(86_400_000)
    expect(await plusAt(carol, T0 + 86_400_000 - 1000)).toBe(true)
    expect(await plusAt(carol, T0 + 86_400_000 + 1000)).toBe(false)

    const second = newTxn()
    await post(pass(second, T0 + 1000))
    const stacked = await rowOf(second)
    expect(stacked.starts_at.getTime()).toBe(row.expires_at!.getTime())
    expect(stacked.expires_at!.getTime()).toBe(row.expires_at!.getTime() + 86_400_000)

    const refund = rc("CANCELLATION", { txn: first, at: T0 + 2000, user: carol, product: "blendn_night_pass", entitlements: null, cancelReason: "CUSTOMER_SUPPORT", expires: null })
    await post(refund)
    expect((await rowOf(first)).expires_at!.getTime()).toBe(T0 + 2000)
  })

  it("stacks a third pass bought the same day after the second, not on top of it (M1, D-16)", async () => {
    const user = await fresh("rc-three")
    const base = Date.now() - 3 * 60 * 60 * 1000
    const refs = [newTxn(), newTxn(), newTxn()]
    for (let i = 0; i < 3; i++) {
      await post(rc("NON_RENEWING_PURCHASE", { txn: refs[i], at: base + i * 60_000, user, product: "blendn_night_pass", entitlements: null, expires: null }))
    }
    const [a, b, c] = await Promise.all(refs.map(rowOf))
    expect(b.starts_at.getTime()).toBe(a.expires_at!.getTime())
    expect(c.starts_at.getTime()).toBe(b.expires_at!.getTime())
    expect(c.expires_at!.getTime() - a.starts_at.getTime()).toBe(3 * 86_400_000)
  })

  it("is one row per transaction, and a refund after it ran out never lengthens it (L1, L2)", async () => {
    const user = await fresh("rc-passref")
    const original = newTxn()
    const [one, two] = [newTxn(), newTxn()]
    // Two passes reported under one original transaction are still two passes.
    for (const [txn, at] of [[one, T0 - 3 * DAY], [two, T0 - 3 * DAY + 1000]] as const) {
      await post(rc("NON_RENEWING_PURCHASE", { txn: original, transactionId: txn, at, user, product: "blendn_night_pass", entitlements: null, expires: null }))
    }
    expect(await db.entitlements.count({ where: { external_ref: { in: [one, two] } } })).toBe(2)
    const before = (await rowOf(one)).expires_at!.getTime()
    await post(rc("CANCELLATION", { txn: original, transactionId: one, at: T0, user, product: "blendn_night_pass", entitlements: null, cancelReason: "CUSTOMER_SUPPORT", expires: null }))
    expect((await rowOf(one)).expires_at!.getTime()).toBe(before)
  })
})

describe("a refunded Night Pass stays refunded (SCRUM-736)", () => {
  const passEvent = (type: string, txn: string, user: string, at: number, extra: Record<string, unknown> = {}) =>
    rc(type, { txn, at, user, product: "blendn_night_pass", entitlements: null, expires: null, ...extra })

  /** A pass bought at T0 and refunded 2 s later; returns where the refund left it. */
  async function refundedPass(label: string) {
    const user = await fresh(label)
    const txn = newTxn()
    await post(passEvent("NON_RENEWING_PURCHASE", txn, user, T0))
    await post(passEvent("CANCELLATION", txn, user, T0 + 2000, { cancelReason: "CUSTOMER_SUPPORT" }))
    const refundedAt = (await rowOf(txn)).expires_at!.getTime()
    expect(refundedAt).toBe(T0 + 2000)
    return { user, txn, refundedAt }
  }

  it.each([
    ["a later CANCELLATION for another reason", "CANCELLATION", { cancelReason: "UNSUBSCRIBE" }],
    ["a later EXPIRATION", "EXPIRATION", {}],
    ["a later BILLING_ISSUE", "BILLING_ISSUE", {}],
    ["the purchase delivered again under a new event id", "NON_RENEWING_PURCHASE", {}],
  ])("is not given its 24 hours back by %s", async (_label, type, extra) => {
    const { user, txn, refundedAt } = await refundedPass(`rc-refd-${type.toLowerCase()}`)
    await post(passEvent(type, txn, user, T0 + 5000, extra))
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(refundedAt)
    expect(await plusAt(user, T0 + 60_000)).toBe(false)
  })

  it("is given back by REFUND_REVERSED: the store undoing the refund is the one event that may", async () => {
    const { user, txn } = await refundedPass("rc-refd-reversed")
    await post(passEvent("REFUND_REVERSED", txn, user, T0 + 5000))
    const row = await rowOf(txn)
    expect(row.expires_at!.getTime() - row.starts_at.getTime()).toBe(86_400_000)
  })
})

describe("refunds and expirations end access, never lengthen it (L1)", () => {
  it("an EXPIRATION carrying a later expiration_at_ms ends at the event, not later", async () => {
    const user = await fresh()
    const txn = newTxn()
    await post(rc("INITIAL_PURCHASE", { txn, user, at: T0, expires: T0 + 3_600_000 }))
    await post(rc("EXPIRATION", { txn, user, at: T0 + 10_000, expires: T0 + MONTH }))
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(T0 + 10_000)
  })

  it("a DEVELOPER_INITIATED cancellation is a refund: it ends now", async () => {
    const user = await fresh()
    const txn = newTxn()
    await post(rc("INITIAL_PURCHASE", { txn, user, at: T0 }))
    await post(rc("CANCELLATION", { txn, user, at: T0 + DAY, cancelReason: "DEVELOPER_INITIATED", expires: T0 + MONTH }))
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(T0 + 86_400_000)
  })

  it("a refund of an older period after a renewal ends nothing and is audited; one of the current period ends it", async () => {
    const user = await fresh()
    const txn = newTxn()
    await post(rc("INITIAL_PURCHASE", { txn, user, at: T0 - 40 * DAY, expires: T0 - 10 * DAY, transactionId: `${txn}-p1` }))
    await post(rc("RENEWAL", { txn, user, at: T0 - 10 * DAY, expires: T0 + 20 * DAY, transactionId: `${txn}-p2` }))
    const old = rc("CANCELLATION", { txn, user, at: T0, expires: T0 - 10 * DAY, cancelReason: "CUSTOMER_SUPPORT", transactionId: `${txn}-p1` })
    expect((await post(old)).json).toMatchObject({ applied: false, refused: "old_period_refund" })
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(T0 + 20 * 86_400_000)
    expect(await plusAt(user, T0 + 1000)).toBe(true)
    expect(await db.audit_logs.count({ where: { action: "entitlement.refund_old_period", resource_id: user } })).toBe(1)

    await post(rc("CANCELLATION", { txn, user, at: T0 + 1000, expires: T0 + 20 * DAY, cancelReason: "CUSTOMER_SUPPORT", transactionId: `${txn}-p2` }))
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(T0 + 1000)
  })
})

describe("who it belongs to", () => {
  it("TRANSFER moves what RevenueCat holds for the receiver; an older renewal still extends it but cannot move it back, nor can an older transfer", async () => {
    const dan = await makeUser("rc-dan")
    const erin = await makeUser("rc-erin")
    users.push(dan, erin)
    const txn = newTxn()
    await post(rc("INITIAL_PURCHASE", { txn, at: T0, user: dan }))
    revenuecatHolds({ [erin]: [txn], [dan]: [txn] })
    // Forged, it moves nothing.
    expect((await post(transfer([dan], [erin], T0 + 2 * DAY), "Bearer rc_forged_0123456789abcdef0123456789")).status).toBe(401)
    expect((await rowOf(txn)).subject_id).toBe(dan)
    expect((await post(transfer([dan], [erin], T0 + 2 * DAY))).json.applied).toBe(true)
    expect((await rowOf(txn)).subject_id).toBe(erin)
    expect(await transferAudits(erin)).toEqual([{ details: expect.objectContaining({ from: [dan], moved: 1, store: "APP_STORE" }) }])
    expect(await plusAt(dan, T0 + 3 * DAY)).toBe(false)
    expect(await plusAt(erin, T0 + 3 * DAY)).toBe(true)

    // Delayed past the transfer: its window is still news, its owner is not.
    await post(rc("RENEWAL", { txn, at: T0 + DAY, user: dan, expires: T0 + 2 * MONTH }))
    expect(await rowOf(txn)).toMatchObject({ subject_id: erin })
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(T0 + 5_184_000_000)

    await post(transfer([erin], [dan], T0 + DAY))
    expect((await rowOf(txn)).subject_id).toBe(erin)
  })

  it("an attacker who restores their own purchase made under the victim's id takes only that purchase (review H1)", async () => {
    const victim = await fresh("rc-victim")
    const attacker = await fresh("rc-attacker")
    const victimSub = newTxn()
    const attackerPass = newTxn()
    await post(rc("INITIAL_PURCHASE", { user: victim, txn: victimSub, at: T0 }))
    // The attacker signed in to RevenueCat as the victim (the SDK key is public) and bought a pass.
    await post(rc("NON_RENEWING_PURCHASE", { user: victim, txn: attackerPass, at: T0 + 1000, product: "blendn_night_pass", entitlements: null, expires: null }))
    // Then restored on their own account: RevenueCat moves only the attacker's receipt.
    const rc_ = revenuecatHolds({ [attacker]: [`pass:${attackerPass}`], [victim]: [victimSub] })
    const res = await post(transfer([victim], [attacker], T0 + 5000))
    expect(res.json.applied).toBe(true)
    expect(rc_).toHaveBeenCalledWith(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(attacker)}`, expect.anything())
    expect((await rowOf(victimSub)).subject_id).toBe(victim)
    expect((await rowOf(attackerPass)).subject_id).toBe(attacker)
    expect(await plusAt(victim, T0 + 10_000)).toBe(true)
  })

  it("without RevenueCat's secret key a TRANSFER moves nothing (fail closed); a failed read is a 500 RevenueCat retries", async () => {
    const giver = await fresh("rc-giver")
    const taker = await fresh("rc-taker")
    const txn = newTxn()
    await post(rc("INITIAL_PURCHASE", { user: giver, txn, at: T0 }))
    const blind = transfer([giver], [taker], T0 + 1000)
    expect((await post(blind)).json).toMatchObject({ applied: false, refused: "unreconciled" })
    expect((await deliveryOf(blind))[0].error).toBe("unreconciled")
    expect((await rowOf(txn)).subject_id).toBe(giver)

    revenuecatHolds({}, { status: 503 })
    const down = transfer([giver], [taker], T0 + 2000)
    await expect(post(down)).rejects.toThrow()
    expect(await deliveryOf(down)).toHaveLength(0)
    jest.restoreAllMocks()
    revenuecatHolds({ [taker]: [txn] })
    expect((await post(down)).json.applied).toBe(true)
    expect((await rowOf(txn)).subject_id).toBe(taker)
  })

  it("a TRANSFER from a deleted account moves nothing", async () => {
    const gone = await fresh("rc-gonegiver")
    const taker = await fresh("rc-taker2")
    const txn = newTxn()
    await post(rc("INITIAL_PURCHASE", { user: gone, txn, at: T0 }))
    await db.user.update({ where: { id: gone }, data: { deletedAt: new Date() } })
    revenuecatHolds({ [taker]: [txn] })
    expect((await post(transfer([gone], [taker], T0 + 1000))).json).toMatchObject({ refused: "unknown_user" })
    expect((await rowOf(txn)).subject_id).toBe(gone)
  })

  it("records and never grants an id that is not one of our people: anonymous, deleted, unknown (MN-I06)", async () => {
    const gone = await makeUser("rc-gone")
    users.push(gone)
    await db.user.update({ where: { id: gone }, data: { deletedAt: new Date() } })
    for (const user of ["$RCAnonymousID:itest1234", gone, "itest_nobody"]) {
      const txn = newTxn()
      const body = rc("INITIAL_PURCHASE", { txn, at: T0, user })
      expect((await post(body)).json).toMatchObject({ applied: false, refused: "unknown_user" })
      expect(await rowsFor(txn)).toHaveLength(0)
      expect((await deliveryOf(body))[0].error).toBe("unknown_user")
    }
    // A transfer moves only between our people, to exactly one of them: never to an
    // anonymous id, never a pick among several, never from nobody we know.
    const fay = await fresh("rc-fay")
    const txn = newTxn()
    await post(rc("INITIAL_PURCHASE", { txn, at: T0, user: fay }))
    for (const [from, to] of [
      [[fay], ["$RCAnonymousID:itest9"]],
      [[fay], ["$RCAnonymousID:itest9", bob]],
      [[fay], [bob, alice]],
      [[fay], [gone]],
      [["$RCAnonymousID:itest8"], [bob]],
      [[], [bob]],
    ] as const) {
      expect((await post(transfer([...from], [...to], T0 + DAY))).json).toMatchObject({ applied: false, refused: "unknown_user" })
    }
    expect((await rowOf(txn)).subject_id).toBe(fay)
    expect(await transferAudits(bob)).toEqual([])
  })

  it("SUBSCRIBER_ALIAS and TEST are recorded and change nothing", async () => {
    for (const type of ["SUBSCRIBER_ALIAS", "TEST"]) {
      const txn = newTxn()
      const body = rc(type, { txn, at: T0 })
      expect((await post(body)).json).toMatchObject({ applied: false })
      expect(await rowsFor(txn)).toHaveLength(0)
      expect(await deliveryOf(body)).toHaveLength(1)
    }
  })
})

describe("held to this environment and to what Blendn+ is (MN-U05)", () => {
  it("a production purchase on staging, and a sandbox one in production, are recorded and never granted", async () => {
    const real = newTxn()
    const body = rc("INITIAL_PURCHASE", { txn: real, at: T0, environment: "PRODUCTION" })
    expect((await post(body)).json).toMatchObject({ refused: "wrong_environment" })
    expect(await rowsFor(real)).toHaveLength(0)

    process.env.RAILWAY_ENVIRONMENT_NAME = "production"
    try {
      const sandbox = newTxn()
      expect((await post(rc("INITIAL_PURCHASE", { txn: sandbox, at: T0 }))).json).toMatchObject({ refused: "wrong_environment" })
      expect(await rowsFor(sandbox)).toHaveLength(0)
      const live = newTxn()
      expect((await post(rc("INITIAL_PURCHASE", { txn: live, at: T0, environment: "PRODUCTION" }))).json.applied).toBe(true)
    } finally {
      delete process.env.RAILWAY_ENVIRONMENT_NAME
    }
  })

  it("App Review: in production a listed review account's sandbox purchase is credited and audited; nobody else's, and none with the list empty", async () => {
    const reviewer = await fresh("rc-reviewer")
    const other = await fresh("rc-other")
    process.env.RAILWAY_ENVIRONMENT_NAME = "production"
    try {
      delete process.env.REVIEW_ACCOUNT_IDS
      const unlisted = newTxn()
      expect((await post(rc("INITIAL_PURCHASE", { user: reviewer, txn: unlisted, at: T0 }))).json).toMatchObject({ refused: "wrong_environment" })
      expect(await rowsFor(unlisted)).toHaveLength(0)

      // Spaces as an operator would paste them.
      process.env.REVIEW_ACCOUNT_IDS = ` ${reviewer} , someone-else`
      const credited = newTxn()
      expect((await post(rc("INITIAL_PURCHASE", { user: reviewer, txn: credited, at: T0 }))).json.applied).toBe(true)
      expect(await rowsFor(credited)).toHaveLength(1)
      const audit = await db.audit_logs.findFirst({ where: { resource_id: reviewer, action: "review.bypass" } })
      expect(audit?.details).toMatchObject({ bypass: "sandbox_purchase", type: "INITIAL_PURCHASE" })

      const notListed = newTxn()
      expect((await post(rc("INITIAL_PURCHASE", { user: other, txn: notListed, at: T0 }))).json).toMatchObject({ refused: "wrong_environment" })
      expect(await rowsFor(notListed)).toHaveLength(0)
      // A transfer is not a purchase: still held to the environment.
      expect((await post(transfer([other], [reviewer], T0, { app_user_id: reviewer }))).json).toMatchObject({ refused: "wrong_environment" })
    } finally {
      delete process.env.RAILWAY_ENVIRONMENT_NAME
      delete process.env.REVIEW_ACCOUNT_IDS
      await db.audit_logs.deleteMany({ where: { resource_id: { in: [reviewer, other] } } })
    }
  })

  it("grants nothing for another product, another entitlement or another store", async () => {
    const cases = [
      { entitlements: ["pro"], product: "some_other_sub" },
      { entitlements: null, product: "coins_2100" },
      { store: "STRIPE" },
      { store: "PROMOTIONAL" },
    ]
    for (const c of cases) {
      const txn = newTxn()
      const res = await post(rc("INITIAL_PURCHASE", { txn, at: T0, ...c }))
      expect(res.json.applied).toBe(false)
      expect(["not_ours", "unsupported_store"]).toContain(res.json.refused)
      expect(await rowsFor(txn)).toHaveLength(0)
    }
  })

  it("Google Play purchases are source google", async () => {
    const txn = newTxn()
    await post(rc("INITIAL_PURCHASE", { txn, at: T0, store: "PLAY_STORE", product: "blendn_plus:monthly" }))
    expect(await rowOf(txn)).toMatchObject({ source: "google", product: "plus" })
  })
})

describe("a delivery that was refused can be applied by a resend (SCRUM-737)", () => {
  it("applies the same event id once its cause is gone: an account that did not exist yet", async () => {
    const later = `itest_later_${randomUUID().slice(0, 10)}`
    const txn = newTxn()
    const body = rc("INITIAL_PURCHASE", { txn, at: T0, user: later })
    expect((await post(body)).json).toMatchObject({ duplicate: false, applied: false, refused: "unknown_user" })
    expect(await rowsFor(txn)).toHaveLength(0)

    await db.user.create({ data: { id: later, email: `${later}@itest.invalid`, name: "Later" } })
    users.push(later)
    // RevenueCat's "resend" is the same bytes under the same event id.
    expect((await post(body)).json).toMatchObject({ duplicate: false, applied: true })
    expect(await rowsFor(txn)).toHaveLength(1)
    const [kept] = await deliveryOf(body)
    expect(kept.error).toBeNull()
    expect(kept.processed_at).not.toBeNull()
    // And now it is a duplicate, applied once.
    expect((await post(body)).json).toMatchObject({ duplicate: true, applied: false })
    expect(await rowsFor(txn)).toHaveLength(1)
  })

  it("still treats a refusal that cannot change as final: the other environment, an older event, an unsupported store", async () => {
    const user = await fresh()
    const txn = newTxn()
    const wrongEnv = rc("INITIAL_PURCHASE", { txn, at: T0, user, environment: "PRODUCTION" })
    expect((await post(wrongEnv)).json).toMatchObject({ refused: "wrong_environment" })
    expect((await post(wrongEnv)).json).toMatchObject({ duplicate: true })
    const stripe = rc("INITIAL_PURCHASE", { txn: newTxn(), at: T0, user, store: "STRIPE" })
    expect((await post(stripe)).json).toMatchObject({ refused: "unsupported_store" })
    expect((await post(stripe)).json).toMatchObject({ duplicate: true })
  })
})

describe("a refund or an expiration ends access even when the event names no expiry (SCRUM-737)", () => {
  it.each([
    ["a refund", "CANCELLATION", { cancelReason: "CUSTOMER_SUPPORT" }],
    ["an EXPIRATION", "EXPIRATION", {}],
  ])("%s with no expiration_at_ms ends the row at the event", async (_label, type, extra) => {
    const user = await fresh()
    const txn = newTxn()
    await post(rc("INITIAL_PURCHASE", { txn, user, at: T0, expires: T0 + MONTH }))
    const res = await post(rc(type, { txn, user, at: T0 + 10_000, expires: null, ...extra }))
    expect(res.json).toMatchObject({ applied: true })
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(T0 + 10_000)
  })

  it("still refuses a purchase or renewal that names no expiry: nothing says how long it runs", async () => {
    const user = await fresh()
    const txn = newTxn()
    expect((await post(rc("INITIAL_PURCHASE", { txn, user, at: T0, expires: null }))).json).toMatchObject({ refused: "malformed" })
    expect(await rowsFor(txn)).toHaveLength(0)
  })
})

describe("a replay is the same delivery, once (SCRUM-737 review)", () => {
  it("applies a refused delivery once when two resends race, and says duplicate to the other", async () => {
    const later = `itest_race_${randomUUID().slice(0, 10)}`
    const txn = newTxn()
    const body = rc("INITIAL_PURCHASE", { txn, at: T0, user: later })
    expect((await post(body)).json).toMatchObject({ refused: "unknown_user" })
    await db.user.create({ data: { id: later, email: `${later}@itest.invalid`, name: "Race" } })
    users.push(later)
    const results = await Promise.all([post(body), post(body), post(body)])
    const applied = results.filter((r) => (r.json as { applied?: boolean }).applied === true)
    expect(applied).toHaveLength(1)
    expect(results.filter((r) => (r.json as { duplicate?: boolean }).duplicate === true)).toHaveLength(2)
    const [kept] = await deliveryOf(body)
    expect(kept.error).toBeNull()
    expect(kept.processed_at).not.toBeNull()
    expect(await rowsFor(txn)).toHaveLength(1)
  })

  it("does not apply different bytes under an event id that was refused: a resend is the same body", async () => {
    const later = `itest_bytes_${randomUUID().slice(0, 10)}`
    const txn = newTxn()
    const refused = rc("INITIAL_PURCHASE", { txn, at: T0, user: later })
    expect((await post(refused)).json).toMatchObject({ refused: "unknown_user" })
    await db.user.create({ data: { id: later, email: `${later}@itest.invalid`, name: "Bytes" } })
    users.push(later)
    // Same event id, a different product and expiry.
    const other = { ...refused, event: { ...refused.event, expiration_at_ms: T0 + 40 * DAY } }
    expect((await post(other)).json).toMatchObject({ duplicate: true, applied: false })
    expect(await rowsFor(txn)).toHaveLength(0)
    expect((await deliveryOf(refused))[0].error).toBe("unknown_user")
  })
})

describe("a refund or an expiration only ever shortens (SCRUM-737 review)", () => {
  it("does not lengthen a window that already ended earlier, with or without a stated expiry", async () => {
    const user = await fresh()
    const txn = newTxn()
    await post(rc("INITIAL_PURCHASE", { txn, user, at: T0, expires: T0 + DAY }))
    // An EXPIRATION stamped a month later, naming no expiry: it ends access, so it cannot move the end to its own time.
    expect((await post(rc("EXPIRATION", { txn, user, at: T0 + MONTH, expires: null }))).json).toMatchObject({ applied: true })
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(T0 + DAY)
    // Same for a refund that names a later expiry than the row holds.
    const refundTxn = newTxn()
    await post(rc("INITIAL_PURCHASE", { txn: refundTxn, user, at: T0, expires: T0 + DAY }))
    await post(rc("CANCELLATION", { txn: refundTxn, user, at: T0 + MONTH, expires: T0 + 2 * MONTH, cancelReason: "CUSTOMER_SUPPORT" }))
    expect((await rowOf(refundTxn)).expires_at!.getTime()).toBe(T0 + DAY)
  })
})

describe("the store's clock cannot freeze a row or buy a millennium (SCRUM-731)", () => {
  it("refuses an event stamped ahead of the server's clock, so a real expiration still lands", async () => {
    const user = await fresh()
    const txn = newTxn()
    await post(rc("INITIAL_PURCHASE", { txn, user, at: T0, expires: T0 + MONTH }))
    const skewed = rc("RENEWAL", { txn, user, at: Date.now() + 10 * DAY, expires: Date.now() + 40 * DAY })
    expect((await post(skewed)).json).toMatchObject({ applied: false, refused: "future_event" })
    // Not applied, so the window is where it was, and the next real event is not "stale".
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(T0 + MONTH)
    const end = await post(rc("EXPIRATION", { txn, user, at: T0 + 2 * DAY, expires: T0 + 2 * DAY }))
    expect(end.json).toMatchObject({ applied: true })
    expect((await rowOf(txn)).expires_at!.getTime()).toBe(T0 + 2 * DAY)
  })

  it("lets the same refused event be applied by a resend once its time has come (the refusal is retryable)", async () => {
    const user = await fresh()
    const txn = newTxn()
    const eventAt = Date.now() + 2 * 60 * 60 * 1000
    const soon = rc("INITIAL_PURCHASE", { txn, user, at: eventAt, expires: eventAt + 30 * DAY })
    expect((await post(soon)).json).toMatchObject({ refused: "future_event" })
    expect((await deliveryOf(soon))[0].error).toBe("future_event")
    expect(await rowsFor(txn)).toHaveLength(0)
    // Two hours on, RevenueCat resends the same bytes: the event's time has come, and it applies.
    const raw = JSON.stringify(soon)
    const again = await recordRevenuecatEvent(
      revenuecatBodySchema.parse(JSON.parse(raw)),
      createHash("sha256").update(raw).digest("hex"),
      new Date(eventAt + 1000)
    )
    expect(again).toMatchObject({ duplicate: false, applied: true })
    expect(await rowsFor(txn)).toHaveLength(1)
  })

  it("tolerates a few minutes of clock skew, which is what a real clock does", async () => {
    const user = await fresh()
    const txn = newTxn()
    const res = await post(rc("INITIAL_PURCHASE", { txn, user, at: Date.now() + 2 * 60 * 1000, expires: Date.now() + MONTH }))
    expect(res.json).toMatchObject({ applied: true })
  })

  it("refuses an expiry more than five years past the event", async () => {
    const user = await fresh()
    for (const years of [6, 275_000]) {
      const txn = newTxn()
      const res = await post(rc("INITIAL_PURCHASE", { txn, user, at: T0, expires: Math.min(T0 + years * 365 * DAY, 8.64e15) }))
      expect(res.json).toMatchObject({ applied: false, refused: "malformed" })
      expect(await rowsFor(txn)).toHaveLength(0)
    }
    const ok = newTxn()
    expect((await post(rc("INITIAL_PURCHASE", { txn: ok, user, at: T0, expires: T0 + 4 * 365 * DAY }))).json).toMatchObject({ applied: true })
  })
})
