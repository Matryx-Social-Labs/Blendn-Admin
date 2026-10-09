/*
 * The Plan page, as the server renders it (G11, G3 for payments).
 *
 *   - Payments are the organisation's own: another organisation's payment (a
 *     canary amount) never appears in planPageData or on the page.
 *   - Every ₹ figure the page itself prints is a table price or its GST split.
 *   - `?status=pending` with nothing granted says "Payment sent" and holds Buy
 *     back; once the entitlement exists it says the plan, not "sent".
 *   - Every open subscription is listed.
 *
 * The element tree the page returns is serialised (everything React would put
 * in the RSC payload), as in analytics-gating.itest.ts.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { randomUUID } from "crypto"

import { billingOrgFor, planPageData } from "@/lib/billing"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const page = require("@/app/dashboard/plan/page") as typeof import("@/app/dashboard/plan/page")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const orgs: string[] = []
let owner = ""
let orgA = ""
let orgB = ""
let subA = ""

async function tree(params: Record<string, string> = {}): Promise<string> {
  const t = await page.default({ searchParams: Promise.resolve(params) })
  const seen = new WeakSet<object>()
  return JSON.stringify(t, (key, value) => {
    if (key.startsWith("_") || typeof value === "function" || typeof value === "symbol") return undefined
    if (value && typeof value === "object") {
      if (seen.has(value)) return undefined
      seen.add(value)
    }
    return value
  })
}

beforeAll(async () => {
  owner = await makeUser(testId("plan-owner"), "organizer")
  const other = await makeUser(testId("plan-other"), "organizer")
  users.push(owner, other)
  for (const label of ["plan-a", "plan-b"]) {
    orgs.push((await db.organisations.create({ data: { kind: "company", display_name: testId(label), status: "verified" } })).id)
  }
  ;[orgA, orgB] = orgs
  await db.organisation_members.createMany({ data: [{ org_id: orgA, user_id: owner, role: "owner" }, { org_id: orgB, user_id: other, role: "owner" }] })
  subA = `sub_${randomUUID().slice(0, 10)}`
  const checkoutA = await db.billing_checkouts.create({
    data: { kind: "subscription", provider_ref: subA, provider_plan_id: "plan_m", org_id: orgA, plan_key: "analytics_monthly", amount_minor: 235_900, status: "active", current_end: new Date("2026-11-03T10:00:00Z") },
  })
  const checkoutB = await db.billing_checkouts.create({
    data: { kind: "subscription", provider_ref: `sub_${randomUUID().slice(0, 10)}`, provider_plan_id: "plan_m", org_id: orgB, plan_key: "analytics_monthly", amount_minor: 777_700, status: "active" },
  })
  await db.billing_payments.createMany({
    data: [
      { provider_payment_id: `pay_${randomUUID().slice(0, 8)}`, checkout_id: checkoutA.id, amount_minor: 235_900, currency: "INR", invoice_id: "inv_mine_0001", captured_at: new Date("2026-10-03T10:00:00Z") },
      { provider_payment_id: `pay_${randomUUID().slice(0, 8)}`, checkout_id: checkoutB.id, amount_minor: 777_700, currency: "INR", invoice_id: "inv_theirs_0001", captured_at: new Date("2026-10-03T10:00:00Z") },
    ],
  })
  mockGetAuth.mockResolvedValue({ user: { id: owner, role: "organizer" } })
})

afterAll(async () => {
  await db.entitlements.deleteMany({ where: { subject_id: { in: orgs } } })
  await db.billing_payments.deleteMany({ where: { checkout: { org_id: { in: orgs } } } })
  await db.billing_checkouts.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

describe("the organisation's own payments only (G3)", () => {
  it("planPageData lists this organisation's payment and never another's", async () => {
    const org = await billingOrgFor({ id: owner, role: "organizer" })
    const view = await planPageData(org!)
    expect(view.payments.map((p) => p.reference)).toEqual(["inv_mine_0001"])
    expect(view.subscriptions.map((s) => s.providerRef)).toEqual([subA])
  })

  it("and the page carries no trace of the other organisation's", async () => {
    const t = await tree()
    expect(t).toContain("inv_mine_0001")
    expect(t).not.toContain("inv_theirs_0001")
    expect(t).not.toContain("7,777")
  })
})

describe("prices (G11)", () => {
  it("every ₹ figure the page prints is a table price or its GST split", async () => {
    let t = await tree()
    for (const split of ["₹1,999 + ₹360 GST", "₹499 + ₹90 GST", "₹19,990 + ₹3,598 GST"]) t = t.split(split).join("")
    const figures = new Set(t.match(/₹[\d,]+/g) ?? [])
    expect([...figures].every((f) => ["₹0", "₹589", "₹2,359", "₹23,588"].includes(f))).toBe(true)
    expect(figures.has("₹589")).toBe(true)
  })
})

describe("after Checkout (?status=pending)", () => {
  // The status panel's words come from these props; the tree carries props, not a nested component's text.
  it("with nothing granted yet: pending, so 'Payment sent' and Buy held back", async () => {
    const t = await tree({ status: "pending", for: "analytics", ref: subA })
    expect(t).toMatch(/"pending":true,"pendingFor":"analytics"/)
    expect(t).toMatch(/"enabled":false,"pending":true\}/)
  })

  it("once the webhook granted it: not pending, and the card says when it renews", async () => {
    await db.entitlements.create({
      data: { subject_kind: "org", subject_id: orgA, product: "analytics", source: "razorpay", external_ref: subA, starts_at: new Date(Date.now() - 1000), expires_at: new Date(Date.now() + 86_400_000) },
    })
    const t = await tree({ status: "pending", for: "analytics", ref: subA })
    expect(t).toMatch(/"pending":false,"pendingFor":"analytics"/)
    expect(t).toContain("On, renews 3 Nov 2026.")
  })
})
