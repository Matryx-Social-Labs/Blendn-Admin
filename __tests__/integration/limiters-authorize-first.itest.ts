/*
 * A rate limit is spent on the caller's own business only (security audit
 * 2026-10-24, WEB M3 + L5).
 *
 * `cancelVenuePro` burned `billing:start:venue:<id>` before it asked whether the
 * caller pays for that venue, and `sendOffer` burned the owner's
 * `offer-send:<org>:<venue>` before it asked whether the caller may send. The
 * ids are public (claim pages, search), so any approved venue owner, or any
 * staff member, could keep the real owner at "Too many tries" for as long as
 * they liked. Real actions, real rows; the victim's next call is the evidence.
 */
process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "itest-nextauth-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await mockGetAuth(); return s?.user ? { ...s, user: { signedInAt: 0, ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { peek, resetMemoryStore } from "@/lib/rate-limit-store"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const billing = require("@/lib/billing-actions") as typeof import("@/lib/billing-actions")
const offers = require("@/lib/offer-actions") as typeof import("@/lib/offer-actions")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const orgs: string[] = []
const venues: string[] = []
const as = (id: string) => mockGetAuth.mockResolvedValue({ user: { id, role: "venue_owner" } })
const message = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message)

async function venueOwner(label: string) {
  const id = await makeUser(testId(label))
  await db.user.update({ where: { id }, data: { role: "venue_owner" } })
  users.push(id)
  return id
}
async function venueOf(owner: string, extraStaff?: string) {
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("lim-org"), status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: owner, role: "owner" } })
  if (extraStaff) await db.organisation_members.create({ data: { org_id: org.id, user_id: extraStaff, role: "staff" } })
  const v = await db.venues.create({
    data: { name: testId("Limit Venue"), city: "Bengaluru", latitude: 12.97, longitude: 77.64, timezone: "UTC", owner_org_id: org.id, claimed_at: new Date(Date.now() - 86_400_000) },
  })
  venues.push(v.id)
  return { venueId: v.id, orgId: org.id }
}

beforeEach(() => {
  resetMemoryStore()
  process.env.RAZORPAY_KEY_ID = "rzp_test_itestkey"
  process.env.RAZORPAY_KEY_SECRET = "itest_key_secret_value_24"
  process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_itest_limiters_0123456789abcd"
})
afterEach(() => {
  delete process.env.RAZORPAY_KEY_ID
  delete process.env.RAZORPAY_KEY_SECRET
  delete process.env.RAZORPAY_WEBHOOK_SECRET
})
afterAll(async () => {
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await cleanup(users, [])
  await closeDb()
})

it("a stranger cancelling Venue Pro on someone else's venue does not spend that venue's bucket", async () => {
  const attacker = await venueOwner("lim-attacker")
  await venueOf(attacker)
  const victim = await venueOwner("lim-victim")
  const { venueId } = await venueOf(victim)

  as(attacker)
  for (let i = 0; i < 8; i++) await message(billing.cancelVenuePro(venueId))

  as(victim)
  // Nothing to cancel is the true answer; "Too many tries" would be the attacker's doing.
  expect(await message(billing.cancelVenuePro(venueId))).toMatch(/no subscription to cancel/)
})

it("staff sending an offer are told they may not, and the owner's send bucket stays empty", async () => {
  const owner = await venueOwner("lim-owner")
  const staff = await venueOwner("lim-staff")
  const { venueId, orgId } = await venueOf(owner, staff)

  as(staff)
  for (let i = 0; i < 8; i++) {
    expect(await message(offers.sendOffer({ venueId, text: "Free drink", days: 7 }))).toMatch(/owner or admin/)
  }
  expect(await peek(`offer-send:${orgId}:${venueId}`)).toBe(0)
})
