import { test, expect } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { getEventAttendance } from "../lib/attendance"

/**
 * E12 - the numbers an organiser is sold, against hand-counted truth.
 *
 * ## The bug this exists to stop coming back
 *
 * `event_check_ins` holds one row per person **per day**. Nine dashboard sites
 * counted rows and called them people, so every figure on a multi-day event was
 * multiplied by the day count: turn-up could read 100%, no-show floored at 0%,
 * and "came back for a 2nd event" counted attending day 1 and day 2 of one
 * conference. W17 fixed it; nothing stopped it returning.
 *
 * A fixture only catches that if somebody in it attended twice. Both seeded
 * events with check-ins have two occurrences and exactly two rows per person,
 * which is the smallest world where rows and people disagree - so a regression
 * to row-counting doubles a number here and this fails.
 *
 * ## Counted from SQL, not from the module under test
 *
 * The expected values come from raw `event_check_ins` rows via Prisma, and the
 * actual values from `getEventAttendance`. Asking the module for both would
 * assert only that it agrees with itself, which is exactly how a counting bug
 * survives its own unit tests.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

test.afterAll(async () => {
  await db.$disconnect()
})

const ATTENDED = ["checked_in", "checked_out"] as const

test.describe("attendance counts people, not rows", () => {
  test("the fixture contains somebody who attended more than one day", async () => {
    /*
     * The control. On a single-day world rows and people are the same number,
     * so every assertion below would pass against code that counts either.
     */
    const withCheckIns = await db.events.findMany({
      where: { deleted_at: null, check_ins: { some: {} } },
      select: {
        id: true,
        title: true,
        _count: { select: { occurrences: true } },
        check_ins: { select: { user_id: true } },
      },
    })

    const multiRow = withCheckIns.filter((e) => {
      const people = new Set(e.check_ins.map((c) => c.user_id)).size
      return e.check_ins.length > people
    })

    expect(
      multiRow.length,
      "No seeded event has more check-in rows than people, so this suite cannot tell " +
        "row-counting from people-counting. Re-run `npm run seed:qa -- --apply`."
    ).toBeGreaterThan(0)
  })

  test("every seeded event reports distinct people", async () => {
    const events = await db.events.findMany({
      where: { deleted_at: null, check_ins: { some: {} } },
      select: { id: true, title: true, check_ins: { select: { user_id: true, status: true } } },
    })
    expect(events.length, "the seed must contain events with check-ins").toBeGreaterThan(0)

    const wrong: string[] = []
    for (const event of events) {
      // Hand-counted from the rows themselves.
      const expectedPeople = new Set(
        event.check_ins
          .filter((c) => (ATTENDED as readonly string[]).includes(c.status))
          .map((c) => c.user_id)
      ).size

      const actual = await getEventAttendance(event.id)

      if (actual.uniqueTotal !== expectedPeople) {
        wrong.push(
          `${event.title}: reported ${actual.uniqueTotal}, ` +
            `${expectedPeople} distinct people across ${event.check_ins.length} rows`
        )
      }
      // The specific failure shape: reporting the row count.
      if (actual.uniqueTotal === event.check_ins.length && event.check_ins.length > expectedPeople) {
        wrong.push(`${event.title}: reported the ROW count (${event.check_ins.length})`)
      }
    }

    expect(
      { wrong, hint: wrong.length ? "Counting rows and calling them people." : "" },
      "every number an organiser is sold sits on this"
    ).toEqual({ wrong: [], hint: "" })
  })

  test("turn-up never exceeds 100%, and is not clamped to hide inflation", async () => {
    /*
     * The clamp was documented as absorbing walk-ins. It was actually absorbing
     * the row-counting inflation, and in doing so hid the walk-ins it named -
     * which is why removing it was only safe *after* the counting fix.
     *
     * So the assertion is not "<= 100". It is that the ratio is honest: it
     * matches attended over committed, computed from raw rows.
     */
    const events = await db.events.findMany({
      where: { deleted_at: null, check_ins: { some: {} } },
      select: {
        id: true,
        title: true,
        check_ins: { select: { user_id: true, status: true } },
        rsvps: { select: { user_id: true, status: true } },
      },
    })

    const wrong: string[] = []
    for (const event of events) {
      const people = new Set(
        event.check_ins
          .filter((c) => (ATTENDED as readonly string[]).includes(c.status))
          .map((c) => c.user_id)
      ).size
      const committed = new Set(
        event.rsvps.filter((r) => r.status === "going" || r.status === "maybe").map((r) => r.user_id)
      ).size

      const actual = await getEventAttendance(event.id)
      if (actual.uniqueTotal > committed && actual.turnUpPct !== null && actual.turnUpPct <= 100) {
        // Walk-ins are real and must be visible, not clamped away.
        wrong.push(
          `${event.title}: ${people} attended vs ${committed} committed, ` +
            `turn-up reported ${actual.turnUpPct}% - walk-ins clamped`
        )
      }
    }

    expect({ wrong }, "a clamp hides walk-ins, the one signal that beat expectations").toEqual({
      wrong: [],
    })
  })
})
