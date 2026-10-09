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
 *
 * Razorpay's API is a stub `fetch`; signatures are computed here.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { createHmac, randomUUID } from "crypto"
import { NextRequest } from "next/server"

import { advanceCharge, getChargeLedger, sendPaymentLink } from "@/lib/charge-actions"
import { getSponsorOverview } from "@/lib/sponsor-actions"
import { placementReach, reachKey } from "@/lib/sponsor-reach"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

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

function stubRazorpay() {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ method: init?.method ?? "GET", url, body })
    if (url.endsWith("/payment_links")) {
      const id = `plink_${randomUUID().slice(0, 12)}`
      return new Response(
        JSON.stringify({ id, short_url: `https://rzp.io/i/${id.slice(6)}`, status: "created", amount: body?.amount, currency: "INR" }),
        { status: 200 }
      )
    }
    return new Response(JSON.stringify({ error: { description: "not stubbed" } }), { status: 404 })
  }) as typeof fetch
}

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
    expect((await chargeRow(c.chargeId)).external_ref).toBe(out.linkId)
    const create = calls.find((x) => x.url.endsWith("/payment_links"))
    expect(create?.body).toMatchObject({ amount: 312_500, currency: "INR", accept_partial: false, notes: { org_id: sponsorOrg, charge_id: c.chargeId } })
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
    expect(reach.get(reachKey(big.eventId, brand))).toEqual({
      reach: 7,
      suppressed: false,
      exposures: 19,
      frequency: 2.7,
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
