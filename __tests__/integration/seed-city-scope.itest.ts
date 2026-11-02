/*
 * The per-city scenario seed (`--city`) removes rows by two `where`s: `--clean`
 * (`seededEventsWhere`) and the remove step of `--apply` (`cityMatchFor`).
 * Against real rows, each touches only what it says: a real organizer's event
 * whose slug happens to start "toronto-" survives a Toronto clean, and a Thane
 * event with no city but "Mumbai" in its address survives Mumbai's remove step.
 */
import { cityMatchFor, seededEventsWhere, type SeedCity } from "../../scripts/seed-city"
import { db, closeDb, makeUser, testId } from "./helpers"

const toronto = { slug: "toronto", name: "Toronto", matchKeys: ["toronto", "north york"] } as unknown as SeedCity
const mumbai = { slug: "mumbai", name: "Mumbai", matchKeys: ["mumbai", "bombay"] } as unknown as SeedCity

const users: string[] = []
const ids: string[] = []
let seedOrg: string
let admin: string
let stranger: string

async function event(slug: string, data: { organizer_id: string; organizer_org_id?: string | null; city?: string | null; address?: string }) {
  const now = Date.now()
  const row = await db.events.create({
    data: { slug, title: slug, description: "itest", start_time: new Date(now + 3_600_000), end_time: new Date(now + 7_200_000), timezone: "UTC", status: "published", ...data },
    select: { id: true },
  })
  ids.push(row.id)
  return row.id
}

beforeAll(async () => {
  admin = await makeUser("scope_admin", "app_admin")
  stranger = await makeUser("scope_org", "organizer")
  users.push(admin, stranger)
  seedOrg = (await db.organisations.create({ data: { display_name: testId("Seed Events Org") }, select: { id: true } })).id
})

afterAll(async () => {
  await db.events.deleteMany({ where: { id: { in: ids } } })
  await db.organisations.deleteMany({ where: { id: seedOrg } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

it("--clean matches the seed's own slugs and owners only: a real 'Toronto Jazz Night' survives", async () => {
  const suffix = testId("x").replace(/_/g, "-").toLowerCase()
  const seededSlug = `toronto-board-game-night-${suffix}`
  const realSlug = `toronto-jazz-night-${suffix}`
  const ours = await event(seededSlug, { organizer_id: admin, organizer_org_id: seedOrg, city: "Toronto" })
  const real = await event(realSlug, { organizer_id: stranger, organizer_org_id: null, city: "Toronto" })
  // A seeded slug in somebody else's hands is not the seed's either.
  const taken = await event(`toronto-design-festival-${suffix}`, { organizer_id: stranger, organizer_org_id: null, city: "Toronto" })

  const where = seededEventsWhere(toronto, [seededSlug, `toronto-design-festival-${suffix}`], { orgId: seedOrg, adminId: admin })
  const matched = (await db.events.findMany({ where: { ...where, id: { in: ids } }, select: { id: true } })).map((r) => r.id)
  expect(matched).toEqual([ours])
  expect(matched).not.toContain(real)
  expect(matched).not.toContain(taken)
})

it("the remove step matches a city by its names, never by an address that merely mentions it", async () => {
  const suffix = testId("y").replace(/_/g, "-").toLowerCase()
  const mumbaiEvent = await event(`m-${suffix}`, { organizer_id: stranger, city: "Mumbai" })
  const thane = await event(`t-${suffix}`, { organizer_id: stranger, city: null, address: "Hiranandani Estate, Thane West, near Mumbai" })

  const matched = (await db.events.findMany({ where: { ...cityMatchFor(mumbai), id: { in: ids } }, select: { id: true } })).map((r) => r.id)
  expect(matched).toContain(mumbaiEvent)
  expect(matched).not.toContain(thane)
})
