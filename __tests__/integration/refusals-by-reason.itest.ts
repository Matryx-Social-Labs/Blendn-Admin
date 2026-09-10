import { refusalsByReason } from "@/lib/check-in-refusals"

import { closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/**
 * People turned away, not attempts.
 *
 * The overview's turn-up panel renders "N turned away" beside the arrivals
 * figure, and the whole point of that pairing is that one number is comparable
 * to the other. Attempts are not: somebody standing on the pavement trying four
 * times is ONE person with a problem, and counting the taps would draw them as
 * a crowd — which on this product means "the fence looks wrong here" when it
 * looks wrong to exactly one person.
 *
 * `dashboard-report.itest.ts` asserted `total <= sum(byReason)` against a
 * fixture that seeds no refusals at all, so it ran as `0 <= 0` and would have
 * passed against a `rows.length`. This is the row shape that tells the two
 * apart, and it is the only one that does: a person refused twice for the SAME
 * reason, and a person refused for TWO different reasons.
 */
const users: string[] = []
const events: string[] = []

afterAll(async () => {
  if (events.length) {
    await db.check_in_refusals.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) {
    await db.profiles.deleteMany({ where: { id: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

describe("refusalsByReason", () => {
  it("counts distinct people per reason, and distinct people overall", async () => {
    const organiser = await makeUser(testId("rbr-org"), "organizer")
    const alice = await makeUser(testId("rbr-alice"))
    const bob = await makeUser(testId("rbr-bob"))
    users.push(organiser, alice, bob)

    const eventId = await makeEvent(organiser)
    events.push(eventId)

    const at = new Date()
    const window = { from: new Date(at.getTime() - 60 * 60_000), to: new Date(at.getTime() + 60_000) }

    await db.check_in_refusals.createMany({
      data: [
        // Alice tried twice from the pavement, then once after the doors shut.
        { event_id: eventId, user_id: alice, reason: "out_of_range", created_at: at },
        { event_id: eventId, user_id: alice, reason: "out_of_range", created_at: at },
        { event_id: eventId, user_id: alice, reason: "too_late", created_at: at },
        // Bob tried once.
        { event_id: eventId, user_id: bob, reason: "out_of_range", created_at: at },
      ],
    })

    const result = await refusalsByReason(window)
    const outOfRange = result.byReason.find((r) => r.reason === "out_of_range")
    const tooLate = result.byReason.find((r) => r.reason === "too_late")

    // Three rows for out_of_range, two people.
    expect(outOfRange?.people).toBe(2)
    expect(tooLate?.people).toBe(1)

    /*
     * Two people, not four rows and not three. `total` is distinct across ALL
     * reasons, so it is deliberately LOWER than the sum of the rows beneath it
     * whenever one person hit two reasons — Alice, here. That mismatch is the
     * honest answer and the docstring says so; the alternative is a headline
     * that double-counts one person having a bad night.
     */
    expect(result.total).toBe(2)
    expect(result.byReason.reduce((n, r) => n + r.people, 0)).toBe(3)
    expect(result.total).toBeLessThan(result.byReason.reduce((n, r) => n + r.people, 0))
  })

  it("ignores refusals outside the window", async () => {
    const organiser = await makeUser(testId("rbr-org2"), "organizer")
    const carol = await makeUser(testId("rbr-carol"))
    users.push(organiser, carol)

    const eventId = await makeEvent(organiser)
    events.push(eventId)

    const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60_000)
    await db.check_in_refusals.create({
      data: { event_id: eventId, user_id: carol, reason: "under_age", created_at: longAgo },
    })

    const result = await refusalsByReason({
      from: new Date(Date.now() - 60 * 60_000),
      to: new Date(Date.now() + 60_000),
    })
    expect(result.byReason.find((r) => r.reason === "under_age" && r.people > 0)).toBeUndefined()
  })
})
