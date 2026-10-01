import { readFileSync } from "fs"
import { join } from "path"

import { normaliseSponsorName } from "@/lib/sponsor-name"
import { ensureOrgBrand, ensurePendingBrandClaim, findBrandByName } from "@/scripts/seed-brand"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

/*
 * The seeds keep an organisation to one brand, keyed the way the product keys
 * it (SCRUM-456).
 *
 * Driven on staging: sponsor@'s organisation owned two "Blue Tokai" rows. The
 * product had re-keyed the first to `bluetokai` (`normaliseSponsorName`, on every
 * brand edit), and `seed-blr-scenarios` looked it up as `"blue tokai"`, missed,
 * and created a second one for the same organisation. The dashboard reads one
 * brand per organisation, so the second one's placements, including a proposal
 * waiting on the sponsor, never showed.
 */
const users: string[] = []
const orgs: string[] = []
const brands: string[] = []

afterAll(async () => {
  await db.sponsor_claims.deleteMany({ where: { sponsor_id: { in: brands } } })
  await db.sponsors.deleteMany({ where: { id: { in: brands } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

async function org() {
  const o = await db.organisations.create({ data: { display_name: testId("brand-org") } })
  orgs.push(o.id)
  return o.id
}

it("reuses the organisation's brand after the product has renamed and re-keyed it, rather than making a second", async () => {
  const admin = await makeUser(testId("brand-admin"))
  users.push(admin)
  const orgId = await org()
  const name = `Blue Tokai ${testId("b")}`
  // What an edit on /dashboard/brand leaves behind: a new name, keyed by the product.
  const renamed = `${name} Coffee Roasters`
  const existing = await db.sponsors.create({
    data: { name: renamed, name_key: normaliseSponsorName(renamed), org_id: orgId, created_by: admin },
  })
  brands.push(existing.id)

  const brand = await ensureOrgBrand(db, { name, orgId, createdBy: admin, claimedAt: new Date() })
  brands.push(brand.id)

  expect(brand.id).toBe(existing.id)
  expect(await db.sponsors.count({ where: { org_id: orgId, deleted_at: null } })).toBe(1)
})

it("creates one keyed as the product keys it when the organisation has none", async () => {
  const admin = await makeUser(testId("brand-admin2"))
  users.push(admin)
  const orgId = await org()
  const name = `Blue Tokai ${testId("c")}`

  const brand = await ensureOrgBrand(db, { name, orgId, createdBy: admin, claimedAt: new Date() })
  brands.push(brand.id)

  expect(brand.name_key).toBe(normaliseSponsorName(name))
  expect(brand.org_id).toBe(orgId)
})

it("refuses to hand an organisation another organisation's brand of the same name", async () => {
  const admin = await makeUser(testId("brand-admin3"))
  users.push(admin)
  const [mine, theirs] = [await org(), await org()]
  const name = `Blue Tokai ${testId("x")}`
  const owned = await db.sponsors.create({ data: { name, name_key: normaliseSponsorName(name), org_id: theirs } })
  brands.push(owned.id)

  // The seeds used to return it, leave this org brandless, and hang its placements on the other org's brand.
  await expect(ensureOrgBrand(db, { name, orgId: mine, createdBy: admin, claimedAt: new Date() })).rejects.toThrow(
    /another organisation/
  )
  expect(await db.sponsors.count({ where: { org_id: mine } })).toBe(0)
})

it("claims an unowned brand of that name for the organisation", async () => {
  const admin = await makeUser(testId("brand-admin4"))
  users.push(admin)
  const orgId = await org()
  const name = `Third Wave ${testId("u")}`
  const unowned = await db.sponsors.create({ data: { name, name_key: name.toLowerCase(), org_id: null } })
  brands.push(unowned.id)

  const brand = await ensureOrgBrand(db, { name, orgId, createdBy: admin, claimedAt: new Date() })

  expect({ id: brand.id, org: brand.org_id, claimed: brand.claimed_at !== null }).toEqual({
    id: unowned.id,
    org: orgId,
    claimed: true,
  })
})

it("skips a deleted brand and, of two live ones, takes the oldest (as the dashboard does)", async () => {
  const admin = await makeUser(testId("brand-admin5"))
  users.push(admin)
  const orgId = await org()
  const name = `Blue Tokai ${testId("o")}`
  const gone = await db.sponsors.create({
    data: { name: `${name} old`, name_key: normaliseSponsorName(`${name} old`), org_id: orgId, deleted_at: new Date(), created_at: new Date(Date.now() - 3 * 86_400_000) },
  })
  const older = await db.sponsors.create({
    data: { name, name_key: name.toLowerCase(), org_id: orgId, created_at: new Date(Date.now() - 2 * 86_400_000) },
  })
  const newer = await db.sponsors.create({ data: { name, name_key: normaliseSponsorName(name), org_id: orgId } })
  brands.push(gone.id, older.id, newer.id)

  const viaOrg = await ensureOrgBrand(db, { name, orgId, createdBy: admin, claimedAt: new Date() })
  const viaName = await findBrandByName(db, name)

  expect({ viaOrg: viaOrg.id, viaName: viaName?.id }).toEqual({ viaOrg: older.id, viaName: older.id })
})

it("finds a brand by name under the product's key and under the seeds' old one", async () => {
  const name = `Third Wave ${testId("d")}`
  const legacy = await db.sponsors.create({ data: { name, name_key: name.toLowerCase(), org_id: null } })
  brands.push(legacy.id)

  expect((await findBrandByName(db, name))?.id).toBe(legacy.id)

  await db.sponsors.update({ where: { id: legacy.id }, data: { name_key: normaliseSponsorName(name) } })
  expect((await findBrandByName(db, name))?.id).toBe(legacy.id)
})

it("leaves no seed writing a sponsor key of its own", () => {
  // The next seed to hand-roll `name_key` (a literal, a template, a variable)
  // reopens the same split, so every key a seed writes goes through the product.
  for (const file of ["scripts/seed-qa.ts", "scripts/seed-blr-scenarios.ts"]) {
    const src = readFileSync(join(__dirname, "../..", file), "utf8")
    const keys = src.match(/name_key:(?!\s*normaliseSponsorName\()[^,}\n]*/g) ?? []
    expect({ file, keys }).toEqual({ file, keys: [] })
  }
})

/*
 * The seeded brand claim is one the product would file (SCRUM-465).
 *
 * Driven on staging: the only brand claim was "Third Wave", filed by sponsor@'s
 * organisation, which owns Blue Tokai. The product refuses to file that (one
 * brand per organisation), the admin could only reject it, and sponsor@'s
 * /dashboard/brand never showed it — so SCRUM-255's approve-a-claim step could
 * not be driven.
 */
describe("the seeded brand claim", () => {
  async function world() {
    const admin = await makeUser(testId("claim-admin"))
    const filer = await makeUser(testId("claim-filer"))
    users.push(admin, filer)
    const owner = await org()
    const brandless = await org()
    const ownedName = `Blue Tokai ${testId("o")}`
    const targetName = `Third Wave ${testId("t")}`
    const owned = await db.sponsors.create({ data: { name: ownedName, name_key: normaliseSponsorName(ownedName), org_id: owner } })
    const target = await db.sponsors.create({
      data: { name: targetName, name_key: normaliseSponsorName(targetName), org_id: null, created_by: admin },
    })
    brands.push(owned.id, target.id)
    return { filer, owner, brandless, target }
  }

  it("is filed by an organisation with no brand, and an earlier seed's unreachable one goes", async () => {
    const { filer, owner, brandless, target } = await world()
    await db.sponsor_claims.create({ data: { sponsor_id: target.id, org_id: owner, filed_by: filer, status: "pending" } })

    const claim = await ensurePendingBrandClaim(db, { brandId: target.id, orgId: brandless, filedBy: filer })

    const pending = await db.sponsor_claims.findMany({ where: { sponsor_id: target.id, status: "pending" } })
    expect(pending.map((c) => c.org_id)).toEqual([brandless])
    expect({ brand: claim.sponsor_id, org: claim.org_id, by: claim.filed_by, status: claim.status }).toEqual({
      brand: target.id,
      org: brandless,
      by: filer,
      status: "pending",
    })
  })

  it("clears only this brand's pending claims: a decided one, and one on another brand, stay", async () => {
    const { filer, owner, brandless, target } = await world()
    const otherName = `Sleepy Owl ${testId("s")}`
    const other = await db.sponsors.create({ data: { name: otherName, name_key: normaliseSponsorName(otherName), org_id: null } })
    brands.push(other.id)
    const elsewhere = await db.sponsor_claims.create({ data: { sponsor_id: other.id, org_id: owner, filed_by: filer, status: "pending" } })
    const decidedOrg = await org()
    const decidedName = `Kapi Kottai ${testId("k")}`
    const decidedBrand = await db.sponsors.create({ data: { name: decidedName, name_key: normaliseSponsorName(decidedName), org_id: decidedOrg } })
    brands.push(decidedBrand.id)
    const rejected = await db.sponsor_claims.create({ data: { sponsor_id: target.id, org_id: decidedOrg, filed_by: filer, status: "rejected" } })

    await ensurePendingBrandClaim(db, { brandId: target.id, orgId: brandless, filedBy: filer })

    const kept = await db.sponsor_claims.findMany({ where: { id: { in: [elsewhere.id, rejected.id] } }, select: { status: true } })
    expect(kept.map((c) => c.status).sort()).toEqual(["pending", "rejected"])
  })

  it("lets an organisation whose only brand was deleted file, as the product does", async () => {
    const { filer, brandless, target } = await world()
    const goneName = `Old Brand ${testId("g")}`
    const gone = await db.sponsors.create({
      data: { name: goneName, name_key: normaliseSponsorName(goneName), org_id: brandless, deleted_at: new Date() },
    })
    brands.push(gone.id)

    const claim = await ensurePendingBrandClaim(db, { brandId: target.id, orgId: brandless, filedBy: filer })

    expect(claim.status).toBe("pending")
  })

  it("returns the same pending claim on the next run, untouched", async () => {
    const { filer, brandless, target } = await world()
    const first = await ensurePendingBrandClaim(db, { brandId: target.id, orgId: brandless, filedBy: filer })

    const again = await ensurePendingBrandClaim(db, { brandId: target.id, orgId: brandless, filedBy: filer })

    expect({ id: again.id, status: again.status, updated: again.updated_at }).toEqual({
      id: first.id,
      status: "pending",
      updated: first.updated_at,
    })
    expect(await db.sponsor_claims.count({ where: { sponsor_id: target.id } })).toBe(1)
  })

  it("is refused from an organisation that already owns a brand, as the product refuses it", async () => {
    const { filer, owner, target } = await world()

    await expect(ensurePendingBrandClaim(db, { brandId: target.id, orgId: owner, filedBy: filer })).rejects.toThrow(
      /already owns a brand/
    )
    expect(await db.sponsor_claims.count({ where: { sponsor_id: target.id } })).toBe(0)
  })

  it("stays decided on the next run, after the admin approved it", async () => {
    const { filer, brandless, target } = await world()
    const first = await ensurePendingBrandClaim(db, { brandId: target.id, orgId: brandless, filedBy: filer })
    // What approving does: the claim is approved and the brand is now the claimant's.
    await db.sponsor_claims.update({ where: { id: first.id }, data: { status: "approved" } })
    await db.sponsors.update({ where: { id: target.id }, data: { org_id: brandless } })

    const again = await ensurePendingBrandClaim(db, { brandId: target.id, orgId: brandless, filedBy: filer })

    expect({ id: again.id, status: again.status }).toEqual({ id: first.id, status: "approved" })
  })
})
