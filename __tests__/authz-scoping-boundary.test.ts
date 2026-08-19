import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

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
  // `organizer_id` survives as a documented floor in these two: an event
  // created before organisations existed stays visible to its creator.
  "app/api/events/route.ts",
  "app/dashboard/chatrooms/page.tsx",
  "app/dashboard/actions.ts",
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

/**
 * Comments explain these bugs at several call sites, so a naive grep matches
 * the prose describing the fix and fails on correct code. Strip comments first.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
}

/** Identity-scoped authorization comparisons that the resolver should own. */
const BANNED: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /organizer_id\s*!==/,
    why: "compares the event's CREATOR to the caller; use eventPermissions(actor, event)",
  },
  {
    pattern: /owner_id\s*:/,
    why: "venues.owner_id has no writer; scope on owner_org_id via actorFor()",
  },
]

describe("authorization is not hand-rolled outside lib/rbac.ts", () => {
  const files = SEARCH_DIRS.flatMap((d) => sourceFiles(join(ROOT, d)))
    .map((f) => [f.replace(`${ROOT}/`, ""), f] as const)
    .filter(([rel]) => !ALLOWED.has(rel))

  it("scans a non-trivial number of files, so a bad path cannot empty this test", () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it.each(BANNED)("no file hand-rolls $pattern", ({ pattern, why }) => {
    const offenders = files
      .filter(([, abs]) => pattern.test(stripComments(readFileSync(abs, "utf8"))))
      .map(([rel]) => `${rel} — ${why}`)
    expect(offenders).toEqual([])
  })
})
