/**
 * Money in the audit log is its payer's (step 18 security review, M3 follow-up).
 *
 * Organisation A pays for Venue Pro on its venue; the venue then passes to B
 * (an approved dispute). Every row about what A paid — the subscription, the
 * payment and invoice ids, the amounts, the entitlements that ended — stays
 * A's, and B's log carries one row saying a previous owner's Venue Pro ended,
 * with nothing of A's in it. The step-17 Plan page already scopes a venue's
 * billing to its payer (`lib/venue-plan.ts`); the log follows the same rule.
 * A sponsor's charge is the brand's to read, never the host's. And the
 * backfill gives an old row the organisation of its time, never the venue's
 * owner today.
 */
import { createHmac, randomUUID } from "crypto"
import { readFileSync } from "fs"
import { join } from "path"
import { NextRequest } from "next/server"

let session: { user: { id: string; role: string } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { auditInTx } from "@/lib/audit-log"
import { getAuditLog } from "@/lib/audit-actions"
import { endPreviousOwnersPro } from "@/lib/subscription-cancel"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const route = require("@/app/api/webhooks/razorpay/route") as typeof import("@/app/api/webhooks/razorpay/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const SECRET = "whsec_itest_money_attribution_0123456789abcdef"
const PLAN_ID = "plan_itest_venue_pro"
const AMOUNT = 353_900
const tag = testId("money")

const users: string[] = []
const orgs: string[] = []
const venues: string[] = []
const events: string[] = []
const refs: string[] = []
let ownerA = ""
let ownerB = ""
let admin = ""
let orgA = ""
let orgB = ""

const as = (id: string, role = "organizer") => {
  session = { user: { id, role } }
}

/** Everything in a viewer's log, as text: whatever is in a row they read is in here. */
async function logOf(viewer: string, role = "organizer") {
  as(viewer, role)
  const log = await getAuditLog()
  return { rows: log.entries, text: JSON.stringify(log.entries) }
}

async function org(label: string) {
  const o = await db.organisations.create({ data: { kind: "company", display_name: testId(label), status: "verified" } })
  orgs.push(o.id)
  return o.id
}

function charged(subId: string, paymentId: string, invoiceId: string) {
  const at = Math.floor(Date.now() / 1000)
  return {
    entity: "event",
    account_id: "acc_itest",
    event: "subscription.charged",
    contains: ["subscription", "payment"],
    payload: {
      subscription: {
        entity: { id: subId, entity: "subscription", plan_id: PLAN_ID, status: "active", start_at: at, current_start: at, current_end: at + 30 * 86_400, ended_at: null, notes: {} },
      },
      payment: { entity: { id: paymentId, entity: "payment", amount: AMOUNT, currency: "INR", status: "captured", invoice_id: invoiceId, email: "payer@example.com" } },
    },
    created_at: at,
  }
}

function post(body: unknown) {
  const raw = JSON.stringify(body)
  const headers = {
    "content-type": "application/json",
    "x-real-ip": "203.0.113.77",
    "x-razorpay-signature": createHmac("sha256", SECRET).update(raw).digest("hex"),
    "x-razorpay-event-id": `itest_evt_${randomUUID()}`,
  }
  return route.POST(new NextRequest("http://localhost/api/webhooks/razorpay", { method: "POST", headers, body: raw }))
}

beforeAll(async () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET
  ownerA = await makeUser("money_ownerA", "organizer")
  ownerB = await makeUser("money_ownerB", "organizer")
  admin = await makeUser("money_admin", "app_admin")
  users.push(ownerA, ownerB, admin)
  orgA = await org("Money A")
  orgB = await org("Money B")
  await db.organisation_members.createMany({
    data: [
      { org_id: orgA, user_id: ownerA, role: "owner" },
      { org_id: orgB, user_id: ownerB, role: "owner" },
    ],
  })
})

afterAll(async () => {
  delete process.env.RAZORPAY_WEBHOOK_SECRET
  await db.payment_events.deleteMany({ where: { checkout: { provider_ref: { in: refs } } } })
  await db.billing_payments.deleteMany({ where: { checkout: { provider_ref: { in: refs } } } })
  await db.entitlements.deleteMany({ where: { subject_id: { in: [...venues, ...orgs] } } })
  await db.billing_checkouts.deleteMany({ where: { provider_ref: { in: refs } } })
  await db.audit_logs.deleteMany({ where: { OR: [{ resource_id: { in: [...venues, ...orgs] } }, { action: { startsWith: tag } }] } })
  await db.placement_charges.deleteMany({ where: { placement: { event_id: { in: events } } } })
  await db.event_sponsors.deleteMany({ where: { event_id: { in: events } } })
  await db.sponsors.deleteMany({ where: { name: { startsWith: tag } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

it("A pays for Venue Pro, the venue passes to B: B reads that it ended, never A's money; A reads all of its own", async () => {
  const venue = await db.venues.create({
    data: { name: `${tag} venue`, city: "Bengaluru", latitude: 12.97, longitude: 77.6, owner_org_id: orgA, claimed_at: new Date(Date.now() - 86_400_000) },
  })
  venues.push(venue.id)
  const ref = `sub_${randomUUID().slice(0, 12)}`
  refs.push(ref)
  await db.billing_checkouts.create({
    data: { kind: "subscription", provider_ref: ref, provider_plan_id: PLAN_ID, org_id: orgA, venue_id: venue.id, plan_key: "venue_pro_monthly", amount_minor: AMOUNT },
  })
  const paymentId = `pay_${randomUUID().slice(0, 10)}`
  const invoiceId = `inv_${randomUUID().slice(0, 10)}`
  expect((await post(charged(ref, paymentId, invoiceId))).status).toBe(200)
  const paidRows = await db.audit_logs.findMany({ where: { resource_id: venue.id } })
  expect(paidRows.length).toBeGreaterThan(0)
  for (const r of paidRows) expect(r.org_id).toBe(orgA)

  // The transfer: B's claim approved, and in the same transaction A's Venue Pro ends.
  await db.$transaction(async (tx) => {
    await tx.venues.update({ where: { id: venue.id }, data: { owner_org_id: orgB, claimed_at: new Date() } })
    expect(await endPreviousOwnersPro(tx, venue.id, orgB, admin)).toBe(1)
  })

  // A's mandate charges again after the move (Razorpay has not stopped it yet):
  // the webhook refuses to grant B a Pro A pays for, and records it — as A's.
  const latePayment = `pay_${randomUUID().slice(0, 10)}`
  const lateInvoice = `inv_${randomUUID().slice(0, 10)}`
  expect((await post(charged(ref, latePayment, lateInvoice))).status).toBe(200)
  const lateRows = await db.audit_logs.findMany({ where: { resource_id: venue.id, created_at: { gte: new Date(Date.now() - 60_000) } } })
  expect(lateRows.some((r) => r.action === "billing.payer_not_owner")).toBe(true)

  const endedIds = (await db.entitlements.findMany({ where: { subject_id: venue.id }, select: { id: true } })).map((e) => e.id)
  const b = await logOf(ownerB)
  for (const secret of [ref, paymentId, invoiceId, latePayment, lateInvoice, String(AMOUNT), orgA, ...endedIds]) expect(b.text).not.toContain(secret)
  const ended = b.rows.filter((r) => r.resourceId !== null || r.action.startsWith("entitlement.")).map((r) => r.action)
  expect(ended).toContain("entitlement.previous_owner_pro_ended")
  expect(b.rows.find((r) => r.action === "entitlement.previous_owner_pro_ended")?.details).toEqual({
    note: "Venue Pro from the previous owner ended at transfer",
  })

  const a = await logOf(ownerA)
  expect(a.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["entitlement.ended_on_transfer"]))
  expect(a.text).toContain(ref)
})

it("a sponsor's charge is in the brand's log and the platform's, never the host's", async () => {
  const host = await org("Money Host")
  const brandOrg = await org("Money Brand")
  const hostOwner = await makeUser("money_host", "organizer")
  const brandOwner = await makeUser("money_brand", "organizer")
  users.push(hostOwner, brandOwner)
  await db.organisation_members.createMany({
    data: [
      { org_id: host, user_id: hostOwner, role: "owner" },
      { org_id: brandOrg, user_id: brandOwner, role: "owner" },
    ],
  })
  const eventId = await makeEvent(hostOwner)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: host } })
  const brand = await db.sponsors.create({ data: { name: `${tag} brand`, name_key: `${tag}brand`, org_id: brandOrg } })
  const placement = await db.event_sponsors.create({ data: { event_id: eventId, sponsor_id: brand.id, status: "approved", created_by: hostOwner } })
  const charge = await db.placement_charges.create({ data: { placement_id: placement.id, amount_minor: 1_250_000, currency: "INR", status: "agreed", priced_by: admin } })

  await db.$transaction((tx) =>
    auditInTx(tx, { userId: admin, action: `${tag}.charge.priced`, resource: "placement_charges", resourceId: charge.id, details: { amountMinor: 1_250_000 } })
  )
  const row = await db.audit_logs.findFirstOrThrow({ where: { action: `${tag}.charge.priced` } })
  expect(row.org_id).toBe(brandOrg)

  expect((await logOf(brandOwner)).rows.some((r) => r.action === `${tag}.charge.priced`)).toBe(true)
  expect((await logOf(hostOwner)).rows.some((r) => r.action === `${tag}.charge.priced`)).toBe(false)
  as(admin, "app_admin")
  expect((await getAuditLog({ action: `${tag}.charge.priced` })).total).toBe(1)
})

it("the backfill gives a transferred venue's old rows the organisation of their time, never its owner today", async () => {
  const venue = await db.venues.create({
    data: { name: `${tag} history`, city: "Bengaluru", latitude: 12.97, longitude: 77.6, owner_org_id: orgB, claimed_at: new Date(Date.now() - 86_400_000) },
  })
  venues.push(venue.id)
  const before = new Date(Date.now() - 10 * 86_400_000)
  const after = new Date(Date.now() - 3_600_000)
  const legacy = (action: string, at: Date, details?: object) =>
    db.audit_logs.create({ data: { user_id: ownerA, action: `${tag}.${action}`, resource: "venue", resource_id: venue.id, created_at: at, ...(details && { details }) } })
  // A's era: A paid, and edited the venue. Then B's claim (claimed_at, a day ago), and B edited it.
  await legacy("billing.checkout.started", before, { orgId: orgA, providerRef: "sub_old_A", plan: "venue_pro_monthly" })
  await db.audit_logs.updateMany({ where: { action: `${tag}.billing.checkout.started` }, data: { action: "billing.checkout.started" } })
  await legacy("venue.updated-in-A-era", before)
  await legacy("venue.updated-in-B-era", after)

  const sql = readFileSync(join(process.cwd(), "prisma/migrations/20261010130100_audit_logs_org_backfill/migration.sql"), "utf8")
  const statements = sql
    .replace(/--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && !/^(BEGIN|COMMIT|SET LOCAL)/i.test(s))
  await db.$transaction(async (tx) => {
    for (const s of statements) await tx.$executeRawUnsafe(s)
  })

  const orgOf = async (where: object) => (await db.audit_logs.findFirstOrThrow({ where: { resource_id: venue.id, ...where }, select: { org_id: true } })).org_id
  // The payer's row is the payer's.
  expect(await orgOf({ action: "billing.checkout.started" })).toBe(orgA)
  // From before B owned it: never B's; not provably A's either, so nobody's.
  expect(await orgOf({ action: `${tag}.venue.updated-in-A-era` })).toBeNull()
  // From B's era: B's.
  expect(await orgOf({ action: `${tag}.venue.updated-in-B-era` })).toBe(orgB)

  const b = await logOf(ownerB)
  expect(b.text).not.toContain("sub_old_A")
})
