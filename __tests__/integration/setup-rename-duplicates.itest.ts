let session: { user: { id: string; role: "app_admin" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { updateAmenity } from "@/lib/amenity-actions"
import { createCategory, renameCategory } from "@/lib/category-actions"

import { db, closeDb, makeUser, testId } from "./helpers"

/**
 * Create refused a name already in the list; rename did not (SCRUM-468).
 *
 * On staging, renaming a category to "Arts & Culture" and an amenity to "Open
 * Bar" were both accepted, and the app's filter and amenity picker then showed
 * two identical choices that filter differently. The slug check on create
 * missed it too: a child created in the dashboard slugs its own name, while the
 * seeded siblings carry their parent's prefix. Categories are compared among
 * siblings (two parents may each have a "Workshops"); amenities are one flat
 * list.
 */

const users: string[] = []
const categories: string[] = []
const amenities: string[] = []
const tag = testId("dup").slice(-8)

beforeAll(async () => {
  const admin = await makeUser(testId("dup_admin"), "app_admin")
  users.push(admin)
  session = { user: { id: admin, role: "app_admin" } }
})

afterAll(async () => {
  await db.categories.deleteMany({ where: { id: { in: categories }, parent_id: { not: null } } })
  await db.categories.deleteMany({ where: { id: { in: categories } } })
  await db.amenities.deleteMany({ where: { id: { in: amenities } } })
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function category(name: string, parentId: string | null = null) {
  const row = await db.categories.create({ data: { name, slug: `${tag}-${categories.length}`, parent_id: parentId } })
  categories.push(row.id)
  return row.id
}

async function amenity(name: string, isActive = true) {
  const row = await db.amenities.create({ data: { name, slug: `${tag}-a${amenities.length}`, is_active: isActive } })
  amenities.push(row.id)
  return row.id
}

const nameOf = async (id: string) => (await db.categories.findUniqueOrThrow({ where: { id } })).name

describe("renameCategory", () => {
  it("refuses a name a sibling already has, in any case, and leaves the row alone", async () => {
    await category(`Culture ${tag}`)
    const other = await category(`Other ${tag}`)

    await expect(renameCategory(other, `culture ${tag}`)).rejects.toThrow(/already exists/)
    expect(await nameOf(other)).toBe(`Other ${tag}`)
  })

  it("refuses a sibling's name under a parent too", async () => {
    const sports = await category(`Sports ${tag}`)
    await category(`Cricket ${tag}`, sports)
    const other = await category(`Hockey ${tag}`, sports)

    await expect(renameCategory(other, `CRICKET ${tag}`)).rejects.toThrow(/already exists/)
    expect(await nameOf(other)).toBe(`Hockey ${tag}`)
  })

  it("allows the name of a category under another parent", async () => {
    const food = await category(`Food ${tag}`)
    const arts = await category(`Arts ${tag}`)
    await category(`Workshops ${tag}`, food)
    const artsChild = await category(`Classes ${tag}`, arts)

    await renameCategory(artsChild, `Workshops ${tag}`)
    expect(await nameOf(artsChild)).toBe(`Workshops ${tag}`)
  })

  it("allows a category to change the case of its own name", async () => {
    const own = await category(`lowercase ${tag}`)

    await renameCategory(own, `Lowercase ${tag}`)
    expect(await nameOf(own)).toBe(`Lowercase ${tag}`)
  })
})

describe("createCategory", () => {
  it("refuses a sibling's name even when the slugs would differ", async () => {
    // The seeded sibling's slug carries its parent's prefix; the new one would not.
    const sports = await category(`Sports two ${tag}`)
    await category(`Screening ${tag}`, sports)

    await expect(createCategory(`screening ${tag}`, sports)).rejects.toThrow(/already exists/)
    expect(await db.categories.count({ where: { parent_id: sports } })).toBe(1)
  })

  it("refuses a name with no letter or digit, which would slug to nothing", async () => {
    const before = await db.categories.count({ where: { slug: "" } })

    await expect(createCategory("!!", null)).rejects.toThrow(/letter or number/)
    expect(await db.categories.count({ where: { slug: "" } })).toBe(before)
  })
})

describe("updateAmenity", () => {
  it("refuses another amenity's name, in any case, and leaves the row alone", async () => {
    await amenity(`Open Bar ${tag}`)
    const mine = await amenity(`Mine ${tag}`)

    await expect(updateAmenity(mine, { name: `open bar ${tag}` })).rejects.toThrow(/already exists/)
    expect((await db.amenities.findUniqueOrThrow({ where: { id: mine } })).name).toBe(`Mine ${tag}`)
  })

  it("says to restore a retired twin rather than rename it", async () => {
    await amenity(`Cloakroom ${tag}`, false)
    const mine = await amenity(`Coats ${tag}`)

    await expect(updateAmenity(mine, { name: `Cloakroom ${tag}` })).rejects.toThrow(/retired — restore it/)
  })

  it("still saves a row whose unchanged name already has a twin", async () => {
    // Duplicates made before this check must not lock the row against edits.
    await amenity(`Rooftop ${tag}`)
    const older = await amenity(`Rooftop ${tag}`)

    await updateAmenity(older, { name: `Rooftop ${tag}`, subtitle: "Open air" })
    expect((await db.amenities.findUniqueOrThrow({ where: { id: older } })).subtitle).toBe("Open air")
  })

  it("treats an underscore as a character, not a wildcard", async () => {
    await amenity(`Open Deck ${tag}`)
    const mine = await amenity(`Deck ${tag}`)

    await updateAmenity(mine, { name: `Open_Deck ${tag}` })
    expect((await db.amenities.findUniqueOrThrow({ where: { id: mine } })).name).toBe(`Open_Deck ${tag}`)
  })

  it("still refuses a true twin whose name has an underscore", async () => {
    await amenity(`Snack_Bar ${tag}`)
    const mine = await amenity(`Snacks ${tag}`)

    await expect(updateAmenity(mine, { name: `snack_bar ${tag}` })).rejects.toThrow(/already exists/)
  })

  it("allows an amenity to change the case of its own name", async () => {
    const mine = await amenity(`quiet corner ${tag}`)

    await updateAmenity(mine, { name: `Quiet Corner ${tag}` })
    expect((await db.amenities.findUniqueOrThrow({ where: { id: mine } })).name).toBe(`Quiet Corner ${tag}`)
  })
})
