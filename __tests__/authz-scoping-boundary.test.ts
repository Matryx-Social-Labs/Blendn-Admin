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

/*
 * A venue owner sees a venue from its claim on (SCRUM-355, SCRUM-500).
 *
 * The resolver held that row by row, while the list, every CSV, the venue page,
 * the building's live count and the linked-events list each read the venue's
 * events their own way — `venue: { owner_org_id }`, or `venue_id: id` — and
 * none of them asked the claim date. So a new owner downloaded per-guest
 * check-in rows for nights before they owned the place.
 *
 * The claim window has two doors: `claimedVenueEventsWhere()` for a scope over
 * an actor's venues, `claimedWindow()` for one venue. These rules refuse the
 * other ways in, and the positive checks below pin the known readers to the
 * doors. Scans every file, including the ones `ALLOWED` exempts above.
 */
/**
 * Files that read events by a list of venue ids and are not an owner's scope.
 * The rule below exists for "an owner's venues, then their events"; a guest
 * count over the venues an attendee is browsing is a different question.
 */
const VENUE_IN_READS_ALLOWED = new Map([
  ["lib/live-count.ts", "who is live at the venues on an attendee's list or venue page, kept as a bucket; nothing per person reaches anyone, nothing reaches an owner"],
])

const VENUE_RULES: Array<{ name: string; pattern: RegExp; why: string; allowed?: Map<string, string> }> = [
  {
    name: "relation filter on the venue's owner",
    // Any key order, `is:`, shorthand, `venues: { some: … }`. Not a `select`
    // or `include`, and not a type annotation (`owner_org_id: string`).
    pattern: /\bvenues?\s*:\s*\{(?!\s*(?:select|include)\b)[^}]*\bowner_org_id\b(?!\s*:\s*string\b)/,
    why: "scopes events through the venue's owner with no claim date; use claimedVenueEventsWhere()",
  },
  {
    name: "owned venue ids, then events by `venue_id: { in }`",
    pattern: /\bvenue_id\s*:\s*\{\s*in\s*:/,
    why: "the two-step version of the same scope; use claimedVenueEventsWhere()",
    allowed: VENUE_IN_READS_ALLOWED,
  },
  {
    name: "raw SQL joining events to a venue's owner",
    pattern: /`[^`]*\b(?:FROM|JOIN)\s+"?events"?\b[^`]*\bowner_org_id\b[^`]*`|`[^`]*\bowner_org_id\b[^`]*\b(?:FROM|JOIN)\s+"?events"?\b[^`]*`/i,
    why: "raw SQL scoping events by a venue's owner; the claim date must be in it — use the helpers",
  },
]

/** Reads of one venue's rows by id: `where: { venue_id: x }` or `event: { venue_id: x }`. */
const VENUE_ID_READ = /\b(?:where|event|events)\s*:\s*\{[^{}]*\bvenue_id\s*:(?!\s*\{\s*not\s*:\s*null)(?!\s*string\b)/

/**
 * Files that read by `venue_id` and are not a venue owner's view of events.
 * Anything else that does must go through `claimedWindow()`.
 */
const VENUE_ID_READS_ALLOWED = new Map([
  ["lib/venue-actions.ts", "counts future bookings to refuse a retire; nothing is shown"],
  ["lib/venue-claim-actions.ts", "venue_claims rows, not events"],
  ["lib/venue-day.ts", "finds the venue's own day to go live in; nothing is shown to an owner"],
  ["lib/venue-visibility.ts", "whether a real event has a venue now, for Go Live, the venue page and the sweeper; nothing is shown to an owner"],
  ["app/api/mobile/venues/[venueId]/route.ts", "the attendee's venue page: a bucketed live count and tonight's public event; nothing per person, nothing to an owner"],
  ["lib/presence-sweeper.ts", "closes a venue's Go Live sessions when an event there starts; nothing is shown to anyone"],
  ["lib/live-count.ts", "who is live at an attendee's venues, kept as a bucket; nothing per person, nothing to an owner"],
])

describe("a venue owner's view starts at the claim", () => {
  const files = SEARCH_DIRS.flatMap((d) => sourceFiles(join(ROOT, d))).map(
    (abs) => [abs.replace(`${ROOT}/`, ""), stripComments(readFileSync(abs, "utf8"))] as const
  )

  it.each(VENUE_RULES)("no file has a $name", ({ pattern, why, allowed }) => {
    const offenders = files
      .filter(([rel, src]) => pattern.test(src) && !allowed?.has(rel))
      .map(([rel]) => `${rel} — ${why}`)
    expect(offenders).toEqual([])
  })

  it("keeps the venue_id-in allowlist honest: each entry still reads that way", () => {
    for (const rel of VENUE_IN_READS_ALLOWED.keys()) {
      const src = files.find(([f]) => f === rel)?.[1] ?? ""
      expect(VENUE_RULES[1].pattern.test(src)).toBe(true)
    }
  })

  it("every read of one venue's events by id goes through claimedWindow()", () => {
    const offenders = files
      .filter(([rel, src]) => VENUE_ID_READ.test(src) && !VENUE_ID_READS_ALLOWED.has(rel))
      .filter(([, src]) => !/\bclaimedWindow\(/.test(src))
      .map(([rel]) => rel)
    expect(offenders).toEqual([])
  })

  it("keeps the allowlist honest: each entry still reads by venue_id", () => {
    for (const rel of VENUE_ID_READS_ALLOWED.keys()) {
      const src = files.find(([f]) => f === rel)?.[1] ?? ""
      expect(VENUE_ID_READ.test(src)).toBe(true)
    }
  })

  /*
   * The readers, pinned to the doors. A grep that bans shapes cannot see a
   * reader that quietly stops calling the helper and returns the same rows;
   * these can.
   */
  it.each([
    ["lib/event-visibility.ts", /\.\.\.\(user\.role === "venue_owner" \? await claimedVenueEventsWhere\(actor\.orgIds\)/],
    ["lib/reports.ts", /role === "venue_owner" \? await claimedVenueEventsWhere\(orgIds\)/],
    ["lib/venue-link-actions.ts", /OR: await claimedVenueEventsWhere\(actor\.orgIds\)/],
    ["lib/venue-link-actions.ts", /startsAfterClaim\(event\.venue, event\.start_time\)/],
    ["lib/building-occupancy.ts", /opts\.asOwner && venue \? claimedWindow\(venue\)/],
    ["app/dashboard/venues/[id]/page.tsx", /isAdmin \? undefined : claimedWindow\(venue\)/],
    ["app/dashboard/venues/[id]/page.tsx", /: claimedWindow\(venue, \{ from: range\.from, to: range\.to \}\)/],
    ["app/dashboard/venues/[id]/page.tsx", /const actor = isAdmin \? null : await actorFor\(session\.user\)/],
    ["app/dashboard/venues/[id]/page.tsx", /getBuildingOccupancy\(id, \{ asOwner: actor \}\)/],
  ])("%s goes through the claim window", (rel, shape) => {
    const src = files.find(([f]) => f === rel)?.[1]
    expect(src).toBeDefined()
    expect(src).toMatch(shape)
  })

  /*
   * Each rule against the shape it exists to catch, and the shapes it must
   * not — so a rule edited into uselessness fails here rather than passing
   * against a codebase that happens to be clean.
   */
  it.each([
    ["key order", 0, `where: { venue: { deleted_at: null, owner_org_id: { in: orgIds } } }`],
    ["`is:`", 0, `where: { venue: { is: { owner_org_id: { in: orgIds } } } }`],
    ["shorthand", 0, `const w = { venue: { owner_org_id } }`],
    ["to-many", 0, `where: { venues: { some: { owner_org_id: orgId } } }`],
    ["two-step", 1, `db.events.findMany({ where: { venue_id: { in: ownedIds } } })`],
    ["raw SQL", 2, "db.$queryRaw`SELECT e.id FROM events e JOIN venues v ON v.id = e.venue_id WHERE v.owner_org_id = ${o}`"],
  ])("rule catches the %s shape", (_label, rule, snippet) => {
    expect(VENUE_RULES[rule as number].pattern.test(snippet)).toBe(true)
  })

  it.each([
    `venue: { select: { owner_org_id: true, claimed_at: true } }`,
    `venue: { owner_org_id: string | null; claimed_at: Date | null } | null`,
    "db.$queryRaw`SELECT v.id, v.owner_org_id FROM venues v LEFT JOIN organisations o ON o.id = v.owner_org_id`",
    `where: { deleted_at: null, venue_id: { not: null } }`,
    `function f(event: { venue_name: string | null; venue_id: string | null }) {}`,
  ])("no rule fires on %s", (snippet) => {
    for (const { pattern } of VENUE_RULES) expect(pattern.test(snippet)).toBe(false)
    expect(VENUE_ID_READ.test(snippet)).toBe(false)
  })

  it("the venue_id read rule sees both forms", () => {
    expect(VENUE_ID_READ.test(`where: { venue_id: id, deleted_at: null }`)).toBe(true)
    expect(VENUE_ID_READ.test(`where: { event: { venue_id: id, deleted_at: null } }`)).toBe(true)
  })
})
