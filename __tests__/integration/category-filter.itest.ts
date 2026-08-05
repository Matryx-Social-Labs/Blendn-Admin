import { db, closeDb, testId } from "./helpers"

/**
 * Filtering by a parent category must sweep in its children.
 *
 * Events get tagged to leaves — "IPL screening", not "Sports" — so an exact id
 * match means picking a parent returns **nothing**. That failure is invisible
 * in code review and looks like "the app has no sports events" to a user, so it
 * gets a test against real rows rather than a careful read of the query.
 *
 * Reproduces the route's where-clause exactly rather than importing it: the
 * filter is built inline in `app/api/mobile/events/route.ts` alongside a dozen
 * other conditions, and the route needs an authenticated request to call.
 */

const created: { categories: string[]; events: string[]; users: string[] } = {
  categories: [],
  events: [],
  users: [],
}

/** Mirrors the parent-inclusive filter in the events route. */
const categoryWhere = (slug: string) => ({
  categories: {
    some: {
      category: { OR: [{ slug }, { parent: { slug } }] },
    },
  },
})

afterAll(async () => {
  if (created.events.length)
    await db.events.deleteMany({ where: { id: { in: created.events } } })
  if (created.categories.length)
    await db.categories.deleteMany({ where: { id: { in: created.categories } } })
  if (created.users.length)
    await db.user.deleteMany({ where: { id: { in: created.users } } })
  await closeDb()
})

describe("parent-inclusive category filtering", () => {
  let parentSlug: string
  let childSlug: string
  let taggedToChild: string
  let taggedToParent: string
  let untagged: string

  beforeAll(async () => {
    const suffix = testId("cat")
    parentSlug = `${suffix}-sports`
    childSlug = `${suffix}-ipl`

    const parent = await db.categories.create({
      data: { name: "Sports (test)", slug: parentSlug },
    })
    const child = await db.categories.create({
      data: { name: "IPL screening (test)", slug: childSlug, parent_id: parent.id },
    })
    created.categories.push(child.id, parent.id)

    const ownerId = testId("catowner")
    await db.user.create({
      data: { id: ownerId, email: `${ownerId}@itest.invalid`, role: "organizer" },
    })
    created.users.push(ownerId)

    const makeEvent = async (label: string) => {
      const slug = testId(label)
      const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
      const e = await db.events.create({
        data: {
          slug,
          title: `Cat ${slug}`,
          description: "fixture",
          start_time: start,
          end_time: new Date(start.getTime() + 2 * 60 * 60 * 1000),
          timezone: "UTC",
          status: "published",
          organizer_id: ownerId,
        },
      })
      created.events.push(e.id)
      return e.id
    }

    taggedToChild = await makeEvent("child")
    taggedToParent = await makeEvent("parent")
    untagged = await makeEvent("untagged")

    await db.event_categories.createMany({
      data: [
        { event_id: taggedToChild, category_id: child.id },
        { event_id: taggedToParent, category_id: parent.id },
      ],
    })
  })

  it("returns events tagged only to a child when filtering by the parent", async () => {
    // THE regression. Before the fix this returned nothing, so "Sports" looked
    // like an empty category while being the busiest one.
    const ids = (
      await db.events.findMany({ where: categoryWhere(parentSlug), select: { id: true } })
    ).map((e) => e.id)

    expect(ids).toContain(taggedToChild)
    expect(ids).toContain(taggedToParent)
    expect(ids).not.toContain(untagged)
  })

  it("returns only the child's events when filtering by the child", async () => {
    // Narrowing must still narrow — a parent-inclusive filter that also
    // widened children would make the leaves useless.
    const ids = (
      await db.events.findMany({ where: categoryWhere(childSlug), select: { id: true } })
    ).map((e) => e.id)

    expect(ids).toContain(taggedToChild)
    expect(ids).not.toContain(taggedToParent)
    expect(ids).not.toContain(untagged)
  })

  it("matches nothing for a category that does not exist", async () => {
    const ids = (
      await db.events.findMany({
        where: categoryWhere("no-such-category-anywhere"),
        select: { id: true },
      })
    ).map((e) => e.id)

    expect(ids).toEqual([])
  })
})
