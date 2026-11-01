import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

import { stripComments } from "./support/strip-comments"

/**
 * A night's rating goes through `lib/disclosure.ts`, or it does not leave.
 *
 * The app tells everyone who rates the night that it is "only ever seen by us"
 * (SCRUM-437). Six screens and two mobile routes averaged or charted ratings
 * over any count, so one rating beside "1 came" was that person's score. Each
 * was an ordinary `aggregate` or `groupBy`, invisible to tsc and to a reviewer.
 *
 * This makes the rule a boundary: a file that reads scores in bulk must go
 * through `publishedRatingGroups` (bars in batches, SCRUM-472) and then `discloseStars` or `discloseStarsAcross`, and the mobile API
 * hands attendees no average at all, since an attendee who can poll one reads
 * each new score from its change.
 *
 * If you are here because this failed: `rows = await publishedRatingGroups(eventsWhere)`, then
 * `discloseStars(spread)` for one event, `discloseStarsAcross(spreadsByEvent(rows))` across several.
 */

const ROOT = join(__dirname, "..")
const SEARCH_DIRS = ["app", "lib", "components"]

/** Bulk reads of scores that never reach a host or an attendee. */
const ALLOWED = new Set([
  // The per-rating export, app_admin only: canRunReport and buildReport both refuse anyone else.
  "lib/reports.ts",
  // Selects who rated (user_id), to leave them out of the "rate the night" push.
  "lib/services/event-notifications.service.ts",
  // Counts raters per event (`_count` only, never a rating value): `ratingCount`, which the `_count` relation it replaced already exposed.
  "lib/event-tallies.ts",
  // The one reader every host surface goes through: raters published in batches (SCRUM-472).
  "lib/rating-batches.ts",
])

const READS_SCORES = [
  /event_ratings\.(aggregate|groupBy|findMany)\b/,
  /ratings:\s*\{\s*select:\s*\{\s*rating:\s*true/,
  /_avg:\s*\{\s*rating\b/,
]

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

const files = SEARCH_DIRS.flatMap((d) => sourceFiles(join(ROOT, d))).map(
  (f) => [f.replace(`${ROOT}/`, ""), stripComments(readFileSync(f, "utf8"))] as const
)

describe("ratings leave only through lib/disclosure.ts (SCRUM-437)", () => {
  it("scans a non-trivial number of files, so a bad path cannot empty this test", () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it("every bulk read of scores goes through publishedRatingGroups, so a reload cannot difference the newest one", () => {
    const offenders = files
      .filter(([rel, src]) => !ALLOWED.has(rel) && READS_SCORES.some((p) => p.test(src)))
      .map(([rel]) => rel)
    expect(offenders).toEqual([])
  })

  it("the mobile API hands attendees no average", () => {
    const offenders = files
      .filter(([rel, src]) => rel.startsWith("app/api/mobile/") && /averageRating|_avg:\s*\{\s*rating\b/.test(src))
      .map(([rel]) => rel)
    expect(offenders).toEqual([])
  })
})
