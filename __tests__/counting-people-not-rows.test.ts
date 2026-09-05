import { readFileSync } from "fs"
import { join } from "path"

import {
  distinctAttendees,
  repeatAttendees,
  turnUpPct,
  noShowPct,
  isAttendee,
} from "@/lib/counting"

/*
 * `event_check_ins` is `@@unique([occurrence_id, user_id])` — one row per person
 * per day, deliberately, so "who came on Wednesday" has an answer. The cost is
 * that `count()` returns attendance-days, and eleven call sites used it while
 * saying "people".
 *
 * On a three-day conference every one of them read three times high, and two of
 * them produced numbers that looked *good* rather than obviously broken:
 * turn-up clamped to exactly 100%, and no-show floored at 0%.
 *
 * Pure and unit-tested on purpose (R18). `lib/attendance.ts` has always folded
 * this correctly and its only coverage is an integration suite that needs
 * Postgres and therefore only runs in CI — so the rule everything else depends
 * on was the one rule nobody could check locally.
 */

/** A three-day conference: one person, present every day. */
const threeDayRegular = [
  { user_id: "u1", event_id: "conf", kind: null },
  { user_id: "u1", event_id: "conf", kind: null },
  { user_id: "u1", event_id: "conf", kind: null },
]

describe("distinctAttendees", () => {
  it("counts one person who came three days as one person", () => {
    expect(distinctAttendees(threeDayRegular)).toBe(1)
  })

  it("excludes staff", () => {
    /*
     * They attend every day by definition, so including them turns "returning
     * attendees" into a headcount of the crew.
     */
    expect(
      distinctAttendees([
        { user_id: "u1", kind: "attendee" },
        { user_id: "crew", kind: "staff" },
      ])
    ).toBe(1)
  })

  it("treats a null kind as an attendee", () => {
    // The column was added after rows existed; the backfill left history null.
    expect(isAttendee({ user_id: "u1", kind: null })).toBe(true)
    expect(distinctAttendees([{ user_id: "u1", kind: null }])).toBe(1)
  })

  it("is zero for no rows", () => {
    expect(distinctAttendees([])).toBe(0)
  })
})

describe("repeatAttendees", () => {
  it("does not count two days of one event as a repeat", () => {
    /*
     * This is the defect the tile was titled against. It grouped by user and
     * asked `_count._all > 1`, so one person at one two-day conference counted
     * as somebody who "came back for a 2nd event".
     */
    expect(repeatAttendees(threeDayRegular)).toBe(0)
  })

  it("counts somebody who attended two different events", () => {
    expect(
      repeatAttendees([
        { user_id: "u1", event_id: "a", kind: null },
        { user_id: "u1", event_id: "b", kind: null },
      ])
    ).toBe(1)
  })

  it("excludes staff, who are at everything", () => {
    expect(
      repeatAttendees([
        { user_id: "crew", event_id: "a", kind: "staff" },
        { user_id: "crew", event_id: "b", kind: "staff" },
      ])
    ).toBe(0)
  })
})

describe("turn-up and no-show", () => {
  it("no longer clamps turn-up at 100", () => {
    /*
     * The clamp existed to stop no-show going negative when row-counting
     * inflated attendance. Counting people removes the cause, and clamping now
     * would hide walk-ins — the only signal that an event outperformed its
     * RSVPs.
     */
    expect(turnUpPct(130, 100)).toBe(130)
  })

  it("reports the honest figure for a three-day event", () => {
    /*
     * 1000 people over three days used to produce 3000 attendances against 1000
     * RSVPs, clamp to 100%, and look perfect. If 620 of the 1000 actually came,
     * the truth is 62%.
     */
    expect(turnUpPct(620, 1000)).toBe(62)
  })

  it("floors no-show at zero rather than going negative", () => {
    // More walk-ins than RSVPs is zero no-shows plus some extra people, and
    // those are different facts.
    expect(noShowPct(130, 100)).toBe(0)
  })

  it("returns null when nobody committed, rather than dividing by zero", () => {
    expect(turnUpPct(5, 0)).toBeNull()
    expect(noShowPct(5, 0)).toBeNull()
  })
})

describe("the fixed call sites do not count rows", () => {
  /*
   * Sixty findings in this codebase come from one shape: an invariant that has
   * a correct module and a route that answers the question itself instead. The
   * counting rule had that shape — `lib/attendance.ts` folded it right, and
   * nine other places ran `count()` and called the result people.
   *
   * Comments stripped, because a guard that counts a mention is a guard that
   * reports green while doing nothing.
   */
  const code = (rel: string) =>
    readFileSync(join(__dirname, "..", rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")

  it("the repeat-attendee tile folds on distinct events", () => {
    const src = code("app/dashboard/actions.ts")
    expect(src).toMatch(/repeatAttendees\(/)
    // `_count._all > 1` over check-in rows is the bug, by name.
    expect(src).not.toMatch(/_count\._all\s*>\s*1/)
  })

  it("the event overview folds people before computing turn-up", () => {
    const src = code("lib/event-overview.ts")
    expect(src).toMatch(/distinctAttendees\(/)
    // The clamp is gone with the row-counting that made it necessary.
    expect(src).not.toMatch(/Math\.min\(everCheckedIn/)
  })
})

describe("occupancy asks which day it is", () => {
  /*
   * `capacityForNow` resolved an occurrence for the capacity and the counts did
   * not, so capacity was per-occurrence while occupancy spanned the whole run.
   * On day three of a conference a day-one attendee whose row was still
   * `checked_in` counted as inside, against day three's capacity.
   *
   * Rows go stale exactly that way: the sweeper closes people on a timer and
   * anyone it misses stays `checked_in` forever, so the number an organiser
   * watches live — and the one a fire officer is quoted — drifted upward across
   * a multi-day event and never came back down.
   */
  const code = (rel: string) =>
    readFileSync(join(__dirname, "..", rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")

  it("scopes the inside counts to the resolved occurrence", () => {
    const src = code("lib/occupancy.ts")

    /*
     * Now expressed as an argument rather than a spread. `headcount` cannot be
     * called without a scope, so the unscoped read that caused this — a
     * day-one attendee counted as inside on day three — stopped being
     * something you can produce by forgetting a spread.
     */
    expect(src).toMatch(
      /headcount\(slot\.occurrence \? \{ occurrenceId: slot\.occurrence\.id \} : \{ eventId \}\)/
    )

    /*
     * And "inside" is no longer read from a mutable status at all. That column
     * only ever went up: a row the sweeper missed stayed `checked_in` for ever,
     * which is why the number drifted upward across a run and never came back.
     */
    expect(src).not.toMatch(/status: "checked_in"/)
  })

  it("resolves the occurrence once and shares it with the capacity", () => {
    /*
     * The comment on `capacityForNow` warns that two implementations of "which
     * day is it" would eventually disagree. There were two: one asked, one did
     * not. Now there is one call and both read it.
     */
    const src = code("lib/occupancy.ts")
    expect((src.match(/await resolveOccurrence\(/g) ?? []).length).toBe(1)
    expect(src).toMatch(/capacityForNow\(slot,/)
  })

  it("still counts unique attendance across the whole run", () => {
    /*
     * "Inside" is about right now; "how many people has this drawn" is about
     * the run. Scoping this one would make a three-day event forget its first
     * two days every morning.
     */
    const src = code("lib/occupancy.ts")
    const uniqueQuery = /kind: "attendee", check_in_time: \{ not: null \} \}/.exec(src)
    expect(uniqueQuery).not.toBeNull()
    expect(uniqueQuery![0]).not.toContain("today")
  })
})

describe("the stored capacity counter has no readers left", () => {
  /*
   * `events.current_capacity` is a stored number with NO WRITER anywhere in the
   * codebase — and it was rendered as if it were live: on the admin events
   * table as "N / capacity", and in the mobile API as `currentCapacity`,
   * sitting beside a `checkInCount` on the same object that was correct.
   *
   * It is the counting bug in its purest form: not a wrong fold, but a number
   * nobody computes at all, displayed next to one somebody does.
   */
  const src = (rel: string) =>
    readFileSync(join(__dirname, "..", rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")

  it("is not selected by the admin events query", () => {
    expect(src("lib/admin-role-actions.ts")).not.toMatch(/current_capacity:\s*true/)
    // Counted instead, through the module that owns the question.
    expect(src("lib/admin-role-actions.ts")).toMatch(/distinctAttendeeCounts\(/)
  })

  it("is not rendered on the admin events table", () => {
    expect(src("components/user-events-table.tsx")).not.toMatch(/current_capacity/)
  })

  it("does not reach the mobile API", () => {
    /*
     * The field survives in the response — an older client build may read it,
     * and a shipped app is not something this repo can update — but it carries
     * the counted value now. Serving the true number cannot break a caller that
     * was already handling an integer.
     */
    const events = src("lib/services/events.service.ts")
    expect(events).not.toMatch(/currentCapacity:\s*event\.current_capacity/)
    expect(events).toMatch(/currentCapacity:\s*attended\.get\(/)
  })

  it("still has no writer", () => {
    /*
     * The state that made it a lie. A writer appearing would not fix it — it
     * would recreate the drift the counting module exists to remove, since
     * every write path would then have to maintain it correctly.
     */
    for (const f of [
      "lib/admin-role-actions.ts",
      "lib/services/events.service.ts",
      "app/api/events/route.ts",
    ]) {
      expect(src(f)).not.toMatch(/current_capacity:\s*\{?\s*(increment|decrement|set)/)
    }
  })
})
