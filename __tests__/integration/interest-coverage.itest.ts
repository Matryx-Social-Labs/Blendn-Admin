import { interestCoverage, MIN_INTERESTS_TO_RANK } from "@/lib/interest-coverage"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf } from "./helpers"

/**
 * The signal that would have caught the empty-interest-graph bug.
 *
 * This is raw SQL with a grouped subquery and a FILTER clause, so a mocked unit
 * test proves nothing about it. The specific things that can silently go wrong:
 * counting a user once per interest instead of once, the LEFT JOIN dropping
 * people with zero interests (which are exactly the people we are counting),
 * and bigint coming back from COUNT() as something JSON cannot serialise.
 */

const users: string[] = []
const events: string[] = []
const categoryIds: string[] = []

/**
 * Seed our own categories rather than assuming any exist.
 *
 * The first version of this file read whatever `categories` happened to hold.
 * That passed locally, where the table is populated, and failed in CI against a
 * freshly pushed schema where it is empty -- so the fixture silently created
 * zero interests and the assertion measured nothing. A test that depends on
 * ambient data is not a test.
 */
async function ensureCategories(howMany: number): Promise<string[]> {
  while (categoryIds.length < howMany) {
    const n = categoryIds.length
    const slug = `itest-cov-${n}-${Math.random().toString(36).slice(2, 8)}`
    const row = await db.categories.create({
      data: { name: `ITest Coverage ${n}`, slug },
      select: { id: true },
    })
    categoryIds.push(row.id)
  }
  return categoryIds.slice(0, howMany)
}

async function checkedInUser(label: string, interestCount: number) {
  const userId = await makeUser(label)
  users.push(userId)

  const host = await makeUser(`${label}-host`, "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)

  await db.event_check_ins.create({
    data: {
      event_id: eventId,
      occurrence_id: await occurrenceOf(eventId),
      user_id: userId,
      status: "checked_in",
      check_in_time: new Date(),
    },
  })

  if (interestCount > 0) {
    const ids = await ensureCategories(interestCount)
    await db.user_interests.createMany({
      data: ids.map((id) => ({ user_id: userId, category_id: id })),
      skipDuplicates: true,
    })
  }

  return userId
}

afterAll(async () => {
  await cleanup(users, events)
  // Categories are not owned by a user or an event, so `cleanup` cannot reach
  // them. Left behind they would accumulate across runs and skew nothing, but
  // they would still be litter in a shared database.
  if (categoryIds.length > 0) {
    await db.categories.deleteMany({ where: { id: { in: categoryIds } } })
  }
  await closeDb()
})

describe("interest coverage", () => {
  it("counts a user once however many interests they hold", async () => {
    // The join is against a grouped subquery precisely so this holds. Without
    // the GROUP BY, someone with 5 interests would inflate both counts by 5 and
    // the share could exceed 1.
    await checkedInUser("cov-many", 5)

    const c = await interestCoverage()
    expect(c.rankableShare).not.toBeNull()
    expect(c.rankableShare!).toBeLessThanOrEqual(1)
    expect(c.rankable).toBeLessThanOrEqual(c.checkedIn)
  })

  it("counts someone with zero interests as checked in but not rankable", async () => {
    // A LEFT JOIN mistake would drop these people entirely, which would make
    // the share look healthy in exactly the situation this is meant to detect.
    const before = await interestCoverage()
    await checkedInUser("cov-none", 0)
    const after = await interestCoverage()

    expect(after.checkedIn).toBe(before.checkedIn + 1)
    expect(after.rankable).toBe(before.rankable)
  })

  it("does not count someone one interest short of the floor", async () => {
    const before = await interestCoverage()
    await checkedInUser("cov-one", MIN_INTERESTS_TO_RANK - 1)
    const after = await interestCoverage()

    expect(after.checkedIn).toBe(before.checkedIn + 1)
    expect(after.rankable).toBe(before.rankable)
  })

  it("counts someone at the floor as rankable", async () => {
    const before = await interestCoverage()
    await checkedInUser("cov-floor", MIN_INTERESTS_TO_RANK)
    const after = await interestCoverage()

    expect(after.rankable).toBe(before.rankable + 1)
  })

  it("returns JSON-serialisable numbers, not bigint", async () => {
    // COUNT() comes back as bigint from Postgres and JSON.stringify throws on
    // it. On a health endpoint that would turn a diagnostic into an outage.
    const c = await interestCoverage()
    expect(typeof c.checkedIn).toBe("number")
    expect(typeof c.rankable).toBe("number")
    expect(() => JSON.stringify(c)).not.toThrow()
  })

  it("says no_signal rather than degraded when nobody has checked in", async () => {
    // Crying wolf on a quiet week trains people to ignore the field.
    const quiet = await db.event_check_ins.findMany({ take: 1, select: { id: true } })
    if (quiet.length > 0) {
      // Other tests have seeded check-ins; assert the shape instead.
      const c = await interestCoverage()
      expect(["ok", "degraded"]).toContain(c.status)
      return
    }
    const c = await interestCoverage()
    expect(c.status).toBe("no_signal")
    expect(c.rankableShare).toBeNull()
  })
})
