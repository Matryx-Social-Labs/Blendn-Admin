import { getRoleUsers } from "@/lib/admin-role-actions"
import { getAuth } from "@/lib/auth"

import { closeDb, db, makeUser, testId } from "./helpers"

jest.mock("@/lib/auth", () => ({ getAuth: jest.fn() }))
const mockAuth = getAuth as jest.MockedFunction<typeof getAuth>

/**
 * What a host has actually supplied, against what they merely started.
 *
 * `/dashboard/organisers` counted `_count.organized_events` — every row,
 * whatever its status — and rendered it as `Events` per row and `Total Events`
 * at the top. So ten drafts and nothing live outranked three published events,
 * on a screen whose own description is *"who publishes, and how concentrated it
 * is"*.
 *
 * The split is only observable against real rows: `groupBy` on
 * `(organizer_id, status)` is the whole mechanism, and a unit test with a mocked
 * client would be asserting the mock. Same argument as `attendee-counts`.
 */
const users: string[] = []
const events: string[] = []

beforeAll(() => {
  mockAuth.mockResolvedValue({
    user: { id: "admin", role: "app_admin", email: "a@b.c" },
  } as unknown as Awaited<ReturnType<typeof getAuth>>)
})

afterAll(async () => {
  if (events.length) await db.events.deleteMany({ where: { id: { in: events } } })
  if (users.length) {
    await db.profiles.deleteMany({ where: { id: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

async function makeEventFor(organizerId: string, status: "published" | "draft", startsAt: Date) {
  const row = await db.events.create({
    data: {
      slug: testId("rus-evt"),
      title: `Test ${testId("rus")}`,
      description: "supply fixture",
      start_time: startsAt,
      end_time: new Date(startsAt.getTime() + 3_600_000),
      timezone: "UTC",
      status,
      organizer_id: organizerId,
      visibility: "public",
    },
  })
  events.push(row.id)
  return row
}

describe("getRoleUsers supply split", () => {
  it("counts published as supply and drafts separately, and never mixes them", async () => {
    const prolific = await makeUser(testId("rus-prolific"), "organizer")
    const drafter = await makeUser(testId("rus-drafter"), "organizer")
    users.push(prolific, drafter)

    const early = new Date("2026-02-01T18:00:00Z")
    const late = new Date("2026-08-01T18:00:00Z")

    await makeEventFor(prolific, "published", early)
    await makeEventFor(prolific, "published", late)
    await makeEventFor(prolific, "draft", late)

    /*
     * Three drafts and nothing live. Under the old count this row read as the
     * platform's busiest supplier; it is in fact the row that wants a nudge.
     */
    await makeEventFor(drafter, "draft", late)
    await makeEventFor(drafter, "draft", late)
    await makeEventFor(drafter, "draft", late)

    const rows = await getRoleUsers("organizer")
    const a = rows.find((r) => r.id === prolific)!
    const b = rows.find((r) => r.id === drafter)!

    expect(a.published).toBe(2)
    expect(a.drafts).toBe(1)
    expect(b.published).toBe(0)
    expect(b.drafts).toBe(3)

    // The old number, kept only for the detail page, still counts everything —
    // which is exactly why it is the wrong one for this list.
    expect(a._count.organized_events).toBe(3)
    expect(b._count.organized_events).toBe(3)
    // Same total, opposite meaning. This pair is the whole point of the change.
    expect(a._count.organized_events).toBe(b._count.organized_events)
    expect(a.published).toBeGreaterThan(b.published)
  })

  it("dates the last PUBLISHED event, not the last draft", async () => {
    const host = await makeUser(testId("rus-dated"), "organizer")
    users.push(host)

    const published = new Date("2026-03-01T18:00:00Z")
    await makeEventFor(host, "published", published)
    // Later, but a draft — a thing nobody shipped is not a sign of life.
    await makeEventFor(host, "draft", new Date("2026-11-01T18:00:00Z"))

    const row = (await getRoleUsers("organizer")).find((r) => r.id === host)!
    expect(row.lastEventAt).toBe(published.toISOString())
  })

  it("gives a host with nothing published a null date and a zero share", async () => {
    const host = await makeUser(testId("rus-empty"), "organizer")
    users.push(host)
    await makeEventFor(host, "draft", new Date("2026-05-01T18:00:00Z"))

    const row = (await getRoleUsers("organizer")).find((r) => r.id === host)!
    expect(row.lastEventAt).toBeNull()
    // Zero, not NaN. An empty platform is not a concentrated one, and the
    // divisor here is the platform's published total.
    expect(row.sharePct).toBe(0)
    expect(Number.isNaN(row.sharePct)).toBe(false)
  })

  it("shares sum to about 100 across everyone who has published", async () => {
    const rows = await getRoleUsers("organizer")
    const publishers = rows.filter((r) => r.published > 0)
    if (publishers.length === 0) return

    const total = publishers.reduce((n, r) => n + r.sharePct, 0)
    // Rounding, so a window rather than an equality — but a share computed
    // against the wrong denominator lands nowhere near it.
    expect(total).toBeGreaterThanOrEqual(95)
    expect(total).toBeLessThanOrEqual(105)
  })
})
