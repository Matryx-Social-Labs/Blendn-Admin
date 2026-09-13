import { readFileSync } from "fs"
import { join } from "path"

import {
  byUrgency,
  queueAgeLabel,
  queueBadges,
  queueBreached,
  totalWaiting,
  type AttentionQueue,
} from "@/lib/attention-queues"
import { dashboardNav } from "@/lib/dashboard-nav"

/**
 * The overview's attention strip and the sidebar badges answer one question.
 *
 * They used to answer it twice, from different code, and they disagreed on
 * screen: the strip counted `moderation_flags` alone and rendered *"Moderation
 * queue is clear"* while the sidebar six inches to its left showed `Claims 4`
 * and `Applications 7`, with one report open 29 days.
 *
 * A wrong number is a bug you can see. A **partial** number rendered with the
 * confidence of a complete one is worse, because the screen looks fine.
 */
const HOUR = 3_600_000
const NOW = new Date("2026-09-10T12:00:00.000Z")

function queue(over: Partial<AttentionQueue> = {}): AttentionQueue {
  return {
    key: "claims",
    label: "claim",
    labelPlural: "claims",
    count: 1,
    oldest: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
    href: "/dashboard/claims",
    slaHours: 72,
    ...over,
  }
}

describe("queueAgeLabel", () => {
  it("says 'open' for one and 'oldest' for several", () => {
    /*
     * Not cosmetic. "oldest 29 days" over a single report reads as though
     * there are others behind it, which changes what the reader thinks the
     * backlog is.
     */
    expect(queueAgeLabel(queue({ count: 1 }), NOW)).toBe("open 2h")
    expect(queueAgeLabel(queue({ count: 4 }), NOW)).toBe("oldest 2h")
  })

  it("counts in hours below a day and in days above it", () => {
    const at = (hours: number) =>
      queueAgeLabel(queue({ oldest: new Date(NOW.getTime() - hours * HOUR).toISOString() }), NOW)

    // A queue that turned over this morning must not read "0 days".
    expect(at(0.5)).toBe("open under an hour")
    expect(at(23)).toBe("open 23h")
    expect(at(24)).toBe("open 1 day")
    expect(at(29 * 24)).toBe("open 29 days")
  })

  it("says nothing at all for an empty queue", () => {
    expect(queueAgeLabel(queue({ count: 0, oldest: null }), NOW)).toBeNull()
    // Defensive: a count of zero wins even if a stale timestamp came with it.
    expect(queueAgeLabel(queue({ count: 0 }), NOW)).toBeNull()
  })
})

describe("queueBreached", () => {
  it("uses each queue's own window, not one global number", () => {
    /*
     * The SLAs differ by an order of magnitude on purpose. A flagged message
     * waiting a day means somebody is reading something that should have been
     * pulled; an application waiting a day means an organiser is mildly
     * impatient. One threshold across both would be too loud for applications
     * or too quiet for moderation, and too quiet is the failure that matters.
     */
    const oldest = new Date(NOW.getTime() - 30 * HOUR).toISOString()
    expect(queueBreached(queue({ slaHours: 24, oldest }), NOW)).toBe(true)
    expect(queueBreached(queue({ slaHours: 72, oldest }), NOW)).toBe(false)
  })

  it("an empty queue is never breached", () => {
    expect(queueBreached(queue({ count: 0, oldest: null, slaHours: 1 }), NOW)).toBe(false)
  })
})

describe("byUrgency", () => {
  it("puts breaches first, then the oldest, and empty queues last", () => {
    const ordered = byUrgency(
      [
        queue({ key: "claims", count: 0, oldest: null }),
        queue({ key: "applications", count: 7, oldest: new Date(NOW.getTime() - 12 * 24 * HOUR).toISOString(), slaHours: 72 }),
        queue({ key: "creative", count: 2, oldest: new Date(NOW.getTime() - 3 * HOUR).toISOString(), slaHours: 48 }),
        queue({ key: "moderation", count: 1, oldest: new Date(NOW.getTime() - 29 * 24 * HOUR).toISOString(), slaHours: 24 }),
      ],
      NOW
    )
    expect(ordered.map((q) => q.key)).toEqual([
      "moderation", // 29 days past a 24h window
      "applications", // 12 days past a 72h window
      "creative", // inside its window
      "claims", // empty, and empty always sorts last
    ])
  })

  it("keeps empty queues rather than dropping them", () => {
    /*
     * The whole failure this module exists to close is a clear queue and an
     * uncounted queue looking identical. An empty row saying "0 · clear" is
     * what makes the silence trustworthy.
     */
    const all = [queue({ key: "claims", count: 0, oldest: null }), queue({ key: "moderation" })]
    expect(byUrgency(all, NOW)).toHaveLength(2)
  })
})

describe("totalWaiting", () => {
  it("adds every queue, so the heading cannot undercount", () => {
    expect(
      totalWaiting([
        queue({ key: "moderation", count: 1 }),
        queue({ key: "claims", count: 4 }),
        queue({ key: "applications", count: 7 }),
        queue({ key: "creative", count: 0, oldest: null }),
      ])
    ).toBe(12)
  })
})

describe("the sidebar and the strip cannot drift apart", () => {
  it("every badgeKey the nav asks for is one queueBadges produces", () => {
    /*
     * A nav item can name a `badgeKey` that nothing supplies, and the failure
     * is silent — `badges?.[key]` is `undefined`, the badge simply does not
     * render, and the queue becomes invisible from every other screen. That is
     * how Creative review sat in "Needs a decision" with no count anywhere.
     */
    const supplied = new Set(
      Object.keys(
        queueBadges([
          queue({ key: "moderation" }),
          queue({ key: "claims" }),
          queue({ key: "applications" }),
          queue({ key: "creative" }),
        ])
      )
    )
    const asked = dashboardNav
      .map((item) => item.badgeKey)
      .filter((key): key is NonNullable<typeof key> => key !== undefined)

    expect(asked.length).toBeGreaterThan(0) // guards the guard
    expect(asked.filter((key) => !supplied.has(key))).toEqual([])
  })

  it("the layout counts nothing itself", () => {
    /*
     * STRUCTURAL. The bug was two implementations of one question, so the fix
     * is not a correct second implementation — it is there being only one.
     *
     * Negative control: put `db.moderation_flags.count(...)` back into
     * `app/dashboard/layout.tsx`. Recorded in negative-controls.json.
     */
    const layout = readFileSync(join(__dirname, "../app/dashboard/layout.tsx"), "utf8")
    expect(layout).toContain("queueBadges")
    for (const table of [
      "moderation_flags",
      "user_reports",
      "message_reports",
      "event_claims",
      "venue_claims",
      "sponsor_claims",
      "organiser_onboarding_requests",
      "sponsored_creatives",
    ]) {
      expect(layout).not.toContain(`db.${table}`)
    }
  })

  it("the pure half never imports the database", () => {
    /*
     * STRUCTURAL, and the build is the only other thing that catches it.
     *
     * `attention-strip.tsx` is a client component using `byUrgency` and
     * `queueAgeLabel` at runtime, so `lib/attention-queues.ts` reaching `db`
     * drags `pg` into a browser bundle and `next build` dies. `tsc` is happy
     * and all 2418 unit tests are happy, because Jest resolves the import and
     * never asks which bundle it lands in — this was found by running a real
     * build, not by any check that runs on save.
     *
     * Negative control: add `import { db } from "./db"` to
     * lib/attention-queues.ts. Recorded in negative-controls.json.
     */
    const pure = readFileSync(join(__dirname, "../lib/attention-queues.ts"), "utf8")
    expect(pure).toContain("export function byUrgency")
    expect(pure).not.toMatch(/from "\.\/db"|from "@\/lib\/db"/)
  })
})
