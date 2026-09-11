import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

import { stripComments } from "./support/strip-comments"

/**
 * Authorization is organisation-shaped. Nothing may hand-roll it.
 *
 * `lib/rbac.ts` resolves who may do what, scoped by organisation membership.
 * The migration to that model converted the API routes and left the screens and
 * the mobile surface behind, so for months the codebase held both models at
 * once and the older one silently won wherever it survived:
 *
 *   `event.organizer_id !== authUser.userId`   5 mobile routes. Over-permissive
 *       (it is the row's CREATOR, so an ex-member of the org kept access) and
 *       under-permissive (an app_admin was refused, and a colleague at the same
 *       org who did not create the row was refused) at the same time.
 *
 *   `venue: { owner_id: ... }`                 The chatrooms triage screen.
 *       `venues.owner_id` has no writer anywhere — only `owner_org_id` is ever
 *       set — so the venue-owner branch matched zero rows for every venue owner
 *       who ever existed, and rendered as a legitimate empty state.
 *
 * Neither was visible to `tsc`, to the unit suite, or to a reviewer reading the
 * diff, because each looked like a perfectly ordinary comparison.
 *
 * `lib/rbac.ts` is a library. This test is what makes it a boundary: nothing
 * stops a new route from writing the comparison by hand, so the grep is the
 * enforcement. It is deliberately blunt, and cheaper than the five fixes it
 * makes permanent.
 *
 * If you are here because this test failed: you almost certainly want
 * `eventPermissions(actor, event)` with `actorFor()` and `eventPermissionSelect`.
 * See `app/api/mobile/events/[eventId]/route.ts` for the shape.
 */

const ROOT = join(__dirname, "..")
const SEARCH_DIRS = ["app", "lib", "components"]

/** The resolver itself, and the one place the fallback clause is legitimate. */
const ALLOWED = new Set([
  "lib/rbac.ts",
  // `organizer_id` survives as a documented floor in these: an event created
  // before organisations existed stays visible to its creator. The first also
  // WRITES it on create, which is the column's legitimate job -- recording who
  // made the row -- and is indistinguishable from a scope filter by grep.
  "app/api/events/route.ts",
  "app/dashboard/actions.ts",
  /*
   * Writes `organizer_id` on clone and does not yet write `organizer_org_id` --
   * which is A1, the finding W1 exists to fix. Drop this entry when #270 lands
   * and the refinement below will pass it on its own.
   */
  "app/api/mobile/events/[eventId]/clone/route.ts",
])

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

/** Identity-scoped authorization comparisons that the resolver should own. */
const BANNED: Array<{ pattern: RegExp; why: string; unlessFileMentions?: string }> = [
  {
    pattern: /organizer_id\s*!==/,
    why: "compares the event's CREATOR to the caller; use eventPermissions(actor, event)",
  },
  {
    pattern: /owner_id\s*:/,
    why: "venues.owner_id has no writer; scope on owner_org_id via actorFor()",
  },
  {
    /*
     * The shape this test could not see.
     *
     * It caught the `!==` comparison and missed the same mistake written as a
     * Prisma filter -- `{ deleted_at: null, organizer_id: session.user.id }` --
     * which is how `app/dashboard/attendees/page.tsx` kept scoping on the row's
     * creator for months after the API twin was fixed. A colleague at the same
     * organisation saw an empty roster; somebody who had left kept theirs.
     *
     * The comparison and the filter are one bug in two grammars, and a guard
     * that knows only one of them is a guard for the version somebody happens
     * to have written.
     *
     * Matches an assignment to a *variable*, which is what a scope filter is.
     * `organizer_id: session.user.id` inside a `data:` block on a create is
     * legitimate and looks identical, so the allowlist carries the two write
     * paths rather than the pattern trying to tell them apart.
     */
    pattern: /organizer_id\s*:\s*(session|authUser|user)\b/,
    /*
     * Only when the file has no notion of an organisation at all.
     *
     * `organizer_id: <caller>` is legitimate twice: written into a `data:`
     * block on create, where recording who made the row is the column's job,
     * and as one arm of an OR beside `organizer_org_id`, where it is the
     * documented floor for events that predate organisations.
     *
     * Both of those mention `organizer_org_id` in the same file. A scope that
     * knows only about the creator does not -- which is exactly what
     * `app/dashboard/attendees/page.tsx` was, and what let it keep H2's bug for
     * months after the API twin was fixed.
     *
     * A cheaper rule than trying to tell a `data:` block from a `where:` by
     * grep, and it fails in the safe direction: a file that has both shapes is
     * one a human has already thought about.
     */
    unlessFileMentions: "organizer_org_id",
    why: "scopes on the row's CREATOR with no org scope in the file; use eventScopeFor()",
  },
]

describe("authorization is not hand-rolled outside lib/rbac.ts", () => {
  const files = SEARCH_DIRS.flatMap((d) => sourceFiles(join(ROOT, d)))
    .map((f) => [f.replace(`${ROOT}/`, ""), f] as const)
    .filter(([rel]) => !ALLOWED.has(rel))

  it("scans a non-trivial number of files, so a bad path cannot empty this test", () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it.each(BANNED)("no file hand-rolls $pattern", ({ pattern, why, unlessFileMentions }) => {
    const offenders = files
      .filter(([, abs]) => {
        const src = stripComments(readFileSync(abs, "utf8"))
        if (!pattern.test(src)) return false
        return !unlessFileMentions || !src.includes(unlessFileMentions)
      })
      .map(([rel]) => `${rel} — ${why}`)
    expect(offenders).toEqual([])
  })
})
