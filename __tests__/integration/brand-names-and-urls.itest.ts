import type { DashboardRole } from "@/lib/dashboard-types"

/*
 * SCRUM-956, found by driving /dashboard/brand on staging: a sponsor renamed
 * its brand to another organisation's brand name (the clash check looked only
 * at its own organisation) and saved `javascript:` as its logo.
 *
 * Owner ruling (2026-10-30): a brand name is unique across organisations,
 * compared without regard to case, because taking someone else's name is
 * impersonation; so is an organisation's. Real actions, real rows.
 */
let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await session; return s?.user ? { ...s, user: { signedInAt: 0, ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/email", () => {
  const actual = jest.requireActual("@/lib/email")
  return { ...actual, emailConfigured: () => true, sendEmail: jest.fn(async () => ({ sent: true, id: "fake" })) }
})

import { approveOnboardingRequest } from "@/lib/onboarding-actions"
import { normaliseSponsorName } from "@/lib/sponsor-name"
import { saveMyBrand } from "@/lib/sponsor-actions"
import { closeDb, db, makeUser, testId } from "./helpers"

const users: string[] = []
const orgs: string[] = []
const brands: string[] = []
const requests: string[] = []

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { OR: [{ resource_id: { in: [...brands, ...requests] } }, { user_id: { in: users } }] } })
  await db.sponsors.deleteMany({ where: { id: { in: brands } } })
  await db.organiser_onboarding_requests.deleteMany({ where: { id: { in: requests } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function sponsorOrg(label: string) {
  const user = await makeUser(label)
  await db.user.update({ where: { id: user }, data: { role: "sponsor" } })
  const org = await db.organisations.create({ data: { display_name: testId(`${label}-org`), status: "verified", kind: "company" } })
  await db.organisation_members.create({ data: { org_id: org.id, user_id: user, role: "owner" } })
  users.push(user)
  orgs.push(org.id)
  return { user, org: org.id }
}
const as = (user: string) => { session = { user: { id: user, role: "sponsor" } } }

async function brandOf(org: string | null, name: string, over: { deleted?: boolean; mergedInto?: string } = {}) {
  const b = await db.sponsors.create({
    data: {
      name, name_key: normaliseSponsorName(name), org_id: org, claimed_at: org ? new Date() : null,
      ...(over.deleted ? { deleted_at: new Date() } : {}),
      ...(over.mergedInto ? { merged_into: over.mergedInto } : {}),
    },
    select: { id: true },
  })
  brands.push(b.id)
  return b.id
}
const unique = () => `Zq${Math.random().toString(36).slice(2, 8)}`
const rowsNamed = (key: string) => db.sponsors.count({ where: { name_key: key, deleted_at: null, merged_into: null } })

describe("a brand's links", () => {
  it.each([
    ["logo", { logo_url: "javascript:alert(1)" }],
    ["website", { website: "javascript:alert(1)" }],
    ["logo (data:)", { logo_url: "data:image/svg+xml,<svg/>" }],
    ["website (http)", { website: "http://example.com" }],
  ])("refuses a bad %s and writes nothing", async (_label, bad) => {
    const { user, org } = await sponsorOrg("bu")
    as(user)
    const name = unique()
    await expect(saveMyBrand({ name, ...bad })).rejects.toThrow(/https/i)
    expect(await db.sponsors.count({ where: { org_id: org } })).toBe(0)
  })

  it("saves https links, and clears them with an empty string", async () => {
    const { user, org } = await sponsorOrg("bu2")
    as(user)
    const name = unique()
    const saved = await saveMyBrand({ name, website: "https://example.com", logo_url: "https://example.com/l.png" })
    brands.push(saved.id)
    expect(await db.sponsors.findUnique({ where: { id: saved.id }, select: { website: true, logo_url: true, org_id: true } }))
      .toEqual({ website: "https://example.com", logo_url: "https://example.com/l.png", org_id: org })
    await saveMyBrand({ name, website: "", logo_url: "" })
    expect(await db.sponsors.findUnique({ where: { id: saved.id }, select: { website: true, logo_url: true } }))
      .toEqual({ website: null, logo_url: null })
  })
})

describe("a brand's name across organisations", () => {
  it("refuses another organisation's claimed brand name, in any case, and writes nothing", async () => {
    const mine = await sponsorOrg("bn-me")
    const theirs = await sponsorOrg("bn-them")
    const taken = unique()
    await brandOf(theirs.org, `${taken} Coffee`)
    as(mine.user)
    for (const variant of [`${taken} Coffee`, `${taken.toUpperCase()} COFFEE`, `${taken.toLowerCase()} coffee`, `${taken}-Coffee`]) {
      await expect(saveMyBrand({ name: variant })).rejects.toThrow(/already/i)
    }
    expect(await db.sponsors.count({ where: { org_id: mine.org } })).toBe(0)
  })

  it("refuses a rename onto another organisation's name and leaves the brand as it was", async () => {
    const mine = await sponsorOrg("bn-ren")
    const theirs = await sponsorOrg("bn-ren2")
    const taken = unique()
    await brandOf(theirs.org, taken)
    as(mine.user)
    const own = unique()
    const saved = await saveMyBrand({ name: own })
    brands.push(saved.id)
    await expect(saveMyBrand({ name: taken.toUpperCase() })).rejects.toThrow(/already/i)
    expect((await db.sponsors.findUniqueOrThrow({ where: { id: saved.id }, select: { name: true } })).name).toBe(own)
  })

  it("refuses an unclaimed brand's name too, and points at the claim", async () => {
    const mine = await sponsorOrg("bn-un")
    const taken = unique()
    await brandOf(null, taken)
    as(mine.user)
    await expect(saveMyBrand({ name: taken.toLowerCase() })).rejects.toThrow(/claim/i)
  })

  it("lets a sponsor save its own brand again, and change its case", async () => {
    const mine = await sponsorOrg("bn-own")
    as(mine.user)
    const name = unique()
    const saved = await saveMyBrand({ name })
    brands.push(saved.id)
    await expect(saveMyBrand({ name, website: "https://example.com" })).resolves.toBeTruthy()
    await expect(saveMyBrand({ name: name.toUpperCase() })).resolves.toBeTruthy()
    expect(await rowsNamed(normaliseSponsorName(name))).toBe(1)
  })

  it("does not count a deleted or merged brand as taking the name", async () => {
    const mine = await sponsorOrg("bn-gone")
    const theirs = await sponsorOrg("bn-gone2")
    const winner = await brandOf(theirs.org, unique())
    const goneName = unique()
    await brandOf(theirs.org, goneName, { deleted: true })
    const mergedName = unique()
    await brandOf(theirs.org, mergedName, { mergedInto: winner })
    as(mine.user)
    const a = await saveMyBrand({ name: goneName })
    brands.push(a.id)
    await db.sponsors.update({ where: { id: a.id }, data: { deleted_at: new Date() } })
    await expect(saveMyBrand({ name: mergedName })).resolves.toBeTruthy()
  })
})

describe("an organisation's name", () => {
  async function application(displayName: string) {
    const r = await db.organiser_onboarding_requests.create({
      data: {
        kind: "company", display_name: displayName, contact_name: "New Host",
        contact_email: `${testId("h")}@example.test`, tier: "needs_proof", status: "pending",
        email_verified_at: new Date(), requested_role: "organizer",
      },
      select: { id: true },
    })
    requests.push(r.id)
    return r.id
  }

  it("is refused at approval when another organisation has it, in any case", async () => {
    const admin = await makeUser("on-admin", "app_admin")
    users.push(admin)
    session = { user: { id: admin, role: "app_admin" } }
    const name = testId("Nightshift Twin")
    const existing = await db.organisations.create({ data: { display_name: name, status: "verified" } })
    orgs.push(existing.id)

    const id = await application(name.toUpperCase())
    await expect(approveOnboardingRequest(id)).rejects.toThrow(/already/i)
    expect((await db.organiser_onboarding_requests.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("pending")
    expect(await db.organisations.count({ where: { display_name: { equals: name, mode: "insensitive" } } })).toBe(1)
  })

  it("is approved when the name is free", async () => {
    const admin = await makeUser("on-admin2", "app_admin")
    users.push(admin)
    session = { user: { id: admin, role: "app_admin" } }
    const result = await approveOnboardingRequest(await application(testId("Fresh Org")))
    orgs.push(result.orgId)
    expect(result.orgId).toBeTruthy()
  })
})
