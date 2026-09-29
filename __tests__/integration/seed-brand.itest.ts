import { readFileSync } from "fs"
import { join } from "path"

import { normaliseSponsorName } from "@/lib/sponsor-name"
import { ensureOrgBrand, findBrandByName } from "@/scripts/seed-brand"

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
