/*
 * Sponsors, step 17 part C, against real Postgres (TQ-DS04: MN-I01..I04 for
 * payment links; SCRUM-560; F8 reach).
 *
 *   - "Send payment link": admin only, an agreed charge only, a claimed brand
 *     only, payments on; our record of the link holds the sponsor's org and
 *     the charge's amount; `external_ref` names the link; a second send returns
 *     the first.
 *   - `payment_link.paid` settles the charge exactly once (replay, re-send,
 *     a later delivery), from our row — the notes are never read; a wrong
 *     amount or currency is refused; a voided charge is not resurrected; a
 *     full refund voids it.
 *   - Reach: distinct people from the per-campaign hashes, the larger campaign
 *     on a two-campaign placement, held back under 5 with its exposures, and
 *     the sponsor's 30 days summing only what is shown.
 *   - Review pass 2 and scans 3–4: the link created silent and emailed after
 *     the commit; an orphan cancelled; a void or a settle closes the link at
 *     Razorpay first; paid twice, refunds, early refunds, disputes, expiry;
 *     and four races run at once (send ∥ void, send ∥ send, void ∥ paid,
 *     settle ∥ paid), each ending with no payable link on a closed charge and
 *     no payment lost or unflagged. Stored reach survives its sweep.
 *
 * Razorpay's API is a stub `fetch`; signatures are computed here.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { createHmac, randomUUID } from "crypto"
import { NextRequest } from "next/server"

import { planPageData } from "@/lib/billing"
import { advanceCharge, getChargeLedger, pricePlacement, sendPaymentLink } from "@/lib/charge-actions"
import { logger } from "@/lib/logger"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { getSponsorOverview } from "@/lib/sponsor-actions"
import { placementReach, reachKey } from "@/lib/sponsor-reach"
import { materialiseEndedReach, sweepSponsored } from "@/lib/sponsored-scheduler"

import { cleanup, closeDb, db, makeEvent, makeUser, refusingWrites, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const route = require("@/app/api/webhooks/razorpay/route") as typeof import("@/app/api/webhooks/razorpay/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const SECRET = "whsec_itest_payment_links_0123456789abcdef"
const DAY = 24 * 60 * 60 * 1000
const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const sponsors: string[] = []
const placements: string[] = []

let admin = ""
let host = ""
let sponsorUser = ""
let sponsorOrg = ""
let brand = ""

const calls: { method: string; url: string; body: Record<string, unknown> | undefined }[] = []
const realFetch = global.fetch

/** Razorpay's own view of each link it made: what GET answers, and what a second cancel refuses. */
const atRazorpay = new Map<string, string>()
const fail = { create: false, cancel: false, notify: false }
let payHost = "rzp.io"
/** A call held at Razorpay until released (`hold`), so a test can run something beside it. */
const gates: Partial<Record<"create" | "cancel", Promise<void>>> = {}
const arrivals: Partial<Record<"create" | "cancel", () => void>> = {}

function hold(kind: "create" | "cancel") {
  let release = () => {}
  gates[kind] = new Promise<void>((r) => (release = r))
  const arrived = new Promise<void>((r) => (arrivals[kind] = r))
  return {
    arrived,
    release: () => {
      delete gates[kind]
      release()
    },
  }
}

function stubRazorpay() {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ method, url, body })
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status })
    const id = decodeURIComponent(url.split("/payment_links/")[1]?.split("/")[0] ?? "")
    if (url.endsWith("/payment_links") && method === "POST") {
      arrivals.create?.()
      if (gates.create) await gates.create
      if (fail.create) return json(500, { error: { description: "Razorpay is having a bad day" } })
      // Razorpay's own rules for a link, so a request it would refuse fails here too.
      const broken = linkContractBroken(body)
      if (broken) return json(400, { error: { description: broken } })
      const made = `plink_${randomUUID().slice(0, 12)}`
      atRazorpay.set(made, "created")
      return json(200, { id: made, short_url: `https://${payHost}/i/${made.slice(6)}`, status: "created", amount: body?.amount, currency: "INR" })
    }
    if (url.endsWith("/cancel")) {
      arrivals.cancel?.()
      if (gates.cancel) await gates.cancel
      if (fail.cancel) return json(500, { error: { description: "Razorpay is having a bad day" } })
      if (atRazorpay.get(id) !== "created") return json(400, { error: { description: "Payment link cannot be cancelled" } })
      atRazorpay.set(id, "cancelled")
      return json(200, { id, status: "cancelled" })
    }
    if (url.includes("/notify_by/")) return fail.notify ? json(500, { error: { description: "no" } }) : json(200, { success: true })
    if (method === "GET" && id) return json(200, { id, status: atRazorpay.get(id) ?? "created" })
    return json(404, { error: { description: "not stubbed" } })
  }) as typeof fetch
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** What Razorpay refuses in a Payment Link request (its API docs): this stub refuses it too. */
function linkContractBroken(body: Record<string, unknown> | undefined): string | null {
  const ref = body?.reference_id
  if (typeof ref !== "string" || ref.length > 40) return "reference_id: at most 40 characters"
  const amount = body?.amount
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 100) return "amount: whole paise, at least 100"
  const expireBy = body?.expire_by
  if (typeof expireBy !== "number" || expireBy < Math.floor(Date.now() / 1000) + 15 * 60) return "expire_by: at least 15 minutes ahead"
  const notes = body?.notes
  if (notes && Object.keys(notes as object).length > 15) return "notes: at most 15 keys"
  return null
}

/**
 * Sessions on this database waiting on a lock (advisory or a row's): the
 * moment a racer is really blocked, rather than a guessed sleep.
 */
const lockWaiters = async () =>
  (
    await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`
  )[0].n
async function waitFor(check: () => Promise<boolean>, ms = 5000) {
  for (let waited = 0; waited < ms; waited += 20) {
    if (await check()) return
    await sleep(20)
  }
  throw new Error("timed out waiting")
}
const blocked = () => waitFor(async () => (await lockWaiters()) > 0)
let errors: jest.SpyInstance
const loggedWith = (key: string, value: unknown) =>
  errors.mock.calls.some(([, meta]) => {
    const v = (meta as Record<string, unknown> | undefined)?.[key]
    return Array.isArray(v) ? v.includes(value) : v === value
  })
/** Links a sponsor could still pay through. */
const payable = (chargeId: string) => db.billing_checkouts.count({ where: { charge_id: chargeId, status: { in: ["created", "issued", "partially_paid"] } } })
const auditCount = (chargeId: string, action: string) => db.audit_logs.count({ where: { resource_id: chargeId, action } })

const as = (id: string, role: "app_admin" | "organizer" | "sponsor") => mockGetAuth.mockResolvedValue({ user: { id, role } })

/** An approved placement of `sponsorId` at a fresh event, priced at `amountMinor`, in `status`. */
async function charge(opts: { status?: "draft" | "agreed" | "settled"; amountMinor?: number; sponsorId?: string; start?: Date } = {}) {
  const eventId = await makeEvent(host)
  events.push(eventId)
  if (opts.start) {
    await db.events.update({ where: { id: eventId }, data: { start_time: opts.start, end_time: new Date(opts.start.getTime() + 3 * 3600_000) } })
  }
  const placement = await db.event_sponsors.create({
    data: { event_id: eventId, sponsor_id: opts.sponsorId ?? brand, status: "approved", created_by: host },
  })
  placements.push(placement.id)
  const status = opts.status ?? "agreed"
  const row = await db.placement_charges.create({
    data: {
      placement_id: placement.id,
      amount_minor: opts.amountMinor ?? 250_000,
      currency: "INR",
      status,
      priced_by: admin,
      external_ref: "Pricing note: two nights",
      ...(status !== "draft" ? { agreed_at: new Date() } : {}),
    },
  })
  return { chargeId: row.id, eventId, placementId: placement.id }
}

const chargeRow = (id: string) => db.placement_charges.findUniqueOrThrow({ where: { id } })

function post(body: unknown, eventId = `itest_pl_${randomUUID()}`) {
  const raw = JSON.stringify(body)
  return route.POST(
    new NextRequest("http://localhost/api/webhooks/razorpay", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": "203.0.113.12",
        "x-razorpay-signature": createHmac("sha256", SECRET).update(raw).digest("hex"),
        "x-razorpay-event-id": eventId,
      },
      body: raw,
    })
  )
}

const T0 = Math.floor(Date.now() / 1000) - 600
function linkPaid(linkId: string, opts: { amount?: number; paid?: number; currency?: string; status?: string; at?: number; paymentId?: string; notes?: Record<string, string> } = {}) {
  const amount = opts.amount ?? 250_000
  return {
    entity: "event",
    event: "payment_link.paid",
    created_at: opts.at ?? T0,
    payload: {
      payment_link: {
        entity: {
          id: linkId,
          amount,
          amount_paid: opts.paid ?? amount,
          currency: opts.currency ?? "INR",
          status: opts.status ?? "paid",
          reference_id: "chg_x",
          customer: { email: "payer@example.com", contact: "+919999999999" },
          notes: opts.notes ?? {},
        },
      },
      payment: { entity: { id: opts.paymentId ?? `pay_${randomUUID().slice(0, 10)}`, amount, currency: opts.currency ?? "INR", status: "captured" } },
      order: { entity: { id: `order_${randomUUID().slice(0, 10)}`, amount, amount_paid: amount, currency: "INR", status: "paid" } },
    },
  }
}

/** A sent link for an agreed charge: what "Send payment link" leaves. */
async function sentLink(amountMinor = 250_000) {
  const c = await charge({ amountMinor })
  as(admin, "app_admin")
  const { linkId } = await sendPaymentLink(c.chargeId)
  return { ...c, linkId }
}

beforeAll(async () => {
  admin = await makeUser(testId("pl-admin"), "app_admin")
  host = await makeUser(testId("pl-host"), "organizer")
  sponsorUser = await makeUser(testId("pl-sponsor"), "organizer")
  users.push(admin, host, sponsorUser)
  await db.user.update({ where: { id: sponsorUser }, data: { role: "sponsor" } })
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("pl-sponsor-org"), status: "verified" } })
  orgs.push(org.id)
  sponsorOrg = org.id
  await db.organisation_members.create({ data: { org_id: org.id, user_id: sponsorUser, role: "owner", is_primary_contact: true } })
  const b = await db.sponsors.create({ data: { name: testId("pl-brand"), name_key: testId("pl-brandkey"), created_by: admin, org_id: org.id } })
  sponsors.push(b.id)
  brand = b.id
})

beforeEach(() => {
  calls.length = 0
  resetMemoryStore()
  fail.create = fail.cancel = fail.notify = false
  payHost = "rzp.io"
  errors = jest.spyOn(logger, "error").mockImplementation(() => undefined)
  process.env.RAZORPAY_KEY_ID = "rzp_test_itestkey"
  process.env.RAZORPAY_KEY_SECRET = "itest_key_secret_value_24"
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET
  stubRazorpay()
})

afterEach(() => {
  errors.mockRestore()
  global.fetch = realFetch
  delete process.env.RAZORPAY_KEY_ID
  delete process.env.RAZORPAY_KEY_SECRET
  delete process.env.RAZORPAY_WEBHOOK_SECRET
})

afterAll(async () => {
  const charges = await db.placement_charges.findMany({ where: { placement_id: { in: placements } }, select: { id: true } })
  const chargeIds = charges.map((c) => c.id)
  await db.payment_events.deleteMany({ where: { provider_event_id: { startsWith: "itest_pl_" } } })
  await db.billing_payments.deleteMany({ where: { checkout: { charge_id: { in: chargeIds } } } })
  await db.billing_checkouts.deleteMany({ where: { charge_id: { in: chargeIds } } })
  await db.audit_logs.deleteMany({ where: { resource_id: { in: chargeIds } } })
  await db.placement_charges.deleteMany({ where: { id: { in: chargeIds } } })
  await db.sponsored_message_sends.deleteMany({ where: { message: { event_id: { in: events } } } })
  await db.sponsored_creatives.deleteMany({ where: { message: { event_id: { in: events } } } })
  await db.event_sponsored_messages.deleteMany({ where: { event_id: { in: events } } })
  await db.event_sponsors.deleteMany({ where: { id: { in: placements } } })
  await db.sponsors.deleteMany({ where: { id: { in: sponsors } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, events)
  await closeDb()
})

describe("Send payment link", () => {
  it("records the link against the charge, at its amount, for the sponsor's organisation", async () => {
    const c = await charge({ amountMinor: 312_500 })
    as(admin, "app_admin")
    const out = await sendPaymentLink(c.chargeId)
    expect(out.reused).toBe(false)
    const checkout = await db.billing_checkouts.findFirstOrThrow({ where: { charge_id: c.chargeId } })
    expect(checkout).toMatchObject({ kind: "payment_link", provider_ref: out.linkId, org_id: sponsorOrg, amount_minor: 312_500, currency: "INR", status: "created" })
    expect(checkout.pay_url).toMatch(/^https:\/\/rzp\.io\//)
    // The pricing note stays; the link is tied by charge_id, and settling names it.
    expect((await chargeRow(c.chargeId)).external_ref).toBe("Pricing note: two nights")
    const create = calls.find((x) => x.url.endsWith("/payment_links"))
    expect(create?.body).toMatchObject({ amount: 312_500, currency: "INR", accept_partial: false, notes: { org_id: sponsorOrg, charge_id: c.chargeId } })
    // Created silent; emailed only after our record committed.
    expect(create?.body?.notify).toEqual({ email: false, sms: false })
    expect(calls.map((x) => x.url.replace(/^.*\/v1/, ""))).toEqual(["/payment_links", `/payment_links/${out.linkId}/notify_by/email`])
    expect((create?.body?.customer as { email: string }).email).toBe(`${sponsorUser}@itest.invalid`)
    // A second click returns the first link and asks Razorpay for nothing.
    const again = await sendPaymentLink(c.chargeId)
    expect(again).toMatchObject({ linkId: out.linkId, reused: true })
    expect(calls.filter((x) => x.url.endsWith("/payment_links"))).toHaveLength(1)
  })

  it.each([
    ["a draft charge", { status: "draft" as const }, () => as(admin, "app_admin"), "Only an agreed charge"],
    ["a non-admin", {}, () => as(host, "organizer"), "Forbidden"],
  ])("refuses %s, writing nothing", async (_label, opts, who, sentence) => {
    const c = await charge(opts)
    who()
    await expect(sendPaymentLink(c.chargeId)).rejects.toThrow(sentence)
    expect(await db.billing_checkouts.count({ where: { charge_id: c.chargeId } })).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it("refuses an unclaimed brand, and payments switched off", async () => {
    const orphanBrand = await db.sponsors.create({ data: { name: testId("pl-orphan"), name_key: testId("pl-orphankey"), created_by: admin } })
    sponsors.push(orphanBrand.id)
    const c = await charge({ sponsorId: orphanBrand.id })
    as(admin, "app_admin")
    await expect(sendPaymentLink(c.chargeId)).rejects.toThrow("no organisation yet")
    const d = await charge()
    delete process.env.RAZORPAY_KEY_ID
    await expect(sendPaymentLink(d.chargeId)).rejects.toThrow("Payments aren't switched on")
    expect(await db.billing_checkouts.count({ where: { charge_id: { in: [c.chargeId, d.chargeId] } } })).toBe(0)
  })
})

describe("payment_link.paid settles the charge (MN-I01..I04)", () => {
  it("settles once: a replay, a re-send under a new id and a later delivery change nothing more", async () => {
    const { chargeId, linkId } = await sentLink()
    const paymentId = `pay_${randomUUID().slice(0, 10)}`
    const body = linkPaid(linkId, { paymentId })
    const eventId = `itest_pl_${randomUUID()}`
    expect((await post(body, eventId)).status).toBe(200)
    const settled = await chargeRow(chargeId)
    expect(settled).toMatchObject({ status: "settled", external_ref: linkId })
    expect(settled.settled_at?.getTime()).toBe(T0 * 1000)

    expect((await post(body, eventId)).status).toBe(200)
    expect((await post(body)).status).toBe(200)
    expect((await post(linkPaid(linkId, { paymentId, at: T0 + 30 }))).status).toBe(200)

    expect((await chargeRow(chargeId)).settled_at?.getTime()).toBe(T0 * 1000)
    expect(await db.billing_payments.count({ where: { provider_payment_id: paymentId } })).toBe(1)
    const audits = await db.audit_logs.findMany({ where: { resource_id: chargeId, action: "charge.settled" } })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ resource: "placement_charges" })
    expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: linkId } })).status).toBe("paid")
    // Kept as a tax record: ids and amounts, never the payer's email or phone.
    const kept = JSON.stringify((await db.payment_events.findFirstOrThrow({ where: { provider_event_id: eventId } })).payload)
    expect(kept).toContain(linkId)
    expect(kept).not.toContain("payer@example.com")
    expect(kept).not.toContain("+919999999999")
  })

  it.each([
    ["a smaller amount paid", { paid: 100_000 }],
    ["a different amount", { amount: 300_000 }],
    ["another currency", { currency: "USD" }],
    ["a link Razorpay does not call paid", { status: "partially_paid" }],
  ])("refuses %s: not settled, recorded as amount_mismatch", async (_label, opts) => {
    const { chargeId, linkId } = await sentLink()
    const eventId = `itest_pl_${randomUUID()}`
    expect((await post(linkPaid(linkId, opts), eventId)).status).toBe(200)
    expect((await chargeRow(chargeId)).status).toBe("agreed")
    expect((await db.payment_events.findFirstOrThrow({ where: { provider_event_id: eventId } })).error).toBe("amount_mismatch")
  })

  it("never reads the notes: an unknown link changes nothing, and notes naming another charge are ignored", async () => {
    const other = await sentLink()
    const eventId = `itest_pl_${randomUUID()}`
    expect((await post(linkPaid(`plink_${randomUUID().slice(0, 10)}`, { notes: { charge_id: other.chargeId, org_id: sponsorOrg } }), eventId)).status).toBe(200)
    expect((await chargeRow(other.chargeId)).status).toBe("agreed")
    expect((await db.payment_events.findFirstOrThrow({ where: { provider_event_id: eventId } })).error).toBe("unknown_ref")

    const mine = await sentLink()
    expect((await post(linkPaid(mine.linkId, { notes: { charge_id: other.chargeId } }))).status).toBe(200)
    expect((await chargeRow(mine.chargeId)).status).toBe("settled")
    expect((await chargeRow(other.chargeId)).status).toBe("agreed")
  })

  it("a charge voided before the payment lands stays void, and is flagged for a refund", async () => {
    const { chargeId, linkId } = await sentLink()
    as(admin, "app_admin")
    await advanceCharge(chargeId, "void", undefined, "Sponsor pulled out before the night")
    expect((await post(linkPaid(linkId))).status).toBe(200)
    expect((await chargeRow(chargeId)).status).toBe("void")
    expect(await db.audit_logs.count({ where: { resource_id: chargeId, action: "charge.paid_after_void" } })).toBe(1)
  })

  it("a full refund of the link's payment voids the charge it settled", async () => {
    const { chargeId, linkId } = await sentLink()
    const paymentId = `pay_${randomUUID().slice(0, 10)}`
    await post(linkPaid(linkId, { paymentId }))
    const refundId = `rfnd_${randomUUID().slice(0, 8)}`
    const refund = {
      entity: "event",
      event: "refund.processed",
      created_at: T0 + 60,
      payload: { refund: { entity: { id: refundId, payment_id: paymentId, amount: 250_000, currency: "INR", status: "processed" } } },
    }
    expect((await post(refund)).status).toBe(200)
    const row = await chargeRow(chargeId)
    expect(row).toMatchObject({ status: "void", voided_by: null, void_reason: `Refunded at Razorpay (${refundId})` })
    expect((await db.billing_payments.findFirstOrThrow({ where: { provider_payment_id: paymentId } })).status).toBe("refunded")
  })
})

describe("reach (F8)", () => {
  let hashSeq = 0
  const people = (n: number) => Array.from({ length: n }, () => `h${hashSeq++}`)

  /** A campaign at the placement's event with sends, each with the hashes of who was in the room. */
  async function campaign(eventId: string, sends: string[][], live = 0) {
    const m = await db.event_sponsored_messages.create({ data: { event_id: eventId, sponsor_id: brand, content: "Sample sponsored message" } })
    const creative = await db.sponsored_creatives.create({ data: { message_id: m.id, content: "Sample sponsored message", moderation_status: "approved" } })
    for (const [i, hashes] of sends.entries()) {
      await db.sponsored_message_sends.create({
        data: {
          sponsored_message_id: m.id,
          creative_id: creative.id,
          scheduled_for: new Date(Date.now() - (i + 1) * 30 * 60_000),
          members: hashes.length,
          live_connected: live,
          recipient_hashes: hashes,
        },
      })
    }
  }

  it("counts distinct people across a campaign's sends, the larger of two campaigns, and holds back under 5", async () => {
    const big = await charge({ start: new Date(Date.now() - 2 * DAY) })
    const crowd = people(7)
    await campaign(big.eventId, [crowd.slice(0, 5), crowd.slice(2, 7), crowd.slice(0, 3)], 4)
    await campaign(big.eventId, [people(6)])
    const small = await charge({ start: new Date(Date.now() - 3 * DAY) })
    await campaign(small.eventId, [people(3), people(0)])

    const reach = await placementReach([
      { eventId: big.eventId, sponsorId: brand },
      { eventId: small.eventId, sponsorId: brand },
    ])
    // 7 distinct in the first campaign, 6 in the second: the larger, never 13.
    // Frequency is that campaign's own, 13 / 7, never all 19 exposures over 7 (db M6).
    expect(reach.get(reachKey(big.eventId, brand))).toEqual({
      reach: 7,
      suppressed: false,
      exposures: 19,
      frequency: 1.9,
      liveSharePct: Math.round((12 / 19) * 100),
      sends: 4,
    })
    expect(reach.get(reachKey(small.eventId, brand))).toEqual({
      reach: null,
      suppressed: true,
      exposures: null,
      frequency: null,
      liveSharePct: null,
      sends: 2,
    })

    // The sponsor's 30 days: the shown night only, and a flag for the held one.
    as(sponsorUser, "sponsor")
    const overview = await getSponsorOverview()
    const row = (eventId: string) => overview.placements.find((p) => p.eventId === eventId)
    expect(row(big.eventId)).toMatchObject({ reach: 7, reachSuppressed: false })
    expect(row(small.eventId)).toMatchObject({ reach: null, reachSuppressed: true })
    expect(overview.reach30dSuppressed).toBe(true)
    expect(overview.reach30d).toBe(7)

    // The admin's ledger carries the same reach and its band.
    as(admin, "app_admin")
    const ledger = await getChargeLedger()
    expect(ledger.placements.find((p) => p.eventId === big.eventId)).toMatchObject({ reach: { reach: 7 }, band: { key: "5-49" } })
    expect(ledger.placements.find((p) => p.eventId === small.eventId)).toMatchObject({ reach: { reach: null }, band: null })
  })

  it("shows the sponsor an unpaid link as Pay on its placement, and nothing once it is paid", async () => {
    const { eventId, linkId } = await sentLink(180_000)
    as(sponsorUser, "sponsor")
    const due = (await getSponsorOverview()).placements.find((p) => p.eventId === eventId)?.due
    expect(due).toMatchObject({ amountMinor: 180_000, currency: "INR", payUrl: expect.stringMatching(/^https:\/\/rzp\.io\//) })
    await post(linkPaid(linkId, { amount: 180_000 }))
    as(sponsorUser, "sponsor")
    expect((await getSponsorOverview()).placements.find((p) => p.eventId === eventId)?.due).toBeNull()
  })
})

describe("Send payment link: when one side fails (review H4; scans 3 and 4)", () => {
  it("Razorpay refuses: no row, no audit, nothing to cancel", async () => {
    const c = await charge()
    as(admin, "app_admin")
    fail.create = true
    await expect(sendPaymentLink(c.chargeId)).rejects.toThrow("Razorpay didn't accept that just now")
    expect(await db.billing_checkouts.count({ where: { charge_id: c.chargeId } })).toBe(0)
    expect(await auditCount(c.chargeId, "charge.link_sent")).toBe(0)
    expect(calls.some((x) => x.url.endsWith("/cancel"))).toBe(false)
  })

  it("the database refuses after Razorpay made the link: no row, nobody emailed, the link cancelled and logged", async () => {
    const c = await charge()
    as(admin, "app_admin")
    await refusingWrites("billing_checkouts", "INSERT", `NEW.charge_id = '${c.chargeId}'`, () =>
      expect(sendPaymentLink(c.chargeId)).rejects.toThrow("Something went wrong on our side")
    )
    const [orphan] = [...atRazorpay.entries()].at(-1)!
    expect(await db.billing_checkouts.count({ where: { charge_id: c.chargeId } })).toBe(0)
    expect(atRazorpay.get(orphan)).toBe("cancelled")
    expect(calls.some((x) => x.url.includes("/notify_by/"))).toBe(false)
    expect(loggedWith("orphanProviderRef", orphan)).toBe(true)
    expect(await auditCount(c.chargeId, "charge.link_sent")).toBe(0)
  })

  it("a failure after the commit never cancels the link it committed", async () => {
    const c = await charge()
    as(admin, "app_admin")
    const { revalidatePath } = jest.requireMock("next/cache") as { revalidatePath: jest.Mock }
    revalidatePath.mockImplementationOnce(() => {
      throw new Error("revalidate failed")
    })
    await expect(sendPaymentLink(c.chargeId)).rejects.toThrow()
    const row = await db.billing_checkouts.findFirstOrThrow({ where: { charge_id: c.chargeId } })
    expect(atRazorpay.get(row.provider_ref)).toBe("created")
    expect(await payable(c.chargeId)).toBe(1)
  })

  it("Razorpay not emailing it afterwards is logged, and the link stands", async () => {
    const c = await charge()
    as(admin, "app_admin")
    fail.notify = true
    const out = await sendPaymentLink(c.chargeId)
    expect(await payable(c.chargeId)).toBe(1)
    expect(loggedWith("paymentLinkId", out.linkId)).toBe(true)
  })

  it("a pay URL that is not Razorpay's is never stored", async () => {
    const c = await charge()
    as(admin, "app_admin")
    payHost = "rzp.io.evil.example"
    await expect(sendPaymentLink(c.chargeId)).rejects.toThrow("Razorpay didn't accept that just now")
    expect(await db.billing_checkouts.count({ where: { charge_id: c.chargeId } })).toBe(0)
  })

  it("refuses a suspended brand's organisation, and more than ten sends a minute, refusals included", async () => {
    const c = await charge()
    as(admin, "app_admin")
    await db.organisations.update({ where: { id: sponsorOrg }, data: { status: "suspended" } })
    try {
      await expect(sendPaymentLink(c.chargeId)).rejects.toThrow("suspended")
    } finally {
      await db.organisations.update({ where: { id: sponsorOrg }, data: { status: "verified" } })
    }
    for (let i = 0; i < 9; i++) await expect(sendPaymentLink(randomUUID())).rejects.toThrow("Charge not found")
    await expect(sendPaymentLink(c.chargeId)).rejects.toThrow("Too many payment links")
    expect(calls).toHaveLength(0)
  })

  it("a link older than Razorpay keeps is expired, and a new one sent", async () => {
    const { chargeId, linkId } = await sentLink()
    await db.billing_checkouts.updateMany({ where: { provider_ref: linkId }, data: { created_at: new Date(Date.now() - 16 * DAY) } })
    as(admin, "app_admin")
    const again = await sendPaymentLink(chargeId)
    expect(again.reused).toBe(false)
    expect(again.linkId).not.toBe(linkId)
    expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: linkId } })).status).toBe("expired")
    expect(await payable(chargeId)).toBe(1)
  })

  it("the role is the database's: a session claiming app_admin for an organiser sends nothing", async () => {
    const c = await charge()
    as(host, "app_admin")
    await expect(sendPaymentLink(c.chargeId)).rejects.toThrow("Forbidden")
    await expect(advanceCharge(c.chargeId, "void", undefined, "a forged admin claim")).rejects.toThrow("Forbidden")
    expect(calls).toHaveLength(0)
  })
})

describe("a void or a hand settlement closes the link first (review H1)", () => {
  it("void: cancelled at Razorpay, then here, then the charge, audited with the link", async () => {
    const { chargeId, linkId } = await sentLink()
    as(admin, "app_admin")
    await advanceCharge(chargeId, "void", undefined, "Sponsor pulled out before the night")
    expect(atRazorpay.get(linkId)).toBe("cancelled")
    expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: linkId } })).status).toBe("cancelled")
    expect((await chargeRow(chargeId)).status).toBe("void")
    const audit = await db.audit_logs.findFirstOrThrow({ where: { resource_id: chargeId, action: "charge.void" } })
    expect(audit.details).toMatchObject({ closedLinks: [linkId] })
  })

  it("refuses while money came through the link: paid here, or paid at Razorpay", async () => {
    const paidHere = await sentLink()
    await post(linkPaid(paidHere.linkId))
    as(admin, "app_admin")
    await expect(advanceCharge(paidHere.chargeId, "void", undefined, "Trying to void a link-paid charge")).rejects.toThrow("A payment came through")
    expect((await chargeRow(paidHere.chargeId)).status).toBe("settled")

    const paidThere = await sentLink()
    atRazorpay.set(paidThere.linkId, "paid")
    await expect(advanceCharge(paidThere.chargeId, "settled", "NEFT-UTR-445566")).rejects.toThrow("A payment came through")
    expect((await chargeRow(paidThere.chargeId)).status).toBe("agreed")
  })

  it("thirty moves a minute per admin, refusals included, before any Razorpay call", async () => {
    const { chargeId } = await sentLink()
    as(admin, "app_admin")
    calls.length = 0
    for (let i = 0; i < 30; i++) await expect(advanceCharge(randomUUID(), "void", undefined, "Not a charge at all, refused")).rejects.toThrow("Charge not found")
    await expect(advanceCharge(chargeId, "void", undefined, "Sponsor pulled out before the night")).rejects.toThrow("Too many changes in a minute")
    expect(calls).toHaveLength(0)
    expect((await chargeRow(chargeId)).status).toBe("agreed")
  })

  it("Razorpay refuses the cancel: nothing changes, the link stays open, logged", async () => {
    const { chargeId, linkId } = await sentLink()
    as(admin, "app_admin")
    fail.cancel = true
    await expect(advanceCharge(chargeId, "void", undefined, "Sponsor pulled out before the night")).rejects.toThrow("wouldn't cancel")
    expect((await chargeRow(chargeId)).status).toBe("agreed")
    expect(await payable(chargeId)).toBe(1)
    expect(await auditCount(chargeId, "charge.void")).toBe(0)
    expect(loggedWith("paymentLinkId", linkId)).toBe(true)
  })

  it("the database fails after Razorpay cancelled: refused and logged; the next attempt finds it closed and goes through", async () => {
    const { chargeId, linkId } = await sentLink()
    as(admin, "app_admin")
    await refusingWrites("audit_logs", "INSERT", `NEW.action = 'charge.void' AND NEW.resource_id = '${chargeId}'`, () =>
      expect(advanceCharge(chargeId, "void", undefined, "Sponsor pulled out before the night")).rejects.toThrow()
    )
    expect(atRazorpay.get(linkId)).toBe("cancelled")
    expect((await chargeRow(chargeId)).status).toBe("agreed")
    expect(loggedWith("paymentLinkIds", linkId)).toBe(true)
    // Razorpay refuses a second cancel; it says the link is closed, so the void goes through.
    await advanceCharge(chargeId, "void", undefined, "Sponsor pulled out before the night")
    expect((await chargeRow(chargeId)).status).toBe("void")
    expect(await payable(chargeId)).toBe(0)
  })
})

describe("the webhook, against our rows (review H3, M2, M5; db M1, M2)", () => {
  it("a charge settled by hand and then paid by its link is flagged paid twice; refunding that payment leaves the settlement", async () => {
    const { chargeId, linkId } = await sentLink()
    atRazorpay.set(linkId, "paid") // the sponsor paid at Razorpay before the hand settlement closed it
    await db.placement_charges.update({ where: { id: chargeId }, data: { status: "settled", settled_at: new Date(), external_ref: "NEFT-UTR-998877" } })
    const paymentId = `pay_${randomUUID().slice(0, 10)}`
    await post(linkPaid(linkId, { paymentId }))
    expect(await auditCount(chargeId, "charge.paid_twice")).toBe(1)
    expect(loggedWith("settledRef", "NEFT-UTR-998877")).toBe(true)
    await post({
      entity: "event",
      event: "refund.processed",
      created_at: T0 + 60,
      payload: { refund: { entity: { id: `rfnd_${randomUUID().slice(0, 8)}`, payment_id: paymentId, amount: 250_000, currency: "INR", status: "processed" } } },
    })
    expect(await chargeRow(chargeId)).toMatchObject({ status: "settled", external_ref: "NEFT-UTR-998877" })
  })

  it("a refund that arrives before the payment is applied once the payment lands", async () => {
    const { chargeId, linkId } = await sentLink()
    const paymentId = `pay_${randomUUID().slice(0, 10)}`
    const refundEvent = `itest_pl_${randomUUID()}`
    await post(
      {
        entity: "event",
        event: "refund.processed",
        created_at: T0 + 60,
        payload: { refund: { entity: { id: `rfnd_${randomUUID().slice(0, 8)}`, payment_id: paymentId, amount: 250_000, currency: "INR", status: "processed" } } },
      },
      refundEvent
    )
    expect((await db.payment_events.findFirstOrThrow({ where: { provider_event_id: refundEvent } })).error).toBe("unknown_ref")
    await post(linkPaid(linkId, { paymentId }))
    expect((await chargeRow(chargeId)).status).toBe("void")
    expect((await db.payment_events.findFirstOrThrow({ where: { provider_event_id: refundEvent } })).error).toBeNull()
  })

  it("a dispute is flagged; lost, the charge this link settled is void", async () => {
    const { chargeId, linkId } = await sentLink()
    const paymentId = `pay_${randomUUID().slice(0, 10)}`
    await post(linkPaid(linkId, { paymentId }))
    const dispute = (event: string, at: number) => ({
      entity: "event",
      event,
      created_at: at,
      payload: { dispute: { entity: { id: `disp_${randomUUID().slice(0, 8)}`, payment_id: paymentId, amount: 250_000, currency: "INR" } } },
    })
    await post(dispute("payment.dispute.created", T0 + 60))
    expect(await auditCount(chargeId, "charge.disputed")).toBe(1)
    expect((await chargeRow(chargeId)).status).toBe("settled")
    await post(dispute("payment.dispute.lost", T0 + 120))
    expect((await chargeRow(chargeId)).status).toBe("void")
  })

  it("payment_link.expired and .cancelled close the link here; a paid link stays paid", async () => {
    const expiring = await sentLink()
    const closed = (linkId: string, event: string) => ({ entity: "event", event, created_at: T0 + 30, payload: { payment_link: { entity: { id: linkId, status: event.split(".")[1] } } } })
    await post(closed(expiring.linkId, "payment_link.expired"))
    expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: expiring.linkId } })).status).toBe("expired")
    const cancelling = await sentLink()
    await post(closed(cancelling.linkId, "payment_link.cancelled"))
    expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: cancelling.linkId } })).status).toBe("cancelled")
    const paid = await sentLink()
    await post(linkPaid(paid.linkId))
    await post(closed(paid.linkId, "payment_link.expired"))
    expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: paid.linkId } })).status).toBe("paid")
  })

  it("the organisation's Plan page never lists a sponsor link payment (review 16, db M3)", async () => {
    const { linkId } = await sentLink(420_000)
    await post(linkPaid(linkId, { amount: 420_000 }))
    const page = await planPageData({ orgId: sponsorOrg, orgName: "x", memberRole: "owner", mayBuy: true })
    expect(page.payments).toEqual([])
  })
})

describe("races, run at once (scan 4)", () => {
  /** The end every race must reach: no link to pay on a closed charge, and every payment recorded. */
  async function settledState(chargeId: string) {
    const row = await chargeRow(chargeId)
    if (row.status === "void" || row.status === "settled") expect(await payable(chargeId)).toBe(0)
    return row
  }

  it("send ∥ void: the void waits for the send, then closes the link it made", async () => {
    const c = await charge()
    as(admin, "app_admin")
    const making = hold("create")
    const send = sendPaymentLink(c.chargeId)
    await making.arrived // the send holds the charge while Razorpay makes the link
    const voiding = advanceCharge(c.chargeId, "void", undefined, "Sponsor pulled out mid-send")
    await blocked()
    making.release()
    const [sent] = await Promise.all([send, voiding])
    expect((await settledState(c.chargeId)).status).toBe("void")
    expect(atRazorpay.get(sent.linkId)).toBe("cancelled")
  })

  it("send ∥ send: one link, both callers given it, one Razorpay call", async () => {
    const c = await charge()
    as(admin, "app_admin")
    const making = hold("create")
    const first = sendPaymentLink(c.chargeId)
    await making.arrived
    const second = sendPaymentLink(c.chargeId)
    await blocked()
    making.release()
    const [a, b] = await Promise.all([first, second])
    expect(b).toMatchObject({ linkId: a.linkId, reused: true })
    expect(calls.filter((x) => x.url.endsWith("/payment_links"))).toHaveLength(1)
    expect(await payable(c.chargeId)).toBe(1)
  })

  it("void ∥ payment_link.paid: the void closes the link first; the payment is recorded and flagged for a refund", async () => {
    const { chargeId, linkId } = await sentLink()
    const paymentId = `pay_${randomUUID().slice(0, 10)}`
    as(admin, "app_admin")
    const cancelling = hold("cancel")
    const voiding = advanceCharge(chargeId, "void", undefined, "Sponsor pulled out as they paid")
    await cancelling.arrived // the void holds the link's row
    const paying = post(linkPaid(linkId, { paymentId }))
    await blocked()
    cancelling.release()
    const [, res] = await Promise.all([voiding, paying])
    expect(res.status).toBe(200)
    expect((await settledState(chargeId)).status).toBe("void")
    expect(await db.billing_payments.count({ where: { provider_payment_id: paymentId } })).toBe(1)
    expect(await auditCount(chargeId, "charge.paid_after_void")).toBe(1)
  })

  it("hand settle ∥ payment_link.paid: settled by hand; the link's payment is recorded and flagged paid twice", async () => {
    const { chargeId, linkId } = await sentLink()
    const paymentId = `pay_${randomUUID().slice(0, 10)}`
    as(admin, "app_admin")
    const cancelling = hold("cancel")
    const settling = advanceCharge(chargeId, "settled", "NEFT-UTR-112233")
    await cancelling.arrived
    const paying = post(linkPaid(linkId, { paymentId }))
    await blocked()
    cancelling.release()
    const [, res] = await Promise.all([settling, paying])
    expect(res.status).toBe(200)
    expect(await settledState(chargeId)).toMatchObject({ status: "settled", external_ref: "NEFT-UTR-112233" })
    expect(await db.billing_payments.count({ where: { provider_payment_id: paymentId } })).toBe(1)
    expect(await auditCount(chargeId, "charge.paid_twice")).toBe(1)
  })
})

describe("void ∥ payment_link.paid, unordered, twenty times (the database review's trial)", () => {
  it("whichever wins: never a payment lost, never void unflagged, never settled and voided", async () => {
    for (let i = 0; i < 20; i++) {
      resetMemoryStore() // one admin, forty actions: the per-minute limits are not what this tests
      const { chargeId, linkId } = await sentLink()
      const paymentId = `pay_${randomUUID().slice(0, 10)}`
      as(admin, "app_admin")
      const [voided] = await Promise.allSettled([
        advanceCharge(chargeId, "void", undefined, "Voiding in a race, reason long enough"),
        post(linkPaid(linkId, { paymentId })),
      ])
      const row = await chargeRow(chargeId)
      expect(await db.billing_payments.count({ where: { provider_payment_id: paymentId } })).toBe(1)
      expect(await payable(chargeId)).toBe(0)
      if (row.status === "void") expect(await auditCount(chargeId, "charge.paid_after_void")).toBe(1)
      if (row.status === "settled") expect(await auditCount(chargeId, "charge.void")).toBe(0)
      expect(["void/fulfilled", "settled/rejected"]).toContain(`${row.status}/${voided.status}`)
    }
  })
})

describe("stored reach (db H5)", () => {
  it("stores each ended campaign's reach once, empties its hashes, and reads the same figure after", async () => {
    const ended = await charge({ start: new Date(Date.now() - 2 * DAY) })
    const m = await db.event_sponsored_messages.create({ data: { event_id: ended.eventId, sponsor_id: brand, content: "Sample sponsored message" } })
    const creative = await db.sponsored_creatives.create({ data: { message_id: m.id, content: "Sample sponsored message", moderation_status: "approved" } })
    const hashes = Array.from({ length: 6 }, (_, i) => `stored${i}_${randomUUID().slice(0, 6)}`)
    for (const [i, room] of [hashes.slice(0, 4), hashes.slice(2, 6)].entries()) {
      await db.sponsored_message_sends.create({
        data: { sponsored_message_id: m.id, creative_id: creative.id, scheduled_for: new Date(Date.now() - 2 * DAY + i * 60_000), members: room.length, live_connected: 0, recipient_hashes: room },
      })
    }
    const before = (await placementReach([{ eventId: ended.eventId, sponsorId: brand }])).get(reachKey(ended.eventId, brand))
    expect(before?.reach).toBe(6)

    expect(await materialiseEndedReach()).toBeGreaterThanOrEqual(1)
    expect(await db.event_sponsored_messages.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ reach: 6 })
    const sends = await db.sponsored_message_sends.findMany({ where: { sponsored_message_id: m.id }, select: { recipient_hashes: true } })
    expect(sends.every((s) => s.recipient_hashes.length === 0)).toBe(true)
    expect((await placementReach([{ eventId: ended.eventId, sponsorId: brand }])).get(reachKey(ended.eventId, brand))).toEqual(before)

    // Again: nothing counted twice, nothing changed.
    const stamped = (await db.event_sponsored_messages.findUniqueOrThrow({ where: { id: m.id } })).reach_materialised_at
    await materialiseEndedReach()
    expect((await db.event_sponsored_messages.findUniqueOrThrow({ where: { id: m.id } })).reach_materialised_at).toEqual(stamped)
  })

  it("leaves a campaign whose event has not ended counting live", async () => {
    const running = await charge({ start: new Date(Date.now() - 60 * 60_000) })
    const m = await db.event_sponsored_messages.create({ data: { event_id: running.eventId, sponsor_id: brand, content: "Sample sponsored message" } })
    await materialiseEndedReach()
    expect(await db.event_sponsored_messages.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ reach: null, reach_materialised_at: null })
  })
})
/* ------------------------------------------------------------------ */
/* REVIEW GAP TESTS                                                    */
/* ------------------------------------------------------------------ */
const refundEvent = (paymentId: string, amount: number, at: number) => ({
  entity: "event",
  event: "refund.processed",
  created_at: at,
  payload: { refund: { entity: { id: `rfnd_${randomUUID().slice(0, 8)}`, payment_id: paymentId, amount, currency: "INR", status: "processed" } } },
})

describe("GAP", () => {
  it("GAP-Y05 a void that commits between the send's first read and its lock stops the send before Razorpay", async () => {
    const c = await charge()
    as(admin, "app_admin")
    let sending!: Promise<unknown>
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`charge:${c.chargeId}`}, 0))`
      sending = sendPaymentLink(c.chargeId)
      sending.catch(() => undefined)
      await blocked()
      await tx.placement_charges.update({
        where: { id: c.chargeId },
        data: { status: "void", voided_at: new Date(), voided_by: admin, void_reason: "Voided before the send took its lock" },
      })
    })
    await expect(sending).rejects.toThrow("Someone else changed that charge")
    expect(calls.some((x) => x.url.endsWith("/payment_links"))).toBe(false)
    expect(await db.billing_checkouts.count({ where: { charge_id: c.chargeId } })).toBe(0)
  })

  it("GAP-Y11 a PARTIAL refund that arrives before the payment is not applied as a void", async () => {
    const { chargeId, linkId } = await sentLink()
    const paymentId = `pay_${randomUUID().slice(0, 10)}`
    await post(refundEvent(paymentId, 100_000, T0 + 60))
    await post(linkPaid(linkId, { paymentId }))
    expect((await chargeRow(chargeId)).status).toBe("settled")
  })

  it("GAP-Y12 a dispute lost on a link payment made twice leaves the hand settlement alone", async () => {
    const { chargeId, linkId } = await sentLink()
    atRazorpay.set(linkId, "paid")
    await db.placement_charges.update({ where: { id: chargeId }, data: { status: "settled", settled_at: new Date(), external_ref: "NEFT-UTR-998877" } })
    const paymentId = `pay_${randomUUID().slice(0, 10)}`
    await post(linkPaid(linkId, { paymentId }))
    expect(await auditCount(chargeId, "charge.paid_twice")).toBe(1)
    await post({
      entity: "event",
      event: "payment.dispute.lost",
      created_at: T0 + 120,
      payload: { dispute: { entity: { id: `disp_${randomUUID().slice(0, 8)}`, payment_id: paymentId, amount: 250_000, currency: "INR" } } },
    })
    expect(await chargeRow(chargeId)).toMatchObject({ status: "settled", external_ref: "NEFT-UTR-998877" })
  })

  it("GAP-X10 a link Razorpay already expired (webhook missed) does not block a void", async () => {
    const { chargeId, linkId } = await sentLink()
    atRazorpay.set(linkId, "expired")
    as(admin, "app_admin")
    await advanceCharge(chargeId, "void", undefined, "Sponsor pulled out; the link had expired")
    expect((await chargeRow(chargeId)).status).toBe("void")
    expect((await db.billing_checkouts.findFirstOrThrow({ where: { provider_ref: linkId } })).status).toBe("expired")
  })

  it("GAP-X11 a link 13.9 days old is still payable at Razorpay and is reused, not replaced", async () => {
    const { chargeId, linkId } = await sentLink()
    await db.billing_checkouts.updateMany({ where: { provider_ref: linkId }, data: { created_at: new Date(Date.now() - 13.9 * DAY) } })
    as(admin, "app_admin")
    expect(await sendPaymentLink(chargeId)).toMatchObject({ reused: true, linkId })
    expect(await payable(chargeId)).toBe(1)
  })

  it("GAP-X13 a campaign whose event ended half an hour ago keeps its hashes; one that ended three hours ago is stored", async () => {
    const recent = await charge({ start: new Date(Date.now() - 3.5 * 3600_000) }) // ends 30 minutes ago
    const older = await charge({ start: new Date(Date.now() - 6 * 3600_000) }) // ended 3 hours ago
    const made: Record<string, string> = {}
    for (const [label, c] of [["recent", recent], ["older", older]] as const) {
      const m = await db.event_sponsored_messages.create({ data: { event_id: c.eventId, sponsor_id: brand, content: "Sample sponsored message" } })
      const creative = await db.sponsored_creatives.create({ data: { message_id: m.id, content: "Sample sponsored message", moderation_status: "approved" } })
      await db.sponsored_message_sends.create({
        data: { sponsored_message_id: m.id, creative_id: creative.id, scheduled_for: new Date(Date.now() - 4 * 3600_000), members: 5, live_connected: 0, recipient_hashes: Array.from({ length: 5 }, (_, i) => `${label}${i}_${randomUUID().slice(0, 6)}`) },
      })
      made[label] = m.id
    }
    await materialiseEndedReach()
    expect(await db.event_sponsored_messages.findUniqueOrThrow({ where: { id: made.recent } })).toMatchObject({ reach: null, reach_materialised_at: null })
    expect((await db.sponsored_message_sends.findFirstOrThrow({ where: { sponsored_message_id: made.recent } })).recipient_hashes).toHaveLength(5)
    expect(await db.event_sponsored_messages.findUniqueOrThrow({ where: { id: made.older } })).toMatchObject({ reach: 5 })
  })

  it("GAP-Y13 the scheduler's own tick stores an ended campaign's reach and empties its hashes", async () => {
    const ended = await charge({ start: new Date(Date.now() - 2 * DAY) })
    const m = await db.event_sponsored_messages.create({ data: { event_id: ended.eventId, sponsor_id: brand, content: "Sample sponsored message" } })
    const creative = await db.sponsored_creatives.create({ data: { message_id: m.id, content: "Sample sponsored message", moderation_status: "approved" } })
    await db.sponsored_message_sends.create({
      data: { sponsored_message_id: m.id, creative_id: creative.id, scheduled_for: new Date(Date.now() - 2 * DAY), members: 5, live_connected: 0, recipient_hashes: Array.from({ length: 5 }, (_, i) => `tick${i}_${randomUUID().slice(0, 6)}`) },
    })
    await sweepSponsored(new Date())
    expect(await db.event_sponsored_messages.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ reach: 5 })
    expect((await db.sponsored_message_sends.findFirstOrThrow({ where: { sponsored_message_id: m.id } })).recipient_hashes).toHaveLength(0)
  })

  it("GAP-Y14 an expired or cancelled link is not offered to the sponsor as Pay", async () => {
    const { eventId, linkId } = await sentLink(180_000)
    await db.billing_checkouts.updateMany({ where: { provider_ref: linkId }, data: { status: "expired" } })
    as(sponsorUser, "sponsor")
    expect((await getSponsorOverview()).placements.find((p) => p.eventId === eventId)?.due).toBeNull()
  })

  it("GAP-X12 a brand handed to another organisation between the send's read and its lock is not sent a link", async () => {
    const c = await charge()
    as(admin, "app_admin")
    const other = await db.organisations.create({ data: { kind: "company", display_name: testId("pl-other-org"), status: "verified" } })
    orgs.push(other.id)
    let sending!: Promise<unknown>
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`charge:${c.chargeId}`}, 0))`
        sending = sendPaymentLink(c.chargeId)
        sending.catch(() => undefined)
        await blocked()
        await tx.sponsors.update({ where: { id: brand }, data: { org_id: other.id } })
      })
      await expect(sending).rejects.toThrow("Someone else changed that charge")
      expect(calls.some((x) => x.url.endsWith("/payment_links"))).toBe(false)
    } finally {
      await db.sponsors.update({ where: { id: brand }, data: { org_id: sponsorOrg } })
    }
  })
})


describe("final review: prices, references and the paid states nothing expects", () => {
  it("D4 refuses a price under ₹1 or with fractions of a paisa, and a malformed placement, writing nothing and calling nobody", async () => {
    const c = await charge()
    await db.placement_charges.update({ where: { id: c.chargeId }, data: { status: "void", voided_at: new Date(), void_reason: "Making room for a new price" } })
    as(admin, "app_admin")
    await expect(pricePlacement(c.placementId, { amount: 0.5 })).rejects.toThrow("at least ₹1")
    await expect(pricePlacement(c.placementId, { amount: 12.345 })).rejects.toThrow("two decimals")
    await expect(pricePlacement("not-a-uuid", { amount: 100 })).rejects.toThrow("Placement not found")
    expect(await db.placement_charges.count({ where: { placement_id: c.placementId, status: { not: "void" } } })).toBe(0)
    expect(calls).toHaveLength(0)
    await pricePlacement(c.placementId, { amount: 1 })
    expect((await db.placement_charges.findFirstOrThrow({ where: { placement_id: c.placementId, status: "draft" } })).amount_minor).toBe(100)
  })

  it("refuses a payment reference longer than 100 characters", async () => {
    const c = await charge()
    as(admin, "app_admin")
    await expect(advanceCharge(c.chargeId, "settled", "U".repeat(101))).rejects.toThrow("under 100 characters")
    expect((await chargeRow(c.chargeId)).status).toBe("agreed")
    await advanceCharge(c.chargeId, "settled", "U".repeat(100))
    expect((await chargeRow(c.chargeId)).status).toBe("settled")
  })

  it("a link payment on a charge in a state no link is sent for is recorded and flagged, never settled", async () => {
    const { chargeId, linkId } = await sentLink()
    await db.placement_charges.update({ where: { id: chargeId }, data: { status: "draft", agreed_at: null } })
    const paymentId = `pay_${randomUUID().slice(0, 10)}`
    expect((await post(linkPaid(linkId, { paymentId }))).status).toBe(200)
    expect((await chargeRow(chargeId)).status).toBe("draft")
    expect(await db.billing_payments.count({ where: { provider_payment_id: paymentId } })).toBe(1)
    expect(await auditCount(chargeId, "charge.paid_unexpected")).toBe(1)
    expect(loggedWith("chargeStatus", "draft")).toBe(true)
  })
})
