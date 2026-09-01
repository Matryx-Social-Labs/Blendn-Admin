import { readFileSync } from "fs"
import { join } from "path"

import { MERGE_REPOINTS } from "@/lib/sponsor-merge"

/**
 * A merge must repoint EVERY relation to `sponsors`, not just placements.
 *
 * ## Why this is a test and not a code review note
 *
 * `mergeSponsors` walks a hand-written list of tables. The day somebody adds a
 * fourth relation to `sponsors` — a contract, a contact, an asset library — the
 * merge keeps compiling, keeps passing, and quietly leaves those rows pointing
 * at a brand that has just been soft-deleted.
 *
 * The consequences are not symmetrical. A stranded `event_sponsored_messages`
 * row still has `is_active = true` and a `sponsor_id` whose brand is gone: the
 * scheduler's due-select joins through the sponsor, so the campaign stops
 * sending and nothing reports it. That is the same silent-stop failure the
 * `sponsored_active_needs_sponsor` CHECK exists to prevent, arriving through a
 * door the CHECK does not cover.
 *
 * So the list is derived from the schema rather than trusted: this reads the
 * back-relations declared on `model sponsors` and asserts the merge covers all
 * of them. Adding a relation without adding it to `MERGE_REPOINTS` fails here.
 */

const SCHEMA = readFileSync(
  join(__dirname, "..", "prisma", "schema.prisma"),
  "utf8"
)

/**
 * `lib/sponsor-actions.ts` carries `"use server"` and pulls in `next/cache` and
 * the Prisma client, neither of which the unit environment transforms — so the
 * body of `mergeSponsors` is read as text below. The list itself is imported: it
 * lives in a plain module precisely because a `"use server"` file may only
 * export async functions, and holding it there broke `next build`.
 */
const ACTIONS = readFileSync(
  join(__dirname, "..", "lib", "sponsor-actions.ts"),
  "utf8"
)

/** The tables `mergeSponsors` declares it repoints. */
function mergeRepoints(): string[] {
  return [...MERGE_REPOINTS]
}

/** The `model sponsors { … }` body. */
function sponsorsModel(): string {
  const start = SCHEMA.indexOf("model sponsors {")
  expect(start).toBeGreaterThan(-1)
  return SCHEMA.slice(start, SCHEMA.indexOf("\n}", start))
}

/**
 * List-valued relation fields on `sponsors` — `foo Bar[]`.
 *
 * These are the rows that point AT a sponsor and therefore have to move. The
 * scalar `org` relation points the other way and is irrelevant to a merge.
 */
function backRelationTargets(): string[] {
  const body = sponsorsModel()
  const targets: string[] = []
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*\w+\s+(\w+)\[\]/)
    if (m) targets.push(m[1])
  }
  return targets
}

describe("mergeSponsors covers every relation to sponsors", () => {
  it("finds the model and its back-relations, so the test cannot pass vacuously", () => {
    const targets = backRelationTargets()
    expect(targets.length).toBeGreaterThan(0)
  })

  it("repoints every list relation declared on the model", () => {
    const declared = backRelationTargets().sort()
    const covered = mergeRepoints().sort()
    expect(covered).toEqual(declared)
  })

  it("actually issues an update for each of them", () => {
    // The constant could drift from the implementation, so check the body too.
    const src = ACTIONS
    for (const table of mergeRepoints()) {
      // Either a bulk updateMany or the collision-aware placement path.
      expect(src).toMatch(new RegExp(`tx\\.${table}\\.(updateMany|deleteMany|findMany)`))
    }
  })

  it("refuses to merge a brand into itself", () => {
    const src = ACTIONS
    // Self-merge would soft-delete the winner and strand everything.
    expect(src).toMatch(/loserId === winnerId/)
  })

  it("soft-deletes the loser and records where it went", () => {
    const src = ACTIONS
    expect(src).toMatch(/merged_into: winnerId/)
    expect(src).toMatch(/deleted_at: new Date\(\)/)
  })
})
